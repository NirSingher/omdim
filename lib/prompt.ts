/**
 * Prompt logic for sending standup DMs to users
 * - Determines when to prompt users based on timezone and schedule
 * - Sends DM prompts with "Open Standup" button
 * - Tracks prompt status to avoid duplicate prompts
 */

import { DbClient, Participant, getAllParticipants, getOrCreatePrompt, updatePromptSent, getCachedUser, upsertCachedUser, getActiveOOO, getUnpostedSubmissions, markSubmissionPosted, Submission, markItemsDone, markItemsDropped, incrementCarryCount, markItemsInProgress, createWorkItems, getGitHubUsername, getUsersWithGitHubLinks, wasReminderSent, recordReminderSent, getDmStandupPreference } from './db';
import { getSchedule, getConfigError, getDaily, getDailies, getGitHubConfig, getGitHubUsernameFromConfig, getGitHubUserMappings, getReminderMinutesBefore } from './config';
import { getUserInfo, postMessage } from './slack';
import { postStandupToChannel, sendStandupDM } from './format';
import { fetchUserPRData, UserPRData } from './github';

// ============================================================================
// User Timezone with Caching
// ============================================================================

/**
 * Get user timezone, using cache when available
 * Falls back to Slack API and updates cache
 */
async function getCachedUserTimezone(
  db: DbClient,
  slackToken: string,
  userId: string
): Promise<{ tz: string; tz_offset: number } | null> {
  // Try cache first
  const cached = await getCachedUser(db, userId);
  if (cached && cached.tz) {
    return { tz: cached.tz, tz_offset: cached.tz_offset };
  }

  // Fetch from Slack API
  const userInfo = await getUserInfo(slackToken, userId);
  if (!userInfo) {
    return null;
  }

  // Update cache
  await upsertCachedUser(db, {
    slackUserId: userId,
    tz: userInfo.tz,
    tzOffset: userInfo.tz_offset,
  });

  return userInfo;
}

// ============================================================================
// Constants
// ============================================================================

/** Day name mapping for schedule matching */
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Prompt window: send prompts within 2 hours of scheduled time */
const PROMPT_WINDOW_MINUTES = 120;

/** Minimum time between prompts (30 minutes) */
const REPROMPT_INTERVAL_MINUTES = 30;

/** Reminder message variants - randomly selected for variety */
const REMINDER_MESSAGES = [
  // Direct
  (daily: string) => `Your *${daily}* update is due - let's do this! :rocket:`,
  (daily: string) => `Quick check-in time for *${daily}*! :alarm_clock:`,
  (daily: string) => `Time to fill out your *${daily}* standup.`,
  (daily: string) => `*${daily}* standup is waiting for you.`,
  (daily: string) => `Please submit your *${daily}* update.`,
  // Friendly
  (daily: string) => `Psst... *${daily}* standup time! :eyes:`,
  (daily: string) => `Hey! Don't forget your *${daily}* update :wave:`,
  (daily: string) => `Your team wants to hear from you! *${daily}* time :speech_balloon:`,
  (daily: string) => `Got a minute? *${daily}* standup is calling :telephone_receiver:`,
  (daily: string) => `Friendly nudge: *${daily}* update awaits :point_left:`,
  // Witty
  (daily: string) => `Plot twist: *${daily}* standup still needs your input :movie_camera:`,
  (daily: string) => `Breaking news: *${daily}* update remains unsubmitted :newspaper:`,
  (daily: string) => `*${daily}* standup: still a thing that exists and needs you :sparkles:`,
  (daily: string) => `Your *${daily}* update called. It misses you :phone:`,
  (daily: string) => `Fun fact: *${daily}* standups work better when you fill them out :bulb:`,
  // Snarky
  (daily: string) => `Still waiting on your *${daily}* update :hourglass_flowing_sand:`,
  (daily: string) => `*${daily}* standup isn't going to fill itself out :coffee:`,
  (daily: string) => `Your *${daily}* update is feeling neglected :wilted_flower:`,
  (daily: string) => `Roses are red, violets are blue, *${daily}* standup is still waiting for you :rose:`,
  (daily: string) => `The *${daily}* standup form is lonely. Very lonely. :new_moon_with_face:`,
  // Ridiculous
  (daily: string) => `BOOP. *${daily}* standup. BOOP. :robot_face:`,
  (daily: string) => `Legend says those who skip *${daily}* standups are haunted by incomplete tasks :ghost:`,
  (daily: string) => `*${daily}* standup or it didn't happen :shrug:`,
  (daily: string) => `A wild *${daily}* standup appeared! Quick, fill it out! :zap:`,
];

// ============================================================================
// User Timezone
// ============================================================================

/**
 * Get user timezone info from Slack API
 * @deprecated Use getUserInfo from lib/slack.ts directly
 */
export async function getUserTimezone(
  slackToken: string,
  userId: string
): Promise<{ tz: string; tz_offset: number } | null> {
  return getUserInfo(slackToken, userId);
}

// ============================================================================
// Schedule Checks
// ============================================================================

/**
 * Check if today is a workday for the given schedule
 */
export function isWorkday(scheduleDays: string[], userDate: Date): boolean {
  const dayName = DAY_NAMES[userDate.getDay()];
  return scheduleDays.map(d => d.toLowerCase()).includes(dayName);
}

/**
 * Check if current time is within the prompt window
 */
export function isWithinPromptWindow(
  scheduleTime: string,
  userDate: Date
): boolean {
  const [scheduleHour, scheduleMinute] = scheduleTime.split(':').map(Number);
  const scheduleTotalMinutes = scheduleHour * 60 + scheduleMinute;

  const userHour = userDate.getHours();
  const userMinute = userDate.getMinutes();
  const userTotalMinutes = userHour * 60 + userMinute;

  // Allow prompting from schedule time until PROMPT_WINDOW_MINUTES after
  const windowStart = scheduleTotalMinutes;
  const windowEnd = scheduleTotalMinutes + PROMPT_WINDOW_MINUTES;

  return userTotalMinutes >= windowStart && userTotalMinutes <= windowEnd;
}

/**
 * Check if enough time has passed since last prompt
 */
export function shouldReprompt(lastPromptedAt: Date | null): boolean {
  if (!lastPromptedAt) {
    return true; // Never prompted
  }

  const now = new Date();
  const timeSinceLastPrompt = now.getTime() - new Date(lastPromptedAt).getTime();
  const minutesSinceLastPrompt = timeSinceLastPrompt / (1000 * 60);

  return minutesSinceLastPrompt >= REPROMPT_INTERVAL_MINUTES;
}

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Get the current date/time in user's timezone
 * @param tzOffset - Timezone offset in seconds (from Slack API)
 */
export function getUserDate(tzOffset: number): Date {
  const now = new Date();
  // tzOffset is in seconds, convert to milliseconds
  const userTime = new Date(now.getTime() + tzOffset * 1000);
  return userTime;
}

/**
 * Get the current date/time in a named timezone (no Slack API call needed).
 * Returns a Date where UTC fields represent the local time in that timezone
 * (same convention as getUserDate).
 */
export function getDateInTimezone(timezone: string): Date {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(now);

  const get = (type: string) => parseInt(parts.find(p => p.type === type)!.value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')));
}

/**
 * Format date as YYYY-MM-DD
 */
export function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Calculate how many minutes late a user is from their scheduled time
 */
export function getMinutesLate(scheduleTime: string, userDate: Date): number {
  const [scheduleHour, scheduleMinute] = scheduleTime.split(':').map(Number);
  const scheduleTotalMinutes = scheduleHour * 60 + scheduleMinute;
  const userTotalMinutes = userDate.getHours() * 60 + userDate.getMinutes();
  return Math.max(0, userTotalMinutes - scheduleTotalMinutes);
}

/**
 * Format lateness as human-readable prefix
 */
export function formatLatenessPrefix(minutesLate: number): string {
  if (minutesLate < 5) return '';
  if (minutesLate < 60) return `${minutesLate} min late · `;
  const hours = Math.floor(minutesLate / 60);
  const mins = minutesLate % 60;
  if (mins === 0) return `${hours}h late · `;
  return `${hours}h ${mins}m late · `;
}

/**
 * Pick a random reminder message
 */
function getRandomReminderMessage(dailyName: string): string {
  const idx = Math.floor(Math.random() * REMINDER_MESSAGES.length);
  return REMINDER_MESSAGES[idx](dailyName);
}

// ============================================================================
// Prompt DM
// ============================================================================

/**
 * Build the prompt DM blocks with "Open Standup" button
 */
function buildPromptBlocks(dailyName: string, minutesLate: number) {
  const latenessPrefix = formatLatenessPrefix(minutesLate);
  const message = getRandomReminderMessage(dailyName);
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${latenessPrefix}${message}`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: 'Open Standup',
            emoji: true,
          },
          style: 'primary',
          action_id: 'open_standup',
          value: dailyName,
        },
      ],
    },
  ];
}

/**
 * Send a DM to user with "Open Standup" button
 */
export async function sendPromptDM(
  slackToken: string,
  userId: string,
  dailyName: string,
  minutesLate = 0
): Promise<boolean> {
  const latenessPrefix = formatLatenessPrefix(minutesLate);
  const text = `${latenessPrefix}Time for your *${dailyName}* standup!`;
  const blocks = buildPromptBlocks(dailyName, minutesLate);
  const result = await postMessage(slackToken, userId, text, blocks);
  return result !== null;
}

// ============================================================================
// Cron Job Logic
// ============================================================================

/**
 * Main prompt function - check all participants and send prompts as needed
 * Called by cron job every 30 minutes
 * @param force - Skip time window checks (for testing)
 */
export async function runPromptCron(
  db: DbClient,
  slackToken: string,
  force = false
): Promise<{ prompted: number; skipped: number; errors: number; configError?: string }> {
  const stats: { prompted: number; skipped: number; errors: number; configError?: string } = {
    prompted: 0,
    skipped: 0,
    errors: 0,
  };

  // Check for config errors first
  const configErr = getConfigError();
  if (configErr) {
    console.error('Prompt cron aborted due to config error:', configErr);
    stats.configError = configErr;
    return stats;
  }

  try {
    const participants = await getAllParticipants(db);
    console.log(`Checking ${participants.length} participants for prompting (force=${force})`);

    for (const participant of participants) {
      try {
        const result = await processParticipant(db, slackToken, participant, force);
        if (result === 'prompted') {
          stats.prompted++;
        } else if (result === 'skipped') {
          stats.skipped++;
        } else {
          stats.errors++;
        }
      } catch (error) {
        console.error(`Error processing participant ${participant.slack_user_id}:`, error);
        stats.errors++;
      }
    }
  } catch (error) {
    console.error('Error in prompt cron:', error);
  }

  console.log(`Prompt cron complete: ${stats.prompted} prompted, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

/**
 * Process a single participant to determine if they need prompting
 * @param force - Skip workday and time window checks (for testing)
 */
async function processParticipant(
  db: DbClient,
  slackToken: string,
  participant: Participant,
  force = false
): Promise<'prompted' | 'skipped' | 'error'> {
  const { slack_user_id: userId, daily_name: dailyName, schedule_name: scheduleName } = participant;

  // Get schedule config
  const schedule = getSchedule(scheduleName);
  if (!schedule) {
    console.warn(`Schedule "${scheduleName}" not found for participant ${userId}`);
    return 'error';
  }

  // Validate daily still exists in config (handles removed dailies)
  if (!getDaily(dailyName)) {
    console.warn(`Daily "${dailyName}" not found in config, skipping participant ${userId}`);
    return 'skipped';
  }

  // Get user timezone (from cache or Slack API)
  const userInfo = await getCachedUserTimezone(db, slackToken, userId);
  if (!userInfo) {
    return 'error';
  }

  // Calculate user's current date/time
  const userDate = getUserDate(userInfo.tz_offset);
  const todayStr = formatDate(userDate);

  // Check if today is a workday (skip if force)
  if (!force && !isWorkday(schedule.days, userDate)) {
    console.log(`Skipping ${userId}: not a workday`);
    return 'skipped';
  }

  // Check if user is out of office (skip if force)
  if (!force) {
    const oooStatus = await getActiveOOO(db, userId, dailyName, todayStr);
    if (oooStatus) {
      console.log(`Skipping ${userId}: out of office until ${oooStatus.end_date}`);
      return 'skipped';
    }
  }

  // Get prompt time (use override if set, otherwise schedule default)
  const promptTime = participant.time_override || schedule.default_time;

  // Check if within prompt window (skip if force)
  if (!force && !isWithinPromptWindow(promptTime, userDate)) {
    console.log(`Skipping ${userId}: outside prompt window (schedule: ${promptTime}, user time: ${userDate.toISOString()})`);
    return 'skipped';
  }

  // Get or create prompt record for today
  const prompt = await getOrCreatePrompt(db, userId, dailyName, todayStr);

  // Check if already submitted
  if (prompt.submitted) {
    console.log(`Skipping ${userId}: already submitted`);
    return 'skipped';
  }

  // Check if we should reprompt (skip if force)
  if (!force && !shouldReprompt(prompt.last_prompted_at)) {
    console.log(`Skipping ${userId}: prompted recently`);
    return 'skipped';
  }

  // Calculate how late the user is
  const minutesLate = getMinutesLate(promptTime, userDate);

  // Send the prompt DM
  const sent = await sendPromptDM(slackToken, userId, dailyName, minutesLate);
  if (!sent) {
    return 'error';
  }

  // Update prompt record
  await updatePromptSent(db, userId, dailyName, todayStr);

  console.log(`Prompted ${userId} for ${dailyName}`);
  return 'prompted';
}

// ============================================================================
// Scheduled Posts (User-Initiated Tomorrow Mode)
// ============================================================================

/**
 * Check if the user's scheduled time has passed
 */
export function hasScheduledTimePassed(scheduleTime: string, userDate: Date): boolean {
  const [scheduleHour, scheduleMinute] = scheduleTime.split(':').map(Number);
  const scheduleTotalMinutes = scheduleHour * 60 + scheduleMinute;
  const userTotalMinutes = userDate.getHours() * 60 + userDate.getMinutes();
  return userTotalMinutes >= scheduleTotalMinutes;
}

/**
 * Process scheduled posts - posts pre-filled "tomorrow" submissions when their time comes
 * Called by cron job every 30 minutes (along with prompt cron)
 */
export async function runScheduledPosts(
  db: DbClient,
  slackToken: string,
  env?: Record<string, string | undefined>
): Promise<{ posted: number; skipped: number; errors: number }> {
  const stats = { posted: 0, skipped: 0, errors: 0 };

  // Check for config errors first
  const configErr = getConfigError();
  if (configErr) {
    console.error('Scheduled posts cron aborted due to config error:', configErr);
    return stats;
  }

  try {
    // Get all unposted submissions
    const submissions = await getUnpostedSubmissions(db);
    console.log(`Found ${submissions.length} unposted submissions to check`);

    for (const submission of submissions) {
      try {
        const result = await processScheduledSubmission(db, slackToken, submission, env);
        if (result === 'posted') {
          stats.posted++;
        } else if (result === 'skipped') {
          stats.skipped++;
        } else {
          stats.errors++;
        }
      } catch (error) {
        console.error(`Error processing scheduled submission ${submission.id}:`, error);
        stats.errors++;
      }
    }
  } catch (error) {
    console.error('Error in scheduled posts cron:', error);
  }

  console.log(`Scheduled posts cron complete: ${stats.posted} posted, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

/**
 * Build a map from GitHub login (lowercase) → Slack user ID
 * Combines config mappings + DB self-linked accounts (config takes precedence)
 */
async function buildGitHubUserMap(
  daily: ReturnType<typeof getDaily>,
  db: DbClient
): Promise<Map<string, string>> {
  if (!daily) return new Map();
  const map = new Map<string, string>();

  const dbLinks = await getUsersWithGitHubLinks(db);
  for (const link of dbLinks) {
    map.set(link.githubUsername.toLowerCase(), link.slackUserId);
  }

  const configMappings = getGitHubUserMappings(daily);
  for (const mapping of configMappings) {
    map.set(mapping.githubUsername.toLowerCase(), mapping.slackUserId);
  }

  return map;
}

/**
 * Process a single scheduled submission
 */
async function processScheduledSubmission(
  db: DbClient,
  slackToken: string,
  submission: Submission,
  env?: Record<string, string | undefined>
): Promise<'posted' | 'skipped' | 'error'> {
  const { slack_user_id: userId, daily_name: dailyName } = submission;
  const submissionDate = String(submission.date).split('T')[0];

  // Get daily config
  const daily = getDaily(dailyName);
  if (!daily) {
    console.warn(`Daily "${dailyName}" not found for scheduled submission ${submission.id}`);
    return 'error';
  }

  // Get schedule config. Anchor date/time decisions to the daily's schedule
  // timezone (same frame used when the submission was written in
  // interactions.ts). Using the user's personal Slack tz here causes scheduled
  // posts to silently skip forever when the user travels across a day boundary
  // relative to the schedule's timezone.
  const schedule = daily.schedule ? getSchedule(daily.schedule) : null;
  const scheduledTime = schedule?.default_time || '10:00';
  const scheduleTz = schedule?.timezone || 'UTC';

  // Current date/time in the schedule's timezone
  const scheduleNow = getDateInTimezone(scheduleTz);
  const todayStr = formatDate(scheduleNow);

  // Check if submission date matches "today" in the schedule's timezone
  if (submissionDate !== todayStr) {
    // Future date (not time yet) or stale past date — skip
    return 'skipped';
  }

  // Check if scheduled time has passed
  if (!hasScheduledTimePassed(scheduledTime, scheduleNow)) {
    console.log(`Skipping ${userId} submission ${submission.id}: scheduled time ${scheduledTime} hasn't passed yet`);
    return 'skipped';
  }

  // Check if user is OOO
  const oooStatus = await getActiveOOO(db, userId, dailyName, todayStr);
  if (oooStatus) {
    console.log(`Skipping ${userId} submission ${submission.id}: user is OOO until ${oooStatus.end_date}`);
    // Mark as posted so we don't keep checking (OOO = cancelled)
    await markSubmissionPosted(db, submission.id, '');
    return 'skipped';
  }

  // Post to channel
  if (!daily.channel) {
    console.warn(`No channel configured for daily "${dailyName}"`);
    return 'error';
  }

  // Parse JSONB fields (Neon driver may return strings or arrays inconsistently)
  const parseJsonbArray = (val: string[] | null): string[] => {
    if (!val) return [];
    return Array.isArray(val) ? val : JSON.parse(val as unknown as string);
  };

  // Fetch GitHub PR data if integration is enabled
  let prData: UserPRData | undefined;
  let reviewerSlackMap: Map<string, string> | undefined;
  const githubConfig = getGitHubConfig(daily);
  if (githubConfig && env) {
    const githubToken = env[githubConfig.tokenEnvVar];
    if (githubToken) {
      // Get GitHub username: config mapping takes precedence over DB
      let githubUsername = getGitHubUsernameFromConfig(daily, userId);
      if (!githubUsername) {
        githubUsername = await getGitHubUsername(db, userId);
      }

      if (githubUsername) {
        try {
          [prData, reviewerSlackMap] = await Promise.all([
            fetchUserPRData(githubToken, githubUsername, githubConfig.org),
            buildGitHubUserMap(daily, db),
          ]);
        } catch (error) {
          console.error('Failed to fetch PR data for scheduled post:', error);
        }
      }
    }
  }

  const yesterdayInProgress = parseJsonbArray(submission.yesterday_in_progress);

  const messageTs = await postStandupToChannel(
    slackToken,
    daily.channel,
    userId,
    dailyName,
    {
      yesterdayCompleted: parseJsonbArray(submission.yesterday_completed),
      yesterdayIncomplete: parseJsonbArray(submission.yesterday_incomplete),
      yesterdayInProgress,
      yesterdayDropped: [], // Not stored in DB, so empty for scheduled posts
      unplanned: parseJsonbArray(submission.unplanned),
      todayPlans: parseJsonbArray(submission.today_plans),
      blockers: submission.blockers || '',
      customAnswers: submission.custom_answers || {},
      questions: daily.questions,
      fieldOrder: daily.field_order,
      prData,
      reviewerSlackMap,
      githubOrg: githubConfig?.org,
    }
  );

  if (!messageTs) {
    console.error(`Failed to post scheduled submission ${submission.id} to channel`);
    return 'error';
  }

  // Mark as posted with the message timestamp
  await markSubmissionPosted(db, submission.id, messageTs);

  // Send DM copy if user preference allows
  try {
    const dmEnabled = await getDmStandupPreference(db, userId);
    if (dmEnabled) {
      const yesterdayInProgressParsed = parseJsonbArray(submission.yesterday_in_progress);
      await sendStandupDM(slackToken, userId, dailyName, daily.channel, {
        yesterdayCompleted: parseJsonbArray(submission.yesterday_completed),
        yesterdayIncomplete: parseJsonbArray(submission.yesterday_incomplete),
        yesterdayInProgress: yesterdayInProgressParsed,
        yesterdayDropped: [],
        unplanned: parseJsonbArray(submission.unplanned),
        todayPlans: parseJsonbArray(submission.today_plans),
        blockers: submission.blockers || '',
        customAnswers: submission.custom_answers || {},
        questions: daily.questions,
        fieldOrder: daily.field_order,
        prData,
        reviewerSlackMap,
        githubOrg: githubConfig?.org,
      });
    }
  } catch (error) {
    console.error('Failed to send standup DM copy for scheduled post:', error);
  }

  // Track work items for analytics (same as regular submissions)
  try {
    const yesterdayCompleted = parseJsonbArray(submission.yesterday_completed);
    const yesterdayIncomplete = parseJsonbArray(submission.yesterday_incomplete);
    const todayPlans = parseJsonbArray(submission.today_plans);

    // We don't have yesterday_dropped in the submission, so skip that
    if (yesterdayCompleted.length > 0) {
      await markItemsDone(db, userId, dailyName, yesterdayCompleted, submissionDate);
    }
    if (yesterdayIncomplete.length > 0) {
      await incrementCarryCount(db, userId, dailyName, yesterdayIncomplete);
    }
    if (yesterdayInProgress.length > 0) {
      await markItemsInProgress(db, userId, dailyName, yesterdayInProgress);
    }
    if (todayPlans.length > 0) {
      await createWorkItems(
        db,
        todayPlans.map(text => ({
          slackUserId: userId,
          dailyName,
          text,
          date: submissionDate,
          submissionId: submission.id,
        }))
      );
    }
  } catch (error) {
    // Don't fail if work item tracking fails
    console.error('Failed to track work items for scheduled submission:', error);
  }

  console.log(`Posted scheduled submission ${submission.id} for ${userId} to ${daily.channel}`);
  return 'posted';
}

// ============================================================================
// Channel Reminder Cron
// ============================================================================

/**
 * Get current time in a timezone using Intl.DateTimeFormat
 */
function getTimeInTimezone(timezone: string): Date {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(now);
  const get = (type: string) => parts.find(p => p.type === type)?.value || '0';
  return new Date(
    Number(get('year')),
    Number(get('month')) - 1,
    Number(get('day')),
    Number(get('hour')),
    Number(get('minute'))
  );
}

/**
 * Send channel reminders before daily standups
 * Checks each daily: is reminder enabled? Is it the right time window? Was it already sent?
 */
export async function runReminderCron(
  db: DbClient,
  slackToken: string
): Promise<{ sent: number; skipped: number; errors: number }> {
  const stats = { sent: 0, skipped: 0, errors: 0 };

  const configErr = getConfigError();
  if (configErr) {
    console.error('Reminder cron aborted due to config error:', configErr);
    return stats;
  }

  const dailies = getDailies();

  for (const daily of dailies) {
    try {
      const reminderMinutes = getReminderMinutesBefore(daily);
      if (reminderMinutes === 0) {
        stats.skipped++;
        continue;
      }

      const schedule = getSchedule(daily.schedule);
      if (!schedule) {
        stats.skipped++;
        continue;
      }

      // Need timezone to check local time
      const timezone = schedule.timezone;
      if (!timezone) {
        // No timezone configured, skip reminder for this daily
        stats.skipped++;
        continue;
      }

      // Get local time in the schedule's timezone
      const localNow = getTimeInTimezone(timezone);

      // Check if today is a workday
      if (!isWorkday(schedule.days, localNow)) {
        stats.skipped++;
        continue;
      }

      // Calculate reminder time = default_time - reminder_minutes
      const [scheduleHour, scheduleMinute] = schedule.default_time.split(':').map(Number);
      const scheduleTotalMinutes = scheduleHour * 60 + scheduleMinute;
      const reminderTotalMinutes = scheduleTotalMinutes - reminderMinutes;

      // Current local time in minutes
      const nowTotalMinutes = localNow.getHours() * 60 + localNow.getMinutes();

      // Check if we're within a 30-minute window of the reminder time
      // (cron runs every 30 minutes, so we accept anything within ±15 min)
      const diff = nowTotalMinutes - reminderTotalMinutes;
      if (diff < 0 || diff >= 30) {
        stats.skipped++;
        continue;
      }

      // Check dedup: was reminder already sent today?
      const todayStr = formatDate(localNow);
      const alreadySent = await wasReminderSent(db, daily.name, todayStr);
      if (alreadySent) {
        stats.skipped++;
        continue;
      }

      // Send channel reminder
      const formattedTime = schedule.default_time;
      const message = `🔔 Reminder: The *${daily.name}* standup posts at *${formattedTime}*. Don't forget to fill yours in!`;
      const result = await postMessage(slackToken, daily.channel, message);

      if (result) {
        await recordReminderSent(db, daily.name, todayStr);
        stats.sent++;
        console.log(`Sent reminder for ${daily.name} to ${daily.channel}`);
      } else {
        stats.errors++;
        console.error(`Failed to send reminder for ${daily.name}`);
      }
    } catch (error) {
      console.error(`Error processing reminder for ${daily.name}:`, error);
      stats.errors++;
    }
  }

  console.log(`Reminder cron complete: ${stats.sent} sent, ${stats.skipped} skipped, ${stats.errors} errors`);
  return stats;
}

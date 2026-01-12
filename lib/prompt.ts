/**
 * Prompt logic for sending standup DMs to users
 * - Determines when to prompt users based on timezone and schedule
 * - Sends DM prompts with "Open Standup" button
 * - Tracks prompt status to avoid duplicate prompts
 */

import { DbClient, Participant, getAllParticipants, getOrCreatePrompt, updatePromptSent, getCachedUser, upsertCachedUser, getActiveOOO, getUnpostedSubmissions, markSubmissionPosted, Submission, markItemsDone, markItemsDropped, incrementCarryCount, createWorkItems } from './db';
import { getSchedule, getConfigError, getDaily } from './config';
import { getUserInfo, postMessage } from './slack';
import { postStandupToChannel } from './format';

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
  slackToken: string
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
        const result = await processScheduledSubmission(db, slackToken, submission);
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
 * Process a single scheduled submission
 */
async function processScheduledSubmission(
  db: DbClient,
  slackToken: string,
  submission: Submission
): Promise<'posted' | 'skipped' | 'error'> {
  const { slack_user_id: userId, daily_name: dailyName, date: submissionDate } = submission;

  // Get daily config
  const daily = getDaily(dailyName);
  if (!daily) {
    console.warn(`Daily "${dailyName}" not found for scheduled submission ${submission.id}`);
    return 'error';
  }

  // Get schedule config
  const schedule = daily.schedule ? getSchedule(daily.schedule) : null;
  const scheduledTime = schedule?.default_time || '10:00';

  // Get user timezone (from cache or Slack API)
  const userInfo = await getCachedUserTimezone(db, slackToken, userId);
  if (!userInfo) {
    console.warn(`Could not get timezone for user ${userId}`);
    return 'error';
  }

  // Calculate user's current date/time
  const userDate = getUserDate(userInfo.tz_offset);
  const userTodayStr = formatDate(userDate);

  // Check if submission date matches user's "today"
  if (submissionDate !== userTodayStr) {
    // Not time yet (submission is for a future date in user's timezone)
    // Or past date (shouldn't happen, but skip if so)
    return 'skipped';
  }

  // Check if scheduled time has passed
  if (!hasScheduledTimePassed(scheduledTime, userDate)) {
    console.log(`Skipping ${userId} submission ${submission.id}: scheduled time ${scheduledTime} hasn't passed yet`);
    return 'skipped';
  }

  // Check if user is OOO
  const oooStatus = await getActiveOOO(db, userId, dailyName, userTodayStr);
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

  const messageTs = await postStandupToChannel(
    slackToken,
    daily.channel,
    userId,
    dailyName,
    {
      yesterdayCompleted: submission.yesterday_completed || [],
      yesterdayIncomplete: submission.yesterday_incomplete || [],
      unplanned: submission.unplanned || [],
      todayPlans: submission.today_plans || [],
      blockers: submission.blockers || '',
      customAnswers: submission.custom_answers || {},
      questions: daily.questions,
      fieldOrder: daily.field_order,
    }
  );

  if (!messageTs) {
    console.error(`Failed to post scheduled submission ${submission.id} to channel`);
    return 'error';
  }

  // Mark as posted with the message timestamp
  await markSubmissionPosted(db, submission.id, messageTs);

  // Track work items for analytics (same as regular submissions)
  try {
    const yesterdayCompleted = submission.yesterday_completed || [];
    const yesterdayIncomplete = submission.yesterday_incomplete || [];
    const todayPlans = submission.today_plans || [];

    // We don't have yesterday_dropped in the submission, so skip that
    if (yesterdayCompleted.length > 0) {
      await markItemsDone(db, userId, dailyName, yesterdayCompleted, submissionDate);
    }
    if (yesterdayIncomplete.length > 0) {
      await incrementCarryCount(db, userId, dailyName, yesterdayIncomplete);
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

/**
 * Prompt logic for sending standup DMs to users
 * - Determines when to prompt users based on timezone and schedule
 * - Sends DM prompts with "Open Standup" button
 * - Tracks prompt status to avoid duplicate prompts
 */

import { DbClient, Participant, getAllParticipants, getOrCreatePrompt, updatePromptSent } from './db';
import { getSchedule } from './config';
import { getUserInfo, postMessage } from './slack';

// ============================================================================
// Constants
// ============================================================================

/** Day name mapping for schedule matching */
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Prompt window: send prompts within 2 hours of scheduled time */
const PROMPT_WINDOW_MINUTES = 120;

/** Minimum time between prompts (30 minutes) */
const REPROMPT_INTERVAL_MINUTES = 30;

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

// ============================================================================
// Prompt DM
// ============================================================================

/**
 * Build the prompt DM blocks with "Open Standup" button
 */
function buildPromptBlocks(dailyName: string) {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `Hey! It's time for your *${dailyName}* standup. :memo:`,
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
  dailyName: string
): Promise<boolean> {
  const text = `Time for your *${dailyName}* standup!`;
  const blocks = buildPromptBlocks(dailyName);
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
): Promise<{ prompted: number; skipped: number; errors: number }> {
  const stats = { prompted: 0, skipped: 0, errors: 0 };

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

  // Get user timezone from Slack
  const userInfo = await getUserTimezone(slackToken, userId);
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

  // Send the prompt DM
  const sent = await sendPromptDM(slackToken, userId, dailyName);
  if (!sent) {
    return 'error';
  }

  // Update prompt record
  await updatePromptSent(db, userId, dailyName, todayStr);

  console.log(`Prompted ${userId} for ${dailyName}`);
  return 'prompted';
}

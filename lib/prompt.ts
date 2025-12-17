/**
 * Prompt logic for sending standup DMs to users
 */

import { DbClient, Participant, Prompt, getAllParticipants, getOrCreatePrompt, updatePromptSent } from './db';
import { getSchedule, getDaily } from './config';

// Day name mapping for schedule matching
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// Prompt window: send prompts within 2 hours of scheduled time
const PROMPT_WINDOW_MINUTES = 120;

// Minimum time between prompts (30 minutes)
const REPROMPT_INTERVAL_MINUTES = 30;

interface UserInfo {
  tz: string;
  tz_offset: number;
}

interface PromptCandidate {
  participant: Participant;
  dailyName: string;
  channelId: string;
}

/**
 * Get user info from Slack API (timezone)
 */
export async function getUserTimezone(
  slackToken: string,
  userId: string
): Promise<UserInfo | null> {
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json() as {
      ok: boolean;
      user?: { tz: string; tz_offset: number };
      error?: string;
    };

    if (!data.ok || !data.user) {
      console.error(`Failed to get user info for ${userId}:`, data.error);
      return null;
    }

    return {
      tz: data.user.tz,
      tz_offset: data.user.tz_offset,
    };
  } catch (error) {
    console.error(`Error fetching user info for ${userId}:`, error);
    return null;
  }
}

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

/**
 * Get the current date in user's timezone as YYYY-MM-DD
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
 * Send a DM to user with "Open Standup" button
 */
export async function sendPromptDM(
  slackToken: string,
  userId: string,
  dailyName: string
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel: userId, // DM to user
        text: `Time for your *${dailyName}* standup!`,
        blocks: [
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
        ],
      }),
    });

    const data = await response.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      console.error(`Failed to send DM to ${userId}:`, data.error);
      return false;
    }

    return true;
  } catch (error) {
    console.error(`Error sending DM to ${userId}:`, error);
    return false;
  }
}

/**
 * Main prompt function - check all participants and send prompts as needed
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

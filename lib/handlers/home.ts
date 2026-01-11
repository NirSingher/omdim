/**
 * App Home handlers for the Home tab
 * Shows user's dailies with "Start Daily" buttons
 */

import { DbClient, getUserDailies, getSubmissionForDate } from '../db';
import { getDaily } from '../config';
import { publishHomeView } from '../slack';
import { formatDate, getUserDate, getUserTimezone } from '../prompt';

// ============================================================================
// Types
// ============================================================================

export interface HomeContext {
  db: DbClient;
  slackToken: string;
}

/** Slack event payload for app_home_opened */
export interface AppHomeOpenedEvent {
  type: 'app_home_opened';
  user: string;
  tab: 'home' | 'messages';
}

// ============================================================================
// Home View Builder
// ============================================================================

interface DailyStatus {
  dailyName: string;
  todaySubmitted: boolean;
  tomorrowScheduled: boolean;
}

/**
 * Build the App Home view for a user
 */
function buildHomeView(dailyStatuses: DailyStatus[]): unknown {
  const blocks: unknown[] = [];

  // Header
  blocks.push({
    type: 'header',
    text: {
      type: 'plain_text',
      text: '📋 Your Daily Standups',
      emoji: true,
    },
  });

  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: 'Click a button below to fill out your standup. If today is already done, you can pre-fill tomorrow\'s.',
    },
  });

  blocks.push({ type: 'divider' });

  if (dailyStatuses.length === 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '_You\'re not part of any dailies yet. Ask an admin to add you!_',
      },
    });
  } else {
    // Add a section for each daily
    for (const status of dailyStatuses) {
      const statusEmoji = status.todaySubmitted
        ? (status.tomorrowScheduled ? '📅' : '✅')
        : '⏳';

      const statusText = status.todaySubmitted
        ? (status.tomorrowScheduled ? 'Tomorrow scheduled' : 'Today done')
        : 'Not submitted';

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${status.dailyName}*\n${statusEmoji} ${statusText}`,
        },
        accessory: {
          type: 'button',
          text: {
            type: 'plain_text',
            text: status.todaySubmitted ? 'Fill Tomorrow' : 'Start Daily',
            emoji: true,
          },
          style: 'primary',
          action_id: 'home_start_daily',
          value: status.dailyName,
        },
      });
    }
  }

  blocks.push({ type: 'divider' });

  // Footer with help text
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '💡 You can also use `/daily` to quickly open the standup form.',
      },
    ],
  });

  return {
    type: 'home',
    blocks,
  };
}

// ============================================================================
// Event Handler
// ============================================================================

/**
 * Handle app_home_opened event
 * Publishes the Home view with user's dailies and their status
 */
export async function handleAppHomeOpened(
  event: AppHomeOpenedEvent,
  ctx: HomeContext
): Promise<boolean> {
  // Only handle the "home" tab (not "messages")
  if (event.tab !== 'home') {
    return true;
  }

  const userId = event.user;

  try {
    // Get user's dailies
    const userDailies = await getUserDailies(ctx.db, userId);

    // Get user's timezone for date calculations
    const userInfo = await getUserTimezone(ctx.slackToken, userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const todayStr = formatDate(userDate);

    // Calculate tomorrow
    const tomorrowDate = new Date(userDate);
    tomorrowDate.setDate(tomorrowDate.getDate() + 1);
    const tomorrowStr = formatDate(tomorrowDate);

    // Get status for each daily
    const dailyStatuses: DailyStatus[] = [];

    for (const participant of userDailies) {
      const dailyName = participant.daily_name;

      // Check today's submission
      const todaySubmission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);
      const todaySubmitted = todaySubmission !== null;

      // Check tomorrow's scheduled submission
      let tomorrowScheduled = false;
      if (todaySubmitted) {
        const tomorrowSubmission = await getSubmissionForDate(ctx.db, userId, dailyName, tomorrowStr);
        tomorrowScheduled = tomorrowSubmission !== null && !tomorrowSubmission.posted;
      }

      dailyStatuses.push({
        dailyName,
        todaySubmitted,
        tomorrowScheduled,
      });
    }

    // Build and publish the home view
    const view = buildHomeView(dailyStatuses);
    const published = await publishHomeView(ctx.slackToken, userId, view);

    if (!published) {
      console.error(`Failed to publish home view for user ${userId}`);
      return false;
    }

    console.log(`Published home view for user ${userId} with ${dailyStatuses.length} dailies`);
    return true;
  } catch (error) {
    console.error(`Error handling app_home_opened for user ${userId}:`, error);
    return false;
  }
}

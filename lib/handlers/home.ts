/**
 * App Home handlers for the Home tab
 * Shows user's dailies with "Start Daily" buttons
 */

import { DbClient, getUserDailies, getSubmissionForDate, getPreviousSubmission, Submission, getGitHubUsername, getLinearUserId, setGitHubUsername, setLinearUserId, getDmStandupPreference } from '../db';
import { getDaily, getGitHubConfig, getGitHubUsernameFromConfig, getLinearConfig, getLinearUserIdFromConfig, getLinearTeamIdForUser } from '../config';
import { publishHomeView } from '../slack';
import { formatDate, getUserDate, getUserTimezone } from '../prompt';
import { fetchUserPRData, UserPRData } from '../github';
import { fetchUserLinearData, UserLinearData } from '../linear';

// ============================================================================
// Types
// ============================================================================

export interface HomeContext {
  db: DbClient;
  slackToken: string;
  env?: Record<string, string | undefined>; // For accessing GitHub tokens etc.
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
  submission?: Submission; // Today's submission for stats
  droppedCount?: number; // Items dropped from yesterday
  prData?: UserPRData; // GitHub PR data if integration enabled
  linearData?: UserLinearData; // Linear data if integration enabled
}

export interface LinkedAccounts {
  github: string | null;  // username or null
  linear: string | null;  // user ID or null
  dmStandup: boolean;     // whether DM standup copies are enabled
}

/**
 * Build the App Home view for a user
 */
export function buildHomeView(dailyStatuses: DailyStatus[], linkedAccounts?: LinkedAccounts): unknown {
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

      // Build status line with optional submission stats, PR and Linear info
      let statusLine = `${statusEmoji} ${statusText}`;

      // Submission stats: planned, carried over, dropped
      if (status.submission) {
        const plans = parseJsonArray(status.submission.today_plans);
        const incomplete = parseJsonArray(status.submission.yesterday_incomplete);
        const inProgress = parseJsonArray(status.submission.yesterday_in_progress);
        const totalPlanned = plans.length + incomplete.length + inProgress.length;
        const carriedOver = incomplete.length + inProgress.length;
        const dropped = status.droppedCount || 0;

        if (totalPlanned > 0 || dropped > 0) {
          const parts: string[] = [];
          if (totalPlanned > 0) parts.push(`${totalPlanned} planned`);
          if (carriedOver > 0) parts.push(`${carriedOver} carried over`);
          if (dropped > 0) parts.push(`${dropped} dropped`);
          statusLine += `\n📋 ${parts.join(' · ')}`;
        }
      }

      if (status.prData) {
        const prParts: string[] = [];
        if (status.prData.draftPRs.length > 0) {
          prParts.push(`${status.prData.draftPRs.length} draft`);
        }
        if (status.prData.readyToMerge.length > 0) {
          prParts.push(`${status.prData.readyToMerge.length} ready to merge`);
        }
        if (status.prData.reviewRequests.length > 0) {
          prParts.push(`${status.prData.reviewRequests.length} to review`);
        }
        if (prParts.length > 0) {
          statusLine += `\n📦 ${prParts.join(' · ')}`;
        }
      }
      if (status.linearData && status.linearData.issues.length > 0) {
        const started = status.linearData.issues.filter(i => i.state.type === 'started').length;
        const todo = status.linearData.issues.filter(i => i.state.type !== 'started').length;
        const linearParts: string[] = [];
        if (started > 0) linearParts.push(`${started} in progress`);
        if (todo > 0) linearParts.push(`${todo} to do`);
        statusLine += `\n🎫 ${linearParts.join(', ')} this cycle`;
      }

      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${status.dailyName}*\n${statusLine}`,
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

  // Linked Accounts section
  if (linkedAccounts) {
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '🔗 Linked Accounts',
        emoji: true,
      },
    });

    // GitHub row
    if (linkedAccounts.github) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*GitHub*\n:white_check_mark: @${linkedAccounts.github}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Unlink', emoji: true },
          action_id: 'home_unlink_github',
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*GitHub*\nNot linked',
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Link', emoji: true },
          action_id: 'home_link_github',
        },
      });
    }

    // Linear row
    if (linkedAccounts.linear) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Linear*\n:white_check_mark: ${linkedAccounts.linear}`,
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Unlink', emoji: true },
          action_id: 'home_unlink_linear',
        },
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Linear*\nNot linked',
        },
        accessory: {
          type: 'button',
          text: { type: 'plain_text', text: 'Link', emoji: true },
          action_id: 'home_link_linear',
        },
      });
    }

    // DM preferences
    blocks.push({
      type: 'header',
      text: {
        type: 'plain_text',
        text: '⚙️ Preferences',
        emoji: true,
      },
    });

    const dmStatus = linkedAccounts.dmStandup ? '✅ Enabled' : '❌ Disabled';
    const dmButtonText = linkedAccounts.dmStandup ? 'Disable' : 'Enable';
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*DM standup copy*\n${dmStatus} — get a private copy of your standup when it posts to the channel`,
      },
      accessory: {
        type: 'button',
        text: { type: 'plain_text', text: dmButtonText, emoji: true },
        action_id: 'home_toggle_dm_standup',
      },
    });

    blocks.push({ type: 'divider' });
  }

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

/** Parse JSONB arrays from database (handles both array and string formats) */
function parseJsonArray(value: string[] | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value as unknown as string);
  } catch {
    return [];
  }
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
      const daily = getDaily(dailyName);

      // Check today's submission
      const todaySubmission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);
      const todaySubmitted = todaySubmission !== null;

      // Check tomorrow's scheduled submission
      let tomorrowScheduled = false;
      if (todaySubmitted) {
        const tomorrowSubmission = await getSubmissionForDate(ctx.db, userId, dailyName, tomorrowStr);
        tomorrowScheduled = tomorrowSubmission !== null && !tomorrowSubmission.posted;
      }

      // Fetch GitHub PR data if integration is enabled
      let prData: UserPRData | undefined;
      if (daily && ctx.env) {
        const githubConfig = getGitHubConfig(daily);
        if (githubConfig) {
          const githubToken = ctx.env[githubConfig.tokenEnvVar];
          if (githubToken) {
            // Get GitHub username: config mapping takes precedence over DB
            let githubUsername = getGitHubUsernameFromConfig(daily, userId);
            if (!githubUsername) {
              githubUsername = await getGitHubUsername(ctx.db, userId);
            }

            if (githubUsername) {
              try {
                prData = await fetchUserPRData(githubToken, githubUsername, githubConfig.org);
              } catch (error) {
                console.error(`Failed to fetch PR data for ${userId}:`, error);
              }
            }
          }
        }
      }

      // Fetch Linear data if integration is enabled
      let linearData: UserLinearData | undefined;
      if (daily && ctx.env) {
        const linearConfig = getLinearConfig(daily);
        if (linearConfig) {
          const linearToken = ctx.env[linearConfig.tokenEnvVar];
          if (linearToken) {
            let linearUserId = getLinearUserIdFromConfig(daily, userId);
            if (!linearUserId) {
              linearUserId = await getLinearUserId(ctx.db, userId);
            }

            const teamId = getLinearTeamIdForUser(daily, userId);
            if (linearUserId && teamId) {
              try {
                linearData = await fetchUserLinearData(linearToken, teamId, linearUserId);
              } catch (error) {
                console.error(`Failed to fetch Linear data for ${userId}:`, error);
              }
            }
          }
        }
      }

      // Compute dropped count from previous submission
      let droppedCount: number | undefined;
      if (todaySubmission) {
        const prevSubmission = await getPreviousSubmission(ctx.db, userId, dailyName, todayStr);
        if (prevSubmission) {
          const prevPlans = new Set([
            ...parseJsonArray(prevSubmission.today_plans),
            ...parseJsonArray(prevSubmission.yesterday_incomplete),
            ...parseJsonArray(prevSubmission.yesterday_in_progress),
          ]);
          const accountedFor = new Set([
            ...parseJsonArray(todaySubmission.yesterday_completed),
            ...parseJsonArray(todaySubmission.yesterday_incomplete),
            ...parseJsonArray(todaySubmission.yesterday_in_progress),
          ]);
          droppedCount = [...prevPlans].filter(item => !accountedFor.has(item)).length;
        }
      }

      dailyStatuses.push({
        dailyName,
        todaySubmitted,
        tomorrowScheduled,
        submission: todaySubmission || undefined,
        droppedCount,
        prData,
        linearData,
      });
    }

    // Fetch linked accounts and preferences
    const [githubUsername, linearUserId, dmStandup] = await Promise.all([
      getGitHubUsername(ctx.db, userId),
      getLinearUserId(ctx.db, userId),
      getDmStandupPreference(ctx.db, userId),
    ]);
    const linkedAccounts: LinkedAccounts = {
      github: githubUsername,
      linear: linearUserId,
      dmStandup,
    };

    // Build and publish the home view
    const view = buildHomeView(dailyStatuses, linkedAccounts);
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

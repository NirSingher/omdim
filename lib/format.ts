/**
 * Standup message formatting and channel posting
 * - Formats submissions as Slack Block Kit blocks
 * - Posts formatted standups to channels
 * - Generates daily digests and weekly summaries
 */

import { Submission, ParticipationStats } from './db';
import { postMessage, sendDM as slackSendDM } from './slack';

// Re-export sendDM for backward compatibility
export { sendDM as sendDM } from './slack';

// ============================================================================
// Types
// ============================================================================

interface StandupData {
  yesterdayCompleted: string[];
  yesterdayIncomplete: string[];
  unplanned: string[];
  todayPlans: string[];
  blockers: string;
  customAnswers: Record<string, string>;
}

interface Block {
  type: string;
  text?: {
    type: string;
    text: string;
    emoji?: boolean;
  };
  elements?: Array<{
    type: string;
    text: string;
  }>;
}

// ============================================================================
// Standup Message Formatting
// ============================================================================

/**
 * Format a standup submission as Slack Block Kit blocks
 */
export function formatStandupBlocks(
  userId: string,
  dailyName: string,
  data: StandupData
): Block[] {
  const blocks: Block[] = [];

  // Header with user mention
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*<@${userId}>* submitted their standup`,
    },
  });

  // Yesterday section - completed and unplanned with checkboxes
  const yesterdayItems: string[] = [];

  // Completed items with checked checkbox
  for (const item of data.yesterdayCompleted) {
    yesterdayItems.push(`☑️ ${item}`);
  }

  // Unplanned completions with checked checkbox (they were completed!)
  for (const item of data.unplanned) {
    yesterdayItems.push(`☑️ ${item} _(unplanned)_`);
  }

  if (yesterdayItems.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Yesterday:*\n' + yesterdayItems.join('\n'),
      },
    });
  }

  // Today's plans section - includes carried over items
  const todayItems: string[] = [];

  // Carried over items first (unchecked)
  for (const item of data.yesterdayIncomplete) {
    todayItems.push(`⬜ ${item} _(carried over)_`);
  }

  // Add separator if we have both carried over and new items
  if (data.yesterdayIncomplete.length > 0 && data.todayPlans.length > 0) {
    todayItems.push('───');
  }

  // New plans (unchecked)
  for (const item of data.todayPlans) {
    todayItems.push(`⬜ ${item}`);
  }

  if (todayItems.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Today:*\n' + todayItems.join('\n'),
      },
    });
  }

  // Blockers
  if (data.blockers && data.blockers.trim()) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*🚧 Blockers:*\n${data.blockers}`,
      },
    });
  }

  // Custom answers
  const customEntries = Object.entries(data.customAnswers).filter(([_, v]) => v && v.trim());
  if (customEntries.length > 0) {
    for (const [question, answer] of customEntries) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${question}*\n${answer}`,
        },
      });
    }
  }

  // Context footer
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_${dailyName} standup_`,
      },
    ],
  });

  return blocks;
}

/**
 * Post a formatted standup to a Slack channel
 * @returns Message timestamp if successful, null otherwise
 */
export async function postStandupToChannel(
  slackToken: string,
  channel: string,
  userId: string,
  dailyName: string,
  data: StandupData
): Promise<string | null> {
  const blocks = formatStandupBlocks(userId, dailyName, data);
  const fallbackText = `${dailyName} standup from <@${userId}>`;
  return postMessage(slackToken, channel, fallbackText, blocks);
}

// ============================================================================
// Digest & Summary Formatting
// ============================================================================

/**
 * Format daily digest message (sent via DM)
 */
export function formatDailyDigest(
  dailyName: string,
  date: string,
  submissions: Submission[]
): string {
  if (submissions.length === 0) {
    return `📊 *${dailyName} Digest for ${date}*\n\nNo submissions yet.`;
  }

  const lines: string[] = [`📊 *${dailyName} Digest for ${date}*\n`];

  for (const sub of submissions) {
    lines.push(`*<@${sub.slack_user_id}>*`);

    // Parse JSON arrays
    const completed = parseJsonArray(sub.yesterday_completed);
    const incomplete = parseJsonArray(sub.yesterday_incomplete);
    const unplanned = parseJsonArray(sub.unplanned);
    const plans = parseJsonArray(sub.today_plans);

    // Yesterday summary
    if (completed.length > 0 || unplanned.length > 0) {
      const yesterdayCount = completed.length + unplanned.length;
      lines.push(`  ✅ Completed: ${yesterdayCount} item${yesterdayCount !== 1 ? 's' : ''}`);
    }

    // Today's plans
    if (plans.length > 0 || incomplete.length > 0) {
      const todayCount = plans.length + incomplete.length;
      lines.push(`  📋 Today: ${todayCount} item${todayCount !== 1 ? 's' : ''}`);
    }

    // Blockers
    if (sub.blockers && sub.blockers.trim()) {
      lines.push(`  🚧 *Blocker:* ${sub.blockers.split('\n')[0]}${sub.blockers.includes('\n') ? '...' : ''}`);
    }

    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Format weekly summary message
 */
export function formatWeeklySummary(
  dailyName: string,
  startDate: string,
  endDate: string,
  submissions: Submission[],
  stats: ParticipationStats[]
): string {
  const lines: string[] = [`📈 *${dailyName} Weekly Summary*\n_${startDate} to ${endDate}_\n`];

  // Participation stats
  lines.push('*Participation:*');
  for (const stat of stats) {
    const rate = stat.total_days > 0
      ? Math.round((Number(stat.submission_count) / Number(stat.total_days)) * 100)
      : 0;
    lines.push(`  • <@${stat.slack_user_id}>: ${stat.submission_count}/${stat.total_days} days (${rate}%)`);
  }
  lines.push('');

  // Aggregate blockers
  const blockers: string[] = [];
  for (const sub of submissions) {
    if (sub.blockers && sub.blockers.trim()) {
      blockers.push(`• <@${sub.slack_user_id}> (${sub.date}): ${sub.blockers.split('\n')[0]}`);
    }
  }

  if (blockers.length > 0) {
    lines.push('*Blockers this week:*');
    // Show up to 10 blockers
    for (const blocker of blockers.slice(0, 10)) {
      lines.push(blocker);
    }
    if (blockers.length > 10) {
      lines.push(`_...and ${blockers.length - 10} more_`);
    }
  } else {
    lines.push('*Blockers this week:* None reported 🎉');
  }

  return lines.join('\n');
}

// ============================================================================
// Helpers
// ============================================================================

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

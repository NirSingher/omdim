/**
 * Standup message formatting and channel posting
 * - Formats submissions as Slack Block Kit blocks
 * - Posts formatted standups to channels
 * - Generates daily digests and weekly summaries
 */

import { Submission, ParticipationStats, TeamMemberStats, BottleneckItem, DropStats, TeamMemberRanking, PeriodStats } from './db';
import { postMessage, sendDM as slackSendDM } from './slack';

// Re-export sendDM for backward compatibility
export { sendDM as sendDM } from './slack';

// ============================================================================
// Types
// ============================================================================

interface QuestionConfig {
  text: string;
  order?: number;
}

interface FieldOrder {
  unplanned?: number;
  today_plans?: number;
  blockers?: number;
}

interface StandupData {
  yesterdayCompleted: string[];
  yesterdayIncomplete: string[];
  unplanned: string[];
  todayPlans: string[];
  blockers: string;
  customAnswers: Record<string, string>;
  questions?: QuestionConfig[];
  fieldOrder?: FieldOrder;
}

// Default field order values
const DEFAULT_FIELD_ORDER = {
  yesterday: 10,  // Combined completed + unplanned
  today: 20,      // Combined carried + new plans
  blockers: 30,
};

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
 * Respects field_order config for positioning custom questions
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

  // Get field order (use field_order.unplanned for yesterday section)
  const fieldOrder = data.fieldOrder || {};
  const yesterdayOrder = fieldOrder.unplanned ?? DEFAULT_FIELD_ORDER.yesterday;
  const todayOrder = fieldOrder.today_plans ?? DEFAULT_FIELD_ORDER.today;
  const blockersOrder = fieldOrder.blockers ?? DEFAULT_FIELD_ORDER.blockers;

  // Build ordered sections
  interface OrderedSection {
    order: number;
    render: () => Block | null;
  }

  const sections: OrderedSection[] = [];

  // Yesterday section - completed and unplanned with checkboxes
  sections.push({
    order: yesterdayOrder,
    render: () => {
      const yesterdayItems: string[] = [];
      for (const item of data.yesterdayCompleted) {
        yesterdayItems.push(`☑️ ${item}`);
      }
      for (const item of data.unplanned) {
        yesterdayItems.push(`☑️ ${item} _(unplanned)_`);
      }
      if (yesterdayItems.length === 0) return null;
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Yesterday:*\n' + yesterdayItems.join('\n') },
      };
    },
  });

  // Today's plans section - includes carried over items
  sections.push({
    order: todayOrder,
    render: () => {
      const todayItems: string[] = [];
      for (const item of data.yesterdayIncomplete) {
        todayItems.push(`⬜ ${item} _(carried over)_`);
      }
      if (data.yesterdayIncomplete.length > 0 && data.todayPlans.length > 0) {
        todayItems.push('───');
      }
      for (const item of data.todayPlans) {
        todayItems.push(`⬜ ${item}`);
      }
      if (todayItems.length === 0) return null;
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Today:*\n' + todayItems.join('\n') },
      };
    },
  });

  // Blockers section
  sections.push({
    order: blockersOrder,
    render: () => {
      if (!data.blockers || !data.blockers.trim()) return null;
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: `*🚧 Blockers:*\n${data.blockers}` },
      };
    },
  });

  // Custom question sections
  const customEntries = Object.entries(data.customAnswers).filter(([_, v]) => v && v.trim());
  for (const [question, answer] of customEntries) {
    const questionConfig = data.questions?.find(q => q.text === question);
    const order = questionConfig?.order ?? 999;
    sections.push({
      order,
      render: () => ({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${question}*\n${answer}` },
      }),
    });
  }

  // Sort by order and render
  sections.sort((a, b) => a.order - b.order);
  for (const section of sections) {
    const block = section.render();
    if (block) {
      blocks.push(block);
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

  // Aggregate blockers - each line is a separate blocker
  const blockers: string[] = [];
  for (const sub of submissions) {
    if (sub.blockers && sub.blockers.trim()) {
      const blockerLines = sub.blockers.split('\n').filter(line => line.trim());
      for (const line of blockerLines) {
        blockers.push(`• <@${sub.slack_user_id}> (${sub.date}): ${line.trim()}`);
      }
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
// Manager Digest Formatting
// ============================================================================

export type DigestPeriod = 'daily' | 'weekly' | '4-week';

export interface TrendData {
  current: PeriodStats;
  previous: PeriodStats;
}

export interface IntegrationStatus {
  github: boolean;
  linear: boolean;
}

export interface DigestOptions {
  dailyName: string;
  period: DigestPeriod;
  startDate: string;
  endDate: string;
  submissions: Submission[];
  stats: TeamMemberStats[];
  totalWorkdays: number;
  missingToday?: string[];
  bottlenecks?: BottleneckItem[];
  dropStats?: DropStats[];
  rankings?: TeamMemberRanking[];
  trends?: TrendData;
  integrations?: IntegrationStatus;
}

/**
 * Format a comprehensive manager digest with full team stats
 */
export function formatManagerDigest(options: DigestOptions): string {
  const { dailyName, period, startDate, endDate, submissions, stats, totalWorkdays, missingToday, bottlenecks, dropStats, rankings, trends, integrations } = options;

  const periodLabel = period === 'daily' ? 'Daily'
    : period === 'weekly' ? 'Weekly'
    : '4-Week';

  const dateRange = period === 'daily'
    ? endDate
    : `${startDate} to ${endDate}`;

  const lines: string[] = [];

  // Header
  lines.push(`📊 *${dailyName} ${periodLabel} Digest*`);
  lines.push(`_${dateRange}_\n`);

  // Summary stats
  const totalSubmissions = submissions.length;
  const uniqueSubmitters = new Set(submissions.map(s => s.slack_user_id)).size;
  const totalParticipants = stats.length;

  lines.push(`*Summary:*`);
  lines.push(`• ${totalSubmissions} submissions from ${uniqueSubmitters}/${totalParticipants} team members`);

  if (totalWorkdays > 0) {
    // Show participation rate with trend indicator if trends available
    if (trends && trends.previous.total_submissions > 0) {
      // Use trends data for consistent period comparison
      const participationTrend = formatTrend(trends.current.participation_rate, trends.previous.participation_rate, '%', true);
      lines.push(`• Participation: ${participationTrend}`);

      // Show completion rate trend (only for weekly/4-week with enough data)
      if (period !== 'daily' && trends.current.total_items_completed + trends.current.total_items_dropped > 0) {
        const completionTrend = formatTrend(trends.current.completion_rate, trends.previous.completion_rate, '%', true);
        lines.push(`• Completion: ${completionTrend}`);
      }

      // Show blocker rate trend (lower is better)
      if (trends.previous.blocker_rate > 0 || trends.current.blocker_rate > 0) {
        const blockerTrend = formatTrend(trends.current.blocker_rate, trends.previous.blocker_rate, '%', false);
        lines.push(`• Blockers: ${blockerTrend}`);
      }
    } else {
      const avgRate = totalParticipants > 0
        ? Math.round((totalSubmissions / (totalWorkdays * totalParticipants)) * 100)
        : 0;
      lines.push(`• ${avgRate}% overall participation rate`);
    }
  }

  // Count blockers (only if not showing trend version)
  if (!trends || trends.previous.total_submissions === 0) {
    // Count individual blocker lines, not just submissions with blockers
    const blockersCount = submissions.reduce((count, s) => {
      if (s.blockers && s.blockers.trim()) {
        return count + s.blockers.split('\n').filter(line => line.trim()).length;
      }
      return count;
    }, 0);
    if (blockersCount > 0) {
      lines.push(`• ⚠️ ${blockersCount} blocker${blockersCount !== 1 ? 's' : ''} reported`);
    }
  }
  lines.push('');

  // Missing submissions (for daily only)
  if (period === 'daily' && missingToday && missingToday.length > 0) {
    lines.push(`*Not yet submitted:*`);
    for (const userId of missingToday) {
      lines.push(`• <@${userId}>`);
    }
    lines.push('');
  }

  // Rankings section (for weekly and 4-week only - too noisy for daily)
  if ((period === 'weekly' || period === '4-week') && rankings && rankings.length > 0) {
    lines.push(`*🏆 Team Rankings:*`);
    for (const r of rankings.slice(0, 5)) {
      const medal = r.rank === 1 ? '🥇' : r.rank === 2 ? '🥈' : r.rank === 3 ? '🥉' : `${r.rank}.`;
      const warning = r.drop_rate > 30 ? ' ⚠️' : '';
      lines.push(`${medal} <@${r.slack_user_id}> (${r.score} pts) - ${r.participation_rate}% participation, ${r.completion_rate}% completion${warning}`);
    }
    if (rankings.length > 5) {
      lines.push(`_...and ${rankings.length - 5} more_`);
    }
    lines.push('');
  }

  // Team member breakdown
  lines.push(`*Team Performance:*`);
  for (const member of stats) {
    const rate = totalWorkdays > 0
      ? Math.round((Number(member.submission_count) / totalWorkdays) * 100)
      : 0;
    const emoji = rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴';

    lines.push(`${emoji} <@${member.slack_user_id}>: ${member.submission_count}/${totalWorkdays} days (${rate}%)`);
    if (Number(member.total_completed) > 0 || Number(member.total_planned) > 0) {
      lines.push(`    ✅ ${member.total_completed} completed • 📋 ${member.total_planned} planned • ${member.avg_items_per_day}/day avg`);
    }
    if (Number(member.total_blockers) > 0) {
      lines.push(`    ⚠️ ${member.total_blockers} days with blockers`);
    }
  }
  lines.push('');

  // Bottlenecks section
  const hasBottlenecks = bottlenecks && bottlenecks.length > 0;
  const hasHighDropUsers = dropStats && dropStats.length > 0;

  if (hasBottlenecks || hasHighDropUsers) {
    lines.push(`*🔥 Bottlenecks:*`);

    // High-carry items
    if (hasBottlenecks) {
      lines.push(`_Carried 3+ days:_`);
      for (const item of bottlenecks!.slice(0, 5)) {
        lines.push(`• <@${item.slack_user_id}>: "${truncate(item.text, 40)}" _(${item.days_pending} days, carried ${item.carry_count}x)_`);
      }
      if (bottlenecks!.length > 5) {
        lines.push(`  _...and ${bottlenecks!.length - 5} more_`);
      }
    }

    // High drop rate users
    if (hasHighDropUsers) {
      lines.push(`_High drop rate (>30%):_`);
      for (const user of dropStats!.slice(0, 3)) {
        lines.push(`• <@${user.slack_user_id}>: ${user.dropped_count}/${user.total_items} items dropped (${user.drop_rate}%)`);
      }
    }

    lines.push('');
  }

  // Blockers detail (show recent ones) - each line is a separate blocker
  const blockers: string[] = [];
  for (const sub of submissions) {
    if (sub.blockers && sub.blockers.trim()) {
      const blockerLines = sub.blockers.split('\n').filter(line => line.trim());
      for (const line of blockerLines) {
        blockers.push(`• <@${sub.slack_user_id}> (${sub.date}): ${line.trim()}`);
      }
    }
  }

  if (blockers.length > 0) {
    lines.push(`*Blockers:*`);
    // Show up to 5 for daily, 10 for weekly, all for 4-week
    const limit = period === 'daily' ? 5 : period === 'weekly' ? 10 : 20;
    for (const blocker of blockers.slice(0, limit)) {
      lines.push(blocker);
    }
    if (blockers.length > limit) {
      lines.push(`_...and ${blockers.length - limit} more_`);
    }
  } else {
    lines.push(`*Blockers:* None reported 🎉`);
  }

  // Work Alignment section (placeholder for GitHub/Linear integration)
  if (integrations) {
    lines.push('');
    if (integrations.github || integrations.linear) {
      const enabled: string[] = [];
      if (integrations.github) enabled.push('GitHub');
      if (integrations.linear) enabled.push('Linear');
      lines.push(`*🔗 Work Alignment:* _${enabled.join(' + ')} enabled_`);
      // Future: Show actual alignment data here
    } else {
      lines.push(`*🔗 Work Alignment:* _Not configured_`);
    }
  }

  return lines.join('\n');
}

/** Truncate text to a maximum length */
function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

// ============================================================================
// Bottleneck Snooze Blocks
// ============================================================================

interface SlackBlock {
  type: string;
  text?: { type: string; text: string; emoji?: boolean };
  accessory?: {
    type: string;
    text?: { type: string; text: string; emoji?: boolean };
    action_id?: string;
    value?: string;
  };
  elements?: Array<{ type: string; text: string }>;
}

/**
 * Build Block Kit blocks for bottleneck items with snooze buttons
 * Only includes items that can be snoozed (not already snoozed)
 */
export function buildBottleneckBlocks(
  bottlenecks: BottleneckItem[],
  dailyName: string
): SlackBlock[] {
  if (bottlenecks.length === 0) return [];

  const blocks: SlackBlock[] = [];

  // Header
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*🔥 Bottleneck Items - Snooze Options*',
    },
  });

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '_Click "Snooze 7d" to hide an item from bottleneck reports for 7 days_',
      },
    ],
  });

  // Add each bottleneck with a snooze button (max 5)
  for (const item of bottlenecks.slice(0, 5)) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `• <@${item.slack_user_id}>: "${truncate(item.text, 50)}" _(${item.days_pending} days, carried ${item.carry_count}x)_`,
      },
      accessory: {
        type: 'button',
        text: {
          type: 'plain_text',
          text: 'Snooze 7d',
          emoji: true,
        },
        action_id: 'snooze_bottleneck',
        value: JSON.stringify({ itemId: item.id, dailyName }),
      },
    });
  }

  if (bottlenecks.length > 5) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `_...and ${bottlenecks.length - 5} more bottleneck items_`,
        },
      ],
    });
  }

  return blocks;
}

/**
 * Get trend indicator comparing current to previous value
 * Returns ↑ (improved), ↓ (declined), or → (stable)
 * @param current Current period value
 * @param previous Previous period value
 * @param higherIsBetter If true, higher values show ↑; if false, lower values show ↑
 * @param threshold Minimum % change to show an arrow (default 5%)
 */
function getTrendIndicator(
  current: number,
  previous: number,
  higherIsBetter: boolean = true,
  threshold: number = 5
): string {
  if (previous === 0) return '';

  const diff = current - previous;
  const percentChange = Math.abs(diff / previous) * 100;

  // If change is below threshold, consider stable
  if (percentChange < threshold) {
    return '→';
  }

  const isUp = diff > 0;
  const isGood = higherIsBetter ? isUp : !isUp;

  return isGood ? '↑' : '↓';
}

/**
 * Format trend string with indicator
 * @param current Current value
 * @param previous Previous value
 * @param unit Unit to display (e.g., '%')
 * @param higherIsBetter If true, higher values are better
 */
function formatTrend(
  current: number,
  previous: number,
  unit: string = '%',
  higherIsBetter: boolean = true
): string {
  const indicator = getTrendIndicator(current, previous, higherIsBetter);
  if (!indicator || previous === 0) {
    return `${current}${unit}`;
  }
  return `${current}${unit} ${indicator}`;
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

/**
 * Standup message formatting and channel posting
 * - Formats submissions as Slack Block Kit blocks
 * - Posts formatted standups to channels
 * - Generates daily digests and weekly summaries
 */

import { Submission, ParticipationStats, TeamMemberStats, BottleneckItem, DropStats, TeamMemberRanking, PeriodStats } from './db';
import { postMessage, sendDM as slackSendDM } from './slack';
import { UserPRData, GitHubPR, formatPRRef, TeamPRData } from './github';
import { TeamLinearData, CycleProgress } from './linear';

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
  yesterdayInProgress?: string[];
  yesterdayDropped: string[];
  unplanned: string[];
  todayPlans: string[];
  blockers: string;
  customAnswers: Record<string, string>;
  questions?: QuestionConfig[];
  fieldOrder?: FieldOrder;
  prData?: UserPRData; // GitHub PR data for integration
  inProgressCarryCounts?: Record<string, number>; // carry counts for attention warnings
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

  // Yesterday section - completed, unplanned, and dropped items
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
      for (const item of data.yesterdayDropped || []) {
        yesterdayItems.push(`❌ ${item} _(dropped)_`);
      }
      if (yesterdayItems.length === 0) return null;
      return {
        type: 'section',
        text: { type: 'mrkdwn', text: '*Yesterday:*\n' + yesterdayItems.join('\n') },
      };
    },
  });

  // Today's plans section - includes in-progress and carried over items
  sections.push({
    order: todayOrder,
    render: () => {
      const todayItems: string[] = [];
      // In-progress items first
      for (const item of data.yesterdayInProgress || []) {
        const carryCount = data.inProgressCarryCounts?.[item] || 0;
        const emoji = carryCount >= 3 ? '⚠️' : '🔄';
        todayItems.push(`${emoji} ${item} _(in progress)_`);
      }
      for (const item of data.yesterdayIncomplete) {
        todayItems.push(`⬜ ${item} _(carried over)_`);
      }
      const carryForwardCount = (data.yesterdayInProgress || []).length + data.yesterdayIncomplete.length;
      if (carryForwardCount > 0 && data.todayPlans.length > 0) {
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

  // PR section (if data available)
  if (data.prData) {
    const prBlock = formatPRSectionBlock(data.prData);
    if (prBlock) {
      blocks.push(prBlock);
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
    const inProgress = parseJsonArray(sub.yesterday_in_progress);
    const unplanned = parseJsonArray(sub.unplanned);
    const plans = parseJsonArray(sub.today_plans);

    // Yesterday summary
    if (completed.length > 0 || unplanned.length > 0) {
      const yesterdayCount = completed.length + unplanned.length;
      lines.push(`  ✅ Completed: ${yesterdayCount} item${yesterdayCount !== 1 ? 's' : ''}`);
    }

    // In-progress items
    if (inProgress.length > 0) {
      lines.push(`  🔄 In progress: ${inProgress.length} item${inProgress.length !== 1 ? 's' : ''}`);
    }

    // Today's plans (carried + in-progress + new)
    if (plans.length > 0 || incomplete.length > 0 || inProgress.length > 0) {
      const todayCount = plans.length + incomplete.length + inProgress.length;
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
  teamPRData?: TeamPRData[]; // GitHub PR data for team
  teamLinearData?: TeamLinearData[]; // Linear data for team
  cycleProgress?: CycleProgress | null; // Linear cycle progress
}

/**
 * Format a compact manager digest (Option C: Priority-First)
 * Lead with action items, compact team summary, no noise
 */
export function formatManagerDigest(options: DigestOptions): string {
  const { dailyName, period, startDate, endDate, submissions, stats, totalWorkdays, missingToday, bottlenecks, dropStats, trends } = options;

  const periodLabel = period === 'daily' ? 'Daily'
    : period === 'weekly' ? 'Weekly'
    : '4-Week';

  // Format date range compactly
  const formatShortDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const dateRange = period === 'daily'
    ? formatShortDate(endDate)
    : `${formatShortDate(startDate)}-${formatShortDate(endDate)}`;

  const lines: string[] = [];
  const totalParticipants = stats.length;

  // Compact header
  lines.push(`📊 *${dailyName} ${periodLabel}* · ${dateRange}`);
  lines.push('');

  // Stats line (inline)
  const statParts: string[] = [];
  if (totalWorkdays > 0 && totalParticipants > 0) {
    if (trends && trends.previous.total_submissions > 0) {
      const participationTrend = formatTrendCompact(trends.current.participation_rate, trends.previous.participation_rate, true);
      statParts.push(`${participationTrend} participation`);
      if (period !== 'daily' && trends.current.total_items_completed + trends.current.total_items_dropped > 0) {
        const completionTrend = formatTrendCompact(trends.current.completion_rate, trends.previous.completion_rate, true);
        statParts.push(`${completionTrend} completion`);
      }
    } else {
      const avgRate = Math.round((submissions.length / (totalWorkdays * totalParticipants)) * 100);
      statParts.push(`${avgRate}% participation`);
    }
  }
  if (statParts.length > 0) {
    lines.push(statParts.join(' · '));
  }

  // Collect all action items
  const actionItems: string[] = [];

  // Stuck items (bottlenecks)
  if (bottlenecks && bottlenecks.length > 0) {
    for (const item of bottlenecks.slice(0, 3)) {
      actionItems.push(`🔥 <@${item.slack_user_id}>: "${truncate(item.text, 35)}" stuck ${item.days_pending} days`);
    }
  }

  // Blockers
  for (const sub of submissions) {
    if (sub.blockers && sub.blockers.trim()) {
      const blockerLines = sub.blockers.split('\n').filter(line => line.trim());
      for (const line of blockerLines.slice(0, 2)) {
        actionItems.push(`🚧 <@${sub.slack_user_id}>: ${truncate(line.trim(), 40)}`);
      }
      if (blockerLines.length > 2) {
        actionItems.push(`🚧 <@${sub.slack_user_id}>: _(${blockerLines.length - 2} more)_`);
        break; // Don't flood with blockers from one person
      }
    }
    if (actionItems.length >= 6) break; // Cap total action items
  }

  // Needs Attention section (only if there are action items)
  if (actionItems.length > 0) {
    lines.push('');
    lines.push(`⚠️ *Needs Attention*`);
    for (const item of actionItems.slice(0, 6)) {
      lines.push(item);
    }
  }

  // Missing submissions (for daily only)
  if (period === 'daily' && missingToday && missingToday.length > 0) {
    lines.push('');
    lines.push(`*Not submitted:* ${missingToday.map(u => `<@${u}>`).join(' · ')}`);
  }

  // Compact team section
  lines.push('');
  lines.push(`👥 *Team*`);

  // Build drop rate lookup for quick access
  const dropRateMap = new Map<string, number>();
  if (dropStats) {
    for (const ds of dropStats) {
      dropRateMap.set(ds.slack_user_id, ds.drop_rate);
    }
  }

  for (const member of stats) {
    const rate = totalWorkdays > 0
      ? Math.round((Number(member.submission_count) / totalWorkdays) * 100)
      : 0;
    const emoji = rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴';
    const completed = Number(member.total_completed);

    let line = `${emoji} <@${member.slack_user_id}> ${member.submission_count}/${totalWorkdays}`;
    if (completed > 0) {
      line += ` (${completed} done)`;
    }

    // Add drop rate warning if high
    const dropRate = dropRateMap.get(member.slack_user_id);
    if (dropRate && dropRate > 30) {
      line += ` — ${dropRate}% drops`;
    }

    lines.push(line);
  }

  // PR section (if GitHub integration data available)
  if (options.teamPRData && options.teamPRData.length > 0) {
    const prSection = formatPRDigestSection(options.teamPRData);
    if (prSection) {
      lines.push(prSection);
    }
  }

  // Linear cycle section (if Linear integration data available)
  if (options.cycleProgress) {
    const linearSection = formatLinearDigestSection(options.teamLinearData || [], options.cycleProgress);
    if (linearSection) {
      lines.push(linearSection);
    }
  }

  // Footer with report hint (only for weekly/4-week)
  if (period !== 'daily') {
    lines.push('');
    lines.push(`_Details: \`/standup report ${dailyName} ${period === 'weekly' ? 'week' : 'month'}\`_`);
  }

  return lines.join('\n');
}

/**
 * Format trend compactly: "80% ↑" or "80%"
 */
function formatTrendCompact(
  current: number,
  previous: number,
  higherIsBetter: boolean = true
): string {
  const indicator = getTrendIndicator(current, previous, higherIsBetter);
  if (!indicator || previous === 0) {
    return `${current}%`;
  }
  return `${current}% ${indicator}`;
}

// ============================================================================
// Full Report Formatting (for /standup report command)
// ============================================================================

export interface FullReportOptions {
  dailyName: string;
  period: DigestPeriod;
  startDate: string;
  endDate: string;
  submissions: Submission[];
  stats: TeamMemberStats[];
  totalWorkdays: number;
  bottlenecks?: BottleneckItem[];
  dropStats?: DropStats[];
  trends?: TrendData;
}

/**
 * Format a detailed report with individual member breakdowns
 * Used by /standup report command
 */
export function formatFullReport(options: FullReportOptions): string {
  const { dailyName, period, startDate, endDate, submissions, stats, totalWorkdays, bottlenecks, dropStats, trends } = options;

  // Format date range
  const formatShortDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  const dateRange = period === 'daily'
    ? formatShortDate(endDate)
    : `${formatShortDate(startDate)}-${formatShortDate(endDate)}`;

  const lines: string[] = [];

  // Header
  lines.push(`📋 *${dailyName} Full Report* · ${dateRange}`);
  lines.push('');

  // Build lookup maps
  const bottleneckMap = new Map<string, BottleneckItem[]>();
  if (bottlenecks) {
    for (const b of bottlenecks) {
      const existing = bottleneckMap.get(b.slack_user_id) || [];
      existing.push(b);
      bottleneckMap.set(b.slack_user_id, existing);
    }
  }

  const dropRateMap = new Map<string, DropStats>();
  if (dropStats) {
    for (const ds of dropStats) {
      dropRateMap.set(ds.slack_user_id, ds);
    }
  }

  const blockerMap = new Map<string, Array<{ date: string; text: string }>>();
  for (const sub of submissions) {
    if (sub.blockers && sub.blockers.trim()) {
      const blockerLines = sub.blockers.split('\n').filter(line => line.trim());
      const existing = blockerMap.get(sub.slack_user_id) || [];
      for (const line of blockerLines) {
        existing.push({ date: sub.date, text: line.trim() });
      }
      blockerMap.set(sub.slack_user_id, existing);
    }
  }

  // Calculate completion rate per user from submissions
  const completionMap = new Map<string, { completed: number; total: number }>();
  for (const sub of submissions) {
    const completed = parseJsonArray(sub.yesterday_completed);
    const incomplete = parseJsonArray(sub.yesterday_incomplete);
    const unplanned = parseJsonArray(sub.unplanned);

    const existing = completionMap.get(sub.slack_user_id) || { completed: 0, total: 0 };
    existing.completed += completed.length + unplanned.length;
    existing.total += completed.length + unplanned.length + incomplete.length;
    completionMap.set(sub.slack_user_id, existing);
  }

  // Individual member sections
  for (const member of stats) {
    const userId = member.slack_user_id;
    const rate = totalWorkdays > 0
      ? Math.round((Number(member.submission_count) / totalWorkdays) * 100)
      : 0;
    const emoji = rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴';
    const completed = Number(member.total_completed);
    const planned = Number(member.total_planned);

    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push('');
    lines.push(`*<@${userId}>* ${emoji}`);
    lines.push(`Participation: ${member.submission_count}/${totalWorkdays} days (${rate}%)`);

    if (completed > 0 || planned > 0) {
      lines.push(`Items: ${completed} completed · ${planned} planned · ${member.avg_items_per_day}/day avg`);
    }

    // Completion rate
    const completionData = completionMap.get(userId);
    if (completionData && completionData.total > 0) {
      const completionRate = Math.round((completionData.completed / completionData.total) * 100);
      lines.push(`Completion rate: ${completionRate}%`);
    }

    // Drop rate warning
    const dropData = dropRateMap.get(userId);
    if (dropData && dropData.drop_rate > 30) {
      lines.push(`Drop rate: ${dropData.drop_rate}% ⚠️`);
    }

    // Blockers
    const userBlockers = blockerMap.get(userId);
    if (userBlockers && userBlockers.length > 0) {
      lines.push(`Blockers: ${userBlockers.length} day${userBlockers.length !== 1 ? 's' : ''}`);
      for (const b of userBlockers.slice(0, 3)) {
        const shortDate = formatShortDate(b.date);
        lines.push(`  • ${shortDate}: ${truncate(b.text, 45)}`);
      }
      if (userBlockers.length > 3) {
        lines.push(`  _...and ${userBlockers.length - 3} more_`);
      }
    } else {
      lines.push(`Blockers: 0 days`);
    }

    // Stuck items
    const userBottlenecks = bottleneckMap.get(userId);
    if (userBottlenecks && userBottlenecks.length > 0) {
      lines.push('');
      lines.push(`Stuck items:`);
      for (const item of userBottlenecks.slice(0, 3)) {
        lines.push(`  🔥 "${truncate(item.text, 40)}" (${item.days_pending} days, carried ${item.carry_count}x)`);
      }
      if (userBottlenecks.length > 3) {
        lines.push(`  _...and ${userBottlenecks.length - 3} more_`);
      }
    }

    lines.push('');
  }

  // Period trends at bottom
  if (trends && trends.previous.total_submissions > 0) {
    lines.push(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    lines.push('');
    lines.push(`*Period Trends*`);
    const participationTrend = formatTrendCompact(trends.current.participation_rate, trends.previous.participation_rate, true);
    lines.push(`Participation: ${participationTrend}`);
    const completionTrend = formatTrendCompact(trends.current.completion_rate, trends.previous.completion_rate, true);
    lines.push(`Completion: ${completionTrend}`);
    const blockerTrend = formatTrendCompact(trends.current.blocker_rate, trends.previous.blocker_rate, false);
    lines.push(`Blockers: ${blockerTrend}`);
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
// GitHub PR Formatting
// ============================================================================

/**
 * Format PR section block for standup messages
 * Shows draft PRs, ready-to-merge PRs, and review requests
 */
function formatPRSectionBlock(prData: UserPRData): Block | null {
  const lines: string[] = [];

  // Draft PRs
  if (prData.draftPRs.length > 0) {
    lines.push('*Draft:*');
    for (const pr of prData.draftPRs.slice(0, 3)) {
      const ref = formatPRRef(pr);
      lines.push(`• \`${ref}\` ${pr.title.length > 40 ? pr.title.slice(0, 37) + '...' : pr.title}`);
    }
    if (prData.draftPRs.length > 3) {
      lines.push(`  _...and ${prData.draftPRs.length - 3} more_`);
    }
  }

  // Ready to merge (approved)
  if (prData.readyToMerge.length > 0) {
    lines.push('*Ready to merge:*');
    for (const pr of prData.readyToMerge.slice(0, 3)) {
      const ref = formatPRRef(pr);
      lines.push(`• \`${ref}\` ✅ approved`);
    }
    if (prData.readyToMerge.length > 3) {
      lines.push(`  _...and ${prData.readyToMerge.length - 3} more_`);
    }
  }

  // Review requests (to review)
  if (prData.reviewRequests.length > 0) {
    lines.push('*To review:*');
    for (const pr of prData.reviewRequests.slice(0, 3)) {
      const ref = formatPRRef(pr);
      lines.push(`• \`${ref}\` by @${pr.author}`);
    }
    if (prData.reviewRequests.length > 3) {
      lines.push(`  _...and ${prData.reviewRequests.length - 3} more_`);
    }
  }

  if (lines.length === 0) return null;

  return {
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*📦 PRs:*\n' + lines.join('\n'),
    },
  };
}

/**
 * Format PR summary for manager digest
 * Shows team-wide PR stats across 3 categories
 */
export function formatPRDigestSection(teamPRData: TeamPRData[]): string {
  const lines: string[] = [];

  // Calculate totals
  let totalDrafts = 0;
  let totalReadyToMerge = 0;
  let totalReviewRequests = 0;

  for (const member of teamPRData) {
    totalDrafts += member.data.draftPRs.length;
    totalReadyToMerge += member.data.readyToMerge.length;
    totalReviewRequests += member.data.reviewRequests.length;
  }

  if (totalDrafts === 0 && totalReadyToMerge === 0 && totalReviewRequests === 0) {
    return '';
  }

  lines.push('');
  lines.push('*📦 PR Activity*');

  const statParts: string[] = [];
  if (totalDrafts > 0) {
    statParts.push(`${totalDrafts} draft`);
  }
  if (totalReadyToMerge > 0) {
    statParts.push(`${totalReadyToMerge} ready to merge`);
  }
  if (totalReviewRequests > 0) {
    statParts.push(`${totalReviewRequests} to review`);
  }
  lines.push(statParts.join(' · '));

  // Show specific users with many open PRs or reviews
  for (const member of teamPRData) {
    const drafts = member.data.draftPRs.length;
    const ready = member.data.readyToMerge.length;
    const reviews = member.data.reviewRequests.length;

    if (drafts + ready >= 3 || reviews >= 3) {
      const parts: string[] = [];
      if (drafts > 0) parts.push(`${drafts} draft`);
      if (ready > 0) parts.push(`${ready} ready`);
      if (reviews >= 3) parts.push(`${reviews} to review`);
      lines.push(`  ⚠️ <@${member.slackUserId}>: ${parts.join(', ')}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format PR summary for individual member in full report
 */
export function formatMemberPRSummary(prData: UserPRData): string {
  const parts: string[] = [];

  if (prData.draftPRs.length > 0) {
    parts.push(`${prData.draftPRs.length} draft`);
  }
  if (prData.readyToMerge.length > 0) {
    parts.push(`${prData.readyToMerge.length} ready`);
  }
  if (prData.reviewRequests.length > 0) {
    parts.push(`${prData.reviewRequests.length} to review`);
  }

  return parts.join(' · ');
}

// ============================================================================
// Linear Digest Formatting
// ============================================================================

/**
 * Format Linear cycle progress section for manager digest
 */
export function formatLinearDigestSection(
  teamData: TeamLinearData[],
  cycleProgress: CycleProgress
): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`*🎫 Cycle: ${cycleProgress.cycleName}*`);

  // Date range
  const formatShort = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };
  lines.push(`${formatShort(cycleProgress.startDate)} – ${formatShort(cycleProgress.endDate)}`);

  // Progress bar
  const total = cycleProgress.done + cycleProgress.inProgress + cycleProgress.todo;
  lines.push(`${cycleProgress.completionPct}% complete · ${cycleProgress.done} done · ${cycleProgress.inProgress} in progress · ${cycleProgress.todo} to do`);

  // Per-member breakdown (only if there are team members with issues)
  const membersWithIssues = teamData.filter((m) => m.data.issues.length > 0);
  if (membersWithIssues.length > 0) {
    for (const member of membersWithIssues) {
      const issues = member.data.issues;
      const started = issues.filter((i) => i.state.type === 'started').length;
      const unstarted = issues.filter((i) => i.state.type !== 'started').length;
      const parts: string[] = [];
      if (started > 0) parts.push(`${started} in progress`);
      if (unstarted > 0) parts.push(`${unstarted} to do`);
      lines.push(`  <@${member.slackUserId}>: ${parts.join(', ')}`);
    }
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

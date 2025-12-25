/**
 * Slash command handlers for /standup command
 * Handles: help, prompt, add, remove, list, digest, week
 */

import { getDailies, getDaily, getSchedule, isAdmin, getConfigError, getBottleneckThreshold } from '../config';
import { DbClient, addParticipant, removeParticipant, getParticipants, getSubmissionsForDate, getSubmissionsInRange, getParticipationStats, getUserDailies, getTeamStats, getMissingSubmissions, countWorkdays, getBottleneckItems, getHighDropUsers, getPeriodStats, setOOO, clearOOO, getUserOOO, getActiveOOOForDaily, OOORecord } from '../db';
import { formatDailyDigest, formatWeeklySummary, formatManagerDigest, formatFullReport, DigestPeriod, TrendData } from '../format';
import { formatDate, getUserDate, getUserTimezone, sendPromptDM } from '../prompt';
import { parseUserId, ephemeralResponse, sendDM, SlackCommandResponse } from '../slack';

// ============================================================================
// Types
// ============================================================================

export interface CommandContext {
  userId: string;
  args: string[];
  db: DbClient;
  slackToken: string;
  devMode?: boolean;
}

/** Re-export for convenience */
export type CommandResponse = SlackCommandResponse;

// ============================================================================
// Helpers
// ============================================================================

/** Check if daily name is the special 'all' keyword */
function isAllDailies(dailyName: string): boolean {
  return dailyName.toLowerCase() === 'all';
}

// ============================================================================
// Command Handlers
// ============================================================================

/** Show help message */
export function handleHelp(): CommandResponse {
  return ephemeralResponse(
    '*Omdim Commands*\n\n' +
    '`/standup help` - Show this help message\n' +
    '`/standup prompt [daily|all]` - Send standup prompt(s) to your DMs\n' +
    '`/standup ooo [tomorrow|clear|dates]` - Manage out of office\n' +
    '`/standup add @user <daily-name>` - Add user to a daily (admin only)\n' +
    '`/standup remove @user <daily-name>` - Remove user from a daily (admin only)\n' +
    '`/standup list [daily|all]` - List participants in a daily\n' +
    '`/standup digest <daily|all> [period]` - Get team summary (DM)\n' +
    '`/standup report <daily|all> [period]` - Get detailed team report (DM)\n' +
    '    _period: `day` (default), `week`, `month`_\n' +
    '    _Use `all` to run for all dailies_'
  );
}

/** Add a user to a daily (admin only) */
export async function handleAdd(ctx: CommandContext): Promise<CommandResponse> {
  if (!isAdmin(ctx.userId)) {
    return ephemeralResponse('❌ Only admins can add users.');
  }

  const addUserId = parseUserId(ctx.args[1] || '');
  const addDailyName = ctx.args[2];

  if (!addUserId || !addDailyName) {
    return ephemeralResponse('Usage: `/standup add @user <daily-name>`');
  }

  const addDaily = getDaily(addDailyName);
  if (!addDaily) {
    return ephemeralResponse(`❌ Daily "${addDailyName}" not found.`);
  }

  try {
    await addParticipant(ctx.db, addUserId, addDailyName, addDaily.schedule);
    return ephemeralResponse(`✅ Added <@${addUserId}> to *${addDailyName}*`);
  } catch (err) {
    console.error('Failed to add participant:', err);
    return ephemeralResponse('❌ Failed to add user. Please try again.');
  }
}

/** Remove a user from a daily (admin only) */
export async function handleRemove(ctx: CommandContext): Promise<CommandResponse> {
  if (!isAdmin(ctx.userId)) {
    return ephemeralResponse('❌ Only admins can remove users.');
  }

  const removeUserId = parseUserId(ctx.args[1] || '');
  const removeDailyName = ctx.args[2];

  if (!removeUserId || !removeDailyName) {
    return ephemeralResponse('Usage: `/standup remove @user <daily-name>`');
  }

  try {
    await removeParticipant(ctx.db, removeUserId, removeDailyName);
    return ephemeralResponse(`✅ Removed <@${removeUserId}> from *${removeDailyName}*`);
  } catch (err) {
    console.error('Failed to remove participant:', err);
    return ephemeralResponse('❌ Failed to remove user. Please try again.');
  }
}

/** List participants in a daily */
export async function handleList(ctx: CommandContext): Promise<CommandResponse> {
  const listDailyName = ctx.args[1];

  // Get today's date for OOO lookup
  const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const userDate = getUserDate(tzOffset);
  const todayStr = formatDate(userDate);

  // No arg or 'all' → show all dailies with participants
  if (!listDailyName || isAllDailies(listDailyName)) {
    const dailies = getDailies();
    if (dailies.length === 0) {
      return ephemeralResponse('No dailies configured.');
    }

    try {
      const results: string[] = [];
      for (const daily of dailies) {
        const participants = await getParticipants(ctx.db, daily.name);
        const oooRecords = await getActiveOOOForDaily(ctx.db, daily.name, todayStr);
        const oooUserIds = new Set(oooRecords.map(r => r.slack_user_id));

        const userList = participants.length > 0
          ? participants.map(p => {
              const oooLabel = oooUserIds.has(p.slack_user_id) ? ' (OOO)' : '';
              return `<@${p.slack_user_id}>${oooLabel}`;
            }).join(', ')
          : '_no participants_';
        results.push(`*${daily.name}* (${daily.channel}): ${userList}`);
      }
      return ephemeralResponse(results.join('\n'));
    } catch (err) {
      console.error('Failed to list participants:', err);
      return ephemeralResponse('❌ Failed to list participants. Please try again.');
    }
  }

  const listDaily = getDaily(listDailyName);
  if (!listDaily) {
    return ephemeralResponse(`❌ Daily "${listDailyName}" not found.`);
  }

  try {
    const participants = await getParticipants(ctx.db, listDailyName);
    if (participants.length === 0) {
      return ephemeralResponse(`*${listDailyName}* has no participants yet.`);
    }

    // Get OOO records for this daily
    const oooRecords = await getActiveOOOForDaily(ctx.db, listDailyName, todayStr);
    const oooMap = new Map<string, OOORecord>();
    for (const r of oooRecords) {
      oooMap.set(r.slack_user_id, r);
    }

    const userList = participants.map(p => {
      const ooo = oooMap.get(p.slack_user_id);
      if (ooo) {
        const endDate = ooo.end_date.split('T')[0];
        return `• <@${p.slack_user_id}> _(OOO until ${endDate})_`;
      }
      return `• <@${p.slack_user_id}>`;
    }).join('\n');

    return ephemeralResponse(`*${listDailyName}* participants:\n${userList}`);
  } catch (err) {
    console.error('Failed to list participants:', err);
    return ephemeralResponse('❌ Failed to list participants. Please try again.');
  }
}

/** Get team digest with full stats (sent as DM) */
export async function handleDigest(ctx: CommandContext): Promise<CommandResponse> {
  const digestDailyName = ctx.args[1];
  const periodArg = ctx.args[2]?.toLowerCase() || 'daily';

  if (!digestDailyName) {
    return ephemeralResponse('Usage: `/standup digest <daily-name> [daily|weekly|4-week]`');
  }

  // Validate period
  const validPeriods = ['daily', 'weekly', '4-week'];
  if (!validPeriods.includes(periodArg)) {
    return ephemeralResponse(`❌ Invalid period "${periodArg}". Use: daily, weekly, or 4-week`);
  }
  const period = periodArg as DigestPeriod;

  // Handle 'all' dailies
  if (isAllDailies(digestDailyName)) {
    const allDailies = getDailies();
    if (allDailies.length === 0) {
      return ephemeralResponse('No dailies configured.');
    }

    try {
      const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
      const tzOffset = userInfo?.tz_offset || 0;
      const userDate = getUserDate(tzOffset);
      const endDate = formatDate(userDate);

      const startDateObj = new Date(userDate);
      if (period === 'weekly') {
        startDateObj.setDate(startDateObj.getDate() - 6);
      } else if (period === '4-week') {
        startDateObj.setDate(startDateObj.getDate() - 27);
      }
      const startDate = formatDate(startDateObj);

      const digestParts: string[] = [];
      for (const daily of allDailies) {
        try {
          const schedule = getSchedule(daily.schedule);
          if (!schedule) continue;

          const submissions = await getSubmissionsInRange(ctx.db, daily.name, startDate, endDate);
          const stats = await getTeamStats(ctx.db, daily.name, startDate, endDate);
          const totalWorkdays = countWorkdays(schedule.days, startDate, endDate);

          let missingToday: string[] | undefined;
          if (period === 'daily') {
            missingToday = await getMissingSubmissions(ctx.db, daily.name, endDate);
          }

          const digestText = formatManagerDigest({
            dailyName: daily.name,
            period,
            startDate,
            endDate,
            submissions,
            stats,
            totalWorkdays,
            missingToday,
          });
          digestParts.push(digestText);
        } catch (err) {
          console.error(`Failed to generate digest for ${daily.name}:`, err);
          digestParts.push(`_Failed to generate digest for ${daily.name}_`);
        }
      }

      const combined = digestParts.join('\n\n---\n\n');
      await sendDM(ctx.slackToken, ctx.userId, combined);
      const periodLabel = period.charAt(0).toUpperCase() + period.slice(1);
      return ephemeralResponse(`📊 ${periodLabel} digest for all dailies sent to your DMs!`);
    } catch (err) {
      console.error('Failed to generate digest:', err);
      return ephemeralResponse('❌ Failed to generate digest. Please try again.');
    }
  }

  const digestDaily = getDaily(digestDailyName);
  if (!digestDaily) {
    return ephemeralResponse(`❌ Daily "${digestDailyName}" not found.`);
  }

  const schedule = getSchedule(digestDaily.schedule);
  if (!schedule) {
    return ephemeralResponse(`❌ Schedule "${digestDaily.schedule}" not found.`);
  }

  try {
    // Get user's timezone for date calculations
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const endDate = formatDate(userDate);

    // Calculate start date based on period
    const startDateObj = new Date(userDate);
    if (period === 'daily') {
      // Same day
    } else if (period === 'weekly') {
      startDateObj.setDate(startDateObj.getDate() - 6);
    } else {
      // 4-week
      startDateObj.setDate(startDateObj.getDate() - 27);
    }
    const startDate = formatDate(startDateObj);

    // Get data
    const submissions = await getSubmissionsInRange(ctx.db, digestDailyName, startDate, endDate);
    const stats = await getTeamStats(ctx.db, digestDailyName, startDate, endDate);
    const totalWorkdays = countWorkdays(schedule.days, startDate, endDate);

    // For daily digest, also get missing submissions
    let missingToday: string[] | undefined;
    if (period === 'daily') {
      missingToday = await getMissingSubmissions(ctx.db, digestDailyName, endDate);
    }

    const digestText = formatManagerDigest({
      dailyName: digestDailyName,
      period,
      startDate,
      endDate,
      submissions,
      stats,
      totalWorkdays,
      missingToday,
    });

    await sendDM(ctx.slackToken, ctx.userId, digestText);
    return ephemeralResponse(`📊 ${period.charAt(0).toUpperCase() + period.slice(1)} digest sent to your DMs!`);
  } catch (err) {
    console.error('Failed to generate digest:', err);
    return ephemeralResponse('❌ Failed to generate digest. Please try again.');
  }
}

/** Send prompt DM with "Open Standup" button */
export async function handlePrompt(ctx: CommandContext): Promise<CommandResponse> {
  const promptDailyName = ctx.args[1];

  try {
    // Get user's dailies
    const userDailies = await getUserDailies(ctx.db, ctx.userId);

    if (userDailies.length === 0) {
      return ephemeralResponse('❌ You\'re not part of any dailies. Ask an admin to add you.');
    }

    // Handle 'all' - send prompts for all user's dailies
    if (promptDailyName && isAllDailies(promptDailyName)) {
      const sentDailies: string[] = [];
      const failedDailies: string[] = [];

      for (const d of userDailies) {
        const sent = await sendPromptDM(ctx.slackToken, ctx.userId, d.daily_name);
        if (sent) {
          sentDailies.push(d.daily_name);
        } else {
          failedDailies.push(d.daily_name);
        }
      }

      if (sentDailies.length === 0) {
        return ephemeralResponse('❌ Failed to send prompts. Please try again.');
      }

      let message = `📬 Sent prompts for ${sentDailies.length} dailies: ${sentDailies.join(', ')}`;
      if (failedDailies.length > 0) {
        message += `\n⚠️ Failed: ${failedDailies.join(', ')}`;
      }
      return ephemeralResponse(message);
    }

    // If daily name provided, use that
    if (promptDailyName) {
      const daily = getDaily(promptDailyName);
      if (!daily) {
        return ephemeralResponse(`❌ Daily "${promptDailyName}" not found.`);
      }

      // Check user is part of this daily
      const isParticipant = userDailies.some(d => d.daily_name === promptDailyName);
      if (!isParticipant) {
        return ephemeralResponse(`❌ You're not part of *${promptDailyName}*.`);
      }

      const sent = await sendPromptDM(ctx.slackToken, ctx.userId, promptDailyName);
      if (!sent) {
        return ephemeralResponse('❌ Failed to send prompt. Please try again.');
      }
      return ephemeralResponse(`📬 Sent! Check your DMs for the *${promptDailyName}* standup.`);
    }

    // No daily name provided - auto-select if user is in only one daily
    if (userDailies.length === 1) {
      const dailyName = userDailies[0].daily_name;
      const sent = await sendPromptDM(ctx.slackToken, ctx.userId, dailyName);
      if (!sent) {
        return ephemeralResponse('❌ Failed to send prompt. Please try again.');
      }
      return ephemeralResponse(`📬 Sent! Check your DMs for the *${dailyName}* standup.`);
    }

    // Multiple dailies - show list
    const dailyList = userDailies.map(d => `• \`${d.daily_name}\``).join('\n');
    return ephemeralResponse(
      `You're part of multiple dailies. Specify which one:\n${dailyList}\n\nUsage: \`/standup prompt <daily-name>\``
    );
  } catch (err) {
    console.error('Failed to send prompt:', err);
    return ephemeralResponse('❌ Failed to send prompt. Please try again.');
  }
}

/** Manage Out of Office status */
export async function handleOOO(ctx: CommandContext): Promise<CommandResponse> {
  const subcommand = ctx.args[1]?.toLowerCase();

  try {
    // Get user's dailies
    const userDailies = await getUserDailies(ctx.db, ctx.userId);

    if (userDailies.length === 0) {
      return ephemeralResponse('❌ You\'re not part of any dailies. Ask an admin to add you.');
    }

    // Get user's timezone for date calculations
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);

    // No subcommand - show current OOO status
    if (!subcommand) {
      const statusLines: string[] = [];
      for (const d of userDailies) {
        const oooRecords = await getUserOOO(ctx.db, ctx.userId, d.daily_name);
        if (oooRecords.length > 0) {
          const periods = oooRecords.map(r => {
            const start = r.start_date.split('T')[0];
            const end = r.end_date.split('T')[0];
            return start === end ? start : `${start} to ${end}`;
          }).join(', ');
          statusLines.push(`*${d.daily_name}*: OOO ${periods}`);
        } else {
          statusLines.push(`*${d.daily_name}*: _not OOO_`);
        }
      }
      return ephemeralResponse('*OOO Status*\n' + statusLines.join('\n'));
    }

    // Handle 'clear' subcommand
    if (subcommand === 'clear') {
      let cleared = 0;
      for (const d of userDailies) {
        cleared += await clearOOO(ctx.db, ctx.userId, d.daily_name);
      }
      if (cleared > 0) {
        return ephemeralResponse(`✅ Cleared ${cleared} OOO period(s).`);
      }
      return ephemeralResponse('No OOO periods to clear.');
    }

    // Handle 'tomorrow' subcommand
    if (subcommand === 'tomorrow') {
      const tomorrow = new Date(userDate);
      tomorrow.setDate(tomorrow.getDate() + 1);
      const tomorrowStr = formatDate(tomorrow);

      for (const d of userDailies) {
        await setOOO(ctx.db, ctx.userId, d.daily_name, tomorrowStr, tomorrowStr);
      }
      return ephemeralResponse(`✅ Out of office tomorrow (${tomorrowStr}) for all your dailies.`);
    }

    // Handle date range: 'YYYY-MM-DD to YYYY-MM-DD'
    const dateMatch = ctx.args.slice(1).join(' ').match(/^(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})$/i);
    if (dateMatch) {
      const startDate = dateMatch[1];
      const endDate = dateMatch[2];

      // Validate dates
      const startObj = new Date(startDate);
      const endObj = new Date(endDate);
      if (isNaN(startObj.getTime()) || isNaN(endObj.getTime())) {
        return ephemeralResponse('❌ Invalid date format. Use: `YYYY-MM-DD to YYYY-MM-DD`');
      }
      if (endObj < startObj) {
        return ephemeralResponse('❌ End date must be after start date.');
      }

      for (const d of userDailies) {
        await setOOO(ctx.db, ctx.userId, d.daily_name, startDate, endDate);
      }
      return ephemeralResponse(`✅ Out of office from ${startDate} to ${endDate} for all your dailies.`);
    }

    // Handle single date: 'YYYY-MM-DD'
    const singleDateMatch = subcommand.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (singleDateMatch) {
      const date = singleDateMatch[1];
      const dateObj = new Date(date);
      if (isNaN(dateObj.getTime())) {
        return ephemeralResponse('❌ Invalid date format. Use: `YYYY-MM-DD`');
      }

      for (const d of userDailies) {
        await setOOO(ctx.db, ctx.userId, d.daily_name, date, date);
      }
      return ephemeralResponse(`✅ Out of office on ${date} for all your dailies.`);
    }

    return ephemeralResponse(
      '*OOO Usage:*\n' +
      '`/standup ooo` - Show current OOO status\n' +
      '`/standup ooo tomorrow` - Skip tomorrow\n' +
      '`/standup ooo YYYY-MM-DD` - Skip a specific date\n' +
      '`/standup ooo YYYY-MM-DD to YYYY-MM-DD` - Set date range\n' +
      '`/standup ooo clear` - Cancel all OOO periods'
    );
  } catch (err) {
    console.error('Failed to manage OOO:', err);
    return ephemeralResponse('❌ Failed to manage OOO. Please try again.');
  }
}

/** Get weekly summary - redirects to digest weekly */
export async function handleWeek(ctx: CommandContext): Promise<CommandResponse> {
  const weekDailyName = ctx.args[1];
  if (!weekDailyName) {
    return ephemeralResponse('Usage: `/standup digest <daily-name> weekly`\n_(Note: `/standup week` is deprecated)_');
  }
  // Redirect to digest weekly
  ctx.args = ['digest', weekDailyName, 'weekly'];
  return handleDigest(ctx);
}

/** Get detailed report with individual breakdowns (sent as DM) */
export async function handleReport(ctx: CommandContext): Promise<CommandResponse> {
  const reportDailyName = ctx.args[1];
  const periodArg = ctx.args[2]?.toLowerCase() || 'day';

  if (!reportDailyName) {
    return ephemeralResponse('Usage: `/standup report <daily-name> [day|week|month]`');
  }

  // Map period aliases
  const periodMap: Record<string, DigestPeriod> = {
    'day': 'daily',
    'daily': 'daily',
    'week': 'weekly',
    'weekly': 'weekly',
    'month': '4-week',
    '4-week': '4-week',
  };

  const period = periodMap[periodArg];
  if (!period) {
    return ephemeralResponse(`❌ Invalid period "${periodArg}". Use: day, week, or month`);
  }

  // Handle 'all' dailies
  if (isAllDailies(reportDailyName)) {
    const allDailies = getDailies();
    if (allDailies.length === 0) {
      return ephemeralResponse('No dailies configured.');
    }

    try {
      const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
      const tzOffset = userInfo?.tz_offset || 0;
      const userDate = getUserDate(tzOffset);
      const endDate = formatDate(userDate);

      const startDateObj = new Date(userDate);
      if (period === 'weekly') {
        startDateObj.setDate(startDateObj.getDate() - 6);
      } else if (period === '4-week') {
        startDateObj.setDate(startDateObj.getDate() - 27);
      }
      const startDate = formatDate(startDateObj);

      const reportParts: string[] = [];
      for (const daily of allDailies) {
        try {
          const schedule = getSchedule(daily.schedule);
          if (!schedule) continue;

          const submissions = await getSubmissionsInRange(ctx.db, daily.name, startDate, endDate);
          const stats = await getTeamStats(ctx.db, daily.name, startDate, endDate);
          const totalWorkdays = countWorkdays(schedule.days, startDate, endDate);

          const threshold = getBottleneckThreshold(daily);
          const bottlenecks = await getBottleneckItems(ctx.db, daily.name, threshold);
          const dropStats = await getHighDropUsers(ctx.db, daily.name, startDate, endDate, 30);

          let trends: TrendData | undefined;
          if (period !== 'daily') {
            const periodDays = period === 'weekly' ? 7 : 28;
            const prevEndDateObj = new Date(startDateObj);
            prevEndDateObj.setDate(prevEndDateObj.getDate() - 1);
            const prevStartDateObj = new Date(prevEndDateObj);
            prevStartDateObj.setDate(prevStartDateObj.getDate() - periodDays + 1);

            const prevStartDate = formatDate(prevStartDateObj);
            const prevEndDate = formatDate(prevEndDateObj);
            const prevWorkdays = countWorkdays(schedule.days, prevStartDate, prevEndDate);

            const currentStats = await getPeriodStats(ctx.db, daily.name, startDate, endDate, totalWorkdays);
            const previousStats = await getPeriodStats(ctx.db, daily.name, prevStartDate, prevEndDate, prevWorkdays);

            trends = { current: currentStats, previous: previousStats };
          }

          const reportText = formatFullReport({
            dailyName: daily.name,
            period,
            startDate,
            endDate,
            submissions,
            stats,
            totalWorkdays,
            bottlenecks,
            dropStats,
            trends,
          });
          reportParts.push(reportText);
        } catch (err) {
          console.error(`Failed to generate report for ${daily.name}:`, err);
          reportParts.push(`_Failed to generate report for ${daily.name}_`);
        }
      }

      const combined = reportParts.join('\n\n---\n\n');
      await sendDM(ctx.slackToken, ctx.userId, combined);
      const periodLabel = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : '4-Week';
      return ephemeralResponse(`📋 ${periodLabel} report for all dailies sent to your DMs!`);
    } catch (err) {
      console.error('Failed to generate report:', err);
      return ephemeralResponse('❌ Failed to generate report. Please try again.');
    }
  }

  const reportDaily = getDaily(reportDailyName);
  if (!reportDaily) {
    return ephemeralResponse(`❌ Daily "${reportDailyName}" not found.`);
  }

  const schedule = getSchedule(reportDaily.schedule);
  if (!schedule) {
    return ephemeralResponse(`❌ Schedule "${reportDaily.schedule}" not found.`);
  }

  try {
    // Get user's timezone for date calculations
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const endDate = formatDate(userDate);

    // Calculate start date based on period
    const startDateObj = new Date(userDate);
    if (period === 'weekly') {
      startDateObj.setDate(startDateObj.getDate() - 6);
    } else if (period === '4-week') {
      startDateObj.setDate(startDateObj.getDate() - 27);
    }
    const startDate = formatDate(startDateObj);

    // Get data
    const submissions = await getSubmissionsInRange(ctx.db, reportDailyName, startDate, endDate);
    const stats = await getTeamStats(ctx.db, reportDailyName, startDate, endDate);
    const totalWorkdays = countWorkdays(schedule.days, startDate, endDate);

    // Get bottleneck data
    const threshold = getBottleneckThreshold(reportDaily);
    const bottlenecks = await getBottleneckItems(ctx.db, reportDailyName, threshold);
    const dropStats = await getHighDropUsers(ctx.db, reportDailyName, startDate, endDate, 30);

    // Get trend data (compare to previous period) for non-daily
    let trends: TrendData | undefined;
    if (period !== 'daily') {
      const periodDays = period === 'weekly' ? 7 : 28;
      const prevEndDateObj = new Date(startDateObj);
      prevEndDateObj.setDate(prevEndDateObj.getDate() - 1);
      const prevStartDateObj = new Date(prevEndDateObj);
      prevStartDateObj.setDate(prevStartDateObj.getDate() - periodDays + 1);

      const prevStartDate = formatDate(prevStartDateObj);
      const prevEndDate = formatDate(prevEndDateObj);
      const prevWorkdays = countWorkdays(schedule.days, prevStartDate, prevEndDate);

      const currentStats = await getPeriodStats(ctx.db, reportDailyName, startDate, endDate, totalWorkdays);
      const previousStats = await getPeriodStats(ctx.db, reportDailyName, prevStartDate, prevEndDate, prevWorkdays);

      trends = {
        current: currentStats,
        previous: previousStats,
      };
    }

    const reportText = formatFullReport({
      dailyName: reportDailyName,
      period,
      startDate,
      endDate,
      submissions,
      stats,
      totalWorkdays,
      bottlenecks,
      dropStats,
      trends,
    });

    await sendDM(ctx.slackToken, ctx.userId, reportText);
    const periodLabel = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : '4-Week';
    return ephemeralResponse(`📋 ${periodLabel} report sent to your DMs!`);
  } catch (err) {
    console.error('Failed to generate report:', err);
    return ephemeralResponse('❌ Failed to generate report. Please try again.');
  }
}

/** Force send a prompt - dev mode only, ignores existing submissions */
export async function handleForcePrompt(ctx: CommandContext): Promise<CommandResponse> {
  if (!ctx.devMode) {
    return ephemeralResponse('❌ `force-prompt` is only available in dev mode.');
  }

  if (!isAdmin(ctx.userId)) {
    return ephemeralResponse('❌ Only admins can use force-prompt.');
  }

  const dailyName = ctx.args[1];
  if (!dailyName) {
    return ephemeralResponse('Usage: `/standup force-prompt <daily-name>`');
  }

  const daily = getDaily(dailyName);
  if (!daily) {
    return ephemeralResponse(`❌ Daily "${dailyName}" not found.`);
  }

  const sent = await sendPromptDM(ctx.slackToken, ctx.userId, dailyName);
  if (!sent) {
    return ephemeralResponse('❌ Failed to send prompt. Please try again.');
  }
  return ephemeralResponse(`🔧 [DEV] Force prompt sent! Check your DMs for the *${dailyName}* standup.`);
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Route a slash command to the appropriate handler
 */
export async function handleCommand(
  subcommand: string,
  ctx: CommandContext
): Promise<CommandResponse> {
  // Check for config errors (except for help command)
  const configErr = getConfigError();
  if (configErr && subcommand !== 'help') {
    console.error('Command failed due to config error:', configErr);
    return ephemeralResponse(
      `❌ Bot configuration error: ${configErr}\n\nPlease contact an admin to fix config.yaml.`
    );
  }

  switch (subcommand) {
    case 'help':
      return handleHelp();
    case 'add':
      return handleAdd(ctx);
    case 'remove':
      return handleRemove(ctx);
    case 'list':
      return handleList(ctx);
    case 'digest':
      return handleDigest(ctx);
    case 'report':
      return handleReport(ctx);
    case 'week':
      return handleWeek(ctx);
    case 'prompt':
      return handlePrompt(ctx);
    case 'ooo':
      return handleOOO(ctx);
    case 'force-prompt':
      return handleForcePrompt(ctx);
    default:
      return ephemeralResponse(
        `Unknown command: \`${subcommand}\`\nTry \`/standup help\` for usage.`
      );
  }
}

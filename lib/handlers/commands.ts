/**
 * Slash command handlers for /standup command
 * Handles: help, add, remove, list, digest, week
 */

import { getDailies, getDaily, isAdmin } from '../config';
import { DbClient, addParticipant, removeParticipant, getParticipants, getSubmissionsForDate, getSubmissionsInRange, getParticipationStats } from '../db';
import { formatDailyDigest, formatWeeklySummary } from '../format';
import { formatDate, getUserDate, getUserTimezone } from '../prompt';
import { parseUserId, ephemeralResponse, sendDM, SlackCommandResponse } from '../slack';

// ============================================================================
// Types
// ============================================================================

export interface CommandContext {
  userId: string;
  args: string[];
  db: DbClient;
  slackToken: string;
}

/** Re-export for convenience */
export type CommandResponse = SlackCommandResponse;

// ============================================================================
// Command Handlers
// ============================================================================

/** Show help message */
export function handleHelp(): CommandResponse {
  return ephemeralResponse(
    '*Standup Bot Commands*\n\n' +
    '`/standup help` - Show this help message\n' +
    '`/standup add @user <daily-name>` - Add user to a daily (admin only)\n' +
    '`/standup remove @user <daily-name>` - Remove user from a daily (admin only)\n' +
    '`/standup list <daily-name>` - List participants in a daily\n' +
    '`/standup digest <daily-name>` - Get today\'s standup digest (DM)\n' +
    '`/standup week <daily-name>` - Get weekly summary (DM)'
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

  if (!listDailyName) {
    const dailies = getDailies();
    return ephemeralResponse(
      '*Available dailies:*\n' +
      dailies.map(d => `• ${d.name} (${d.channel})`).join('\n')
    );
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
    const userList = participants.map(p => `• <@${p.slack_user_id}>`).join('\n');
    return ephemeralResponse(`*${listDailyName}* participants:\n${userList}`);
  } catch (err) {
    console.error('Failed to list participants:', err);
    return ephemeralResponse('❌ Failed to list participants. Please try again.');
  }
}

/** Get today's digest (sent as DM) */
export async function handleDigest(ctx: CommandContext): Promise<CommandResponse> {
  const digestDailyName = ctx.args[1];

  if (!digestDailyName) {
    return ephemeralResponse('Usage: `/standup digest <daily-name>`');
  }

  const digestDaily = getDaily(digestDailyName);
  if (!digestDaily) {
    return ephemeralResponse(`❌ Daily "${digestDailyName}" not found.`);
  }

  try {
    // Get user's timezone for today's date
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const todayStr = formatDate(userDate);

    const submissions = await getSubmissionsForDate(ctx.db, digestDailyName, todayStr);
    const digestText = formatDailyDigest(digestDailyName, todayStr, submissions);

    // Send as DM
    await sendDM(ctx.slackToken, ctx.userId, digestText);
    return ephemeralResponse(`📊 Digest sent to your DMs!`);
  } catch (err) {
    console.error('Failed to generate digest:', err);
    return ephemeralResponse('❌ Failed to generate digest. Please try again.');
  }
}

/** Get weekly summary (sent as DM) */
export async function handleWeek(ctx: CommandContext): Promise<CommandResponse> {
  const weekDailyName = ctx.args[1];

  if (!weekDailyName) {
    return ephemeralResponse('Usage: `/standup week <daily-name>`');
  }

  const weekDaily = getDaily(weekDailyName);
  if (!weekDaily) {
    return ephemeralResponse(`❌ Daily "${weekDailyName}" not found.`);
  }

  try {
    // Get user's timezone for date calculations
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const endDate = formatDate(userDate);

    // Go back 7 days
    const startDateObj = new Date(userDate);
    startDateObj.setDate(startDateObj.getDate() - 6);
    const startDate = formatDate(startDateObj);

    const submissions = await getSubmissionsInRange(ctx.db, weekDailyName, startDate, endDate);
    const stats = await getParticipationStats(ctx.db, weekDailyName, startDate, endDate);
    const weekText = formatWeeklySummary(weekDailyName, startDate, endDate, submissions, stats);

    // Send as DM
    await sendDM(ctx.slackToken, ctx.userId, weekText);
    return ephemeralResponse(`📈 Weekly summary sent to your DMs!`);
  } catch (err) {
    console.error('Failed to generate weekly summary:', err);
    return ephemeralResponse('❌ Failed to generate weekly summary. Please try again.');
  }
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
    case 'week':
      return handleWeek(ctx);
    default:
      return ephemeralResponse(
        `Unknown command: \`${subcommand}\`\nTry \`/standup help\` for usage.`
      );
  }
}

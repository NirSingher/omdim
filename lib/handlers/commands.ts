/**
 * Slash command handlers for /standup command
 * Handles: help, prompt, add, remove, list, digest, week
 */

import { getDailies, getDaily, isAdmin, getConfigError } from '../config';
import { DbClient, addParticipant, removeParticipant, getParticipants, getSubmissionsForDate, getSubmissionsInRange, getParticipationStats, getUserDailies } from '../db';
import { formatDailyDigest, formatWeeklySummary } from '../format';
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
    '`/standup prompt [daily-name]` - Send standup prompt to your DMs\n' +
    '`/standup add @user <daily-name>` - Add user to a daily (admin only)\n' +
    '`/standup remove @user <daily-name>` - Remove user from a daily (admin only)\n' +
    '`/standup list <daily-name>` - List participants in a daily\n' +
    '`/standup digest [daily-name]` - Get today\'s digest (DM, all dailies if none specified)\n' +
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

  try {
    // Get user's timezone for today's date
    const userInfo = await getUserTimezone(ctx.slackToken, ctx.userId);
    const tzOffset = userInfo?.tz_offset || 0;
    const userDate = getUserDate(tzOffset);
    const todayStr = formatDate(userDate);

    // If specific daily provided, get just that one
    if (digestDailyName) {
      const digestDaily = getDaily(digestDailyName);
      if (!digestDaily) {
        return ephemeralResponse(`❌ Daily "${digestDailyName}" not found.`);
      }

      const submissions = await getSubmissionsForDate(ctx.db, digestDailyName, todayStr);
      const digestText = formatDailyDigest(digestDailyName, todayStr, submissions);

      await sendDM(ctx.slackToken, ctx.userId, digestText);
      return ephemeralResponse(`📊 Digest sent to your DMs!`);
    }

    // No daily specified - get all dailies
    const allDailies = getDailies();
    if (allDailies.length === 0) {
      return ephemeralResponse('❌ No dailies configured.');
    }

    // Build combined digest for all dailies
    const digestParts: string[] = [];
    for (const daily of allDailies) {
      const submissions = await getSubmissionsForDate(ctx.db, daily.name, todayStr);
      const digestText = formatDailyDigest(daily.name, todayStr, submissions);
      digestParts.push(digestText);
    }

    await sendDM(ctx.slackToken, ctx.userId, digestParts.join('\n\n---\n\n'));
    return ephemeralResponse(`📊 Digest for all ${allDailies.length} dailies sent to your DMs!`);
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
    case 'week':
      return handleWeek(ctx);
    case 'prompt':
      return handlePrompt(ctx);
    default:
      return ephemeralResponse(
        `Unknown command: \`${subcommand}\`\nTry \`/standup help\` for usage.`
      );
  }
}

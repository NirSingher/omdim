/**
 * Cloudflare Workers entry point
 * Routes requests to appropriate handlers
 */

import { loadConfig, loadConfigOverrides, getDailies, getSchedules, getConfigError, getDailiesWithManagers, getDaily, getSchedule, getDailyManagers, getWeeklyDigestDay, getBottleneckThreshold, getIntegrationStatus, getDigestTime, getGitHubConfig, getGitHubUserMappings, getLinearConfig, getLinearUserMappings, getLinearTeamIdForUser, getMaxPlanItems, isDailyEnabled, getLinearIntelligenceConfig, getGitHubIntelligenceConfig, getWeeklyRecap } from '../lib/config';
import { verifySlackSignature, parseCommandPayload, sendDM, sendDMWithBlocks, postMessage } from '../lib/slack';
import { getDb, deleteOldSubmissions, deleteOldPrompts, getSubmissionsInRange, getTeamStats, getMissingSubmissions, countWorkdays, getBottleneckItems, getHighDropUsers, getTeamRankings, getPeriodStats, getParticipants, getUsersWithGitHubLinks, getUsersWithLinearLinks, getActiveOOOForDaily, getOOOStartingOnDate, getBlockerStreaks, getUnplannedOverload, getActiveWorkItems } from '../lib/db';
import { computeLinearAlignment, AlignmentResult } from '../lib/linear-intelligence';
import { computeGitHubAlignment, GitHubAlignmentResult } from '../lib/github-intelligence';
import { fetchTeamPRData, TeamPRData, fetchTeamMergedPRs } from '../lib/github';
import { fetchTeamCycleData, TeamLinearData, CycleProgress } from '../lib/linear';
import { runPromptCron, runScheduledPosts, runReminderCron, runNudgeCron, formatDate, getUserDate, isWorkday, getDateInTimezone } from '../lib/prompt';
import { handleCommand, handleDaily } from '../lib/handlers/commands';
import { handleInteraction, InteractionPayload } from '../lib/handlers/interactions';
import { handleAppHomeOpened, AppHomeOpenedEvent } from '../lib/handlers/home';
import { handleLinearWebhook } from '../lib/handlers/webhooks';
import { formatManagerDigest, DigestPeriod, TrendData, buildBottleneckBlocks, formatPRDigestAnalytics, OOOInfo, formatTeamSummary, formatPersonalWeeklyRecap } from '../lib/format';

// ============================================================================
// Types
// ============================================================================

export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DATABASE_URL: string;
  CRON_SECRET?: string;
  DEV_MODE?: string;
  GITHUB_TOKEN?: string;
  LINEAR_API_KEY?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  // Allow additional env vars for custom token names per daily
  [key: string]: string | undefined;
}

// ============================================================================
// HTTP Handler
// ============================================================================

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/api/health' || path === '/health') {
        return handleHealthCheck();
      }

      // Slack commands
      if (path === '/api/slack/commands') {
        return handleSlackCommands(request, env);
      }

      // Slack interactions (modals, buttons)
      if (path === '/api/slack/interact') {
        return handleSlackInteractions(request, env, ctx);
      }

      // Slack events (app_home_opened)
      if (path === '/api/slack/events') {
        return handleSlackEvents(request, env);
      }

      // Cron: prompt users
      if (path === '/api/cron/prompt') {
        return handlePromptCron(url, env);
      }

      // Cron: cleanup old data
      if (path === '/api/cron/cleanup') {
        return handleCleanupCron(url, env);
      }

      // Cron: send manager digests
      if (path === '/api/cron/digest') {
        return handleDigestCron(url, env);
      }

      // Linear webhook: issue status changes → auto-update standup items
      if (path === '/api/webhooks/linear' && request.method === 'POST') {
        const db = getDb(env.DATABASE_URL);
        await loadConfigOverrides(db);
        return handleLinearWebhook(request, env, db, ctx);
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  },

  // Cloudflare cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronPattern = event.cron;

    if (cronPattern === '*/30 * * * *') {
      console.log('Running prompt cron job');
      const db = getDb(env.DATABASE_URL);
      await loadConfigOverrides(db);

      // Run prompt cron (send DM prompts to users)
      const promptStats = await runPromptCron(db, env.SLACK_BOT_TOKEN);
      console.log('Prompt cron complete:', promptStats);

      // Run scheduled posts cron (post pre-filled "tomorrow" submissions)
      const scheduledStats = await runScheduledPosts(db, env.SLACK_BOT_TOKEN, env);
      console.log('Scheduled posts cron complete:', scheduledStats);

      // Run reminder cron (send channel reminders before daily standups)
      const reminderStats = await runReminderCron(db, env.SLACK_BOT_TOKEN);
      console.log('Reminder cron complete:', reminderStats);

      // Run nudge cron (DM users who haven't submitted before digest)
      const nudgeStats = await runNudgeCron(db, env.SLACK_BOT_TOKEN);
      console.log('Nudge cron complete:', nudgeStats);

      // Check if it's time to send digests (based on configured digest_time)
      if (isDigestTime()) {
        console.log('Running digest cron');
        const result = await runDigestCronUnified(env);
        console.log('Digest cron complete:', result);
      }
    } else if (cronPattern === '0 3 * * *') {
      console.log('Running cleanup cron job');
      await runCleanup(env);
    }
  },
};

// ============================================================================
// Route Handlers
// ============================================================================

/** Health check endpoint */
function handleHealthCheck(): Response {
  loadConfig(); // Attempt to load config
  const error = getConfigError();

  const configStatus = error ? 'error' : 'loaded';
  const configDetails = error
    ? { error }
    : {
        dailies: getDailies().map((d) => d.name),
        schedules: getSchedules().map((s) => s.name),
      };

  return new Response(JSON.stringify({
    status: error ? 'degraded' : 'healthy',
    timestamp: new Date().toISOString(),
    config: {
      status: configStatus,
      ...configDetails,
    },
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Slack slash commands endpoint */
async function handleSlackCommands(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  // Verify signature
  const isValid = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    body
  );

  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = parseCommandPayload(body);
  const db = getDb(env.DATABASE_URL);
  await loadConfigOverrides(db);

  // Handle /daily command separately
  if (payload.command === '/daily') {
    const args = payload.text.trim().split(/\s+/).filter(a => a);
    console.log('Command: /daily', { user_id: payload.user_id, args });

    const response = await handleDaily({
      userId: payload.user_id,
      args,
      db,
      slackToken: env.SLACK_BOT_TOKEN,
      triggerId: payload.trigger_id,
      env,
    });

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Handle /standup command (existing behavior)
  const args = payload.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase() || 'help';

  console.log('Command:', { subcommand, user_id: payload.user_id });

  const response = await handleCommand(subcommand, {
    userId: payload.user_id,
    args,
    db,
    slackToken: env.SLACK_BOT_TOKEN,
    devMode: env.DEV_MODE === 'true',
    triggerId: payload.trigger_id,
  });

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Slack interactions endpoint */
async function handleSlackInteractions(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  // Verify signature
  const isValid = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    body
  );

  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  // Parse interaction payload
  const params = new URLSearchParams(body);
  const payloadStr = params.get('payload');
  if (!payloadStr) {
    return new Response('Missing payload', { status: 400 });
  }

  const payload = JSON.parse(payloadStr) as InteractionPayload;
  console.log('Interaction:', { type: payload.type, user: payload.user.id });

  const db = getDb(env.DATABASE_URL);
  await loadConfigOverrides(db);
  const result = await handleInteraction(payload, {
    db,
    slackToken: env.SLACK_BOT_TOKEN,
    env,
    waitUntil: ctx.waitUntil.bind(ctx),
  });

  // Return validation errors for modal submissions
  if (typeof result === 'object' && result.response_action === 'errors') {
    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Otherwise return 200 to acknowledge
  return new Response('', { status: 200 });
}

/** Slack events endpoint (app_home_opened) */
async function handleSlackEvents(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await request.text();
  const timestamp = request.headers.get('x-slack-request-timestamp');
  const signature = request.headers.get('x-slack-signature');

  // Verify signature
  const isValid = await verifySlackSignature(
    env.SLACK_SIGNING_SECRET,
    signature,
    timestamp,
    body
  );

  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const payload = JSON.parse(body) as {
    type: string;
    challenge?: string;
    event?: AppHomeOpenedEvent;
  };

  // Handle URL verification challenge (required when setting up Events API)
  if (payload.type === 'url_verification' && payload.challenge) {
    return new Response(payload.challenge, {
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // Handle events
  if (payload.type === 'event_callback' && payload.event) {
    const event = payload.event;

    // Handle app_home_opened event
    if (event.type === 'app_home_opened') {
      const db = getDb(env.DATABASE_URL);
      await loadConfigOverrides(db);
      await handleAppHomeOpened(event, {
        db,
        slackToken: env.SLACK_BOT_TOKEN,
        env,
      });
    }
  }

  // Always return 200 to acknowledge
  return new Response('', { status: 200 });
}

/** Prompt cron endpoint (HTTP trigger) */
async function handlePromptCron(url: URL, env: Env): Promise<Response> {
  // Verify cron secret if using external cron
  const secret = url.searchParams.get('secret');
  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  // Force parameter skips time window checks (for testing)
  const force = url.searchParams.get('force') === 'true';

  const db = getDb(env.DATABASE_URL);
  await loadConfigOverrides(db);
  const stats = await runPromptCron(db, env.SLACK_BOT_TOKEN, force);

  return new Response(JSON.stringify({
    status: 'ok',
    ...stats,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Cleanup cron endpoint (HTTP trigger) */
async function handleCleanupCron(url: URL, env: Env): Promise<Response> {
  const secret = url.searchParams.get('secret');
  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const result = await runCleanup(env);

  return new Response(JSON.stringify({
    status: 'ok',
    ...result,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ============================================================================
// Cleanup Logic
// ============================================================================

/** Delete data older than 28 days */
async function runCleanup(env: Env): Promise<{
  cutoffDate: string;
  deletedSubmissions: number;
  deletedPrompts: number;
}> {
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 28);
  const cutoffStr = formatDate(cutoffDate);

  const db = getDb(env.DATABASE_URL);
  const deletedSubmissions = await deleteOldSubmissions(db, cutoffStr);
  const deletedPrompts = await deleteOldPrompts(db, cutoffStr);

  console.log(`Cleanup complete: ${deletedSubmissions} submissions, ${deletedPrompts} prompts deleted`);

  return {
    cutoffDate: cutoffStr,
    deletedSubmissions,
    deletedPrompts,
  };
}

// ============================================================================
// Digest Cron Logic
// ============================================================================

/** Digest cron endpoint (HTTP trigger) */
async function handleDigestCron(url: URL, env: Env): Promise<Response> {
  const secret = url.searchParams.get('secret');
  if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
    return new Response('Unauthorized', { status: 401 });
  }

  const period = (url.searchParams.get('period') || 'daily') as DigestPeriod;
  if (!['daily', 'weekly', '4-week'].includes(period)) {
    return new Response('Invalid period. Use: daily, weekly, 4-week', { status: 400 });
  }

  const db = getDb(env.DATABASE_URL);
  await loadConfigOverrides(db);
  const result = await runDigestCron(env, period);

  return new Response(JSON.stringify({
    status: 'ok',
    ...result,
  }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Get current day abbreviation (sun, mon, tue, etc.) */
function getCurrentDayAbbrev(): string {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return days[new Date().getDay()];
}

/**
 * Check if current time falls within the digest time window.
 * Since the cron runs every 30 minutes (at :00 and :30), we check if
 * the configured digest_time falls within the current 30-minute window.
 * For example:
 * - Cron at 14:00 covers digest times from 14:00 to 14:29
 * - Cron at 14:30 covers digest times from 14:30 to 14:59
 */
function isDigestTime(): boolean {
  const digestTime = getDigestTime();
  const [digestHour, digestMinute] = digestTime.split(':').map(Number);

  const now = new Date();
  const currentHour = now.getUTCHours();
  const currentMinute = now.getUTCMinutes();

  // Calculate which 30-minute window we're in
  const windowStart = currentMinute < 30 ? 0 : 30;
  const windowEnd = windowStart + 29;

  // Check if digest time falls in this window
  return currentHour === digestHour && digestMinute >= windowStart && digestMinute <= windowEnd;
}

/** Unified digest cron - sends daily digest every day, weekly on configured day */
async function runDigestCronUnified(env: Env): Promise<{
  dailySent: number;
  weeklySent: number;
  errors: number;
  dailies: string[];
}> {
  const dailiesWithManagers = getDailiesWithManagers();
  let dailySent = 0;
  let weeklySent = 0;
  let errors = 0;
  const processedDailies: string[] = [];

  const db = getDb(env.DATABASE_URL);
  const todayAbbrev = getCurrentDayAbbrev();

  for (const daily of dailiesWithManagers) {
    const managers = getDailyManagers(daily);
    if (managers.length === 0) continue;

    const schedule = getSchedule(daily.schedule);
    if (!schedule) {
      console.error(`Schedule "${daily.schedule}" not found for daily "${daily.name}"`);
      errors++;
      continue;
    }

    try {
      // Only send daily digest on workdays (check in schedule timezone)
      const localNow = schedule.timezone ? getDateInTimezone(schedule.timezone) : new Date();
      const isWorkdayToday = isWorkday(schedule.days, localNow);
      if (isWorkdayToday) {
        const dailyResult = await sendDigestToManagers(env, db, daily, managers, schedule, 'daily');
        dailySent += dailyResult.sent;
        errors += dailyResult.errors;
      }

      // Check if today is the weekly digest day for this daily
      const weeklyDay = getWeeklyDigestDay(daily);
      if (todayAbbrev === weeklyDay) {
        const weeklyResult = await sendDigestToManagers(env, db, daily, managers, schedule, 'weekly');
        weeklySent += weeklyResult.sent;
        errors += weeklyResult.errors;

        // Personal weekly recap DMs
        if (getWeeklyRecap(daily)) {
          try {
            const recapEnd = formatDate(new Date());
            const recapStartObj = new Date();
            recapStartObj.setDate(recapStartObj.getDate() - 6);
            const recapStart = formatDate(recapStartObj);
            const weeklySubs = await getSubmissionsInRange(db, daily.name, recapStart, recapEnd);
            const participants = await getParticipants(db, daily.name);
            for (const p of participants) {
              const userSubs = weeklySubs.filter(s => s.slack_user_id === p.slack_user_id);
              const recap = formatPersonalWeeklyRecap(daily.name, userSubs);
              await sendDM(env.SLACK_BOT_TOKEN, p.slack_user_id, recap);
            }
          } catch (err) {
            console.error(`Failed to send weekly recaps for "${daily.name}":`, err);
            errors++;
          }
        }
      }

      // Post OOO notice to daily channel for users whose OOO starts today (workdays only)
      const todayStr = formatDate(new Date());
      const oooStarting = isWorkdayToday ? await getOOOStartingOnDate(db, daily.name, todayStr) : [];
      if (oooStarting.length > 0) {
        const formatShortDate = (d: string) => {
          const date = new Date(d + 'T00:00:00');
          return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        };
        const oooLines = oooStarting.map(r => {
          const back = r.start_date === r.end_date
            ? 'back tomorrow'
            : `back ${formatShortDate(r.end_date)}`;
          return `<@${r.slack_user_id}> (${back})`;
        });
        const oooText = `🏖️ *Out today:* ${oooLines.join(' · ')}`;
        try {
          await postMessage(env.SLACK_BOT_TOKEN, daily.channel, oooText);
        } catch (err) {
          console.error(`Failed to post OOO notice to channel for "${daily.name}":`, err);
        }
      }

      // Post team summary to channel (opt-in per-daily, workdays only)
      if (isWorkdayToday && daily.team_summary) {
        try {
          const todaySubs = await getSubmissionsInRange(db, daily.name, todayStr, todayStr);
          if (todaySubs.length > 0) {
            const githubCfg = getGitHubConfig(daily);
            const summaryText = formatTeamSummary({
              dailyName: daily.name,
              channel: daily.channel,
              submissions: todaySubs,
              githubOrg: githubCfg?.org,
            });
            if (summaryText) {
              await postMessage(env.SLACK_BOT_TOKEN, daily.channel, summaryText);
            }
          }
        } catch (err) {
          console.error(`Failed to post team summary for "${daily.name}":`, err);
        }
      }

      processedDailies.push(daily.name);
    } catch (err) {
      console.error(`Failed to process digests for "${daily.name}":`, err);
      errors++;
    }
  }

  return { dailySent, weeklySent, errors, dailies: processedDailies };
}

/** Send digest to all managers for a specific daily and period */
async function sendDigestToManagers(
  env: Env,
  db: ReturnType<typeof getDb>,
  daily: ReturnType<typeof getDaily>,
  managers: string[],
  schedule: ReturnType<typeof getSchedule>,
  period: DigestPeriod
): Promise<{ sent: number; errors: number }> {
  if (!daily || !schedule) return { sent: 0, errors: 0 };

  let sent = 0;
  let errors = 0;

  // Calculate date range
  const today = new Date();
  const endDate = formatDate(today);

  const startDateObj = new Date(today);
  if (period === 'weekly') {
    startDateObj.setDate(startDateObj.getDate() - 6);
  } else if (period === '4-week') {
    startDateObj.setDate(startDateObj.getDate() - 27);
  }
  // daily: same day (no change)
  const startDate = formatDate(startDateObj);

  // Get data
  const submissions = await getSubmissionsInRange(db, daily.name, startDate, endDate);
  const stats = await getTeamStats(db, daily.name, startDate, endDate);
  const totalWorkdays = countWorkdays(schedule.days, startDate, endDate);

  // For daily digest, get missing submissions
  let missingToday: string[] | undefined;
  if (period === 'daily') {
    missingToday = await getMissingSubmissions(db, daily.name, endDate);
  }

  // Get bottleneck data
  const threshold = getBottleneckThreshold(daily);
  const bottlenecks = await getBottleneckItems(db, daily.name, threshold);
  const dropStats = await getHighDropUsers(db, daily.name, startDate, endDate, 30);
  const blockerStreaks = await getBlockerStreaks(db, daily.name, startDate, endDate);
  const unplannedOverloads = await getUnplannedOverload(db, daily.name, startDate, endDate, 70);

  // Get rankings (only for weekly and 4-week)
  let rankings;
  if (period === 'weekly' || period === '4-week') {
    rankings = await getTeamRankings(db, daily.name, startDate, endDate, totalWorkdays);
  }

  // Get trend data (compare to previous period)
  let trends: TrendData | undefined;
  if (period !== 'daily') {
    // Calculate previous period dates
    const periodDays = period === 'weekly' ? 7 : 28;
    const prevEndDateObj = new Date(startDateObj);
    prevEndDateObj.setDate(prevEndDateObj.getDate() - 1);
    const prevStartDateObj = new Date(prevEndDateObj);
    prevStartDateObj.setDate(prevStartDateObj.getDate() - periodDays + 1);

    const prevStartDate = formatDate(prevStartDateObj);
    const prevEndDate = formatDate(prevEndDateObj);
    const prevWorkdays = countWorkdays(schedule.days, prevStartDate, prevEndDate);

    // Fetch current and previous period stats
    const currentStats = await getPeriodStats(db, daily.name, startDate, endDate, totalWorkdays);
    const previousStats = await getPeriodStats(db, daily.name, prevStartDate, prevEndDate, prevWorkdays);

    trends = {
      current: currentStats,
      previous: previousStats,
    };
  }

  // Get integration status for work alignment section
  const integrations = getIntegrationStatus(daily);

  // Fetch team PR data if GitHub integration is enabled
  let teamPRData: TeamPRData[] | undefined;
  const githubConfig = getGitHubConfig(daily);
  if (githubConfig) {
    const githubToken = env[githubConfig.tokenEnvVar];
    if (githubToken) {
      try {
        // Get GitHub user mappings from config
        const configMappings = getGitHubUserMappings(daily);

        // Get participants for this daily
        const participants = await getParticipants(db, daily.name);

        // Get DB-linked GitHub usernames for participants not in config
        const dbLinks = await getUsersWithGitHubLinks(db);
        const dbLinksMap = new Map(dbLinks.map(l => [l.slackUserId, l.githubUsername]));

        // Build combined user list (config takes precedence)
        const configUserIds = new Set(configMappings.map(m => m.slackUserId));
        const users: Array<{ slackUserId: string; githubUsername: string }> = [...configMappings];

        for (const p of participants) {
          if (!configUserIds.has(p.slack_user_id)) {
            const githubUsername = dbLinksMap.get(p.slack_user_id);
            if (githubUsername) {
              users.push({ slackUserId: p.slack_user_id, githubUsername });
            }
          }
        }

        if (users.length > 0) {
          teamPRData = await fetchTeamPRData(githubToken, githubConfig.org, users);
        }
      } catch (error) {
        console.error('Failed to fetch team PR data for digest:', error);
      }
    }
  }

  // Fetch team Linear data if Linear integration is enabled
  let teamLinearData: TeamLinearData[] | undefined;
  let cycleProgress: CycleProgress | null | undefined;
  const linearConfig = getLinearConfig(daily);
  if (linearConfig) {
    const linearToken = env[linearConfig.tokenEnvVar];
    if (linearToken) {
      try {
        // Get Linear user mappings from config
        const configMappings = getLinearUserMappings(daily);

        // Get participants for this daily (reuse if already fetched for GitHub)
        const linearParticipants = await getParticipants(db, daily.name);

        // Get DB-linked Linear user IDs for participants not in config
        const dbLinearLinks = await getUsersWithLinearLinks(db);
        const dbLinearMap = new Map(dbLinearLinks.map(l => [l.slackUserId, l.linearUserId]));

        // Build combined user list with per-user team IDs (config takes precedence)
        const configLinearUserIds = new Set(configMappings.map(m => m.slackUserId));
        const linearUsers: Array<{ slackUserId: string; linearUserId: string; teamId?: string }> = [
          ...configMappings,
        ];

        for (const p of linearParticipants) {
          if (!configLinearUserIds.has(p.slack_user_id)) {
            const linearUserId = dbLinearMap.get(p.slack_user_id);
            if (linearUserId) {
              // DB-linked users get team_id from config default
              linearUsers.push({ slackUserId: p.slack_user_id, linearUserId });
            }
          }
        }

        if (linearUsers.length > 0) {
          // Resolve effective team_id per user and group by team
          const teamGroups = new Map<string, Array<{ slackUserId: string; linearUserId: string }>>();
          for (const u of linearUsers) {
            const teamId = u.teamId || getLinearTeamIdForUser(daily, u.slackUserId) || linearConfig.defaultTeamId;
            if (teamId) {
              if (!teamGroups.has(teamId)) teamGroups.set(teamId, []);
              teamGroups.get(teamId)!.push({ slackUserId: u.slackUserId, linearUserId: u.linearUserId });
            }
          }

          // Fetch cycle data per team and merge results
          teamLinearData = [];
          for (const [teamId, users] of teamGroups) {
            const result = await fetchTeamCycleData(linearToken, teamId, users);
            teamLinearData.push(...result.teamData);
            // Use the first team's cycle progress (or merge if needed)
            if (!cycleProgress && result.cycleProgress) {
              cycleProgress = result.cycleProgress;
            }
          }
        }
      } catch (error) {
        console.error('Failed to fetch team Linear data for digest:', error);
      }
    }
  }

  // Fetch OOO data for daily digest
  let oooToday: OOOInfo[] | undefined;
  if (period === 'daily') {
    const oooRecords = await getActiveOOOForDaily(db, daily.name, endDate);
    if (oooRecords.length > 0) {
      oooToday = oooRecords.map(r => ({ slackUserId: r.slack_user_id, endDate: r.end_date }));
    }
  }

  // Compute Linear intelligence alignment (Phase 1 & 2)
  let linearAlignment: AlignmentResult[] | undefined;
  const linearIntelConfig = getLinearIntelligenceConfig(daily);
  if (linearIntelConfig && teamLinearData && teamLinearData.length > 0) {
    try {
      linearAlignment = [];
      for (const member of teamLinearData) {
        const workItems = await getActiveWorkItems(db, member.slackUserId, daily.name, endDate);
        const result = computeLinearAlignment(member.slackUserId, workItems, member.data.issues);
        linearAlignment.push(result);
      }
    } catch (error) {
      console.error('Failed to compute Linear alignment for digest:', error);
      linearAlignment = undefined;
    }
  }

  // Compute GitHub intelligence alignment (Phase 4 & 5)
  let githubAlignment: GitHubAlignmentResult[] | undefined;
  const githubIntelConfig = getGitHubIntelligenceConfig(daily);
  if (githubIntelConfig?.work_alignment && githubConfig) {
    const githubToken = env[githubConfig.tokenEnvVar];
    if (githubToken) {
      try {
        // Build combined user list (same logic as team PR data above)
        const configMappings = getGitHubUserMappings(daily);
        const participants = await getParticipants(db, daily.name);
        const dbLinks = await getUsersWithGitHubLinks(db);
        const dbLinksMap = new Map(dbLinks.map(l => [l.slackUserId, l.githubUsername]));
        const configUserIds = new Set(configMappings.map(m => m.slackUserId));
        const githubUsers: Array<{ slackUserId: string; githubUsername: string }> = [...configMappings];
        for (const p of participants) {
          if (!configUserIds.has(p.slack_user_id)) {
            const githubUsername = dbLinksMap.get(p.slack_user_id);
            if (githubUsername) {
              githubUsers.push({ slackUserId: p.slack_user_id, githubUsername });
            }
          }
        }

        if (githubUsers.length > 0) {
          const teamMergedPRs = await fetchTeamMergedPRs(githubToken, githubConfig.org, githubUsers, endDate);
          githubAlignment = [];
          for (const member of teamMergedPRs) {
            const workItems = await getActiveWorkItems(db, member.slackUserId, daily.name, endDate);
            const result = computeGitHubAlignment(member.slackUserId, workItems, member.mergedPRs);
            githubAlignment.push(result);
          }
        }
      } catch (error) {
        console.error('Failed to compute GitHub alignment for digest:', error);
        githubAlignment = undefined;
      }
    }
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
    oooToday,
    bottlenecks,
    dropStats,
    rankings,
    trends,
    integrations,
    teamPRData,
    teamLinearData,
    cycleProgress,
    maxPlanItems: getMaxPlanItems(daily.name),
    blockerStreaks,
    unplannedOverloads,
    linearAlignment,
    githubAlignment,
  });

  // Build bottleneck blocks with snooze buttons (only if there are bottlenecks)
  const bottleneckBlocks = bottlenecks && bottlenecks.length > 0
    ? buildBottleneckBlocks(bottlenecks, daily.name)
    : [];

  // Send to ALL managers
  for (const managerId of managers) {
    try {
      // Send main digest text
      await sendDM(env.SLACK_BOT_TOKEN, managerId, digestText);

      // Send bottleneck snooze buttons as a separate message (if any)
      if (bottleneckBlocks.length > 0) {
        await sendDMWithBlocks(
          env.SLACK_BOT_TOKEN,
          managerId,
          'Bottleneck items with snooze options',
          bottleneckBlocks
        );
      }

      sent++;
      console.log(`Sent ${period} digest for "${daily.name}" to manager ${managerId}`);
    } catch (err) {
      console.error(`Failed to send ${period} digest to ${managerId}:`, err);
      errors++;
    }
  }

  return { sent, errors };
}

/** Send digests to all managers (used by HTTP endpoint) */
async function runDigestCron(
  env: Env,
  period: DigestPeriod
): Promise<{ sent: number; errors: number; dailies: string[] }> {
  const dailiesWithManagers = getDailiesWithManagers();
  let sent = 0;
  let errors = 0;
  const processedDailies: string[] = [];

  const db = getDb(env.DATABASE_URL);

  for (const daily of dailiesWithManagers) {
    const managers = getDailyManagers(daily);
    if (managers.length === 0) continue;

    const schedule = getSchedule(daily.schedule);
    if (!schedule) {
      console.error(`Schedule "${daily.schedule}" not found for daily "${daily.name}"`);
      errors++;
      continue;
    }

    try {
      const result = await sendDigestToManagers(env, db, daily, managers, schedule, period);
      sent += result.sent;
      errors += result.errors;
      processedDailies.push(daily.name);
    } catch (err) {
      console.error(`Failed to send digest for "${daily.name}":`, err);
      errors++;
    }
  }

  return { sent, errors, dailies: processedDailies };
}

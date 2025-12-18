/**
 * Cloudflare Workers entry point
 * Routes requests to appropriate handlers
 */

import { loadConfig, getDailies, getSchedules, getConfigError } from '../lib/config';
import { verifySlackSignature, parseCommandPayload } from '../lib/slack';
import { getDb, deleteOldSubmissions, deleteOldPrompts } from '../lib/db';
import { runPromptCron, formatDate } from '../lib/prompt';
import { handleCommand } from '../lib/handlers/commands';
import { handleInteraction, InteractionPayload } from '../lib/handlers/interactions';

// ============================================================================
// Types
// ============================================================================

export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DATABASE_URL: string;
  CRON_SECRET?: string;
}

// ============================================================================
// HTTP Handler
// ============================================================================

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
        return handleSlackInteractions(request, env);
      }

      // Cron: prompt users
      if (path === '/api/cron/prompt') {
        return handlePromptCron(url, env);
      }

      // Cron: cleanup old data
      if (path === '/api/cron/cleanup') {
        return handleCleanupCron(url, env);
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
      const stats = await runPromptCron(db, env.SLACK_BOT_TOKEN);
      console.log('Prompt cron complete:', stats);
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
  const args = payload.text.trim().split(/\s+/);
  const subcommand = args[0]?.toLowerCase() || 'help';

  console.log('Command:', { subcommand, user_id: payload.user_id });

  const db = getDb(env.DATABASE_URL);
  const response = await handleCommand(subcommand, {
    userId: payload.user_id,
    args,
    db,
    slackToken: env.SLACK_BOT_TOKEN,
  });

  return new Response(JSON.stringify(response), {
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Slack interactions endpoint */
async function handleSlackInteractions(request: Request, env: Env): Promise<Response> {
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
  await handleInteraction(payload, {
    db,
    slackToken: env.SLACK_BOT_TOKEN,
  });

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

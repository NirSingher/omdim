/**
 * Cloudflare Workers entry point
 * Routes requests to appropriate handlers
 */

export interface Env {
  SLACK_BOT_TOKEN: string;
  SLACK_SIGNING_SECRET: string;
  DATABASE_URL: string;
  CRON_SECRET?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Health check
      if (path === '/api/health' || path === '/health') {
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Slack commands
      if (path === '/api/slack/commands') {
        // TODO: Implement in Step 3
        return new Response('Not implemented', { status: 501 });
      }

      // Slack interactions (modals, buttons)
      if (path === '/api/slack/interact') {
        // TODO: Implement in Step 6
        return new Response('Not implemented', { status: 501 });
      }

      // Cron: prompt users
      if (path === '/api/cron/prompt') {
        // Verify cron secret if using external cron
        const secret = url.searchParams.get('secret');
        if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
        // TODO: Implement in Step 5
        return new Response('Not implemented', { status: 501 });
      }

      // Cron: cleanup old data
      if (path === '/api/cron/cleanup') {
        const secret = url.searchParams.get('secret');
        if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }
        // TODO: Implement in Step 11
        return new Response('Not implemented', { status: 501 });
      }

      return new Response('Not found', { status: 404 });
    } catch (error) {
      console.error('Error:', error);
      return new Response('Internal server error', { status: 500 });
    }
  },

  // Cloudflare cron trigger handler
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Determine which cron job based on the cron expression
    // */30 * * * * = prompt (every 30 min)
    // 0 3 * * * = cleanup (daily 3am UTC)

    const cronPattern = event.cron;

    if (cronPattern === '*/30 * * * *') {
      // TODO: Run prompt logic
      console.log('Running prompt cron job');
    } else if (cronPattern === '0 3 * * *') {
      // TODO: Run cleanup logic (runs daily, deletes data >28 days old)
      console.log('Running cleanup cron job');
    }
  },
};

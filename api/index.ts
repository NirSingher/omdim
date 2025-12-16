/**
 * Cloudflare Workers entry point
 * Routes requests to appropriate handlers
 */

import { loadConfig, getDailies, getSchedules, isAdmin, getDaily } from '../lib/config';
import {
  verifySlackSignature,
  parseCommandPayload,
  parseUserId,
  ephemeralResponse,
} from '../lib/slack';
import { getDb, addParticipant, removeParticipant, getParticipants } from '../lib/db';

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
        let configStatus = 'unknown';
        let configDetails = {};

        try {
          const config = loadConfig();
          configStatus = 'loaded';
          configDetails = {
            dailies: getDailies().map((d) => d.name),
            schedules: getSchedules().map((s) => s.name),
          };
        } catch (e) {
          configStatus = 'error';
          configDetails = { error: String(e) };
        }

        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          config: {
            status: configStatus,
            ...configDetails,
          },
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Slack commands
      if (path === '/api/slack/commands') {
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

        let response;

        switch (subcommand) {
          case 'help':
            response = ephemeralResponse(
              '*Standup Bot Commands*\n\n' +
              '`/standup help` - Show this help message\n' +
              '`/standup add @user <daily-name>` - Add user to a daily (admin only)\n' +
              '`/standup remove @user <daily-name>` - Remove user from a daily (admin only)\n' +
              '`/standup list <daily-name>` - List participants in a daily\n' +
              '`/standup digest <daily-name>` - Get today\'s standup digest (DM)\n' +
              '`/standup week <daily-name>` - Get weekly summary (DM)'
            );
            break;

          case 'add': {
            if (!isAdmin(payload.user_id)) {
              response = ephemeralResponse('❌ Only admins can add users.');
              break;
            }
            const addUserId = parseUserId(args[1] || '');
            const addDailyName = args[2];
            if (!addUserId || !addDailyName) {
              response = ephemeralResponse('Usage: `/standup add @user <daily-name>`');
              break;
            }
            const addDaily = getDaily(addDailyName);
            if (!addDaily) {
              response = ephemeralResponse(`❌ Daily "${addDailyName}" not found.`);
              break;
            }
            try {
              const db = getDb(env.DATABASE_URL);
              await addParticipant(db, addUserId, addDailyName, addDaily.schedule);
              response = ephemeralResponse(`✅ Added <@${addUserId}> to *${addDailyName}*`);
            } catch (err) {
              console.error('Failed to add participant:', err);
              response = ephemeralResponse('❌ Failed to add user. Please try again.');
            }
            break;
          }

          case 'remove': {
            if (!isAdmin(payload.user_id)) {
              response = ephemeralResponse('❌ Only admins can remove users.');
              break;
            }
            const removeUserId = parseUserId(args[1] || '');
            const removeDailyName = args[2];
            if (!removeUserId || !removeDailyName) {
              response = ephemeralResponse('Usage: `/standup remove @user <daily-name>`');
              break;
            }
            try {
              const db = getDb(env.DATABASE_URL);
              await removeParticipant(db, removeUserId, removeDailyName);
              response = ephemeralResponse(`✅ Removed <@${removeUserId}> from *${removeDailyName}*`);
            } catch (err) {
              console.error('Failed to remove participant:', err);
              response = ephemeralResponse('❌ Failed to remove user. Please try again.');
            }
            break;
          }

          case 'list': {
            const listDailyName = args[1];
            if (!listDailyName) {
              const dailies = getDailies();
              response = ephemeralResponse(
                '*Available dailies:*\n' +
                dailies.map(d => `• ${d.name} (${d.channel})`).join('\n')
              );
              break;
            }
            const listDaily = getDaily(listDailyName);
            if (!listDaily) {
              response = ephemeralResponse(`❌ Daily "${listDailyName}" not found.`);
              break;
            }
            try {
              const db = getDb(env.DATABASE_URL);
              const participants = await getParticipants(db, listDailyName);
              if (participants.length === 0) {
                response = ephemeralResponse(`*${listDailyName}* has no participants yet.`);
              } else {
                const userList = participants.map(p => `• <@${p.slack_user_id}>`).join('\n');
                response = ephemeralResponse(`*${listDailyName}* participants:\n${userList}`);
              }
            } catch (err) {
              console.error('Failed to list participants:', err);
              response = ephemeralResponse('❌ Failed to list participants. Please try again.');
            }
            break;
          }

          case 'digest':
          case 'week':
            response = ephemeralResponse(`📊 \`/standup ${subcommand}\` coming soon!`);
            break;

          default:
            response = ephemeralResponse(
              `Unknown command: \`${subcommand}\`\nTry \`/standup help\` for usage.`
            );
        }

        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' },
        });
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

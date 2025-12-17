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
import { getDb, addParticipant, removeParticipant, getParticipants, getPreviousSubmission, saveSubmission, markPromptSubmitted, updateSubmissionMessageTs, getSubmissionsForDate, getSubmissionsInRange, getParticipationStats, deleteOldSubmissions, deleteOldPrompts } from '../lib/db';
import { postStandupToChannel, formatDailyDigest, formatWeeklySummary, sendDM } from '../lib/format';
import { runPromptCron } from '../lib/prompt';
import { buildStandupModal, openModal, YesterdayData } from '../lib/modal';
import { formatDate, getUserDate, getUserTimezone } from '../lib/prompt';

// Rich text element types from Slack
interface RichTextElement {
  type: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  url?: string;
  elements?: RichTextElement[];
}

interface RichTextBlock {
  type: string;
  elements?: RichTextElement[];
}

// Parse rich_text_input value to mrkdwn string with @mentions
function parseRichText(richText: RichTextBlock): string {
  if (!richText?.elements) return '';

  const parts: string[] = [];

  for (const block of richText.elements) {
    if (block.elements) {
      for (const el of block.elements) {
        if (el.type === 'text' && el.text) {
          parts.push(el.text);
        } else if (el.type === 'user' && el.user_id) {
          parts.push(`<@${el.user_id}>`);
        } else if (el.type === 'channel' && el.channel_id) {
          parts.push(`<#${el.channel_id}>`);
        } else if (el.type === 'link' && el.url) {
          parts.push(el.url);
        }
      }
    }
  }

  return parts.join('').trim();
}

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

          case 'digest': {
            const digestDailyName = args[1];
            if (!digestDailyName) {
              response = ephemeralResponse('Usage: `/standup digest <daily-name>`');
              break;
            }
            const digestDaily = getDaily(digestDailyName);
            if (!digestDaily) {
              response = ephemeralResponse(`❌ Daily "${digestDailyName}" not found.`);
              break;
            }
            try {
              const db = getDb(env.DATABASE_URL);
              // Get user's timezone for today's date
              const userInfo = await getUserTimezone(env.SLACK_BOT_TOKEN, payload.user_id);
              const tzOffset = userInfo?.tz_offset || 0;
              const userDate = getUserDate(tzOffset);
              const todayStr = formatDate(userDate);

              const submissions = await getSubmissionsForDate(db, digestDailyName, todayStr);
              const digestText = formatDailyDigest(digestDailyName, todayStr, submissions);

              // Send as DM
              await sendDM(env.SLACK_BOT_TOKEN, payload.user_id, digestText);
              response = ephemeralResponse(`📊 Digest sent to your DMs!`);
            } catch (err) {
              console.error('Failed to generate digest:', err);
              response = ephemeralResponse('❌ Failed to generate digest. Please try again.');
            }
            break;
          }

          case 'week': {
            const weekDailyName = args[1];
            if (!weekDailyName) {
              response = ephemeralResponse('Usage: `/standup week <daily-name>`');
              break;
            }
            const weekDaily = getDaily(weekDailyName);
            if (!weekDaily) {
              response = ephemeralResponse(`❌ Daily "${weekDailyName}" not found.`);
              break;
            }
            try {
              const db = getDb(env.DATABASE_URL);
              // Get user's timezone for date calculations
              const userInfo = await getUserTimezone(env.SLACK_BOT_TOKEN, payload.user_id);
              const tzOffset = userInfo?.tz_offset || 0;
              const userDate = getUserDate(tzOffset);
              const endDate = formatDate(userDate);

              // Go back 7 days
              const startDateObj = new Date(userDate);
              startDateObj.setDate(startDateObj.getDate() - 6);
              const startDate = formatDate(startDateObj);

              const submissions = await getSubmissionsInRange(db, weekDailyName, startDate, endDate);
              const stats = await getParticipationStats(db, weekDailyName, startDate, endDate);
              const weekText = formatWeeklySummary(weekDailyName, startDate, endDate, submissions, stats);

              // Send as DM
              await sendDM(env.SLACK_BOT_TOKEN, payload.user_id, weekText);
              response = ephemeralResponse(`📈 Weekly summary sent to your DMs!`);
            } catch (err) {
              console.error('Failed to generate weekly summary:', err);
              response = ephemeralResponse('❌ Failed to generate weekly summary. Please try again.');
            }
            break;
          }

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

        // Parse interaction payload (it's URL encoded with a 'payload' field containing JSON)
        const params = new URLSearchParams(body);
        const payloadStr = params.get('payload');
        if (!payloadStr) {
          return new Response('Missing payload', { status: 400 });
        }

        const payload = JSON.parse(payloadStr) as {
          type: string;
          trigger_id: string;
          user: { id: string };
          actions?: Array<{ action_id: string; value: string }>;
          view?: {
            callback_id: string;
            private_metadata: string;
            state: {
              values: Record<string, Record<string, {
                value?: string;
                selected_options?: Array<{ value: string }>;
                rich_text?: RichTextBlock;
              }>>;
            };
          };
        };

        console.log('Interaction:', { type: payload.type, user: payload.user.id });

        // Handle button click (open_standup)
        if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'open_standup') {
          const dailyName = payload.actions[0].value;
          const userId = payload.user.id;
          const triggerId = payload.trigger_id;

          // Get daily config
          const daily = getDaily(dailyName);
          if (!daily) {
            console.error(`Daily "${dailyName}" not found`);
            return new Response('', { status: 200 });
          }

          // Get user's timezone and calculate today's date
          const userInfo = await getUserTimezone(env.SLACK_BOT_TOKEN, userId);
          const tzOffset = userInfo?.tz_offset || 0;
          const userDate = getUserDate(tzOffset);
          const todayStr = formatDate(userDate);

          // Get previous submission for pre-fill (most recent, regardless of how many days ago)
          const db = getDb(env.DATABASE_URL);
          const previousSubmission = await getPreviousSubmission(db, userId, dailyName, todayStr);

          let yesterdayData: YesterdayData | null = null;
          if (previousSubmission && previousSubmission.today_plans) {
            // Parse the JSONB arrays
            const plans = Array.isArray(previousSubmission.today_plans)
              ? previousSubmission.today_plans
              : JSON.parse(previousSubmission.today_plans as unknown as string);

            yesterdayData = {
              plans,
              completed: [], // Will be selected by user
              incomplete: [], // Don't pre-fill - carried over items are added automatically to the post
            };
          }

          // Build and open modal
          const modal = buildStandupModal(dailyName, yesterdayData, daily.questions || []);
          const opened = await openModal(env.SLACK_BOT_TOKEN, triggerId, modal);

          if (!opened) {
            console.error('Failed to open modal');
          }

          // Acknowledge the button click
          return new Response('', { status: 200 });
        }

        // Handle modal submission
        if (payload.type === 'view_submission' && payload.view?.callback_id === 'standup_submission') {
          const userId = payload.user.id;
          const values = payload.view.state.values;
          const metadata = JSON.parse(payload.view.private_metadata) as { dailyName: string };
          const dailyName = metadata.dailyName;

          console.log('Modal submitted for', dailyName, 'by', userId);

          // Get user's timezone and calculate today's date
          const userInfo = await getUserTimezone(env.SLACK_BOT_TOKEN, userId);
          const tzOffset = userInfo?.tz_offset || 0;
          const userDate = getUserDate(tzOffset);
          const todayStr = formatDate(userDate);

          // Get previous submission to know what items were planned
          const db = getDb(env.DATABASE_URL);
          const previousSubmission = await getPreviousSubmission(db, userId, dailyName, todayStr);

          // Parse previous submission's plans
          let previousPlans: string[] = [];
          if (previousSubmission?.today_plans) {
            previousPlans = Array.isArray(previousSubmission.today_plans)
              ? previousSubmission.today_plans
              : JSON.parse(previousSubmission.today_plans as unknown as string);
          }

          // Get checked items (completed from previous plans)
          const completedValues = values.yesterday_completed?.completed_items?.selected_options || [];
          const completedIndices = completedValues.map((opt: { value: string }) => {
            const match = opt.value.match(/plan_(\d+)/);
            return match ? parseInt(match[1]) : -1;
          }).filter((i: number) => i >= 0);

          const yesterdayCompleted = completedIndices.map((i: number) => previousPlans[i]).filter(Boolean);
          const yesterdayIncomplete = previousPlans.filter((_, i) => !completedIndices.includes(i));

          // Parse text inputs (split by newlines, trim, filter empty)
          const parseLines = (text: string | undefined): string[] => {
            if (!text) return [];
            return text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          };

          const unplanned = parseLines(values.unplanned?.unplanned_input?.value);
          const todayPlans = parseLines(values.today_plans?.plans_input?.value);
          const blockers = values.blockers?.blockers_input?.value || '';

          // Parse custom question answers (rich_text_input format)
          const daily = getDaily(dailyName);
          const customAnswers: Record<string, string> = {};
          if (daily?.questions) {
            daily.questions.forEach((q, index) => {
              const richText = values[`custom_${index}`]?.[`custom_input_${index}`]?.rich_text;
              if (richText) {
                const answer = parseRichText(richText);
                if (answer) {
                  customAnswers[q.text] = answer;
                }
              }
            });
          }

          // Save submission
          const submission = await saveSubmission(db, {
            slackUserId: userId,
            dailyName,
            date: todayStr,
            yesterdayCompleted,
            yesterdayIncomplete,
            unplanned,
            todayPlans,
            blockers,
            customAnswers,
          });

          // Mark prompt as submitted
          await markPromptSubmitted(db, userId, dailyName, todayStr);

          console.log('Submission saved:', { userId, dailyName, todayPlans: todayPlans.length });

          // Post to channel
          if (daily?.channel) {
            const messageTs = await postStandupToChannel(
              env.SLACK_BOT_TOKEN,
              daily.channel,
              userId,
              dailyName,
              {
                yesterdayCompleted,
                yesterdayIncomplete,
                unplanned,
                todayPlans,
                blockers,
                customAnswers,
              }
            );

            // Store message timestamp for future reference
            if (messageTs && submission.id) {
              await updateSubmissionMessageTs(db, submission.id, messageTs);
            }
          }

          // Return empty response to close modal
          return new Response('', { status: 200 });
        }

        // Unknown interaction type
        return new Response('', { status: 200 });
      }

      // Cron: prompt users
      if (path === '/api/cron/prompt') {
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

      // Cron: cleanup old data
      if (path === '/api/cron/cleanup') {
        const secret = url.searchParams.get('secret');
        if (env.CRON_SECRET && secret !== env.CRON_SECRET) {
          return new Response('Unauthorized', { status: 401 });
        }

        // Delete data older than 28 days
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - 28);
        const cutoffStr = formatDate(cutoffDate);

        const db = getDb(env.DATABASE_URL);
        const deletedSubmissions = await deleteOldSubmissions(db, cutoffStr);
        const deletedPrompts = await deleteOldPrompts(db, cutoffStr);

        console.log(`Cleanup complete: ${deletedSubmissions} submissions, ${deletedPrompts} prompts deleted`);

        return new Response(JSON.stringify({
          status: 'ok',
          cutoffDate: cutoffStr,
          deletedSubmissions,
          deletedPrompts,
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
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
      console.log('Running prompt cron job');
      const db = getDb(env.DATABASE_URL);
      const stats = await runPromptCron(db, env.SLACK_BOT_TOKEN);
      console.log('Prompt cron complete:', stats);
    } else if (cronPattern === '0 3 * * *') {
      console.log('Running cleanup cron job');
      const db = getDb(env.DATABASE_URL);

      // Delete data older than 28 days
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - 28);
      const cutoffStr = formatDate(cutoffDate);

      const deletedSubmissions = await deleteOldSubmissions(db, cutoffStr);
      const deletedPrompts = await deleteOldPrompts(db, cutoffStr);

      console.log(`Cleanup complete: ${deletedSubmissions} submissions, ${deletedPrompts} prompts deleted`);
    }
  },
};

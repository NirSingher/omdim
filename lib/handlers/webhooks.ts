/**
 * Webhook handlers for external integrations
 * Currently: Linear issue status changes → standup auto-update
 */

import { DbClient, WorkItem, getActiveWorkItemsBySourceRef, updateWorkItemStatus, updateSubmissionArrays, getSubmissionForDate } from '../db';
import { getDaily, getLinearIntelligenceConfig, getGitHubConfig } from '../config';
import { sendDM, updateMessage } from '../slack';
import { formatStandupBlocks, StandupData } from '../format';
import { handleAppHomeOpened, AppHomeOpenedEvent, HomeContext } from './home';
import { formatDate } from '../prompt';
import { getInProgressCarryCounts } from '../db';
import { Env } from '../../api/index';

// ============================================================================
// Types
// ============================================================================

export interface LinearWebhookPayload {
  action: 'create' | 'update' | 'remove';
  type: string; // "Issue", "Comment", etc.
  data: {
    id: string;
    identifier: string;
    title: string;
    state: { id: string; name: string; type: string };
    assignee?: { id: string };
    priority: number;
    url: string;
  };
  updatedFrom?: {
    stateId?: string;
  };
  url: string;
  createdAt: string;
  webhookTimestamp: number;
}

// ============================================================================
// Signature Verification
// ============================================================================

/**
 * Verify Linear webhook signature (HMAC-SHA256)
 * Linear sends the signature in the "Linear-Signature" header.
 * It's computed as: HMAC-SHA256(webhookSecret, rawBody)
 */
export async function verifyLinearSignature(
  body: string,
  signature: string,
  secret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return expected === signature;
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle incoming Linear webhook request.
 * Called from api/index.ts for POST /api/webhooks/linear
 */
export async function handleLinearWebhook(
  request: Request,
  env: Env,
  db: DbClient,
  ctx?: ExecutionContext
): Promise<Response> {
  // 1. Read body as text (must be done before any other body access)
  const body = await request.text();

  // 2. Get signature header (Linear may send it lowercase or title-case)
  const signature =
    request.headers.get('Linear-Signature') ||
    request.headers.get('linear-signature') ||
    '';

  // 3. Get secret — if not configured, skip processing gracefully
  const secret = env.LINEAR_WEBHOOK_SECRET;
  if (!secret) {
    console.log('LINEAR_WEBHOOK_SECRET not configured — skipping Linear webhook');
    return new Response('OK', { status: 200 });
  }

  // 4. Verify signature
  const isValid = await verifyLinearSignature(body, signature, secret);
  if (!isValid) {
    console.warn('Linear webhook signature verification failed');
    return new Response('Unauthorized', { status: 401 });
  }

  // 5. Parse payload
  let payload: LinearWebhookPayload;
  try {
    payload = JSON.parse(body) as LinearWebhookPayload;
  } catch (err) {
    console.error('Failed to parse Linear webhook body:', err);
    return new Response('Bad Request', { status: 400 });
  }

  // 6. Only process issue updates
  if (payload.action !== 'update' || payload.type !== 'Issue') {
    return new Response('OK', { status: 200 });
  }

  // 7. Only process if the state actually changed
  if (!payload.updatedFrom?.stateId) {
    return new Response('OK', { status: 200 });
  }

  // 8. Look up work items to check auto_update config and find the daily
  const identifier = payload.data.identifier;
  const items = await getActiveWorkItemsBySourceRef(db, identifier);

  if (items.length === 0) {
    // Issue not tracked in any standup — ignore
    return new Response('OK', { status: 200 });
  }

  // Check auto_update config using the first matching item's daily
  const firstDaily = getDaily(items[0].daily_name);
  if (!firstDaily) {
    return new Response('OK', { status: 200 });
  }
  const intelConfig = getLinearIntelligenceConfig(firstDaily);
  if (!intelConfig?.auto_update) {
    return new Response('OK', { status: 200 });
  }

  // 9. Process status change — run synchronously (fast enough for 5s window)
  const process = processIssueStatusChange(payload, items, db, env.SLACK_BOT_TOKEN, env, ctx);

  if (ctx) {
    ctx.waitUntil(process);
  } else {
    await process;
  }

  return new Response('OK', { status: 200 });
}

// ============================================================================
// Status Change Processor
// ============================================================================

/**
 * Map Linear state type to internal work item status.
 * Returns null for state types we don't act on.
 */
function mapLinearState(stateType: string): 'done' | 'in_progress' | null {
  switch (stateType) {
    case 'completed':
      return 'done';
    case 'started':
      return 'in_progress';
    default:
      return null;
  }
}

/**
 * Parse JSONB arrays from database (handles both array and string formats)
 */
function parseJsonArray(value: string[] | null): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value as unknown as string);
  } catch {
    return [];
  }
}

/**
 * Process an issue status change from a Linear webhook.
 * For each matching work item:
 *   - Update work item status
 *   - Sync submission JSONB arrays
 *   - Update channel post
 *   - Refresh App Home
 *   - Send DM notification
 */
async function processIssueStatusChange(
  payload: LinearWebhookPayload,
  items: WorkItem[],
  db: DbClient,
  slackToken: string,
  env: Env,
  ctx?: ExecutionContext
): Promise<void> {
  const newStateType = payload.data.state.type;
  const newStatus = mapLinearState(newStateType);

  if (!newStatus) {
    // State type not actionable (e.g., "backlog", "cancelled") — skip
    return;
  }

  const todayStr = formatDate(new Date());

  for (const item of items) {
    try {
      // a. Update work item status
      await updateWorkItemStatus(db, item.id, newStatus, newStatus === 'done' ? todayStr : undefined);

      // b. Sync submission JSONB arrays if we have a submission
      if (item.submission_id) {
        await updateSubmissionArrays(db, item.submission_id, item.slack_user_id, item.daily_name, item.created_date);
      }

      // c. Get daily config for the channel
      const daily = getDaily(item.daily_name);
      if (!daily) continue;

      // d. Update channel post if it exists
      const submission = item.submission_id
        ? await getSubmissionForDate(db, item.slack_user_id, item.daily_name, item.created_date)
        : null;

      if (submission?.posted && submission.slack_message_ts) {
        await syncChannelPost(db, slackToken, item.slack_user_id, item.daily_name, item.created_date, submission, daily);
      }

      // e. Refresh App Home (non-critical — run in background if we have ctx)
      const homeRefresh = refreshAppHome(db, slackToken, item.slack_user_id, env);
      if (ctx) {
        ctx.waitUntil(homeRefresh);
      } else {
        await homeRefresh;
      }

      // f. Send DM notification
      const emoji = newStatus === 'done' ? '✅' : '🔄';
      const statusLabel = newStatus === 'done' ? 'marked done' : 'marked in progress';
      const dmText = `${emoji} Linear auto-update: [${payload.data.identifier}] ${payload.data.title} — ${statusLabel}`;
      const dmSend = sendDM(slackToken, item.slack_user_id, dmText);
      if (ctx) {
        ctx.waitUntil(dmSend);
      } else {
        await dmSend;
      }
    } catch (err) {
      console.error(`Failed to process webhook update for work item ${item.id}:`, err);
      // Continue processing remaining items — don't let one failure block others
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Rebuild and push the updated standup post to the channel.
 * Mirrors syncStandupPost from interactions.ts.
 */
async function syncChannelPost(
  db: DbClient,
  slackToken: string,
  userId: string,
  dailyName: string,
  date: string,
  submission: Awaited<ReturnType<typeof getSubmissionForDate>>,
  daily: ReturnType<typeof getDaily>
): Promise<void> {
  if (!submission || !daily) return;

  const inProgressItems = parseJsonArray(submission.yesterday_in_progress);
  let inProgressCarryCounts: Record<string, number> | undefined;
  if (inProgressItems.length > 0) {
    try {
      inProgressCarryCounts = await getInProgressCarryCounts(db, userId, dailyName, inProgressItems);
    } catch (err) {
      console.error('Failed to get in-progress carry counts for webhook sync:', err);
    }
  }

  const githubOrg = getGitHubConfig(daily)?.org;

  const data: StandupData = {
    yesterdayCompleted: parseJsonArray(submission.yesterday_completed),
    yesterdayIncomplete: parseJsonArray(submission.yesterday_incomplete),
    yesterdayInProgress: inProgressItems,
    yesterdayDropped: [],
    unplanned: parseJsonArray(submission.unplanned),
    todayPlans: parseJsonArray(submission.today_plans),
    blockers: submission.blockers || '',
    customAnswers: submission.custom_answers || {},
    questions: daily.questions,
    fieldOrder: daily.field_order,
    inProgressCarryCounts,
    githubOrg,
  };

  const blocks = formatStandupBlocks(userId, dailyName, data);
  const fallbackText = `*<@${userId}>* submitted their standup`;

  await updateMessage(slackToken, daily.channel, submission.slack_message_ts!, fallbackText, blocks);
}

/**
 * Refresh the App Home view for a user.
 */
async function refreshAppHome(
  db: DbClient,
  slackToken: string,
  userId: string,
  env: Env
): Promise<void> {
  try {
    const event: AppHomeOpenedEvent = { type: 'app_home_opened', user: userId, tab: 'home' };
    const homeCtx: HomeContext = { db, slackToken, env };
    await handleAppHomeOpened(event, homeCtx);
  } catch (err) {
    console.error(`Failed to refresh App Home for ${userId}:`, err);
  }
}

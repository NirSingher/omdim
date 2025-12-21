/**
 * Slack interaction handlers for buttons and modal submissions
 * Handles: open_standup button, standup_submission modal
 */

import { getDaily, getConfigError } from '../config';
import {
  DbClient,
  getPreviousSubmission,
  saveSubmission,
  markPromptSubmitted,
  updateSubmissionMessageTs,
  markItemsDone,
  markItemsDropped,
  incrementCarryCount,
  createWorkItems,
} from '../db';
import { postStandupToChannel } from '../format';
import { buildStandupModal, YesterdayData } from '../modal';
import { formatDate, getUserDate, getUserTimezone } from '../prompt';
import { openModal, parseRichText, RichTextBlock } from '../slack';

// ============================================================================
// Types
// ============================================================================

export interface InteractionContext {
  db: DbClient;
  slackToken: string;
}

/** Slack interaction payload type */
export interface InteractionPayload {
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
        selected_option?: { value: string };
        selected_options?: Array<{ value: string }>;
        rich_text_value?: RichTextBlock;  // Slack uses rich_text_value, not rich_text
      }>>;
    };
  };
}

// ============================================================================
// Button Handler: Open Standup
// ============================================================================

/**
 * Handle "Open Standup" button click
 * Opens the standup modal with yesterday's plans pre-loaded
 */
export async function handleOpenStandup(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const dailyName = payload.actions?.[0]?.value;
  if (!dailyName) {
    console.error('No daily name in open_standup action');
    return false;
  }

  const userId = payload.user.id;
  const triggerId = payload.trigger_id;

  // Get daily config
  const daily = getDaily(dailyName);
  if (!daily) {
    console.error(`Daily "${dailyName}" not found`);
    return false;
  }

  // Get user's timezone and calculate today's date
  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const userDate = getUserDate(tzOffset);
  const todayStr = formatDate(userDate);

  // Get previous submission for pre-fill
  const previousSubmission = await getPreviousSubmission(ctx.db, userId, dailyName, todayStr);

  let yesterdayData: YesterdayData | null = null;
  if (previousSubmission && previousSubmission.today_plans) {
    const plans = Array.isArray(previousSubmission.today_plans)
      ? previousSubmission.today_plans
      : JSON.parse(previousSubmission.today_plans as unknown as string);

    yesterdayData = {
      plans,
      completed: [],
      incomplete: [],
    };
  }

  // Build and open modal
  const modal = buildStandupModal(dailyName, yesterdayData, daily.questions || [], daily.field_order, userDate);
  return openModal(ctx.slackToken, triggerId, modal);
}

// ============================================================================
// Modal Handler: Standup Submission
// ============================================================================

/**
 * Parse text input into array of lines
 */
function parseLines(text: string | undefined): string[] {
  if (!text) return [];
  return text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
}

/**
 * Handle standup modal submission
 * Saves submission and posts to channel
 */
export async function handleStandupSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;
  const values = payload.view!.state.values;
  const metadata = JSON.parse(payload.view!.private_metadata) as {
    dailyName: string;
    yesterdayPlans?: string[];
  };
  const dailyName = metadata.dailyName;
  const yesterdayPlanItems = metadata.yesterdayPlans || [];

  console.log('Modal submitted for', dailyName, 'by', userId);

  // Get user's timezone and calculate today's date
  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const userDate = getUserDate(tzOffset);
  const todayStr = formatDate(userDate);

  // Parse dropdown selections for yesterday's items
  const yesterdayCompleted: string[] = [];
  const yesterdayIncomplete: string[] = [];
  const yesterdayDropped: string[] = [];

  yesterdayPlanItems.forEach((item, index) => {
    const selectedOption = values[`yesterday_item_${index}`]?.[`item_status_${index}`]?.selected_option;
    const status = selectedOption?.value || 'continue';

    if (status === 'done') {
      yesterdayCompleted.push(item);
    } else if (status === 'continue') {
      yesterdayIncomplete.push(item);
    } else if (status === 'drop') {
      yesterdayDropped.push(item);
    }
  });

  // Parse text inputs
  const unplanned = parseLines(values.unplanned?.unplanned_input?.value);
  const todayPlans = parseLines(values.today_plans?.plans_input?.value);
  const blockers = parseRichText(values.blockers?.blockers_input?.rich_text_value) || '';

  // Parse custom question answers
  const daily = getDaily(dailyName);
  const customAnswers: Record<string, string> = {};
  if (daily?.questions) {
    daily.questions.forEach((q, index) => {
      const blockId = `custom_${index}`;
      const actionId = `custom_input_${index}`;
      const richText = values[blockId]?.[actionId]?.rich_text_value;
      if (richText) {
        const answer = parseRichText(richText);
        if (answer) {
          customAnswers[q.text] = answer;
        }
      }
    });
  }

  // Save submission
  const submission = await saveSubmission(ctx.db, {
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
  await markPromptSubmitted(ctx.db, userId, dailyName, todayStr);

  // Track work items for analytics
  try {
    // Mark yesterday's items based on status
    if (yesterdayCompleted.length > 0) {
      await markItemsDone(ctx.db, userId, dailyName, yesterdayCompleted, todayStr);
    }
    if (yesterdayDropped.length > 0) {
      await markItemsDropped(ctx.db, userId, dailyName, yesterdayDropped);
    }
    if (yesterdayIncomplete.length > 0) {
      await incrementCarryCount(ctx.db, userId, dailyName, yesterdayIncomplete);
    }

    // Create new work items for today's plans
    if (todayPlans.length > 0) {
      await createWorkItems(
        ctx.db,
        todayPlans.map(text => ({
          slackUserId: userId,
          dailyName,
          text,
          date: todayStr,
          submissionId: submission.id,
        }))
      );
    }
  } catch (error) {
    // Don't fail the submission if work item tracking fails
    console.error('Failed to track work items:', error);
  }

  console.log('Submission saved:', { userId, dailyName, todayPlans: todayPlans.length });

  // Post to channel
  if (daily?.channel) {
    const messageTs = await postStandupToChannel(
      ctx.slackToken,
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
      await updateSubmissionMessageTs(ctx.db, submission.id, messageTs);
    }
  }

  return true;
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Route an interaction to the appropriate handler
 * @returns true if handled, false otherwise
 */
export async function handleInteraction(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  // Check for config errors
  const configErr = getConfigError();
  if (configErr) {
    console.error('Interaction failed due to config error:', configErr);
    return false;
  }

  // Handle button click (open_standup)
  if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'open_standup') {
    return handleOpenStandup(payload, ctx);
  }

  // Handle modal submission
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'standup_submission') {
    return handleStandupSubmission(payload, ctx);
  }

  // Unknown interaction type
  return true;
}

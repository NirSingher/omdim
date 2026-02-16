/**
 * Slack interaction handlers for buttons and modal submissions
 * Handles: open_standup button, standup_submission modal
 */

import { getDaily, getConfigError, getSchedule, getGitHubConfig, getGitHubUsernameFromConfig, getGitHubUserMappings, getLinearConfig, getLinearUserIdFromConfig, getLinearTeamIdForUser } from '../config';
import {
  DbClient,
  getPreviousSubmission,
  saveSubmission,
  markPromptSubmitted,
  updateSubmissionMessageTs,
  markItemsDone,
  markItemsDropped,
  incrementCarryCount,
  markItemsInProgress,
  getInProgressCarryCounts,
  createWorkItems,
  snoozeItem,
  getSubmissionForDate,
  getGitHubUsername,
  getLinearUserId,
  setGitHubUsername,
  setLinearUserId,
  getUsersWithGitHubLinks,
} from '../db';
import { handleAppHomeOpened, AppHomeOpenedEvent, HomeContext } from './home';
import { fetchUserPRData, UserPRData } from '../github';
import { fetchUserAssignedIssues, fetchUserLinearData, LinearIssue } from '../linear';
import { postStandupToChannel } from '../format';
import { buildStandupModal, YesterdayData, SubmissionPrefill } from '../modal';
import { formatDate, getDateInTimezone, getUserDate, getUserTimezone, hasScheduledTimePassed } from '../prompt';
import { openModal, parseRichText, RichTextBlock, sendDM } from '../slack';
import { StandupMode } from '../modal';

// ============================================================================
// Types
// ============================================================================

export interface InteractionContext {
  db: DbClient;
  slackToken: string;
  env?: Record<string, string | undefined>; // For accessing GitHub tokens etc.
  waitUntil?: (promise: Promise<unknown>) => void; // Cloudflare Workers background processing
}

/** Validation error response for modal submissions */
export interface ValidationErrorResponse {
  response_action: 'errors';
  errors: Record<string, string>;
}

/** Handler result: true = success, ValidationErrorResponse = show errors to user */
export type InteractionResult = boolean | ValidationErrorResponse;

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
// Helpers
// ============================================================================

/**
 * Fetch Linear issues for a user if Linear integration is enabled for the daily
 */
export async function fetchLinearIssuesForUser(
  daily: ReturnType<typeof getDaily>,
  userId: string,
  ctx: InteractionContext
): Promise<LinearIssue[]> {
  if (!daily) return [];

  const linearConfig = getLinearConfig(daily);
  if (!linearConfig || !ctx.env) return [];

  const linearToken = ctx.env[linearConfig.tokenEnvVar];
  if (!linearToken) return [];

  // Get Linear user ID: config mapping takes precedence over DB
  let linearUserId = getLinearUserIdFromConfig(daily, userId);
  if (!linearUserId) {
    linearUserId = await getLinearUserId(ctx.db, userId);
  }

  if (!linearUserId) return [];

  // Get per-user team ID (user mapping overrides daily default)
  const teamId = getLinearTeamIdForUser(daily, userId);

  try {
    // If no team_id configured, use cross-team user query
    if (!teamId) {
      const data = await fetchUserAssignedIssues(linearToken, linearUserId);
      return data.issues;
    }
    const data = await fetchUserLinearData(linearToken, teamId, linearUserId);
    return data.issues;
  } catch (error) {
    console.error('Failed to fetch Linear data:', error);
    return [];
  }
}

/**
 * Build a map from GitHub login (lowercase) → Slack user ID
 * Combines config mappings + DB self-linked accounts (config takes precedence)
 */
async function buildGitHubUserMap(
  daily: ReturnType<typeof getDaily>,
  db: DbClient
): Promise<Map<string, string>> {
  if (!daily) return new Map();
  const map = new Map<string, string>();

  // DB links first (lower priority)
  const dbLinks = await getUsersWithGitHubLinks(db);
  for (const link of dbLinks) {
    map.set(link.githubUsername.toLowerCase(), link.slackUserId);
  }

  // Config mappings override DB links
  const configMappings = getGitHubUserMappings(daily);
  for (const mapping of configMappings) {
    map.set(mapping.githubUsername.toLowerCase(), mapping.slackUserId);
  }

  return map;
}

/**
 * Fetch GitHub PRs for a user if GitHub integration is enabled for the daily
 * Returns PR data and reviewer map for tagging reviewers
 */
export async function fetchGitHubPRsForUser(
  daily: ReturnType<typeof getDaily>,
  userId: string,
  ctx: InteractionContext
): Promise<{ prData?: UserPRData; reviewerMap?: Map<string, string> }> {
  if (!daily) return {};

  const githubConfig = getGitHubConfig(daily);
  if (!githubConfig || !ctx.env) return {};

  const githubToken = ctx.env[githubConfig.tokenEnvVar];
  if (!githubToken) return {};

  // Get GitHub username: config mapping takes precedence over DB
  let githubUsername = getGitHubUsernameFromConfig(daily, userId);
  if (!githubUsername) {
    githubUsername = await getGitHubUsername(ctx.db, userId);
  }

  if (!githubUsername) return {};

  try {
    const [prData, reviewerMap] = await Promise.all([
      fetchUserPRData(githubToken, githubUsername, githubConfig.org),
      buildGitHubUserMap(daily, ctx.db),
    ]);
    return { prData, reviewerMap };
  } catch (error) {
    console.error('Failed to fetch GitHub PR data:', error);
    return {};
  }
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
  if (previousSubmission) {
    // Parse today_plans (new items entered yesterday)
    const todayPlans = previousSubmission.today_plans
      ? (Array.isArray(previousSubmission.today_plans)
          ? previousSubmission.today_plans
          : JSON.parse(previousSubmission.today_plans as unknown as string))
      : [];

    // Parse yesterday_incomplete (items carried over yesterday - need to carry again!)
    const carriedItems = previousSubmission.yesterday_incomplete
      ? (Array.isArray(previousSubmission.yesterday_incomplete)
          ? previousSubmission.yesterday_incomplete
          : JSON.parse(previousSubmission.yesterday_incomplete as unknown as string))
      : [];

    // Parse yesterday_in_progress (items marked in progress yesterday)
    const inProgressItems = previousSubmission.yesterday_in_progress
      ? (Array.isArray(previousSubmission.yesterday_in_progress)
          ? previousSubmission.yesterday_in_progress
          : JSON.parse(previousSubmission.yesterday_in_progress as unknown as string))
      : [];

    // Combine: in-progress first, then carried, then new plans
    const allPlans = [...inProgressItems, ...carriedItems, ...todayPlans];

    if (allPlans.length > 0) {
      yesterdayData = {
        plans: allPlans,
        completed: [],
        incomplete: [],
      };
    }
  }

  // Fetch Linear issues and GitHub PRs in parallel
  const [linearIssues, githubResult] = await Promise.all([
    fetchLinearIssuesForUser(daily, userId, ctx),
    fetchGitHubPRsForUser(daily, userId, ctx),
  ]);

  // Build and open modal
  const modal = buildStandupModal(dailyName, yesterdayData, daily.questions || [], daily.field_order, userDate, 'today', undefined, linearIssues, githubResult.prData, githubResult.reviewerMap);
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
): Promise<InteractionResult> {
  const userId = payload.user.id;
  const values = payload.view!.state.values;
  const metadata = JSON.parse(payload.view!.private_metadata) as {
    dailyName: string;
    yesterdayPlans?: string[];
    mode?: StandupMode;
    targetDate?: string;
    unmappedReviewers?: string[];
  };
  const dailyName = metadata.dailyName;
  const yesterdayPlanItems = metadata.yesterdayPlans || [];
  const mode = metadata.mode || 'today';
  const isTomorrowMode = mode === 'tomorrow';

  console.log('Modal submitted for', dailyName, 'by', userId, 'mode:', mode);
  console.log('Values block keys:', Object.keys(values));

  // Get the daily's schedule timezone (avoids Slack API call)
  const daily = getDaily(dailyName);
  const scheduleConfig = daily?.schedule ? getSchedule(daily.schedule) : null;
  const timezone = scheduleConfig?.timezone || 'UTC';
  const userDate = getDateInTimezone(timezone);
  const todayStr = formatDate(userDate);

  // Use targetDate from metadata if in tomorrow mode, otherwise use today
  const submissionDate = isTomorrowMode && metadata.targetDate ? metadata.targetDate : todayStr;

  // Parse dropdown selections for yesterday's items
  const yesterdayCompleted: string[] = [];
  const yesterdayIncomplete: string[] = [];
  const yesterdayInProgress: string[] = [];
  const yesterdayDropped: string[] = [];

  yesterdayPlanItems.forEach((item, index) => {
    const selectedOption = values[`yesterday_item_${index}`]?.[`item_status_${index}`]?.selected_option;
    const status = selectedOption?.value || 'continue';

    if (status === 'done') {
      yesterdayCompleted.push(item);
    } else if (status === 'continue') {
      yesterdayIncomplete.push(item);
    } else if (status === 'in_progress') {
      yesterdayInProgress.push(item);
    } else if (status === 'drop') {
      yesterdayDropped.push(item);
    }
  });

  // Parse text inputs
  const unplanned = parseLines(values.unplanned?.unplanned_input?.value);
  const todayPlans = parseLines(values.today_plans?.plans_input?.value);
  const blockers = parseRichText(values.blockers?.blockers_input?.rich_text_value) || '';

  // Parse Linear ticket selections and append to todayPlans
  // Parse integration checkbox selections — extract display text from the option's text field
  // Format is "*IDENTIFIER* Title" in mrkdwn, so strip the bold markers
  const parseOptionText = (text: string): string => text.replace(/^\*([^*]+)\*\s*/, '[$1] ');

  const linearSelections = values.linear_tickets?.linear_tickets_input?.selected_options;
  if (linearSelections && linearSelections.length > 0) {
    for (const option of linearSelections) {
      todayPlans.push(parseOptionText(option.text?.text || option.value));
    }
  }

  // Parse GitHub PR selections (review requests + my PRs)
  const reviewSelections = values.review_requests?.review_requests_input?.selected_options;
  if (reviewSelections && reviewSelections.length > 0) {
    for (const option of reviewSelections) {
      todayPlans.push(parseOptionText(option.text?.text || option.value));
    }
  }
  const myPrSelections = values.my_prs?.my_prs_input?.selected_options;
  if (myPrSelections && myPrSelections.length > 0) {
    for (const option of myPrSelections) {
      todayPlans.push(parseOptionText(option.text?.text || option.value));
    }
  }

  // Parse reviewer mapping selections and save to DB
  if (metadata.unmappedReviewers && metadata.unmappedReviewers.length > 0) {
    for (const login of metadata.unmappedReviewers) {
      const selectedUser = values[`reviewer_map_${login}`]?.[`reviewer_map_input_${login}`] as { selected_user?: string } | undefined;
      if (selectedUser?.selected_user) {
        try {
          await setGitHubUsername(ctx.db, selectedUser.selected_user, login);
          console.log(`Linked GitHub @${login} → Slack ${selectedUser.selected_user}`);
        } catch (error) {
          console.error(`Failed to save reviewer mapping for ${login}:`, error);
        }
      }
    }
  }

  // Validate: require today's plans if nothing is carried over or in progress
  if (yesterdayIncomplete.length === 0 && yesterdayInProgress.length === 0 && todayPlans.length === 0) {
    return {
      response_action: 'errors',
      errors: {
        today_plans: "Add today's plans or carry over items from yesterday",
      },
    };
  }

  // Parse custom question answers (daily already fetched above for timezone)
  const customAnswers: Record<string, string> = {};
  if (daily?.questions) {
    console.log('Parsing custom questions, count:', daily.questions.length);
    daily.questions.forEach((q, index) => {
      const blockId = `custom_${index}`;
      const actionId = `custom_input_${index}`;
      console.log(`Looking for blockId=${blockId}, actionId=${actionId}`);
      console.log(`Block exists: ${!!values[blockId]}, Action exists: ${!!values[blockId]?.[actionId]}`);
      const richText = values[blockId]?.[actionId]?.rich_text_value;
      console.log(`Rich text value:`, JSON.stringify(richText));
      if (richText) {
        const answer = parseRichText(richText);
        console.log(`Parsed answer for "${q.text}":`, answer);
        if (answer) {
          customAnswers[q.text] = answer;
        }
      }
    });
    console.log('Final customAnswers:', JSON.stringify(customAnswers));
  } else {
    console.log('No questions in daily config');
  }

  // Determine if we should queue the post for later
  // Queue if: tomorrow mode OR today mode but before scheduled posting time
  const scheduledTime = scheduleConfig?.default_time || '10:00';
  const isBeforeScheduledTime = !hasScheduledTimePassed(scheduledTime, userDate);
  const shouldQueue = isTomorrowMode || isBeforeScheduledTime;

  // Run the heavy work (DB saves, API calls) in the background so Slack
  // gets an immediate 200 response and doesn't show "trouble connecting".
  const processSubmission = async () => {
    // Save submission
    const submission = await saveSubmission(ctx.db, {
      slackUserId: userId,
      dailyName,
      date: submissionDate,
      yesterdayCompleted,
      yesterdayIncomplete,
      yesterdayInProgress,
      unplanned,
      todayPlans,
      blockers,
      customAnswers,
      posted: !shouldQueue,
    });

    console.log('Submission saved:', { userId, dailyName, date: submissionDate, mode, shouldQueue, todayPlans: todayPlans.length });

    // Queued mode: send confirmation DM, skip channel post and work item tracking
    if (shouldQueue) {
      // Format the target date for display
      const targetDate = new Date(submissionDate + 'T00:00:00');
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const dateDisplay = `${days[targetDate.getDay()]}, ${months[targetDate.getMonth()]} ${targetDate.getDate()}`;

      // Mark prompt as submitted for the target date (prevents re-prompting)
      await markPromptSubmitted(ctx.db, userId, dailyName, submissionDate);

      // Send confirmation DM
      const confirmationMsg = `✅ *Standup scheduled!*\n\nYour *${dailyName}* standup for *${dateDisplay}* will be posted to ${daily?.channel} at *${scheduledTime}*.\n\nYou can use \`/daily\` to edit it before then.`;
      await sendDM(ctx.slackToken, userId, confirmationMsg);
      return;
    }

    // Today mode: normal flow - mark prompt submitted, track work items, post to channel
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
      if (yesterdayInProgress.length > 0) {
        await markItemsInProgress(ctx.db, userId, dailyName, yesterdayInProgress);
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

    // Get carry counts for in-progress items (for attention warnings)
    let inProgressCarryCounts: Record<string, number> | undefined;
    if (yesterdayInProgress.length > 0) {
      try {
        inProgressCarryCounts = await getInProgressCarryCounts(ctx.db, userId, dailyName, yesterdayInProgress);
      } catch (error) {
        console.error('Failed to get in-progress carry counts:', error);
      }
    }

    // Post to channel
    // NOTE: We do NOT re-fetch PR data here. The user's checkbox selections
    // are already included in todayPlans — re-fetching would show ALL PRs
    // regardless of what the user selected.
    if (daily?.channel) {
      const messageTs = await postStandupToChannel(
        ctx.slackToken,
        daily.channel,
        userId,
        dailyName,
        {
          yesterdayCompleted,
          yesterdayIncomplete,
          yesterdayInProgress,
          yesterdayDropped,
          unplanned,
          todayPlans,
          blockers,
          customAnswers,
          questions: daily.questions,
          fieldOrder: daily.field_order,
          inProgressCarryCounts,
        }
      );

      // Store message timestamp for future reference
      if (messageTs && submission.id) {
        await updateSubmissionMessageTs(ctx.db, submission.id, messageTs);
      }
    }
  };

  // Use waitUntil for background processing if available (Cloudflare Workers),
  // otherwise await inline (tests, local dev)
  if (ctx.waitUntil) {
    ctx.waitUntil(processSubmission().catch(err => console.error('Background submission processing failed:', err)));
  } else {
    await processSubmission();
  }

  return true;
}

// ============================================================================
// Button Handler: Snooze Bottleneck
// ============================================================================

/**
 * Handle "Snooze 7d" button click on bottleneck items
 * Snoozes the item for 7 days so it won't appear in bottleneck reports
 */
export async function handleSnoozeBottleneck(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const valueStr = payload.actions?.[0]?.value;
  if (!valueStr) {
    console.error('No value in snooze_bottleneck action');
    return false;
  }

  try {
    const { itemId, dailyName } = JSON.parse(valueStr) as { itemId: number; dailyName: string };
    const userId = payload.user.id;

    console.log(`Snoozing bottleneck item ${itemId} for daily "${dailyName}" by user ${userId}`);

    // Snooze the item for 7 days
    await snoozeItem(ctx.db, itemId, 7);

    console.log(`Successfully snoozed item ${itemId} for 7 days`);
    return true;
  } catch (error) {
    console.error('Failed to snooze bottleneck item:', error);
    return false;
  }
}

// ============================================================================
// Button Handler: Home Start Daily
// ============================================================================

/**
 * Handle "Start Daily" or "Fill Tomorrow" button click from App Home
 * Opens the standup modal with today/tomorrow logic (same as /daily command)
 */
export async function handleHomeStartDaily(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const dailyName = payload.actions?.[0]?.value;
  if (!dailyName) {
    console.error('No daily name in home_start_daily action');
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

  // Get user's timezone and calculate dates
  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const userDate = getUserDate(tzOffset);
  const todayStr = formatDate(userDate);

  // Calculate tomorrow
  const tomorrowDate = new Date(userDate);
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = formatDate(tomorrowDate);

  // Check if today's submission exists
  const todaySubmission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);

  // Determine mode and target date
  const mode: StandupMode = todaySubmission ? 'tomorrow' : 'today';
  const targetDate = mode === 'today' ? userDate : tomorrowDate;

  // Get yesterday data for pre-fill
  let yesterdayData: YesterdayData | null = null;

  if (mode === 'today') {
    const previousSubmission = await getPreviousSubmission(ctx.db, userId, dailyName, todayStr);
    if (previousSubmission) {
      const todayPlans = previousSubmission.today_plans || [];
      const carriedItems = previousSubmission.yesterday_incomplete || [];
      const inProgressItems = previousSubmission.yesterday_in_progress || [];
      const allPlans = [...inProgressItems, ...carriedItems, ...todayPlans];
      if (allPlans.length > 0) {
        yesterdayData = { plans: allPlans, completed: [], incomplete: [] };
      }
    }
  } else {
    // Tomorrow mode: use today's submission as "yesterday"
    if (todaySubmission) {
      const todayPlans = todaySubmission.today_plans || [];
      const carriedItems = todaySubmission.yesterday_incomplete || [];
      const inProgressItems = todaySubmission.yesterday_in_progress || [];
      const allPlans = [...inProgressItems, ...carriedItems, ...todayPlans];
      if (allPlans.length > 0) {
        yesterdayData = { plans: allPlans, completed: [], incomplete: [] };
      }
    }
  }

  // Check for existing scheduled submission (for editing tomorrow)
  let prefill: SubmissionPrefill | undefined;
  if (mode === 'tomorrow') {
    const existingSubmission = await getSubmissionForDate(ctx.db, userId, dailyName, tomorrowStr);
    if (existingSubmission) {
      prefill = {
        todayPlans: existingSubmission.today_plans || undefined,
        unplanned: existingSubmission.unplanned || undefined,
        blockers: existingSubmission.blockers || undefined,
        customAnswers: existingSubmission.custom_answers || undefined,
      };
    }
  }

  // Fetch Linear issues and GitHub PRs in parallel
  const [linearIssues, githubResult] = await Promise.all([
    fetchLinearIssuesForUser(daily, userId, ctx),
    fetchGitHubPRsForUser(daily, userId, ctx),
  ]);

  // Build and open modal
  const modal = buildStandupModal(
    dailyName,
    yesterdayData,
    daily.questions || [],
    daily.field_order,
    targetDate,
    mode,
    prefill,
    linearIssues,
    githubResult.prData,
    githubResult.reviewerMap
  );

  return openModal(ctx.slackToken, triggerId, modal);
}

// ============================================================================
// Button Handlers: Link/Unlink Accounts
// ============================================================================

/**
 * Refresh the App Home view after link/unlink
 */
async function refreshHome(userId: string, ctx: InteractionContext): Promise<void> {
  const homeCtx: HomeContext = {
    db: ctx.db,
    slackToken: ctx.slackToken,
    env: ctx.env,
  };
  const event: AppHomeOpenedEvent = { type: 'app_home_opened', user: userId, tab: 'home' };
  await handleAppHomeOpened(event, homeCtx);
}

/**
 * Handle "Link GitHub" button — opens a modal with a text input
 */
export async function handleLinkGitHub(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const modal = {
    type: 'modal',
    callback_id: 'github_link_submission',
    title: { type: 'plain_text', text: 'Link GitHub' },
    submit: { type: 'plain_text', text: 'Link' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Enter your GitHub username — it\'s the handle shown in parentheses next to your name at <https://github.com/settings/profile|github.com/settings/profile>, or the part after `github.com/` in your profile URL.',
        },
      },
      {
        type: 'input',
        block_id: 'github_username',
        label: { type: 'plain_text', text: 'GitHub Username' },
        element: {
          type: 'plain_text_input',
          action_id: 'github_username_input',
          placeholder: { type: 'plain_text', text: 'e.g. octocat' },
        },
      },
    ],
  };
  return openModal(ctx.slackToken, payload.trigger_id, modal);
}

/**
 * Handle "Link Linear" button — opens a modal with a text input
 */
export async function handleLinkLinear(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const modal = {
    type: 'modal',
    callback_id: 'linear_link_submission',
    title: { type: 'plain_text', text: 'Link Linear' },
    submit: { type: 'plain_text', text: 'Link' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'Enter your Linear user ID — a UUID like `a1b2c3d4-e5f6-...`. Ask your workspace admin for it, or find it by querying `{ viewer { id } }` in the <https://studio.apollographql.com/sandbox/explorer|GraphQL API explorer> using your Linear API key.',
        },
      },
      {
        type: 'input',
        block_id: 'linear_user_id',
        label: { type: 'plain_text', text: 'Linear User ID' },
        element: {
          type: 'plain_text_input',
          action_id: 'linear_user_id_input',
          placeholder: { type: 'plain_text', text: 'e.g. a1b2c3d4-e5f6-...' },
        },
      },
    ],
  };
  return openModal(ctx.slackToken, payload.trigger_id, modal);
}

/**
 * Handle "Unlink GitHub" button
 */
export async function handleUnlinkGitHub(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;
  await setGitHubUsername(ctx.db, userId, null);
  await refreshHome(userId, ctx);
  return true;
}

/**
 * Handle "Unlink Linear" button
 */
export async function handleUnlinkLinear(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;
  await setLinearUserId(ctx.db, userId, null);
  await refreshHome(userId, ctx);
  return true;
}

/**
 * Handle GitHub link modal submission
 */
export async function handleGitHubLinkSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<InteractionResult> {
  const userId = payload.user.id;
  const username = payload.view!.state.values.github_username?.github_username_input?.value?.trim();
  if (!username) {
    return {
      response_action: 'errors',
      errors: { github_username: 'Please enter your GitHub username' },
    };
  }
  await setGitHubUsername(ctx.db, userId, username);
  await refreshHome(userId, ctx);
  return true;
}

/**
 * Handle Linear link modal submission
 */
export async function handleLinearLinkSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<InteractionResult> {
  const userId = payload.user.id;
  const linearUserId = payload.view!.state.values.linear_user_id?.linear_user_id_input?.value?.trim();
  if (!linearUserId) {
    return {
      response_action: 'errors',
      errors: { linear_user_id: 'Please enter your Linear user ID' },
    };
  }
  await setLinearUserId(ctx.db, userId, linearUserId);
  await refreshHome(userId, ctx);
  return true;
}

// ============================================================================
// Main Router
// ============================================================================

/**
 * Route an interaction to the appropriate handler
 * @returns true if handled, false otherwise, or ValidationErrorResponse for modal errors
 */
export async function handleInteraction(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<InteractionResult> {
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

  // Handle button click (snooze_bottleneck)
  if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'snooze_bottleneck') {
    return handleSnoozeBottleneck(payload, ctx);
  }

  // Handle button click (home_start_daily) - from App Home
  if (payload.type === 'block_actions' && payload.actions?.[0]?.action_id === 'home_start_daily') {
    return handleHomeStartDaily(payload, ctx);
  }

  // Handle link/unlink account buttons from App Home
  if (payload.type === 'block_actions') {
    const actionId = payload.actions?.[0]?.action_id;
    if (actionId === 'home_link_github') return handleLinkGitHub(payload, ctx);
    if (actionId === 'home_link_linear') return handleLinkLinear(payload, ctx);
    if (actionId === 'home_unlink_github') return handleUnlinkGitHub(payload, ctx);
    if (actionId === 'home_unlink_linear') return handleUnlinkLinear(payload, ctx);
  }

  // Handle modal submission
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'standup_submission') {
    return handleStandupSubmission(payload, ctx);
  }

  // Handle link modal submissions
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'github_link_submission') {
    return handleGitHubLinkSubmission(payload, ctx);
  }
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'linear_link_submission') {
    return handleLinearLinkSubmission(payload, ctx);
  }

  // Unknown interaction type
  return true;
}

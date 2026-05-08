/**
 * Slack interaction handlers for buttons and modal submissions
 * Handles: open_standup button, standup_submission modal
 */

import { getDaily, getConfigError, getSchedule, getGitHubConfig, getGitHubUsernameFromConfig, getGitHubUserMappings, getLinearConfig, getLinearUserIdFromConfig, getLinearTeamIdForUser, getMaxPlanItems, isAdmin, getGitHubIntelligenceConfig, getDailySections } from '../config';
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
  linkItemsToSubmission,
  ItemSource,
  snoozeItem,
  getSubmissionForDate,
  getGitHubUsername,
  getLinearUserId,
  setGitHubUsername,
  setLinearUserId,
  getUsersWithGitHubLinks,
  getRecentlyDoneLinearItems,
  getDmStandupPreference,
  setDmStandupPreference,
  updateUserSetting,
  getUserDailies,
  getParticipants,
  setOOO,
  clearOOO,
  updateWorkItemStatus,
  addWorkItem,
  updateSubmissionArrays,
} from '../db';
import { handleAppHomeOpened, AppHomeOpenedEvent, HomeContext } from './home';
import { fetchUserPRData, UserPRData, fetchMergedPRs, MergedPR } from '../github';
import { fetchUserAssignedIssues, fetchUserLinearData, LinearIssue, UserLinearData, extractLinearReferences, fetchWorkflowStates, markIssuesInProgress as markLinearIssuesInProgress, commentOnIssue, resolveIdentifiers } from '../linear';
import { postStandupToChannel, sendStandupDM, formatStandupBlocks, StandupData } from '../format';
import { buildStandupModal, YesterdayData, SubmissionPrefill } from '../modal';
import { formatDate, getDateInTimezone, getUserDate, getUserTimezone, hasScheduledTimePassed, sendPromptDM } from '../prompt';
import { openModal, parseRichText, RichTextBlock, sendDM, updateMessage, extractMentionedUserIds } from '../slack';
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
  actions?: Array<{ action_id: string; value: string; selected_option?: { value: string } }>;
  view?: {
    callback_id: string;
    private_metadata: string;
    state: {
      values: Record<string, Record<string, {
        value?: string;
        selected_option?: { value: string };
        selected_options?: Array<{ value: string; text?: { type: string; text: string } }>;
        selected_date?: string;
        rich_text_value?: RichTextBlock;  // Slack uses rich_text_value, not rich_text
      }>>;
    };
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Timeout for integration API calls — must finish well within Slack's 3-second limit */
const INTEGRATION_TIMEOUT_MS = 2000;

/** Race a promise against a timeout. Rejects on timeout so callers' catch blocks handle it. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Fetch Linear issues for a user if Linear integration is enabled for the daily
 */
interface LinearFetchResult {
  issues: LinearIssue[];
  allActiveIdentifiers: string[];
}

export async function fetchLinearIssuesForUser(
  daily: ReturnType<typeof getDaily>,
  userId: string,
  ctx: InteractionContext
): Promise<LinearFetchResult> {
  const empty: LinearFetchResult = { issues: [], allActiveIdentifiers: [] };
  if (!daily) return empty;

  const linearConfig = getLinearConfig(daily);
  if (!linearConfig || !ctx.env) return empty;

  const linearToken = ctx.env[linearConfig.tokenEnvVar];
  if (!linearToken) return empty;

  // Get Linear user ID: config mapping takes precedence over DB
  let linearUserId = getLinearUserIdFromConfig(daily, userId);
  if (!linearUserId) {
    linearUserId = await getLinearUserId(ctx.db, userId);
  }

  if (!linearUserId) return empty;

  // Get per-user team ID (user mapping overrides daily default)
  const teamId = getLinearTeamIdForUser(daily, userId);

  try {
    // If no team_id configured, use cross-team user query
    if (!teamId) {
      const data = await withTimeout(
        fetchUserAssignedIssues(linearToken, linearUserId),
        INTEGRATION_TIMEOUT_MS, 'Linear API'
      );
      return { issues: data.issues, allActiveIdentifiers: data.allActiveIdentifiers || [] };
    }
    const data = await withTimeout(
      fetchUserLinearData(linearToken, teamId, linearUserId),
      INTEGRATION_TIMEOUT_MS, 'Linear API'
    );
    return { issues: data.issues, allActiveIdentifiers: data.allActiveIdentifiers || [] };
  } catch (error) {
    console.error('Failed to fetch Linear data:', error);
    return empty;
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
    const [prData, reviewerMap] = await withTimeout(
      Promise.all([
        fetchUserPRData(githubToken, githubUsername, githubConfig.org),
        buildGitHubUserMap(daily, ctx.db),
      ]),
      INTEGRATION_TIMEOUT_MS, 'GitHub API'
    );
    return { prData, reviewerMap };
  } catch (error) {
    console.error('Failed to fetch GitHub PR data:', error);
    return {};
  }
}

/**
 * Fetch merged PRs for a user if GitHub intelligence auto_populate is enabled
 */
async function fetchMergedPRsForUser(
  daily: ReturnType<typeof getDaily>,
  userId: string,
  ctx: InteractionContext,
  since: string
): Promise<MergedPR[]> {
  if (!daily) return [];

  const githubIntelConfig = getGitHubIntelligenceConfig(daily);
  if (!githubIntelConfig?.auto_populate) return [];

  const githubConfig = getGitHubConfig(daily);
  if (!githubConfig || !ctx.env) return [];

  const githubToken = ctx.env[githubConfig.tokenEnvVar];
  if (!githubToken) return [];

  // Get GitHub username: config mapping takes precedence over DB
  let githubUsername = getGitHubUsernameFromConfig(daily, userId);
  if (!githubUsername) {
    githubUsername = await getGitHubUsername(ctx.db, userId);
  }

  if (!githubUsername) return [];

  try {
    const mergedPRs = await withTimeout(
      fetchMergedPRs(githubToken, githubUsername, githubConfig.org, since),
      INTEGRATION_TIMEOUT_MS, 'GitHub merged PRs API'
    );
    return mergedPRs;
  } catch (error) {
    console.error('Failed to fetch merged PRs:', error);
    return [];
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
        inProgressCount: inProgressItems.length,
      };
    }
  }

  // Compute "since" date for merged PRs: use previous submission date, or yesterday
  const yesterdayDate = new Date(userDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const sinceDate = previousSubmission?.date || formatDate(yesterdayDate);

  // Fetch Linear issues, GitHub PRs, and merged PRs in parallel
  const [linearResult, githubResult, mergedPRs] = await Promise.all([
    fetchLinearIssuesForUser(daily, userId, ctx),
    fetchGitHubPRsForUser(daily, userId, ctx),
    fetchMergedPRsForUser(daily, userId, ctx, sinceDate),
  ]);

  // Compute done suppression and auto-completed sets
  let doneIdentifiers: Set<string> | undefined;
  let autoCompletedIds: Set<string> | undefined;

  if (linearResult.allActiveIdentifiers.length > 0 || yesterdayData) {
    try {
      // Get recently done Linear identifiers from DB (7-day window)
      const recentlyDoneItems = await getRecentlyDoneLinearItems(ctx.db, userId, dailyName);
      const doneIds = new Set(
        recentlyDoneItems.map(text => text.match(/^\[([^\]]+)\]/)?.[1]).filter((id): id is string => !!id)
      );
      if (doneIds.size > 0) {
        doneIdentifiers = doneIds;
      }

      // Detect auto-completed: yesterday Linear items no longer active on Linear
      if (yesterdayData && linearResult.allActiveIdentifiers.length > 0) {
        const activeSet = new Set(linearResult.allActiveIdentifiers);
        const autoDone = new Set<string>();
        for (const plan of yesterdayData.plans) {
          const match = plan.match(/^\[([^\]]+)\]\s/);
          if (match && !activeSet.has(match[1]) && !doneIds.has(match[1])) {
            autoDone.add(match[1]);
          }
        }
        if (autoDone.size > 0) {
          autoCompletedIds = autoDone;
        }
      }
    } catch (error) {
      console.error('Failed to compute done/auto-completed sets:', error);
    }
  }

  // Build and open modal
  const sects = getDailySections(daily);
  const modal = buildStandupModal(dailyName, yesterdayData, daily.questions || [], daily.field_order, userDate, 'today', undefined, linearResult.issues, githubResult.prData, githubResult.reviewerMap, doneIdentifiers, autoCompletedIds, mergedPRs.length > 0 ? mergedPRs : undefined, sects);
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
    sections?: { blockers: boolean; unplanned: boolean };
    unmappedReviewers?: string[];
    prReviewerTags?: Record<string, string>;
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

  // Parse text inputs (gate by sections config from metadata)
  const sectionsCfg = metadata.sections ?? { blockers: true, unplanned: true };
  const unplanned = sectionsCfg.unplanned ? parseLines(values.unplanned?.unplanned_input?.value) : [];
  const todayPlans = parseLines(values.today_plans?.plans_input?.value);
  const blockers = sectionsCfg.blockers ? (parseRichText(values.blockers?.blockers_input?.rich_text_value) || '') : '';

  // Parse integration checkbox selections — extract display text and structured source info
  // Format is "*IDENTIFIER* Title" in mrkdwn, so strip the bold markers for flat text
  const parseOptionText = (text: string): string => text.replace(/^\*([^*]+)\*\s*/, '[$1] ');
  const extractIdentifier = (text: string): string | undefined => {
    const m = text.match(/^\*([^*]+)\*\s*/);
    return m ? m[1] : undefined;
  };

  interface StructuredItem {
    text: string;
    source: ItemSource;
    sourceRef?: string;
    sourceUrl?: string;
  }
  const structuredPlans: StructuredItem[] = [];

  // Manual text plans
  for (const plan of todayPlans) {
    structuredPlans.push({ text: plan, source: 'manual' });
  }

  const githubOrg = daily ? getGitHubConfig(daily)?.org : undefined;

  const linearSelections = values.linear_tickets?.linear_tickets_input?.selected_options;
  if (linearSelections && linearSelections.length > 0) {
    for (const option of linearSelections) {
      const flatText = parseOptionText(option.text?.text || option.value);
      todayPlans.push(flatText);
      const identifier = extractIdentifier(option.text?.text || '');
      structuredPlans.push({
        text: flatText,
        source: 'linear_ticket',
        sourceRef: identifier,
        sourceUrl: identifier ? `https://linear.app/issue/${identifier}` : undefined,
      });
    }
  }

  // Parse GitHub PR selections (review requests + my PRs)
  const reviewSelections = values.review_requests?.review_requests_input?.selected_options;
  if (reviewSelections && reviewSelections.length > 0) {
    for (const option of reviewSelections) {
      const flatText = parseOptionText(option.text?.text || option.value);
      todayPlans.push(flatText);
      const ref = option.value; // "repo#42"
      const [repo, num] = ref.split('#');
      structuredPlans.push({
        text: flatText,
        source: 'github_pr',
        sourceRef: ref,
        sourceUrl: githubOrg ? `https://github.com/${githubOrg}/${repo}/pull/${num}` : undefined,
      });
    }
  }
  const myPrSelections = values.my_prs?.my_prs_input?.selected_options;
  if (myPrSelections && myPrSelections.length > 0) {
    for (const option of myPrSelections) {
      let planText = parseOptionText(option.text?.text || option.value);
      const reviewers = metadata.prReviewerTags?.[option.value];
      if (reviewers) {
        planText += ` — waiting on ${reviewers}`;
      }
      todayPlans.push(planText);
      const ref = option.value; // "repo#42"
      const [repo, num] = ref.split('#');
      structuredPlans.push({
        text: planText,
        source: 'github_pr',
        sourceRef: ref,
        sourceUrl: githubOrg ? `https://github.com/${githubOrg}/${repo}/pull/${num}` : undefined,
      });
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

    // Plan-size soft warning: send a DM if the submitted plan count exceeds the threshold.
    // Counts everything that lands in today's plans: typed items + checked integrations
    // (already merged into todayPlans) + yesterday's carry-over + in-progress.
    const maxPlanItems = getMaxPlanItems(dailyName);
    if (maxPlanItems > 0) {
      const newPlanCount = todayPlans.length;
      const carriedCount = yesterdayIncomplete.length + yesterdayInProgress.length;
      const submittedPlanCount = newPlanCount + carriedCount;
      if (submittedPlanCount >= maxPlanItems) {
        const dayWord = isTomorrowMode ? 'for tomorrow' : 'today';
        const breakdown = carriedCount > 0 ? ` (${newPlanCount} new + ${carriedCount} carried)` : '';
        const warningMsg = `⚠️ You're planning ${submittedPlanCount} items${breakdown} ${dayWord}. Teams usually stay under ${maxPlanItems} to keep the day focused.`;
        try {
          await sendDM(ctx.slackToken, userId, warningMsg);
        } catch (error) {
          console.error('Failed to send plan-size warning DM:', error);
        }
      }
    }

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
        await linkItemsToSubmission(ctx.db, submission.id, userId, dailyName, yesterdayCompleted, 'yesterday_completed');
      }
      if (yesterdayDropped.length > 0) {
        await markItemsDropped(ctx.db, userId, dailyName, yesterdayDropped);
        await linkItemsToSubmission(ctx.db, submission.id, userId, dailyName, yesterdayDropped, 'yesterday_dropped');
      }
      if (yesterdayIncomplete.length > 0) {
        await incrementCarryCount(ctx.db, userId, dailyName, yesterdayIncomplete);
        await linkItemsToSubmission(ctx.db, submission.id, userId, dailyName, yesterdayIncomplete, 'yesterday_incomplete');
      }
      if (yesterdayInProgress.length > 0) {
        await markItemsInProgress(ctx.db, userId, dailyName, yesterdayInProgress);
        await linkItemsToSubmission(ctx.db, submission.id, userId, dailyName, yesterdayInProgress, 'yesterday_in_progress');
      }

      // Create new work items for today's plans (with structured source metadata)
      if (structuredPlans.length > 0) {
        await createWorkItems(
          ctx.db,
          structuredPlans.map((item, i) => ({
            slackUserId: userId,
            dailyName,
            text: item.text,
            date: todayStr,
            submissionId: submission.id,
            source: item.source,
            sourceRef: item.sourceRef,
            sourceUrl: item.sourceUrl,
            itemType: 'plan' as const,
          }))
        );
      }

      // Create work items for unplanned items
      if (unplanned.length > 0) {
        await createWorkItems(
          ctx.db,
          unplanned.map((text, i) => ({
            slackUserId: userId,
            dailyName,
            text,
            date: todayStr,
            submissionId: submission.id,
            source: 'manual' as const,
            itemType: 'unplanned' as const,
          }))
        );
      }
    } catch (error) {
      // Don't fail the submission if work item tracking fails
      console.error('Failed to track work items:', error);
    }

    // Mark selected Linear tickets as "In Progress" and comment blockers
    try {
      const linearConfig = daily ? getLinearConfig(daily) : null;
      const linearToken = linearConfig && ctx.env ? ctx.env[linearConfig.tokenEnvVar] : undefined;
      if (linearToken) {
        if (linearSelections && linearSelections.length > 0) {
          const teamId = daily ? getLinearTeamIdForUser(daily, userId) : undefined;
          if (teamId) {
            const states = await fetchWorkflowStates(linearToken, teamId);
            const startedState = states.get('started');
            if (startedState) {
              const identifiers = linearSelections.map(opt => opt.value);
              const idMap = await resolveIdentifiers(linearToken, identifiers);
              const issueIds = [...idMap.values()];
              if (issueIds.length > 0) {
                const result = await markLinearIssuesInProgress(linearToken, issueIds, startedState.id);
                console.log(`Linear: marked ${result.updated} issues in-progress, ${result.skipped} skipped`);
              }
            }
          }
        }

        if (blockers) {
          const refs = extractLinearReferences(blockers);
          if (refs.length > 0) {
            const idMap = await resolveIdentifiers(linearToken, refs);
            for (const [, issueId] of idMap) {
              await commentOnIssue(linearToken, issueId, `🚧 Blocker reported in standup by <@${userId}>:\n\n${blockers}`);
            }
          }
        }
      }
    } catch (error) {
      console.error('Failed to process Linear actions:', error);
    }

    // Blocker @-mention DMs: notify mentioned participants
    if (blockers) {
      try {
        const mentionedIds = extractMentionedUserIds(blockers);
        if (mentionedIds.length > 0) {
          const participants = await getParticipants(ctx.db, dailyName);
          const participantIds = new Set(participants.map(p => p.slack_user_id));
          for (const mentionedId of mentionedIds) {
            if (mentionedId === userId) continue;
            if (!participantIds.has(mentionedId)) continue;
            await sendDM(ctx.slackToken, mentionedId, `🚧 <@${userId}> flagged you in a blocker:\n\n_${blockers}_`);
          }
        }
      } catch (error) {
        console.error('Failed to send blocker mention DMs:', error);
      }
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

    // Post to channel (or update existing post on re-submit)
    if (daily?.channel) {
      const standupData = {
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
        githubOrg,
      };

      if (submission.slack_message_ts) {
        // Re-submit: update the existing channel post in place
        const blocks = formatStandupBlocks(userId, dailyName, standupData);
        const fallbackText = `*<@${userId}>* updated their standup`;
        await updateMessage(ctx.slackToken, daily.channel, submission.slack_message_ts, fallbackText, blocks);
      } else {
        // First submit: post new message
        const messageTs = await postStandupToChannel(
          ctx.slackToken,
          daily.channel,
          userId,
          dailyName,
          standupData
        );

        if (messageTs && submission.id) {
          await updateSubmissionMessageTs(ctx.db, submission.id, messageTs);
        }
      }

      // Send DM copy if user preference allows
      try {
        const dmEnabled = await getDmStandupPreference(ctx.db, userId);
        if (dmEnabled) {
          await sendStandupDM(ctx.slackToken, userId, dailyName, daily.channel, standupData);
        }
      } catch (error) {
        console.error('Failed to send standup DM copy:', error);
      }
    }

    // Refresh App Home so user sees their plan immediately
    try {
      await refreshHome(userId, ctx);
    } catch (error) {
      console.error('Failed to refresh App Home after submission:', error);
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
        yesterdayData = { plans: allPlans, completed: [], incomplete: [], inProgressCount: inProgressItems.length };
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
        yesterdayData = { plans: allPlans, completed: [], incomplete: [], inProgressCount: inProgressItems.length };
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

  // Compute "since" date for merged PRs: yesterday relative to user's local date
  const yesterdayDateHome = new Date(userDate);
  yesterdayDateHome.setDate(yesterdayDateHome.getDate() - 1);
  const sinceDateHome = formatDate(yesterdayDateHome);

  // Fetch Linear issues, GitHub PRs, and merged PRs in parallel
  const [linearResult, githubResult, mergedPRsHome] = await Promise.all([
    fetchLinearIssuesForUser(daily, userId, ctx),
    fetchGitHubPRsForUser(daily, userId, ctx),
    fetchMergedPRsForUser(daily, userId, ctx, sinceDateHome),
  ]);

  // Compute done suppression and auto-completed sets
  let doneIdentifiers: Set<string> | undefined;
  let autoCompletedIds: Set<string> | undefined;

  if (linearResult.allActiveIdentifiers.length > 0 || yesterdayData) {
    try {
      const recentlyDoneItems = await getRecentlyDoneLinearItems(ctx.db, userId, dailyName);
      const doneIds = new Set(
        recentlyDoneItems.map(text => text.match(/^\[([^\]]+)\]/)?.[1]).filter((id): id is string => !!id)
      );
      if (doneIds.size > 0) {
        doneIdentifiers = doneIds;
      }

      if (yesterdayData && linearResult.allActiveIdentifiers.length > 0) {
        const activeSet = new Set(linearResult.allActiveIdentifiers);
        const autoDone = new Set<string>();
        for (const plan of yesterdayData.plans) {
          const match = plan.match(/^\[([^\]]+)\]\s/);
          if (match && !activeSet.has(match[1]) && !doneIds.has(match[1])) {
            autoDone.add(match[1]);
          }
        }
        if (autoDone.size > 0) {
          autoCompletedIds = autoDone;
        }
      }
    } catch (error) {
      console.error('Failed to compute done/auto-completed sets:', error);
    }
  }

  // Build and open modal
  const modal = buildStandupModal(
    dailyName,
    yesterdayData,
    daily.questions || [],
    daily.field_order,
    targetDate,
    mode,
    prefill,
    linearResult.issues,
    githubResult.prData,
    githubResult.reviewerMap,
    doneIdentifiers,
    autoCompletedIds,
    mergedPRsHome.length > 0 ? mergedPRsHome : undefined,
    getDailySections(daily)
  );

  return openModal(ctx.slackToken, triggerId, modal);
}

// ============================================================================
// Button Handler: Edit Standup
// ============================================================================

/**
 * Handle "Edit Standup" button from App Home
 * Reopens the modal pre-filled with today's submission data
 */
export async function handleEditStandup(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const dailyName = payload.actions?.[0]?.value;
  if (!dailyName) {
    console.error('No daily name in home_edit_standup action');
    return false;
  }

  const userId = payload.user.id;
  const triggerId = payload.trigger_id;

  const daily = getDaily(dailyName);
  if (!daily) {
    console.error(`Daily "${dailyName}" not found`);
    return false;
  }

  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const userDate = getUserDate(tzOffset);
  const todayStr = formatDate(userDate);

  // Fetch today's submission for prefill
  const todaySubmission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);
  if (!todaySubmission) {
    await sendDM(ctx.slackToken, userId, `No standup found for today in *${dailyName}*. Use "Start Daily" to submit one.`);
    return true;
  }

  // Build prefill from today's submission
  const prefill: SubmissionPrefill = {
    todayPlans: todaySubmission.today_plans || undefined,
    unplanned: todaySubmission.unplanned || undefined,
    blockers: todaySubmission.blockers || undefined,
    customAnswers: todaySubmission.custom_answers || undefined,
  };

  // Build yesterday data from the submission *before* today (same logic as handleOpenStandup)
  const previousSubmission = await getPreviousSubmission(ctx.db, userId, dailyName, todayStr);

  let yesterdayData: YesterdayData | null = null;
  if (previousSubmission) {
    const todayPlans = previousSubmission.today_plans
      ? (Array.isArray(previousSubmission.today_plans)
          ? previousSubmission.today_plans
          : JSON.parse(previousSubmission.today_plans as unknown as string))
      : [];
    const carriedItems = previousSubmission.yesterday_incomplete
      ? (Array.isArray(previousSubmission.yesterday_incomplete)
          ? previousSubmission.yesterday_incomplete
          : JSON.parse(previousSubmission.yesterday_incomplete as unknown as string))
      : [];
    const inProgressItems = previousSubmission.yesterday_in_progress
      ? (Array.isArray(previousSubmission.yesterday_in_progress)
          ? previousSubmission.yesterday_in_progress
          : JSON.parse(previousSubmission.yesterday_in_progress as unknown as string))
      : [];
    const allPlans = [...inProgressItems, ...carriedItems, ...todayPlans];
    if (allPlans.length > 0) {
      yesterdayData = {
        plans: allPlans,
        completed: [],
        incomplete: [],
        inProgressCount: inProgressItems.length,
      };
    }
  }

  // Fetch integrations in parallel
  const yesterdayDate = new Date(userDate);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const sinceDate = previousSubmission?.date || formatDate(yesterdayDate);

  const [linearResult, githubResult, mergedPRs] = await Promise.all([
    fetchLinearIssuesForUser(daily, userId, ctx),
    fetchGitHubPRsForUser(daily, userId, ctx),
    fetchMergedPRsForUser(daily, userId, ctx, sinceDate),
  ]);

  let doneIdentifiers: Set<string> | undefined;
  let autoCompletedIds: Set<string> | undefined;

  if (linearResult.allActiveIdentifiers.length > 0 || yesterdayData) {
    try {
      const recentlyDoneItems = await getRecentlyDoneLinearItems(ctx.db, userId, dailyName);
      const doneIds = new Set(
        recentlyDoneItems.map(text => text.match(/^\[([^\]]+)\]/)?.[1]).filter((id): id is string => !!id)
      );
      if (doneIds.size > 0) doneIdentifiers = doneIds;
      if (yesterdayData && linearResult.allActiveIdentifiers.length > 0) {
        const activeSet = new Set(linearResult.allActiveIdentifiers);
        const autoDone = new Set<string>();
        for (const plan of yesterdayData.plans) {
          const match = plan.match(/^\[([^\]]+)\]\s/);
          if (match && !activeSet.has(match[1]) && !doneIds.has(match[1])) autoDone.add(match[1]);
        }
        if (autoDone.size > 0) autoCompletedIds = autoDone;
      }
    } catch (error) {
      console.error('Failed to compute done/auto-completed sets:', error);
    }
  }

  const sects = getDailySections(daily);
  const modal = buildStandupModal(
    dailyName, yesterdayData, daily.questions || [], daily.field_order, userDate,
    'today', prefill, linearResult.issues, githubResult.prData, githubResult.reviewerMap,
    doneIdentifiers, autoCompletedIds, mergedPRs.length > 0 ? mergedPRs : undefined, sects
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
// Button Handler: Toggle DM Standup
// ============================================================================

/**
 * Handle DM standup toggle button from App Home
 * Flips the user's dm_standup preference and refreshes the home view
 */
export async function handleToggleDmStandup(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;

  try {
    const current = await getDmStandupPreference(ctx.db, userId);
    await setDmStandupPreference(ctx.db, userId, !current);
    await refreshHome(userId, ctx);
    return true;
  } catch (error) {
    console.error('Failed to toggle DM standup preference:', error);
    return false;
  }
}

// ============================================================================
// Settings Handlers
// ============================================================================

async function handleSetOOO(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const view = {
    type: 'modal',
    callback_id: 'ooo_set_submission',
    title: { type: 'plain_text', text: 'Set Out of Office' },
    submit: { type: 'plain_text', text: 'Set OOO' },
    blocks: [
      {
        type: 'input',
        block_id: 'ooo_start',
        element: { type: 'datepicker', action_id: 'start_date' },
        label: { type: 'plain_text', text: 'Start date' },
      },
      {
        type: 'input',
        block_id: 'ooo_end',
        element: { type: 'datepicker', action_id: 'end_date' },
        label: { type: 'plain_text', text: 'End date' },
      },
    ],
  };

  return openModal(ctx.slackToken, payload.trigger_id, view);
}

async function handleClearOOO(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;
  try {
    const dailies = await getUserDailies(ctx.db, userId);
    for (const d of dailies) {
      await clearOOO(ctx.db, userId, d.daily_name);
    }
    await refreshHome(userId, ctx);
    return true;
  } catch (error) {
    console.error('Failed to clear OOO:', error);
    return false;
  }
}

async function handleOOOSetSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<InteractionResult> {
  const userId = payload.user.id;
  const values = payload.view?.state?.values;
  const startDate = values?.ooo_start?.start_date?.selected_date;
  const endDate = values?.ooo_end?.end_date?.selected_date;

  if (!startDate || !endDate) {
    return { response_action: 'errors', errors: { ooo_start: 'Please select both dates' } };
  }
  if (endDate < startDate) {
    return { response_action: 'errors', errors: { ooo_end: 'End date must be on or after start date' } };
  }

  try {
    const dailies = await getUserDailies(ctx.db, userId);
    for (const d of dailies) {
      await setOOO(ctx.db, userId, d.daily_name, startDate, endDate);
    }
    await refreshHome(userId, ctx);
    return true;
  } catch (error) {
    console.error('Failed to set OOO:', error);
    return false;
  }
}

async function handleSetMaxItems(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const view = {
    type: 'modal',
    callback_id: 'settings_max_items',
    title: { type: 'plain_text', text: 'Max Items Per List' },
    submit: { type: 'plain_text', text: 'Save' },
    blocks: [
      {
        type: 'input',
        block_id: 'max_items',
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select limit' },
          options: [
            { text: { type: 'plain_text', text: 'No limit' }, value: '0' },
            { text: { type: 'plain_text', text: '3 items' }, value: '3' },
            { text: { type: 'plain_text', text: '5 items' }, value: '5' },
            { text: { type: 'plain_text', text: '10 items' }, value: '10' },
          ],
        },
        label: { type: 'plain_text', text: 'Max PRs and Linear tickets shown' },
      },
    ],
  };
  return openModal(ctx.slackToken, payload.trigger_id, view);
}

async function handleSetStalePrDays(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const view = {
    type: 'modal',
    callback_id: 'settings_stale_pr_days',
    title: { type: 'plain_text', text: 'Stale PR Threshold' },
    submit: { type: 'plain_text', text: 'Save' },
    blocks: [
      {
        type: 'input',
        block_id: 'stale_pr_days',
        element: {
          type: 'static_select',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'Select threshold' },
          options: [
            { text: { type: 'plain_text', text: '1 day' }, value: '1' },
            { text: { type: 'plain_text', text: '2 days' }, value: '2' },
            { text: { type: 'plain_text', text: '3 days (default)' }, value: '3' },
            { text: { type: 'plain_text', text: '5 days' }, value: '5' },
            { text: { type: 'plain_text', text: '7 days' }, value: '7' },
          ],
        },
        label: { type: 'plain_text', text: 'Flag reviews older than' },
      },
    ],
  };
  return openModal(ctx.slackToken, payload.trigger_id, view);
}

async function handleSetLinearTeams(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const view = {
    type: 'modal',
    callback_id: 'settings_linear_teams',
    title: { type: 'plain_text', text: 'Linear Team Filter' },
    submit: { type: 'plain_text', text: 'Save' },
    blocks: [
      {
        type: 'input',
        block_id: 'linear_teams',
        optional: true,
        element: {
          type: 'plain_text_input',
          action_id: 'value',
          placeholder: { type: 'plain_text', text: 'e.g. ENG,PLATFORM (leave empty for all)' },
        },
        label: { type: 'plain_text', text: 'Linear team IDs (comma-separated)' },
      },
    ],
  };
  return openModal(ctx.slackToken, payload.trigger_id, view);
}

async function handleSettingsSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext,
  callbackId: string
): Promise<InteractionResult> {
  const userId = payload.user.id;
  const values = payload.view?.state?.values;

  try {
    if (callbackId === 'settings_max_items') {
      const val = parseInt(values?.max_items?.value?.selected_option?.value || '0', 10);
      await updateUserSetting(ctx.db, userId, 'max_items', val === 0 ? null : val);
    } else if (callbackId === 'settings_stale_pr_days') {
      const val = parseInt(values?.stale_pr_days?.value?.selected_option?.value || '3', 10);
      await updateUserSetting(ctx.db, userId, 'stale_pr_days', val === 3 ? null : val);
    } else if (callbackId === 'settings_linear_teams') {
      const val = values?.linear_teams?.value?.value?.trim() || '';
      await updateUserSetting(ctx.db, userId, 'linear_team_filter', val || null);
    }
    await refreshHome(userId, ctx);
    return true;
  } catch (error) {
    console.error(`Failed to save setting ${callbackId}:`, error);
    return false;
  }
}

// ============================================================================
// Phase 4: Standup Post Sync
// ============================================================================

/** Parse JSONB arrays (handles both array and string formats) */
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
 * Rebuild and update the standup post in the channel after an App Home mutation.
 * No-ops if the submission doesn't exist, hasn't been posted, or has no message ts.
 */
async function syncStandupPost(
  db: DbClient,
  slackToken: string,
  userId: string,
  dailyName: string,
  date: string
): Promise<void> {
  const submission = await getSubmissionForDate(db, userId, dailyName, date);
  if (!submission || !submission.posted || !submission.slack_message_ts) return;

  const daily = getDaily(dailyName);
  if (!daily || !daily.channel) return;

  // Fetch carry counts for in-progress items (for "Day X" annotations)
  const inProgressItems = parseJsonArray(submission.yesterday_in_progress);
  let inProgressCarryCounts: Record<string, number> | undefined;
  if (inProgressItems.length > 0) {
    try {
      inProgressCarryCounts = await getInProgressCarryCounts(db, userId, dailyName, inProgressItems);
    } catch (error) {
      console.error('Failed to get in-progress carry counts for sync:', error);
    }
  }

  const githubOrg = getGitHubConfig(daily)?.org;

  const data: StandupData = {
    yesterdayCompleted: parseJsonArray(submission.yesterday_completed),
    yesterdayIncomplete: parseJsonArray(submission.yesterday_incomplete),
    yesterdayInProgress: inProgressItems,
    yesterdayDropped: [], // dropped items aren't tracked on the submission record
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

  await updateMessage(slackToken, daily.channel, submission.slack_message_ts, fallbackText, blocks);
}

// ============================================================================
// Phase 3: App Home Task Action Handlers
// ============================================================================

/**
 * Handle overflow menu selection on a task item (done / in_progress / drop)
 * action_id: "task_action", value JSON: { itemId, dailyName, action }
 */
async function handleTaskAction(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const selectedValue = payload.actions?.[0]?.selected_option?.value;
  if (!selectedValue) {
    console.error('No selected_option value in task_action');
    return false;
  }

  let parsed: { itemId: number; dailyName: string; action: string };
  try {
    parsed = JSON.parse(selectedValue);
  } catch {
    console.error('Failed to parse task_action value:', selectedValue);
    return false;
  }

  const { itemId, dailyName, action } = parsed;
  const userId = payload.user.id;

  // Map "drop" → "dropped" for DB; others pass through
  const dbStatus = action === 'drop' ? 'dropped' : action as 'done' | 'in_progress';

  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const todayStr = formatDate(getUserDate(tzOffset));

  await updateWorkItemStatus(ctx.db, itemId, dbStatus, dbStatus === 'done' ? todayStr : undefined);

  const submission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);
  if (submission) {
    await updateSubmissionArrays(ctx.db, submission.id, userId, dailyName, todayStr);
  }

  await refreshHome(userId, ctx);

  if (submission) {
    const syncPromise = syncStandupPost(ctx.db, ctx.slackToken, userId, dailyName, todayStr)
      .catch(err => console.error('syncStandupPost failed:', err));
    ctx.waitUntil?.(syncPromise);
  }

  return true;
}

/**
 * Handle "Add Item" button click from App Home task list
 * action_id: "task_add", value: dailyName
 */
async function handleTaskAdd(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const dailyName = payload.actions?.[0]?.value;
  if (!dailyName) {
    console.error('No dailyName in task_add action');
    return false;
  }

  const userId = payload.user.id;
  const triggerId = payload.trigger_id;

  const userInfo = await getUserTimezone(ctx.slackToken, userId);
  const tzOffset = userInfo?.tz_offset || 0;
  const todayStr = formatDate(getUserDate(tzOffset));

  const submission = await getSubmissionForDate(ctx.db, userId, dailyName, todayStr);
  if (!submission) {
    await sendDM(
      ctx.slackToken,
      userId,
      `You need to submit your *${dailyName}* standup first before adding items.`
    );
    return true;
  }

  const modal = {
    type: 'modal',
    callback_id: 'task_add_submission',
    title: { type: 'plain_text', text: 'Add Item' },
    submit: { type: 'plain_text', text: 'Add' },
    private_metadata: JSON.stringify({ dailyName, date: todayStr, submissionId: submission.id }),
    blocks: [
      {
        type: 'input',
        block_id: 'task_text',
        label: { type: 'plain_text', text: 'Item' },
        element: {
          type: 'plain_text_input',
          action_id: 'task_text_input',
          placeholder: { type: 'plain_text', text: 'What are you adding?' },
          multiline: false,
        },
      },
    ],
  };

  return openModal(ctx.slackToken, triggerId, modal);
}

/**
 * Handle "Add Item" modal submission
 * callback_id: "task_add_submission"
 */
async function handleTaskAddSubmission(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<InteractionResult> {
  const userId = payload.user.id;

  let metadata: { dailyName: string; date: string; submissionId: number };
  try {
    metadata = JSON.parse(payload.view!.private_metadata);
  } catch {
    console.error('Failed to parse task_add_submission metadata');
    return false;
  }

  const { dailyName, date, submissionId } = metadata;

  const text = payload.view!.state.values.task_text?.task_text_input?.value?.trim();
  if (!text) {
    return {
      response_action: 'errors',
      errors: { task_text: 'Please enter an item' },
    };
  }

  await addWorkItem(ctx.db, userId, dailyName, text, date, submissionId);
  await updateSubmissionArrays(ctx.db, submissionId, userId, dailyName, date);
  await refreshHome(userId, ctx);

  const syncPromise = syncStandupPost(ctx.db, ctx.slackToken, userId, dailyName, date)
    .catch(err => console.error('syncStandupPost failed:', err));
  ctx.waitUntil?.(syncPromise);

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
    if (actionId === 'home_toggle_dm_standup') return handleToggleDmStandup(payload, ctx);
    if (actionId === 'home_set_ooo') return handleSetOOO(payload, ctx);
    if (actionId === 'home_clear_ooo') return handleClearOOO(payload, ctx);
    if (actionId === 'home_set_max_items') return handleSetMaxItems(payload, ctx);
    if (actionId === 'home_set_stale_pr_days') return handleSetStalePrDays(payload, ctx);
    if (actionId === 'home_set_linear_teams') return handleSetLinearTeams(payload, ctx);
    if (actionId === 'home_edit_standup') return handleEditStandup(payload, ctx);
    if (actionId === 'task_action') return handleTaskAction(payload, ctx);
    if (actionId === 'task_add') return handleTaskAdd(payload, ctx);
  }

  // Handle task_add modal submission
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'task_add_submission') {
    return handleTaskAddSubmission(payload, ctx);
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

  // Handle OOO set submission
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'ooo_set_submission') {
    return handleOOOSetSubmission(payload, ctx);
  }

  // Handle mass prompt confirmation
  if (payload.type === 'view_submission' && payload.view?.callback_id === 'mass_prompt_confirm') {
    return handleMassPromptConfirm(payload, ctx);
  }

  // Handle settings modal submissions
  if (payload.type === 'view_submission') {
    const callbackId = payload.view?.callback_id || '';
    if (callbackId.startsWith('settings_')) {
      return handleSettingsSubmission(payload, ctx, callbackId);
    }
  }

  // Unknown interaction type
  return true;
}

async function handleMassPromptConfirm(
  payload: InteractionPayload,
  ctx: InteractionContext
): Promise<boolean> {
  const userId = payload.user.id;
  if (!isAdmin(userId)) return false;

  let metadata: { dailyName: string };
  try {
    metadata = JSON.parse(payload.view?.private_metadata || '{}');
  } catch {
    return false;
  }

  const { dailyName } = metadata;
  if (!dailyName) return false;

  const participants = await getParticipants(ctx.db, dailyName);
  let sent = 0;
  let failed = 0;

  for (const p of participants) {
    const ok = await sendPromptDM(ctx.slackToken, p.slack_user_id, dailyName);
    if (ok) sent++;
    else failed++;
  }

  let summary = `📬 Sent prompts to ${sent} user${sent !== 1 ? 's' : ''} in *${dailyName}*.`;
  if (failed > 0) {
    summary += `\n⚠️ ${failed} failed.`;
  }

  await sendDM(ctx.slackToken, userId, summary);
  return true;
}

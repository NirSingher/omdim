/**
 * Slack Block Kit modal builder for standup form
 * Builds the modal view structure - actual opening is done via lib/slack.ts
 */

import { Question, FieldOrder, getMaxPlanItems } from './config';
import { UserPRData, GitHubPR, MergedPR } from './github';
import { LinearIssue } from './linear';

// Re-export openModal from slack.ts for backward compatibility
export { openModal } from './slack';

interface TextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

interface Option {
  text: TextObject;
  value: string;
}

interface Block {
  type: string;
  block_id?: string;
  text?: TextObject;
  element?: Record<string, unknown>;
  elements?: Record<string, unknown>[];
  label?: TextObject;
  optional?: boolean;
  accessory?: Record<string, unknown>;
}

interface ModalView {
  type: 'modal';
  callback_id: string;
  private_metadata: string;
  title: TextObject;
  submit: TextObject;
  close: TextObject;
  blocks: Block[];
}

export interface YesterdayData {
  plans: string[];
  completed: string[];
  incomplete: string[];
  inProgressCount?: number; // First N items in plans[] that were "in progress"
}

/** Pre-fill data for editing an existing submission */
export interface SubmissionPrefill {
  todayPlans?: string[];
  unplanned?: string[];
  blockers?: string;
  customAnswers?: Record<string, string>;
}

// Default field order values
const DEFAULT_FIELD_ORDER = {
  unplanned: 10,
  review_requests: 18,
  today_plans: 20,
  my_prs: 24,
  blockers: 30,
};

// Field type for ordering
type FieldType = 'unplanned' | 'review_requests' | 'today_plans' | 'my_prs' | 'blockers' | 'custom';

// Dropdown options for yesterday's items
const YESTERDAY_ITEM_OPTIONS = [
  { text: { type: 'plain_text' as const, text: '➡️ Carry over', emoji: true }, value: 'continue' },
  { text: { type: 'plain_text' as const, text: '🔄 In progress', emoji: true }, value: 'in_progress' },
  { text: { type: 'plain_text' as const, text: '✅ Done', emoji: true }, value: 'done' },
  { text: { type: 'plain_text' as const, text: '❌ Drop', emoji: true }, value: 'drop' },
];

interface OrderedField {
  type: FieldType;
  order: number;
  question?: Question;
  questionIndex?: number;
}

/**
 * Format date for display (e.g., "Wednesday, Dec 18")
 */
function formatDisplayDate(date: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[date.getDay()]}, ${months[date.getMonth()]} ${date.getDate()}`;
}

/** Mode for the standup modal */
export type StandupMode = 'today' | 'tomorrow';

/**
 * Build the standup modal with configurable field ordering
 * @param prefill - Optional pre-fill data for editing existing submissions
 * @param linearIssues - Optional Linear issues to show as checkboxes
 * @param reviewerMap - GitHub login (lowercase) → Slack user ID mapping
 */
export function buildStandupModal(
  dailyName: string,
  yesterday: YesterdayData | null,
  customQuestions: Question[] = [],
  fieldOrder?: FieldOrder,
  userDate?: Date,
  mode: StandupMode = 'today',
  prefill?: SubmissionPrefill,
  linearIssues?: LinearIssue[],
  prData?: UserPRData,
  reviewerMap?: Map<string, string>,
  doneIdentifiers?: Set<string>,
  autoCompletedIds?: Set<string>,
  mergedPRs?: MergedPR[],
  sections?: { blockers: boolean; unplanned: boolean }
): ModalView {
  const blocks: Block[] = [];
  const isFirstDay = !yesterday || yesterday.plans.length === 0;
  // We may append merged PR plan items to this array later; keep it mutable
  const yesterdayPlans: string[] = [...(yesterday?.plans || [])];

  // Deduplicate: extract integration IDs from yesterday's plans so we don't
  // show the same Linear tickets or GitHub PRs as both "yesterday" items and
  // fresh integration checkboxes
  const yesterdayIntegrationIds = new Set<string>();
  for (const plan of yesterdayPlans) {
    const match = plan.match(/^\[([^\]]+)\]\s/);
    if (match) {
      yesterdayIntegrationIds.add(match[1]);
    }
  }
  // Also suppress Linear checkboxes for recently done items
  if (doneIdentifiers?.size) {
    if (linearIssues) {
      linearIssues = linearIssues.filter(
        issue => !doneIdentifiers.has(issue.identifier)
      );
    }
  }

  if (yesterdayIntegrationIds.size > 0) {
    if (linearIssues) {
      linearIssues = linearIssues.filter(
        issue => !yesterdayIntegrationIds.has(issue.identifier)
      );
    }
    if (prData) {
      const filterPRs = (prs: GitHubPR[]) => prs.filter(pr => {
        const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
        const repo = repoMatch?.[1] || 'unknown';
        return !yesterdayIntegrationIds.has(`${repo}#${pr.number}`);
      });
      prData = {
        ...prData,
        reviewRequests: filterPRs(prData.reviewRequests),
        awaitingReview: filterPRs(prData.awaitingReview),
        readyToMerge: filterPRs(prData.readyToMerge),
        draftPRs: filterPRs(prData.draftPRs),
      };
    }
  }

  // Merge field order with defaults
  const order = {
    unplanned: fieldOrder?.unplanned ?? DEFAULT_FIELD_ORDER.unplanned,
    review_requests: fieldOrder?.review_requests ?? DEFAULT_FIELD_ORDER.review_requests,
    today_plans: fieldOrder?.today_plans ?? DEFAULT_FIELD_ORDER.today_plans,
    my_prs: fieldOrder?.my_prs ?? DEFAULT_FIELD_ORDER.my_prs,
    blockers: fieldOrder?.blockers ?? DEFAULT_FIELD_ORDER.blockers,
  };

  // Header section with date context
  const dateStr = userDate ? formatDisplayDate(userDate) : 'today';
  const modeLabel = mode === 'tomorrow' ? "Tomorrow's" : '';
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: mode === 'tomorrow'
        ? `📅 *${dailyName}* standup for *${dateStr}* (tomorrow)`
        : `*${dailyName}* standup for *${dateStr}*`,
    },
  });

  blocks.push({ type: 'divider' });

  // Plan-size soft warning: count items that will become today's plans at open time.
  // Sources: yesterday's carry-over/in-progress items (everything except auto-completed),
  // pre-checked integration items (currently none), and prefill today-plans (edit mode).
  // Free-text input in the plans textarea can't be observed here — the post-submit DM
  // covers that path.
  const maxPlanItems = getMaxPlanItems(dailyName);
  if (maxPlanItems > 0) {
    const carryForwardCount = yesterdayPlans.length - (autoCompletedIds?.size || 0);
    const prefillCount = prefill?.todayPlans?.length || 0;
    const openTimeCount = carryForwardCount + prefillCount;
    if (openTimeCount >= maxPlanItems) {
      const dayWord = mode === 'tomorrow' ? 'for tomorrow' : 'today';
      const breakdown = carryForwardCount > 0 && prefillCount > 0 ? ` (${prefillCount} new + ${carryForwardCount} carried)` : '';
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ You're planning ${openTimeCount} items${breakdown} ${dayWord}. Teams usually stay under ${maxPlanItems} to keep the day focused.`,
        },
      });
      blocks.push({ type: 'divider' });
    }
  }

  // First-time user welcome message
  if (isFirstDay) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '👋 *Welcome to your first standup!* Just fill in your plans for today below.',
      },
    });
    blocks.push({ type: 'divider' });
  }

  // Yesterday section: plans + unplanned (grouped as "what happened")
  // Items are grouped by source: manual first, then PR items, then Linear items
  if (!isFirstDay && yesterdayPlans.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📋 *What happened to yesterday\'s plans?*',
      },
    });

    // Classify items by source for grouped display
    const manualItems: Array<{ plan: string; index: number }> = [];
    const prItems: Array<{ plan: string; index: number }> = [];
    const linearItems: Array<{ plan: string; index: number }> = [];

    yesterdayPlans.forEach((plan, index) => {
      const idMatch = plan.match(/^\[([^\]]+)\]\s/);
      if (idMatch) {
        if (idMatch[1].includes('#')) {
          prItems.push({ plan, index });
        } else {
          linearItems.push({ plan, index });
        }
      } else {
        manualItems.push({ plan, index });
      }
    });

    // Render grouped items with section labels when there are mixed sources
    const hasMixedSources = [manualItems, prItems, linearItems].filter(g => g.length > 0).length > 1;

    const renderYesterdayItem = (plan: string, index: number) => {
      const isInProgress = yesterday?.inProgressCount != null && index < yesterday.inProgressCount;
      const linearId = plan.match(/^\[([^\]]+)\]\s/)?.[1];
      const isAutoCompleted = linearId && autoCompletedIds?.has(linearId);

      blocks.push({
        type: 'section',
        block_id: `yesterday_item_${index}`,
        text: {
          type: 'mrkdwn',
          text: plan.length > 60 ? plan.substring(0, 57) + '...' : plan,
        },
        accessory: {
          type: 'static_select',
          action_id: `item_status_${index}`,
          options: YESTERDAY_ITEM_OPTIONS,
          initial_option: isAutoCompleted
            ? YESTERDAY_ITEM_OPTIONS[2]   // Done
            : isInProgress
            ? YESTERDAY_ITEM_OPTIONS[1]   // In progress
            : YESTERDAY_ITEM_OPTIONS[0],  // Carry over
        },
      });
    };

    // Manual items first
    if (manualItems.length > 0) {
      if (hasMixedSources) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '*✍️ Manual items*' }],
        });
      }
      for (const { plan, index } of manualItems) {
        renderYesterdayItem(plan, index);
      }
    }

    // PR items
    if (prItems.length > 0) {
      if (hasMixedSources) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '*📦 PR items*' }],
        });
      }
      for (const { plan, index } of prItems) {
        renderYesterdayItem(plan, index);
      }
    }

    // Linear items
    if (linearItems.length > 0) {
      if (hasMixedSources) {
        blocks.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: '*🎫 Linear items*' }],
        });
      }
      for (const { plan, index } of linearItems) {
        renderYesterdayItem(plan, index);
      }
    }

    // Merged PRs auto-populate: add up to 5 new (non-duplicate) merged PRs as yesterday items
    if (mergedPRs && mergedPRs.length > 0) {
      const newMergedPRs = mergedPRs
        .filter(pr => !yesterdayIntegrationIds.has(`${pr.repo}#${pr.number}`))
        .slice(0, 5);

      if (newMergedPRs.length > 0) {
        if ([manualItems, prItems, linearItems].filter(g => g.length > 0).length > 0) {
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '*📦 Merged PRs*' }],
          });
        }
        for (const pr of newMergedPRs) {
          const planText = `[${pr.repo}#${pr.number}] ${pr.title}`;
          // Append to yesterdayPlans so the submission handler can find it at this index
          const index = yesterdayPlans.length;
          yesterdayPlans.push(planText);
          blocks.push({
            type: 'section',
            block_id: `yesterday_item_${index}`,
            text: {
              type: 'mrkdwn',
              text: planText.length > 60 ? planText.substring(0, 57) + '...' : planText,
            },
            accessory: {
              type: 'static_select',
              action_id: `item_status_${index}`,
              options: YESTERDAY_ITEM_OPTIONS,
              initial_option: YESTERDAY_ITEM_OPTIONS[2], // Default to "Done" for merged PRs
            },
          });
        }
      }
    }

    // Unplanned completions - grouped with yesterday (both are "what happened")
    if (sections?.unplanned ?? true) {
      const unplannedYesterdayElement: Record<string, unknown> = {
        type: 'plain_text_input',
        action_id: 'unplanned_input',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'Fixed urgent prod bug\nHelped teammate with code review\nUnblocked design team',
        },
      };
      if (prefill?.unplanned && prefill.unplanned.length > 0) {
        unplannedYesterdayElement.initial_value = prefill.unplanned.join('\n');
      }
      blocks.push({
        type: 'input',
        block_id: 'unplanned',
        optional: true,
        element: unplannedYesterdayElement,
        label: {
          type: 'plain_text',
          text: '✨ Unplanned wins',
          emoji: true,
        },
      });
    }

    blocks.push({ type: 'divider' });
  }

  // Build ordered list of remaining fields (exclude unplanned if already shown above)
  const orderedFields: OrderedField[] = [];

  const showUnplanned = sections?.unplanned ?? true;
  const showBlockers = sections?.blockers ?? true;

  // Only add unplanned to ordered fields if this is first day (wasn't shown above)
  if (isFirstDay && showUnplanned) {
    orderedFields.push({ type: 'unplanned', order: order.unplanned });
  }

  if (prData && prData.reviewRequests.length > 0) {
    orderedFields.push({ type: 'review_requests', order: order.review_requests });
  }
  orderedFields.push({ type: 'today_plans', order: order.today_plans });
  if (prData && (prData.awaitingReview.length + prData.readyToMerge.length + prData.draftPRs.length > 0)) {
    orderedFields.push({ type: 'my_prs', order: order.my_prs });
  }
  if (showBlockers) {
    orderedFields.push({ type: 'blockers', order: order.blockers });
  }

  // Add custom questions with their indices
  customQuestions.forEach((question, index) => {
    console.log(`Adding custom question ${index}: "${question.text}" with order ${question.order}`);
    orderedFields.push({
      type: 'custom',
      order: question.order ?? 999,
      question,
      questionIndex: index,
    });
  });

  // Sort by order
  orderedFields.sort((a, b) => a.order - b.order);

  let unmappedReviewerLogins: string[] = [];
  const prReviewerTags: Record<string, string> = {};
  const prCategories: Record<string, string> = {};

  // Render fields in order
  orderedFields.forEach((field, idx) => {
    // Add divider between fields (except before first)
    if (idx > 0) {
      blocks.push({ type: 'divider' });
    }

    switch (field.type) {
      case 'unplanned':
        // Only shown for first-time users (otherwise it's in the yesterday section)
        const unplannedElement: Record<string, unknown> = {
          type: 'plain_text_input',
          action_id: 'unplanned_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Fixed prod bug, Helped teammate with code review...',
          },
        };
        // Pre-fill if editing existing submission
        if (prefill?.unplanned && prefill.unplanned.length > 0) {
          unplannedElement.initial_value = prefill.unplanned.join('\n');
        }
        blocks.push({
          type: 'input',
          block_id: 'unplanned',
          optional: true,
          element: unplannedElement,
          label: {
            type: 'plain_text',
            text: '✨ Unplanned wins',
            emoji: true,
          },
        });
        break;

      case 'today_plans':
        // Integration checkboxes go right above today's plans
        if (linearIssues && linearIssues.length > 0) {
          const displayIssues = linearIssues.slice(0, 10);
          const linearOptions = displayIssues.map((issue) => ({
            text: {
              type: 'mrkdwn' as const,
              text: `*${issue.identifier}* ${issue.title.length > 50 ? issue.title.slice(0, 47) + '...' : issue.title}`,
            },
            description: {
              type: 'plain_text' as const,
              text: issue.state.name,
              emoji: true,
            },
            value: issue.id,
          }));
          blocks.push({
            type: 'input',
            block_id: 'linear_tickets',
            optional: true,
            element: {
              type: 'checkboxes',
              action_id: 'linear_tickets_input',
              options: linearOptions,
            },
            label: {
              type: 'plain_text',
              text: '🎫 Cycle tickets (select to add to plans)',
              emoji: true,
            },
          });
          if (linearIssues.length > 10) {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `_Showing 10 of ${linearIssues.length} assigned tickets_`,
              }],
            });
          }
        }

        const plansElement: Record<string, unknown> = {
          type: 'plain_text_input',
          action_id: 'plans_input',
          multiline: true,
          placeholder: {
            type: 'plain_text',
            text: 'Ship feature X\nReview open PRs\n1:1 with Bob',
          },
        };
        // Pre-fill if editing existing submission
        if (prefill?.todayPlans && prefill.todayPlans.length > 0) {
          plansElement.initial_value = prefill.todayPlans.join('\n');
        }
        blocks.push({
          type: 'input',
          block_id: 'today_plans',
          optional: true,
          element: plansElement,
          label: {
            type: 'plain_text',
            text: mode === 'tomorrow' ? "🎯 Tomorrow's plans" : "🎯 Today's plans",
            emoji: true,
          },
        });
        break;

      case 'review_requests':
        if (prData) {
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '_PRs from teammates that need your review_' }],
          });
          const reviewPRs = prData.reviewRequests.slice(0, 10);
          const reviewOptions = reviewPRs.map((pr) => {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            return {
              text: {
                type: 'mrkdwn' as const,
                text: `*${repo}#${pr.number}* ${pr.title.length > 45 ? pr.title.slice(0, 42) + '...' : pr.title}`,
              },
              description: {
                type: 'plain_text' as const,
                text: `by ${pr.author}`,
                emoji: true,
              },
              value: `${repo}#${pr.number}`,
            };
          });
          blocks.push({
            type: 'input',
            block_id: 'review_requests',
            optional: true,
            element: {
              type: 'checkboxes',
              action_id: 'review_requests_input',
              options: reviewOptions,
            },
            label: {
              type: 'plain_text',
              text: '👀 PRs to review (select to add to plans)',
              emoji: true,
            },
          });
          if (prData.reviewRequests.length > 10) {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `_Showing 10 of ${prData.reviewRequests.length} review requests_`,
              }],
            });
          }
        }
        break;

      case 'my_prs':
        if (prData) {
          blocks.push({
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '_Your authored PRs — select to track in your standup_' }],
          });
          // PRs I authored: awaiting review, ready to merge, draft
          const myPRsCategorized: Array<{ pr: GitHubPR; category: string; descSuffix?: string }> = [];
          for (const pr of prData.awaitingReview) {
            const reviewerNames = pr.requestedReviewers.map(login => {
              const slackId = reviewerMap?.get(login.toLowerCase());
              return slackId ? `<@${slackId}>` : `@${login}`;
            });
            const descSuffix = reviewerNames.length > 0 ? ` — ${reviewerNames.join(', ')}` : '';
            myPRsCategorized.push({ pr, category: 'Awaiting Review', descSuffix });
            // Store reviewer tags keyed by PR ref for the submission handler
            if (reviewerNames.length > 0) {
              const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
              const repo = repoMatch?.[1] || 'unknown';
              prReviewerTags[`${repo}#${pr.number}`] = reviewerNames.join(', ');
            }
            const repoMatchCat = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repoCat = repoMatchCat?.[1] || 'unknown';
            prCategories[`${repoCat}#${pr.number}`] = 'awaiting review';
          }
          for (const pr of prData.readyToMerge) {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            prCategories[`${repo}#${pr.number}`] = 'ready to merge';
            myPRsCategorized.push({ pr, category: 'Ready to Merge' });
          }
          for (const pr of prData.draftPRs) {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            prCategories[`${repo}#${pr.number}`] = 'draft';
            myPRsCategorized.push({ pr, category: 'Draft' });
          }
          const displayMyPRs = myPRsCategorized.slice(0, 10);
          const myPROptions = displayMyPRs.map(({ pr, category, descSuffix }) => {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            const descText = descSuffix ? `${category}${descSuffix}` : category;
            return {
              text: {
                type: 'mrkdwn' as const,
                text: `*${repo}#${pr.number}* ${pr.title.length > 45 ? pr.title.slice(0, 42) + '...' : pr.title}`,
              },
              description: {
                type: 'plain_text' as const,
                text: descText.length > 75 ? descText.slice(0, 72) + '...' : descText,
                emoji: true,
              },
              value: `${repo}#${pr.number}`,
            };
          });
          blocks.push({
            type: 'input',
            block_id: 'my_prs',
            optional: true,
            element: {
              type: 'checkboxes',
              action_id: 'my_prs_input',
              options: myPROptions,
            },
            label: {
              type: 'plain_text',
              text: '🔀 My PRs (select to request review, tag reviewers)',
              emoji: true,
            },
          });
          const totalMyPRs = prData.awaitingReview.length + prData.readyToMerge.length + prData.draftPRs.length;
          if (totalMyPRs > 10) {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `_Showing 10 of ${totalMyPRs} PRs_`,
              }],
            });
          }

          // Add unmapped reviewer dropdowns (capped at 3)
          if (reviewerMap) {
            const allReviewers = new Set<string>();
            for (const pr of prData.awaitingReview) {
              for (const login of pr.requestedReviewers) {
                if (!reviewerMap.has(login.toLowerCase())) {
                  allReviewers.add(login);
                }
              }
            }
            const unmappedLogins = Array.from(allReviewers).slice(0, 3);
            for (const login of unmappedLogins) {
              blocks.push({
                type: 'input',
                block_id: `reviewer_map_${login}`,
                optional: true,
                element: {
                  type: 'users_select',
                  action_id: `reviewer_map_input_${login}`,
                  placeholder: {
                    type: 'plain_text',
                    text: 'Select a Slack user',
                  },
                },
                label: {
                  type: 'plain_text',
                  text: `Who is @${login} on Slack?`,
                  emoji: true,
                },
              });
            }
            if (unmappedLogins.length > 0) {
              unmappedReviewerLogins = unmappedLogins;
            }
          }
        }
        break;

      case 'blockers':
        blocks.push({
          type: 'input',
          block_id: 'blockers',
          optional: true,
          element: {
            type: 'rich_text_input',
            action_id: 'blockers_input',
            placeholder: {
              type: 'plain_text',
              text: 'Waiting on API access, Need 15 min with @someone...',
            },
          },
          label: {
            type: 'plain_text',
            text: '🤝 Need help or time from anyone? Need to get unblocked?',
            emoji: true,
          },
        });
        break;

      case 'custom':
        if (field.question && field.questionIndex !== undefined) {
          const blockId = `custom_${field.questionIndex}`;
          const actionId = `custom_input_${field.questionIndex}`;
          console.log(`Building custom question block: blockId=${blockId}, actionId=${actionId}, text="${field.question.text}"`);
          blocks.push({
            type: 'input',
            block_id: blockId,
            optional: !field.question.required,
            element: {
              type: 'rich_text_input',
              action_id: actionId,
              placeholder: {
                type: 'plain_text',
                text: 'Your answer...',
              },
            },
            label: {
              type: 'plain_text',
              text: field.question.text,
              emoji: true,
            },
          });
        }
        break;
    }
  });

  // Calculate target date string for submission handler
  const targetDateStr = userDate ? userDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0];

  const metadata = JSON.stringify({
      dailyName,
      yesterdayPlans,
      mode,
      targetDate: targetDateStr,
      ...(sections ? { sections } : {}),
      ...(unmappedReviewerLogins.length > 0 ? { unmappedReviewers: unmappedReviewerLogins } : {}),
      ...(Object.keys(prReviewerTags).length > 0 ? { prReviewerTags } : {}),
      ...(Object.keys(prCategories).length > 0 ? { prCategories } : {}),
  });
  console.log(`private_metadata length: ${metadata.length}`);

  return {
    type: 'modal',
    callback_id: 'standup_submission',
    private_metadata: metadata,
    title: {
      type: 'plain_text',
      text: mode === 'tomorrow' ? "Tomorrow's Standup" : 'Daily Standup',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Submit',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    blocks,
  };
}


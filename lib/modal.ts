/**
 * Slack Block Kit modal builder for standup form
 * Builds the modal view structure - actual opening is done via lib/slack.ts
 */

import { Question, FieldOrder } from './config';
import { UserPRData, GitHubPR } from './github';
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
}

/** Pre-fill data for editing an existing submission */
export interface SubmissionPrefill {
  todayPlans?: string[];
  unplanned?: string[];
  blockers?: string;
  customAnswers?: Record<string, string>;
}

// Default field order values
const DEFAULT_FIELD_ORDER: Required<FieldOrder> = {
  unplanned: 10,
  today_plans: 20,
  blockers: 30,
};

// Field type for ordering
type FieldType = 'unplanned' | 'today_plans' | 'github_prs' | 'blockers' | 'custom';

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
  prData?: UserPRData
): ModalView {
  const blocks: Block[] = [];
  const isFirstDay = !yesterday || yesterday.plans.length === 0;
  const yesterdayPlans = yesterday?.plans || [];

  // Merge field order with defaults
  const order = {
    unplanned: fieldOrder?.unplanned ?? DEFAULT_FIELD_ORDER.unplanned,
    today_plans: fieldOrder?.today_plans ?? DEFAULT_FIELD_ORDER.today_plans,
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
  if (!isFirstDay && yesterdayPlans.length > 0) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '📋 *What happened to yesterday\'s plans?*',
      },
    });

    // Add a dropdown for each yesterday's plan item
    yesterdayPlans.forEach((plan, index) => {
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
          initial_option: YESTERDAY_ITEM_OPTIONS[0], // Default to "Carry over"
        },
      });
    });

    // Unplanned completions - grouped with yesterday (both are "what happened")
    const unplannedYesterdayElement: Record<string, unknown> = {
      type: 'plain_text_input',
      action_id: 'unplanned_input',
      multiline: true,
      placeholder: {
        type: 'plain_text',
        text: 'Fixed urgent prod bug\nHelped teammate with code review\nUnblocked design team',
      },
    };
    // Pre-fill if editing existing submission
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

    blocks.push({ type: 'divider' });
  }

  // Build ordered list of remaining fields (exclude unplanned if already shown above)
  const orderedFields: OrderedField[] = [];

  // Only add unplanned to ordered fields if this is first day (wasn't shown above)
  if (isFirstDay) {
    orderedFields.push({ type: 'unplanned', order: order.unplanned });
  }

  orderedFields.push({ type: 'today_plans', order: order.today_plans });
  if (prData && (prData.reviewRequests.length + prData.readyToMerge.length + prData.draftPRs.length > 0)) {
    orderedFields.push({ type: 'github_prs', order: 24 });
  }
  orderedFields.push({ type: 'blockers', order: order.blockers });

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

  // Maps populated inside the loop when rendering integration checkboxes
  const linearIssueMap: Record<string, { identifier: string; title: string }> = {};
  const prMap: Record<string, { repo: string; number: number; title: string }> = {};

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
          for (const issue of displayIssues) {
            linearIssueMap[issue.id] = { identifier: issue.identifier, title: issue.title };
          }
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

      case 'github_prs':
        if (prData) {
          const categorized: Array<{ pr: GitHubPR; category: string }> = [];
          for (const pr of prData.reviewRequests) categorized.push({ pr, category: 'Review Requested' });
          for (const pr of prData.readyToMerge) categorized.push({ pr, category: 'Ready to Merge' });
          for (const pr of prData.draftPRs) categorized.push({ pr, category: 'Draft' });
          const displayPRs = categorized.slice(0, 10);
          for (const { pr } of displayPRs) {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            prMap[`${repo}#${pr.number}`] = { repo, number: pr.number, title: pr.title };
          }
          const prOptions = displayPRs.map(({ pr, category }) => {
            const repoMatch = pr.url.match(/github\.com\/[^/]+\/([^/]+)/);
            const repo = repoMatch?.[1] || 'unknown';
            return {
              text: {
                type: 'mrkdwn' as const,
                text: `*${repo}#${pr.number}* ${pr.title.length > 45 ? pr.title.slice(0, 42) + '...' : pr.title}`,
              },
              description: {
                type: 'plain_text' as const,
                text: category,
                emoji: true,
              },
              value: `${repo}#${pr.number}`,
            };
          });
          // All PRs pre-checked by default
          blocks.push({
            type: 'input',
            block_id: 'github_prs',
            optional: true,
            element: {
              type: 'checkboxes',
              action_id: 'github_prs_input',
              options: prOptions,
              initial_options: prOptions,
            },
            label: {
              type: 'plain_text',
              text: '🔀 GitHub PRs (select to add to plans)',
              emoji: true,
            },
          });
          const totalPRs = prData.reviewRequests.length + prData.readyToMerge.length + prData.draftPRs.length;
          if (totalPRs > 10) {
            blocks.push({
              type: 'context',
              elements: [{
                type: 'mrkdwn',
                text: `_Showing 10 of ${totalPRs} PRs_`,
              }],
            });
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

  return {
    type: 'modal',
    callback_id: 'standup_submission',
    private_metadata: JSON.stringify({
      dailyName,
      yesterdayPlans,
      mode,
      targetDate: targetDateStr,
      ...(Object.keys(linearIssueMap).length > 0 ? { linearIssueMap } : {}),
      ...(Object.keys(prMap).length > 0 ? { prMap } : {}),
    }),
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


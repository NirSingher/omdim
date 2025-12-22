/**
 * Slack Block Kit modal builder for standup form
 * Builds the modal view structure - actual opening is done via lib/slack.ts
 */

import { Question, FieldOrder } from './config';

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

// Default field order values
const DEFAULT_FIELD_ORDER: Required<FieldOrder> = {
  unplanned: 10,
  today_plans: 20,
  blockers: 30,
};

// Field type for ordering
type FieldType = 'unplanned' | 'today_plans' | 'blockers' | 'custom';

// Dropdown options for yesterday's items
const YESTERDAY_ITEM_OPTIONS = [
  { text: { type: 'plain_text' as const, text: '➡️ Carry over', emoji: true }, value: 'continue' },
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

/**
 * Build the standup modal with configurable field ordering
 */
export function buildStandupModal(
  dailyName: string,
  yesterday: YesterdayData | null,
  customQuestions: Question[] = [],
  fieldOrder?: FieldOrder,
  userDate?: Date
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
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${dailyName}* standup for *${dateStr}*`,
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
    blocks.push({
      type: 'input',
      block_id: 'unplanned',
      optional: true,
      element: {
        type: 'plain_text_input',
        action_id: 'unplanned_input',
        multiline: true,
        placeholder: {
          type: 'plain_text',
          text: 'Fixed urgent prod bug\nHelped teammate with code review\nUnblocked design team',
        },
      },
      label: {
        type: 'plain_text',
        text: '✨ Unplanned wins',
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
  orderedFields.push({ type: 'blockers', order: order.blockers });

  // Add custom questions with their indices
  customQuestions.forEach((question, index) => {
    orderedFields.push({
      type: 'custom',
      order: question.order ?? 999,
      question,
      questionIndex: index,
    });
  });

  // Sort by order
  orderedFields.sort((a, b) => a.order - b.order);

  // Render fields in order
  orderedFields.forEach((field, idx) => {
    // Add divider between fields (except before first)
    if (idx > 0) {
      blocks.push({ type: 'divider' });
    }

    switch (field.type) {
      case 'unplanned':
        // Only shown for first-time users (otherwise it's in the yesterday section)
        blocks.push({
          type: 'input',
          block_id: 'unplanned',
          optional: true,
          element: {
            type: 'plain_text_input',
            action_id: 'unplanned_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: 'Fixed prod bug, Helped teammate with code review...',
            },
          },
          label: {
            type: 'plain_text',
            text: '✨ Unplanned wins',
          },
        });
        break;

      case 'today_plans':
        blocks.push({
          type: 'input',
          block_id: 'today_plans',
          element: {
            type: 'plain_text_input',
            action_id: 'plans_input',
            multiline: true,
            placeholder: {
              type: 'plain_text',
              text: 'Ship feature X\nReview open PRs\n1:1 with Bob',
            },
          },
          label: {
            type: 'plain_text',
            text: '🎯 Today\'s plans',
          },
        });
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
          },
        });
        break;

      case 'custom':
        if (field.question && field.questionIndex !== undefined) {
          blocks.push({
            type: 'input',
            block_id: `custom_${field.questionIndex}`,
            optional: !field.question.required,
            element: {
              type: 'rich_text_input',
              action_id: `custom_input_${field.questionIndex}`,
              placeholder: {
                type: 'plain_text',
                text: 'Your answer...',
              },
            },
            label: {
              type: 'plain_text',
              text: field.question.text,
            },
          });
        }
        break;
    }
  });

  return {
    type: 'modal',
    callback_id: 'standup_submission',
    private_metadata: JSON.stringify({ dailyName, yesterdayPlans }),
    title: {
      type: 'plain_text',
      text: 'Daily Standup',
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


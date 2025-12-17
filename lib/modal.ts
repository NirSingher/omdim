/**
 * Slack Block Kit modal builder for standup form
 */

import { Question, FieldOrder } from './config';

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

interface OrderedField {
  type: FieldType;
  order: number;
  question?: Question;
  questionIndex?: number;
}

/**
 * Build the standup modal with configurable field ordering
 */
export function buildStandupModal(
  dailyName: string,
  yesterday: YesterdayData | null,
  customQuestions: Question[] = [],
  fieldOrder?: FieldOrder
): ModalView {
  const blocks: Block[] = [];
  const isFirstDay = !yesterday || yesterday.plans.length === 0;

  // Merge field order with defaults
  const order = {
    unplanned: fieldOrder?.unplanned ?? DEFAULT_FIELD_ORDER.unplanned,
    today_plans: fieldOrder?.today_plans ?? DEFAULT_FIELD_ORDER.today_plans,
    blockers: fieldOrder?.blockers ?? DEFAULT_FIELD_ORDER.blockers,
  };

  // Header section (always first)
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${dailyName}* standup for today`,
    },
  });

  blocks.push({ type: 'divider' });

  // Yesterday's plans as checkboxes (if not first day) - always after header
  if (!isFirstDay && yesterday && yesterday.plans.length > 0) {
    const options: Option[] = yesterday.plans.map((plan, index) => ({
      text: { type: 'mrkdwn', text: plan },
      value: `plan_${index}`,
    }));

    // Pre-select completed items
    const initialOptions = yesterday.completed.map((_, index) => options[index]).filter(Boolean);

    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*Yesterday\'s plans* - check off what you completed:',
      },
    });

    blocks.push({
      type: 'input',
      block_id: 'yesterday_completed',
      optional: true,
      element: {
        type: 'checkboxes',
        action_id: 'completed_items',
        options,
        ...(initialOptions.length > 0 ? { initial_options: initialOptions } : {}),
      },
      label: {
        type: 'plain_text',
        text: 'Completed items',
      },
    });

    blocks.push({ type: 'divider' });
  }

  // Build ordered list of fields (standard + custom)
  const orderedFields: OrderedField[] = [
    { type: 'unplanned', order: order.unplanned },
    { type: 'today_plans', order: order.today_plans },
    { type: 'blockers', order: order.blockers },
  ];

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

  // Pre-calculate values needed for today_plans
  const prefillPlans = yesterday?.incomplete?.join('\n') || '';

  // Render fields in order
  orderedFields.forEach((field, idx) => {
    // Add divider between fields (except before first)
    if (idx > 0) {
      blocks.push({ type: 'divider' });
    }

    switch (field.type) {
      case 'unplanned':
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
              text: 'Any work you completed that wasn\'t planned? (one item per line)',
            },
          },
          label: {
            type: 'plain_text',
            text: 'Unplanned completions',
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
              text: 'What do you plan to work on today? (one item per line)',
            },
            ...(prefillPlans ? { initial_value: prefillPlans } : {}),
          },
          label: {
            type: 'plain_text',
            text: 'Today\'s plans',
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
              text: 'Any blockers or things you need help with?',
            },
          },
          label: {
            type: 'plain_text',
            text: 'Blockers',
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
    private_metadata: JSON.stringify({ dailyName }),
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

/**
 * Open a modal via Slack API
 */
export async function openModal(
  slackToken: string,
  triggerId: string,
  view: ModalView
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view,
      }),
    });

    const data = await response.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      console.error('Failed to open modal:', data.error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error opening modal:', error);
    return false;
  }
}

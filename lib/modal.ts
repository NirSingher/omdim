/**
 * Slack Block Kit modal builder for standup form
 */

import { Question } from './config';

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

/**
 * Build the standup modal
 */
export function buildStandupModal(
  dailyName: string,
  yesterday: YesterdayData | null,
  customQuestions: Question[] = []
): ModalView {
  const blocks: Block[] = [];
  const isFirstDay = !yesterday || yesterday.plans.length === 0;

  // Header section
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*${dailyName}* standup for today`,
    },
  });

  blocks.push({ type: 'divider' });

  // Yesterday's plans as checkboxes (if not first day)
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

  // Unplanned work (things done that weren't in yesterday's plan)
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
        text: 'Any work you completed that wasn\'t planned? (one per line)',
      },
    },
    label: {
      type: 'plain_text',
      text: 'Unplanned completions',
    },
  });

  blocks.push({ type: 'divider' });

  // Today's plans - pre-fill with incomplete items from yesterday
  const prefillPlans = yesterday?.incomplete?.join('\n') || '';

  blocks.push({
    type: 'input',
    block_id: 'today_plans',
    element: {
      type: 'plain_text_input',
      action_id: 'plans_input',
      multiline: true,
      placeholder: {
        type: 'plain_text',
        text: 'What do you plan to work on today? (one per line)',
      },
      ...(prefillPlans ? { initial_value: prefillPlans } : {}),
    },
    label: {
      type: 'plain_text',
      text: 'Today\'s plans',
    },
  });

  blocks.push({ type: 'divider' });

  // Blockers
  blocks.push({
    type: 'input',
    block_id: 'blockers',
    optional: true,
    element: {
      type: 'plain_text_input',
      action_id: 'blockers_input',
      multiline: true,
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

  // Custom questions from config (using rich_text_input to support @mentions)
  if (customQuestions.length > 0) {
    blocks.push({ type: 'divider' });

    customQuestions.forEach((question, index) => {
      blocks.push({
        type: 'input',
        block_id: `custom_${index}`,
        optional: !question.required,
        element: {
          type: 'rich_text_input',
          action_id: `custom_input_${index}`,
          placeholder: {
            type: 'plain_text',
            text: 'Your answer... (you can @mention teammates)',
          },
        },
        label: {
          type: 'plain_text',
          text: question.text,
        },
      });
    });
  }

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

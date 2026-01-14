/**
 * Tests for lib/handlers/interactions.ts - Slack interaction handlers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('../lib/db', () => ({
  snoozeItem: vi.fn(),
  getPreviousSubmission: vi.fn(),
  saveSubmission: vi.fn(),
  markPromptSubmitted: vi.fn(),
  updateSubmissionMessageTs: vi.fn(),
  markItemsDone: vi.fn(),
  markItemsDropped: vi.fn(),
  incrementCarryCount: vi.fn(),
  createWorkItems: vi.fn(),
}));

// Mock the config module
vi.mock('../lib/config', () => ({
  getDaily: vi.fn(() => ({
    name: 'daily-il',
    channel: 'C123',
    questions: [],
  })),
  getConfigError: vi.fn(() => null),
}));

// Mock the slack module
vi.mock('../lib/slack', () => ({
  openModal: vi.fn(),
  postMessage: vi.fn(),
  parseRichText: vi.fn(() => ''),
  sendDM: vi.fn(),
}));

// Mock the prompt module
vi.mock('../lib/prompt', () => ({
  formatDate: vi.fn(() => '2025-12-22'),
  getUserDate: vi.fn(() => new Date('2025-12-22')),
  getUserTimezone: vi.fn(() => Promise.resolve({ tz: 'UTC', tz_offset: 0 })),
}));

// Mock the format module
vi.mock('../lib/format', () => ({
  postStandupToChannel: vi.fn(),
}));

import { handleSnoozeBottleneck, handleInteraction, handleOpenStandup, handleStandupSubmission, InteractionPayload, ValidationErrorResponse } from '../lib/handlers/interactions';
import { snoozeItem, getPreviousSubmission, saveSubmission } from '../lib/db';
import { openModal } from '../lib/slack';

describe('interaction handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleSnoozeBottleneck', () => {
    it('snoozes item for 7 days when button clicked', async () => {
      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [
          {
            action_id: 'snooze_bottleneck',
            value: JSON.stringify({ itemId: 42, dailyName: 'daily-il' }),
          },
        ],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleSnoozeBottleneck(payload, ctx);

      expect(result).toBe(true);
      expect(snoozeItem).toHaveBeenCalledWith({}, 42, 7);
    });

    it('returns false when no value in action', async () => {
      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [
          {
            action_id: 'snooze_bottleneck',
            value: '',
          },
        ],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleSnoozeBottleneck(payload, ctx);

      expect(result).toBe(false);
      expect(snoozeItem).not.toHaveBeenCalled();
    });

    it('returns false when value is invalid JSON', async () => {
      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [
          {
            action_id: 'snooze_bottleneck',
            value: 'not-json',
          },
        ],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleSnoozeBottleneck(payload, ctx);

      expect(result).toBe(false);
      expect(snoozeItem).not.toHaveBeenCalled();
    });

    it('returns false when snoozeItem throws', async () => {
      vi.mocked(snoozeItem).mockRejectedValueOnce(new Error('DB error'));

      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [
          {
            action_id: 'snooze_bottleneck',
            value: JSON.stringify({ itemId: 42, dailyName: 'daily-il' }),
          },
        ],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleSnoozeBottleneck(payload, ctx);

      expect(result).toBe(false);
    });
  });

  describe('handleInteraction router', () => {
    it('routes snooze_bottleneck action to handler', async () => {
      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [
          {
            action_id: 'snooze_bottleneck',
            value: JSON.stringify({ itemId: 99, dailyName: 'daily-il' }),
          },
        ],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleInteraction(payload, ctx);

      expect(result).toBe(true);
      expect(snoozeItem).toHaveBeenCalledWith({}, 99, 7);
    });

    it('returns true for unknown interaction types', async () => {
      const payload: InteractionPayload = {
        type: 'unknown_type',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      const result = await handleInteraction(payload, ctx);

      expect(result).toBe(true);
    });
  });

  describe('handleOpenStandup - carry over persistence', () => {
    it('includes carried items from previous day in modal', async () => {
      // Simulate: yesterday user had plans ["A", "B"]
      // They marked A=done, B=continue, and added ["C"] as new plan
      // Today's modal should show ["B", "C"] as yesterday's plans
      vi.mocked(getPreviousSubmission).mockResolvedValueOnce({
        id: 1,
        slack_user_id: 'U12345',
        daily_name: 'daily-il',
        submitted_at: new Date(),
        date: '2025-12-21',
        yesterday_completed: ['A'],
        yesterday_incomplete: ['B'], // This was carried over
        unplanned: null,
        today_plans: ['C'], // This was new plan
        blockers: null,
        custom_answers: null,
        slack_message_ts: null,
      });

      vi.mocked(openModal).mockResolvedValueOnce(true);

      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [{ action_id: 'open_standup', value: 'daily-il' }],
      };

      const ctx = {
        db: {} as any,
        slackToken: 'xoxb-test',
      };

      await handleOpenStandup(payload, ctx);

      // Verify openModal was called
      expect(openModal).toHaveBeenCalled();

      // Get the modal that was built
      const modalCall = vi.mocked(openModal).mock.calls[0];
      const modal = modalCall[2];

      // Parse private_metadata to see what plans are passed to the modal
      const metadata = JSON.parse(modal.private_metadata);

      // CRITICAL: Both carried item "B" and new plan "C" should appear
      expect(metadata.yesterdayPlans).toContain('B');
      expect(metadata.yesterdayPlans).toContain('C');
      expect(metadata.yesterdayPlans).toHaveLength(2);
    });

    it('preserves carry chain across multiple days', async () => {
      // Day 3 scenario: Item "X" was carried Day1->Day2->Day3
      // Previous submission (Day 2) has:
      // - yesterday_incomplete: ["X"] (carried from Day 1)
      // - today_plans: ["Y"] (new on Day 2)
      // Day 3 modal should show both ["X", "Y"]
      vi.mocked(getPreviousSubmission).mockResolvedValueOnce({
        id: 2,
        slack_user_id: 'U12345',
        daily_name: 'daily-il',
        submitted_at: new Date(),
        date: '2025-12-21',
        yesterday_completed: [],
        yesterday_incomplete: ['Task carried twice'], // Still being carried
        unplanned: null,
        today_plans: ['New task from yesterday'],
        blockers: null,
        custom_answers: null,
        slack_message_ts: null,
      });

      vi.mocked(openModal).mockResolvedValueOnce(true);

      const payload: InteractionPayload = {
        type: 'block_actions',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        actions: [{ action_id: 'open_standup', value: 'daily-il' }],
      };

      await handleOpenStandup(payload, { db: {} as any, slackToken: 'xoxb-test' });

      const modalCall = vi.mocked(openModal).mock.calls[0];
      const modal = modalCall[2];
      const metadata = JSON.parse(modal.private_metadata);

      // Both should be in yesterday's plans for today's modal
      expect(metadata.yesterdayPlans).toContain('Task carried twice');
      expect(metadata.yesterdayPlans).toContain('New task from yesterday');
    });
  });

  describe('handleStandupSubmission - today plans validation', () => {
    const createSubmissionPayload = (options: {
      yesterdayPlans?: string[];
      yesterdaySelections?: Record<number, string>; // index -> 'done' | 'continue' | 'drop'
      todayPlans?: string;
    }): InteractionPayload => {
      const { yesterdayPlans = [], yesterdaySelections = {}, todayPlans = '' } = options;

      // Build values object with yesterday item selections
      const values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> = {};

      yesterdayPlans.forEach((_, index) => {
        const status = yesterdaySelections[index] || 'continue';
        values[`yesterday_item_${index}`] = {
          [`item_status_${index}`]: {
            selected_option: { value: status },
          },
        };
      });

      // Add today_plans if provided
      if (todayPlans) {
        values.today_plans = {
          plans_input: { value: todayPlans },
        };
      }

      return {
        type: 'view_submission',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        view: {
          callback_id: 'standup_submission',
          private_metadata: JSON.stringify({
            dailyName: 'daily-il',
            yesterdayPlans,
            mode: 'today',
          }),
          state: { values },
        },
      };
    };

    it('returns validation error when no carry-overs and no today plans', async () => {
      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'done', 1: 'drop' }, // None carried over
        todayPlans: '',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          today_plans: "Add today's plans or carry over items from yesterday",
        },
      });
      expect(saveSubmission).not.toHaveBeenCalled();
    });

    it('returns validation error when first-time user submits empty plans', async () => {
      const payload = createSubmissionPayload({
        yesterdayPlans: [], // No yesterday plans (first day)
        todayPlans: '',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          today_plans: "Add today's plans or carry over items from yesterday",
        },
      });
      expect(saveSubmission).not.toHaveBeenCalled();
    });

    it('succeeds when items are carried over but no new today plans', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'done', 1: 'continue' }, // Task B carried over
        todayPlans: '',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toBe(true);
      expect(saveSubmission).toHaveBeenCalled();
    });

    it('succeeds when today plans provided but nothing carried over', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A'],
        yesterdaySelections: { 0: 'done' }, // Nothing carried
        todayPlans: 'New task for today',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toBe(true);
      expect(saveSubmission).toHaveBeenCalled();
    });

    it('succeeds when both carry-overs and today plans exist', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A'],
        yesterdaySelections: { 0: 'continue' },
        todayPlans: 'Additional task',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toBe(true);
      expect(saveSubmission).toHaveBeenCalled();
    });

    it('treats whitespace-only today plans as empty', async () => {
      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A'],
        yesterdaySelections: { 0: 'done' },
        todayPlans: '   \n  \n   ', // Only whitespace
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toEqual({
        response_action: 'errors',
        errors: {
          today_plans: "Add today's plans or carry over items from yesterday",
        },
      });
    });
  });
});

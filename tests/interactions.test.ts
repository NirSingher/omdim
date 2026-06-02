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
  markItemsInProgress: vi.fn(),
  getInProgressCarryCounts: vi.fn(() => Promise.resolve({})),
  createWorkItems: vi.fn(),
  linkItemsToSubmission: vi.fn(),
  getGitHubUsername: vi.fn(() => Promise.resolve(null)),
  getLinearUserId: vi.fn(() => Promise.resolve(null)),
  setGitHubUsername: vi.fn(),
  setLinearUserId: vi.fn(),
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getUserDailies: vi.fn(() => Promise.resolve([])),
  getUsersWithGitHubLinks: vi.fn(() => Promise.resolve([])),
  getRecentlyDoneLinearItems: vi.fn(() => Promise.resolve([])),
  getDmStandupPreference: vi.fn(() => Promise.resolve(true)),
  setDmStandupPreference: vi.fn(),
  getLinearSyncBack: vi.fn(() => Promise.resolve(true)),
  setLinearSyncBack: vi.fn(),
  // New task management functions
  updateWorkItemStatus: vi.fn(() => Promise.resolve(true)),
  addWorkItem: vi.fn(() => Promise.resolve({ id: 1, text: 'New item', status: 'pending' })),
  updateSubmissionArrays: vi.fn(() => Promise.resolve()),
  getParticipants: vi.fn(() => Promise.resolve([])),
}));

// Mock the config module
vi.mock('../lib/config', () => ({
  getDaily: vi.fn(() => ({
    name: 'daily-il',
    channel: 'C123',
    questions: [],
  })),
  getConfigError: vi.fn(() => null),
  getSchedule: vi.fn(() => ({ default_time: '10:00' })),
  getGitHubConfig: vi.fn(() => null), // No GitHub integration by default
  getGitHubUsernameFromConfig: vi.fn(() => null),
  getGitHubIntelligenceConfig: vi.fn(() => null), // No GitHub intelligence by default
  getLinearConfig: vi.fn(() => null), // No Linear integration by default
  getLinearUserIdFromConfig: vi.fn(() => null),
  getLinearTeamIdForUser: vi.fn(() => null),
  getMaxPlanItems: vi.fn(() => 0), // Disabled by default in tests
  getDailySections: vi.fn(() => ({ blockers: true, unplanned: true })),
}));

// Mock the slack module
vi.mock('../lib/slack', () => ({
  openModal: vi.fn(),
  postMessage: vi.fn(),
  parseRichText: vi.fn(() => ''),
  sendDM: vi.fn(),
  updateMessage: vi.fn(() => Promise.resolve(true)),
  extractMentionedUserIds: vi.fn(() => []),
}));

// Mock the prompt module
vi.mock('../lib/prompt', () => ({
  formatDate: vi.fn(() => '2025-12-22'),
  getDateInTimezone: vi.fn(() => new Date('2025-12-22T12:00:00')), // Noon - after default 10:00 schedule
  getUserDate: vi.fn(() => new Date('2025-12-22T12:00:00')), // Noon - after default 10:00 schedule
  getUserTimezone: vi.fn(() => Promise.resolve({ tz: 'UTC', tz_offset: 0 })),
  hasScheduledTimePassed: vi.fn(() => true), // Default to after scheduled time (posts immediately)
}));

// Mock the format module
vi.mock('../lib/format', () => ({
  postStandupToChannel: vi.fn(),
  sendStandupDM: vi.fn(),
  formatStandupBlocks: vi.fn(() => []),
}));

// Mock the home module (imported by interactions for refreshHome)
vi.mock('../lib/handlers/home', () => ({
  handleAppHomeOpened: vi.fn(() => Promise.resolve(true)),
}));

import { handleSnoozeBottleneck, handleInteraction, handleOpenStandup, handleStandupSubmission, handleEditStandup, InteractionPayload, ValidationErrorResponse } from '../lib/handlers/interactions';
import { snoozeItem, getPreviousSubmission, saveSubmission, markItemsInProgress, getInProgressCarryCounts, updateWorkItemStatus, addWorkItem, updateSubmissionArrays, getSubmissionForDate, getParticipants } from '../lib/db';
import { openModal, sendDM, updateMessage, extractMentionedUserIds, parseRichText } from '../lib/slack';
import { getMaxPlanItems, getDaily, getSchedule, getConfigError } from '../lib/config';
import { postStandupToChannel } from '../lib/format';
import { formatDate, getDateInTimezone, getUserDate, getUserTimezone, hasScheduledTimePassed } from '../lib/prompt';

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
        yesterday_in_progress: null,
        unplanned: null,
        today_plans: ['C'], // This was new plan
        blockers: null,
        custom_answers: null,
        slack_message_ts: null,
        posted: true,
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
        yesterday_in_progress: null,
        unplanned: null,
        today_plans: ['New task from yesterday'],
        blockers: null,
        custom_answers: null,
        slack_message_ts: null,
        posted: true,
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

    it('succeeds when items are in_progress but no new today plans', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'done', 1: 'in_progress' },
        todayPlans: '',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      const result = await handleStandupSubmission(payload, ctx);

      expect(result).toBe(true);
      expect(saveSubmission).toHaveBeenCalled();
    });

    it('calls markItemsInProgress for in-progress items', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'in_progress', 1: 'done' },
        todayPlans: 'New task',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      await handleStandupSubmission(payload, ctx);

      expect(markItemsInProgress).toHaveBeenCalledWith({}, 'U12345', 'daily-il', ['Task A']);
    });

    it('saves yesterdayInProgress in submission', async () => {
      vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 1 } as any);

      const payload = createSubmissionPayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'in_progress', 1: 'continue' },
        todayPlans: '',
      });

      const ctx = { db: {} as any, slackToken: 'xoxb-test' };
      await handleStandupSubmission(payload, ctx);

      const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
      expect(saveCall.yesterdayInProgress).toEqual(['Task A']);
      expect(saveCall.yesterdayIncomplete).toEqual(['Task B']);
    });
  });

  describe('handleStandupSubmission - plan-size warning DM', () => {
    const makePayload = (opts: {
      yesterdayPlans?: string[];
      yesterdaySelections?: Record<number, string>;
      todayPlans?: string;
      mode?: 'today' | 'tomorrow';
    }): InteractionPayload => {
      const { yesterdayPlans = [], yesterdaySelections = {}, todayPlans = '', mode = 'today' } = opts;
      const values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>> = {};

      yesterdayPlans.forEach((_, index) => {
        const status = yesterdaySelections[index] || 'continue';
        values[`yesterday_item_${index}`] = {
          [`item_status_${index}`]: { selected_option: { value: status } },
        };
      });

      if (todayPlans) {
        values.today_plans = { plans_input: { value: todayPlans } };
      }

      return {
        type: 'view_submission',
        trigger_id: 'trigger123',
        user: { id: 'U12345' },
        view: {
          callback_id: 'standup_submission',
          private_metadata: JSON.stringify({ dailyName: 'daily-il', yesterdayPlans, mode }),
          state: { values },
        },
      };
    };

    beforeEach(() => {
      vi.mocked(saveSubmission).mockResolvedValue({ id: 1 } as any);
    });

    it('sends DM when submitted plan count meets threshold', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      // 2 carry-over + 3 new = 5 (meets threshold of 5)
      const payload = makePayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'continue', 1: 'continue' },
        todayPlans: 'X\nY\nZ',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).toHaveBeenCalledWith(
        'xoxb-test',
        'U12345',
        expect.stringContaining('planning 5 items')
      );
      expect(sendDM).toHaveBeenCalledWith(
        'xoxb-test',
        'U12345',
        expect.stringContaining('3 new + 2 carried')
      );
    });

    it('does not send DM when submitted count is below threshold', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      // 1 carry-over + 2 new = 3 (under 5)
      const payload = makePayload({
        yesterdayPlans: ['Task A'],
        yesterdaySelections: { 0: 'continue' },
        todayPlans: 'X\nY',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).not.toHaveBeenCalled();
    });

    it('does not send DM when max_plan_items is 0 (disabled)', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(0);

      const payload = makePayload({
        yesterdayPlans: ['A', 'B', 'C', 'D', 'E'],
        yesterdaySelections: { 0: 'continue', 1: 'continue', 2: 'continue', 3: 'continue', 4: 'continue' },
        todayPlans: 'X\nY\nZ',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).not.toHaveBeenCalled();
    });

    it('counts in-progress items toward the total', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(3);

      // 1 in-progress + 1 carry-over + 1 new = 3 (meets threshold)
      const payload = makePayload({
        yesterdayPlans: ['Task A', 'Task B'],
        yesterdaySelections: { 0: 'in_progress', 1: 'continue' },
        todayPlans: 'X',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).toHaveBeenCalledWith(
        'xoxb-test',
        'U12345',
        expect.stringContaining('planning 3 items')
      );
      expect(sendDM).toHaveBeenCalledWith(
        'xoxb-test',
        'U12345',
        expect.stringContaining('1 new + 2 carried')
      );
    });

    it('excludes done and dropped items from the count', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(3);

      // 2 done + 1 dropped + 2 new = 2 toward plans (under 3)
      const payload = makePayload({
        yesterdayPlans: ['A', 'B', 'C'],
        yesterdaySelections: { 0: 'done', 1: 'done', 2: 'drop' },
        todayPlans: 'X\nY',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).not.toHaveBeenCalled();
    });

    it('uses "for tomorrow" wording in tomorrow mode', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(3);

      const payload = makePayload({
        yesterdayPlans: [],
        todayPlans: 'X\nY\nZ',
        mode: 'tomorrow',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      expect(sendDM).toHaveBeenCalledWith(
        'xoxb-test',
        'U12345',
        expect.stringContaining('for tomorrow'),
      );
    });

    it('still sends warning DM when in queued (tomorrow) mode', async () => {
      vi.mocked(getMaxPlanItems).mockReturnValue(3);

      const payload = makePayload({
        yesterdayPlans: [],
        todayPlans: 'X\nY\nZ',
        mode: 'tomorrow',
      });

      await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

      // Warning DM + scheduling confirmation DM → sendDM called at least once with the warning
      const warningCalls = vi.mocked(sendDM).mock.calls.filter(call =>
        typeof call[2] === 'string' && call[2].includes('Teams usually stay under')
      );
      expect(warningCalls).toHaveLength(1);
    });
  });

  describe('handleOpenStandup - in-progress items in allPlans', () => {
    it('includes in-progress items from previous day in modal', async () => {
      vi.mocked(getPreviousSubmission).mockResolvedValueOnce({
        id: 1,
        slack_user_id: 'U12345',
        daily_name: 'daily-il',
        submitted_at: new Date(),
        date: '2025-12-21',
        yesterday_completed: [],
        yesterday_incomplete: ['Carried task'],
        yesterday_in_progress: ['WIP task'],
        unplanned: null,
        today_plans: ['New task'],
        blockers: null,
        custom_answers: null,
        slack_message_ts: null,
        posted: true,
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

      // In-progress items should come first, then carried, then new plans
      expect(metadata.yesterdayPlans).toEqual(['WIP task', 'Carried task', 'New task']);
    });
  });
});

// ============================================================================
// Task management: handleTaskAction
// ============================================================================

describe('handleInteraction - task_action (overflow menu)', () => {
  const makeTaskActionPayload = (action: string, itemId = 55): InteractionPayload => ({
    type: 'block_actions',
    trigger_id: 'trigger-task',
    user: { id: 'U12345' },
    actions: [{
      action_id: 'task_action',
      value: '',
      selected_option: {
        value: JSON.stringify({ itemId, dailyName: 'daily-il', action }),
      },
    }],
  });

  const ctx = { db: {} as any, slackToken: 'xoxb-test' };

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: submission exists and is posted
    vi.mocked(getSubmissionForDate).mockResolvedValue({
      id: 1,
      slack_user_id: 'U12345',
      daily_name: 'daily-il',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: null,
      today_plans: ['Some task'],
      blockers: null,
      custom_answers: null,
      slack_message_ts: 'ts-111',
      posted: true,
      items_normalized: true,
    });
  });

  it('mark done: calls updateWorkItemStatus with "done" and syncs arrays', async () => {
    const result = await handleInteraction(makeTaskActionPayload('done', 55), ctx);

    expect(result).toBe(true);
    expect(updateWorkItemStatus).toHaveBeenCalledWith(
      {},
      55,
      'done',
      '2025-12-22' // today's date (mocked formatDate)
    );
    expect(updateSubmissionArrays).toHaveBeenCalledWith({}, 1, 'U12345', 'daily-il', '2025-12-22');
  });

  it('mark in_progress: calls updateWorkItemStatus with "in_progress" without completedDate', async () => {
    const result = await handleInteraction(makeTaskActionPayload('in_progress', 55), ctx);

    expect(result).toBe(true);
    expect(updateWorkItemStatus).toHaveBeenCalledWith(
      {},
      55,
      'in_progress',
      undefined
    );
  });

  it('drop: maps "drop" action to "dropped" status in db call', async () => {
    const result = await handleInteraction(makeTaskActionPayload('drop', 55), ctx);

    expect(result).toBe(true);
    expect(updateWorkItemStatus).toHaveBeenCalledWith(
      {},
      55,
      'dropped',
      undefined
    );
  });

  it('returns false when selected_option is missing', async () => {
    const payload: InteractionPayload = {
      type: 'block_actions',
      trigger_id: 'trigger-task',
      user: { id: 'U12345' },
      actions: [{
        action_id: 'task_action',
        value: '',
        // no selected_option
      }],
    };

    const result = await handleInteraction(payload, ctx);
    expect(result).toBe(false);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('refreshes App Home after status update', async () => {
    const { handleAppHomeOpened } = await import('../lib/handlers/home');
    const result = await handleInteraction(makeTaskActionPayload('done', 55), ctx);

    expect(result).toBe(true);
    expect(handleAppHomeOpened).toHaveBeenCalled();
  });
});

// ============================================================================
// Task management: handleTaskAdd (Add Item button)
// ============================================================================

describe('handleInteraction - task_add (Add Item button)', () => {
  const makeTaskAddPayload = (dailyName = 'daily-il'): InteractionPayload => ({
    type: 'block_actions',
    trigger_id: 'trigger-add',
    user: { id: 'U12345' },
    actions: [{ action_id: 'task_add', value: dailyName }],
  });

  const ctx = { db: {} as any, slackToken: 'xoxb-test' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens Add Item modal when submission exists', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce({
      id: 7,
      slack_user_id: 'U12345',
      daily_name: 'daily-il',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: null,
      today_plans: [],
      blockers: null,
      custom_answers: null,
      slack_message_ts: null,
      posted: false,
      items_normalized: true,
    });
    vi.mocked(openModal).mockResolvedValueOnce(true);

    const result = await handleInteraction(makeTaskAddPayload(), ctx);

    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalled();

    const modalArg = vi.mocked(openModal).mock.calls[0][2];
    expect(modalArg.callback_id).toBe('task_add_submission');

    const metadata = JSON.parse(modalArg.private_metadata);
    expect(metadata.dailyName).toBe('daily-il');
    expect(metadata.submissionId).toBe(7);
  });

  it('sends DM error and does not open modal when no submission exists', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce(null);

    const result = await handleInteraction(makeTaskAddPayload(), ctx);

    expect(result).toBe(true); // handler returns true to acknowledge the action
    expect(openModal).not.toHaveBeenCalled();
    expect(sendDM).toHaveBeenCalledWith(
      'xoxb-test',
      'U12345',
      expect.stringContaining('submit your')
    );
  });
});

// ============================================================================
// Task management: handleTaskAddSubmission (modal submit)
// ============================================================================

describe('handleInteraction - task_add_submission (modal)', () => {
  const makeTaskAddSubmissionPayload = (text: string, submissionId = 7): InteractionPayload => ({
    type: 'view_submission',
    trigger_id: 'trigger-add-sub',
    user: { id: 'U12345' },
    view: {
      callback_id: 'task_add_submission',
      private_metadata: JSON.stringify({ dailyName: 'daily-il', date: '2025-12-22', submissionId }),
      state: {
        values: {
          task_text: {
            task_text_input: { value: text },
          },
        },
      },
    },
  });

  const ctx = { db: {} as any, slackToken: 'xoxb-test' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSubmissionForDate).mockResolvedValue(null); // syncStandupPost will no-op
  });

  it('creates work item and syncs submission arrays on valid submission', async () => {
    const result = await handleInteraction(makeTaskAddSubmissionPayload('New task item'), ctx);

    expect(result).toBe(true);
    expect(addWorkItem).toHaveBeenCalledWith(
      {},
      'U12345',
      'daily-il',
      'New task item',
      '2025-12-22',
      7
    );
    expect(updateSubmissionArrays).toHaveBeenCalledWith({}, 7, 'U12345', 'daily-il', '2025-12-22');
  });

  it('refreshes App Home after adding item', async () => {
    const { handleAppHomeOpened } = await import('../lib/handlers/home');
    await handleInteraction(makeTaskAddSubmissionPayload('Another task'), ctx);

    expect(handleAppHomeOpened).toHaveBeenCalled();
  });

  it('returns validation error when item text is empty', async () => {
    const result = await handleInteraction(makeTaskAddSubmissionPayload(''), ctx);

    expect(result).toEqual({
      response_action: 'errors',
      errors: { task_text: 'Please enter an item' },
    });
    expect(addWorkItem).not.toHaveBeenCalled();
  });

  it('returns validation error when item text is whitespace only', async () => {
    const result = await handleInteraction(makeTaskAddSubmissionPayload('   '), ctx);

    expect(result).toEqual({
      response_action: 'errors',
      errors: { task_text: 'Please enter an item' },
    });
    expect(addWorkItem).not.toHaveBeenCalled();
  });
});

// ============================================================================
// syncStandupPost (via handleTaskAction) — skips when submission conditions not met
// ============================================================================

describe('syncStandupPost — skip conditions (exercised via handleTaskAction)', () => {
  const makeTaskActionPayload = (action: string): InteractionPayload => ({
    type: 'block_actions',
    trigger_id: 'trigger-task',
    user: { id: 'U12345' },
    actions: [{
      action_id: 'task_action',
      value: '',
      selected_option: {
        value: JSON.stringify({ itemId: 1, dailyName: 'daily-il', action }),
      },
    }],
  });

  const ctx = { db: {} as any, slackToken: 'xoxb-test' };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips channel update when no submission exists for today', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValue(null);

    await handleInteraction(makeTaskActionPayload('done'), ctx);

    // updateMessage should not be called because syncStandupPost returns early
    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('skips channel update when submission exists but not yet posted', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValue({
      id: 2,
      slack_user_id: 'U12345',
      daily_name: 'daily-il',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: null,
      today_plans: [],
      blockers: null,
      custom_answers: null,
      slack_message_ts: null, // no ts → no update
      posted: false,          // not posted → no update
      items_normalized: true,
    });

    await handleInteraction(makeTaskActionPayload('done'), ctx);

    expect(updateMessage).not.toHaveBeenCalled();
  });

  it('calls updateMessage when submission is posted with a message ts', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValue({
      id: 3,
      slack_user_id: 'U12345',
      daily_name: 'daily-il',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: null,
      today_plans: ['Task one'],
      blockers: null,
      custom_answers: null,
      slack_message_ts: 'ts-posted-999',
      posted: true,
      items_normalized: true,
    });

    // handleTaskAction uses ctx.waitUntil?.(syncPromise) — provide a waitUntil
    // that actually awaits the promise so we can assert on updateMessage.
    const backgroundPromises: Promise<unknown>[] = [];
    const ctxWithWaitUntil = {
      ...ctx,
      waitUntil: (p: Promise<unknown>) => { backgroundPromises.push(p); },
    };

    await handleInteraction(makeTaskActionPayload('done'), ctxWithWaitUntil);
    // Drain the background work
    await Promise.all(backgroundPromises);

    expect(updateMessage).toHaveBeenCalledWith(
      'xoxb-test',
      'C123', // daily channel from mocked getDaily
      'ts-posted-999',
      expect.any(String),
      expect.any(Array)
    );
  });
});

describe('standup template sections - submission parsing', () => {
  const makePayload = (opts: {
    sections?: { blockers: boolean; unplanned: boolean };
    blockerRichText?: object;
    unplannedText?: string;
  }): InteractionPayload => {
    const values: Record<string, Record<string, any>> = {
      today_plans: { plans_input: { value: 'some plan' } },
    };
    if (opts.unplannedText) {
      values.unplanned = { unplanned_input: { value: opts.unplannedText } };
    }
    if (opts.blockerRichText) {
      values.blockers = { blockers_input: { rich_text_value: opts.blockerRichText } };
    }

    return {
      type: 'view_submission',
      trigger_id: 'trigger123',
      user: { id: 'U12345' },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({
          dailyName: 'daily-il',
          yesterdayPlans: [],
          mode: 'today',
          ...(opts.sections ? { sections: opts.sections } : {}),
        }),
        state: { values },
      },
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveSubmission).mockResolvedValue({ id: 1 } as any);
    vi.mocked(getMaxPlanItems).mockReturnValue(0);
    vi.mocked(parseRichText).mockReturnValue('some blocker text');
  });

  it('ignores unplanned input when sections.unplanned is false', async () => {
    const payload = makePayload({
      sections: { blockers: true, unplanned: false },
      unplannedText: 'Fixed a bug',
    });

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
    expect(saveCall.unplanned).toEqual([]);
  });

  it('ignores blockers input when sections.blockers is false', async () => {
    const payload = makePayload({
      sections: { blockers: false, unplanned: true },
      blockerRichText: { type: 'rich_text', elements: [] },
    });

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
    expect(saveCall.blockers).toBe('');
  });

  it('parses both when sections are both true', async () => {
    vi.mocked(parseRichText).mockReturnValue('blocker text');

    const payload = makePayload({
      sections: { blockers: true, unplanned: true },
      unplannedText: 'Fixed a bug',
      blockerRichText: { type: 'rich_text', elements: [] },
    });

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
    expect(saveCall.unplanned).toEqual(['Fixed a bug']);
    expect(saveCall.blockers).toBe('blocker text');
  });

  it('defaults to parsing both when sections not in metadata', async () => {
    vi.mocked(parseRichText).mockReturnValue('blocker text');

    const payload = makePayload({
      unplannedText: 'Fixed a bug',
      blockerRichText: { type: 'rich_text', elements: [] },
    });

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
    expect(saveCall.unplanned).toEqual(['Fixed a bug']);
    expect(saveCall.blockers).toBe('blocker text');
  });
});

describe('Linear ticket selections - submission parsing', () => {
  const makePayload = (): InteractionPayload => ({
    type: 'view_submission',
    trigger_id: 'trigger123',
    user: { id: 'U12345' },
    view: {
      callback_id: 'standup_submission',
      private_metadata: JSON.stringify({ dailyName: 'daily-il', yesterdayPlans: [], mode: 'today' }),
      state: {
        values: {
          today_plans: { plans_input: { value: '' } },
          // First checkbox chunk (base block).
          linear_tickets: {
            linear_tickets_input: {
              selected_options: [
                { value: 'issue-1', text: { type: 'mrkdwn', text: '*ENG-101* First ticket' } },
              ],
            },
          },
          // Second chunk produced when a user has >10 tickets and clicks "Show all".
          linear_tickets_chunk_1: {
            linear_tickets_input_chunk_1: {
              selected_options: [
                { value: 'issue-11', text: { type: 'mrkdwn', text: '*ENG-111* Eleventh ticket' } },
              ],
            },
          },
        },
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(saveSubmission).mockResolvedValue({ id: 1 } as any);
    vi.mocked(getMaxPlanItems).mockReturnValue(0);
    vi.mocked(parseRichText).mockReturnValue('');
  });

  it('collects selections from the base block and chunk blocks', async () => {
    await handleStandupSubmission(makePayload(), { db: {} as any, slackToken: 'xoxb-test' });

    const saveCall = vi.mocked(saveSubmission).mock.calls[0][1];
    expect(saveCall.todayPlans).toContain('[ENG-101] First ticket');
    expect(saveCall.todayPlans).toContain('[ENG-111] Eleventh ticket');
  });
});

describe('blocker @-mention DMs', () => {
  const makeSubmissionPayload = (blockerText: string): InteractionPayload => ({
    type: 'view_submission',
    user: { id: 'U_SUBMITTER' },
    view: {
      callback_id: 'standup_submission',
      private_metadata: JSON.stringify({ dailyName: 'daily-il', yesterdayPlans: [], mode: 'today' }),
      state: {
        values: {
          today_plans: { plans_input: { value: 'some plan' } },
          blockers: { blockers_input: { rich_text_value: {} } },
        },
      },
    },
  });

  const ctx = {
    slackToken: 'xoxb-test',
    db: {},
    waitUntil: (p: Promise<unknown>) => { p.catch(() => {}); },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(extractMentionedUserIds).mockReturnValue([]);
    vi.mocked(parseRichText).mockReturnValue('');
    vi.mocked(saveSubmission).mockResolvedValue({ id: 1 } as any);
    vi.mocked(getInProgressCarryCounts).mockResolvedValue({});
    vi.mocked(getParticipants).mockResolvedValue([]);
    vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', channel: 'C123', questions: [] } as any);
    vi.mocked(getSchedule).mockReturnValue({ default_time: '10:00' } as any);
    vi.mocked(getConfigError).mockReturnValue(null);
    vi.mocked(getMaxPlanItems).mockReturnValue(0);
    vi.mocked(formatDate).mockReturnValue('2025-12-22');
    vi.mocked(getDateInTimezone).mockReturnValue(new Date('2025-12-22T12:00:00'));
    vi.mocked(getUserDate).mockReturnValue(new Date('2025-12-22T12:00:00'));
    vi.mocked(getUserTimezone).mockResolvedValue({ tz: 'UTC', tz_offset: 0 } as any);
    vi.mocked(hasScheduledTimePassed).mockReturnValue(true);
    vi.mocked(postStandupToChannel).mockResolvedValue(undefined as any);
  });

  it('sends DM to mentioned participant', async () => {
    vi.mocked(parseRichText).mockReturnValue('waiting on <@U_OTHER> for review');
    vi.mocked(extractMentionedUserIds).mockReturnValue(['U_OTHER']);
    vi.mocked(getParticipants).mockResolvedValue([
      { slack_user_id: 'U_SUBMITTER' } as any,
      { slack_user_id: 'U_OTHER' } as any,
    ]);

    await handleInteraction(makeSubmissionPayload('waiting on <@U_OTHER>'), ctx as any);
    await new Promise(r => setTimeout(r, 50));

    expect(sendDM).toHaveBeenCalledWith(
      'xoxb-test',
      'U_OTHER',
      expect.stringContaining('flagged you in a blocker')
    );
  });

  it('does not DM self-mentions', async () => {
    vi.mocked(parseRichText).mockReturnValue('I <@U_SUBMITTER> am blocked');
    vi.mocked(extractMentionedUserIds).mockReturnValue(['U_SUBMITTER']);
    vi.mocked(getParticipants).mockResolvedValue([
      { slack_user_id: 'U_SUBMITTER' } as any,
    ]);

    await handleInteraction(makeSubmissionPayload('I <@U_SUBMITTER> am blocked'), ctx as any);
    await new Promise(r => setTimeout(r, 50));

    expect(sendDM).not.toHaveBeenCalledWith(
      expect.anything(),
      'U_SUBMITTER',
      expect.stringContaining('flagged you in a blocker')
    );
  });

  it('does not DM non-participants', async () => {
    vi.mocked(parseRichText).mockReturnValue('need <@U_OUTSIDE> to help');
    vi.mocked(extractMentionedUserIds).mockReturnValue(['U_OUTSIDE']);
    vi.mocked(getParticipants).mockResolvedValue([
      { slack_user_id: 'U_SUBMITTER' } as any,
    ]);

    await handleInteraction(makeSubmissionPayload('need <@U_OUTSIDE>'), ctx as any);
    await new Promise(r => setTimeout(r, 50));

    expect(sendDM).not.toHaveBeenCalledWith(
      expect.anything(),
      'U_OUTSIDE',
      expect.anything()
    );
  });
});

// ============================================================================
// Edit After Submit
// ============================================================================

describe('handleEditStandup', () => {
  const makeEditPayload = (dailyName = 'daily-il'): InteractionPayload => ({
    type: 'block_actions',
    trigger_id: 'trigger-edit',
    user: { id: 'U12345' },
    actions: [{ action_id: 'home_edit_standup', value: dailyName }],
  });

  const ctx = { db: {} as any, slackToken: 'xoxb-test' };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', channel: 'C123', questions: [] } as any);
    vi.mocked(getConfigError).mockReturnValue(null);
  });

  it('opens modal with prefill from today submission', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce({
      id: 10,
      slack_user_id: 'U12345',
      daily_name: 'daily-il',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: ['Fixed urgent bug'],
      today_plans: ['Deploy feature', 'Code review'],
      blockers: 'Waiting on QA',
      custom_answers: null,
      slack_message_ts: 'ts-orig',
      posted: true,
      items_normalized: true,
    });
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);
    vi.mocked(openModal).mockResolvedValueOnce(true);

    const result = await handleEditStandup(makeEditPayload(), ctx);

    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalled();

    const modalArg = vi.mocked(openModal).mock.calls[0][2];
    const metadata = JSON.parse(modalArg.private_metadata);
    expect(metadata.dailyName).toBe('daily-il');
    expect(metadata.mode).toBe('today');
  });

  it('sends DM when no submission exists for today', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce(null);

    const result = await handleEditStandup(makeEditPayload(), ctx);

    expect(result).toBe(true);
    expect(openModal).not.toHaveBeenCalled();
    expect(sendDM).toHaveBeenCalledWith(
      'xoxb-test',
      'U12345',
      expect.stringContaining('No standup found')
    );
  });

  it('routes home_edit_standup action correctly', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce({
      id: 10, slack_user_id: 'U12345', daily_name: 'daily-il', date: '2025-12-22',
      submitted_at: new Date(), yesterday_completed: [], yesterday_incomplete: [],
      yesterday_in_progress: [], unplanned: null, today_plans: ['Task'],
      blockers: null, custom_answers: null, slack_message_ts: null,
      posted: true, items_normalized: true,
    });
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);
    vi.mocked(openModal).mockResolvedValueOnce(true);

    const result = await handleInteraction(makeEditPayload(), ctx);
    expect(result).toBe(true);
    expect(openModal).toHaveBeenCalled();
  });
});

describe('handleStandupSubmission - re-submit updates existing post', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', channel: 'C123', questions: [] } as any);
    vi.mocked(getSchedule).mockReturnValue({ default_time: '10:00' } as any);
    vi.mocked(getConfigError).mockReturnValue(null);
    vi.mocked(getMaxPlanItems).mockReturnValue(0);
    vi.mocked(formatDate).mockReturnValue('2025-12-22');
    vi.mocked(getDateInTimezone).mockReturnValue(new Date('2025-12-22T12:00:00'));
    vi.mocked(hasScheduledTimePassed).mockReturnValue(true);
    vi.mocked(postStandupToChannel).mockResolvedValue('ts-new' as any);
  });

  it('updates existing channel message when submission has slack_message_ts', async () => {
    vi.mocked(saveSubmission).mockResolvedValueOnce({
      id: 10,
      slack_message_ts: 'ts-existing-123',
    } as any);

    const payload: InteractionPayload = {
      type: 'view_submission',
      trigger_id: 'trigger123',
      user: { id: 'U12345' },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({ dailyName: 'daily-il', yesterdayPlans: [], mode: 'today' }),
        state: {
          values: {
            today_plans: { plans_input: { value: 'Updated plan' } },
          },
        },
      },
    };

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    expect(updateMessage).toHaveBeenCalledWith(
      'xoxb-test',
      'C123',
      'ts-existing-123',
      expect.any(String),
      expect.any(Array)
    );
    expect(postStandupToChannel).not.toHaveBeenCalled();
  });

  it('posts new message when submission has no slack_message_ts', async () => {
    vi.mocked(saveSubmission).mockResolvedValueOnce({
      id: 11,
      slack_message_ts: null,
    } as any);

    const payload: InteractionPayload = {
      type: 'view_submission',
      trigger_id: 'trigger123',
      user: { id: 'U12345' },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({ dailyName: 'daily-il', yesterdayPlans: [], mode: 'today' }),
        state: {
          values: {
            today_plans: { plans_input: { value: 'New plan' } },
          },
        },
      },
    };

    await handleStandupSubmission(payload, { db: {} as any, slackToken: 'xoxb-test' });

    expect(postStandupToChannel).toHaveBeenCalled();
    expect(updateMessage).not.toHaveBeenCalled();
  });
});

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

import { handleSnoozeBottleneck, handleInteraction, InteractionPayload } from '../lib/handlers/interactions';
import { snoozeItem } from '../lib/db';

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
});

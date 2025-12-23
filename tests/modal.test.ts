/**
 * Tests for lib/modal.ts - Slack modal building
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config module (imports yaml)
vi.mock('../lib/config', () => ({
  getSchedule: vi.fn(),
  getDaily: vi.fn(),
  loadConfig: vi.fn(),
}));

// Mock slack module
vi.mock('../lib/slack', () => ({
  openModal: vi.fn(),
}));

import { buildStandupModal, YesterdayData } from '../lib/modal';

describe('modal builder', () => {
  describe('buildStandupModal', () => {
    it('creates modal with correct structure', () => {
      const modal = buildStandupModal('daily-il', null, []);

      expect(modal.type).toBe('modal');
      expect(modal.callback_id).toBe('standup_submission');
      expect(modal.title.text).toBe('Daily Standup');
      expect(modal.submit.text).toBe('Submit');
      expect(modal.close.text).toBe('Cancel');
    });

    it('includes daily name in header', () => {
      const modal = buildStandupModal('daily-il', null, []);

      const headerBlock = modal.blocks.find(b =>
        b.text?.text?.includes('daily-il')
      );
      expect(headerBlock).toBeDefined();
      expect(headerBlock?.text?.text).toContain('standup');
    });

    it('includes date context in header when provided', () => {
      const userDate = new Date('2025-12-18T10:00:00Z');
      const modal = buildStandupModal('daily-il', null, [], undefined, userDate);

      const headerBlock = modal.blocks[0];
      expect(headerBlock?.text?.text).toContain('Thursday');
      expect(headerBlock?.text?.text).toContain('Dec 18');
    });

    it('shows welcome message for first-time users', () => {
      const modal = buildStandupModal('daily-il', null, []);

      const welcomeBlock = modal.blocks.find(b =>
        b.text?.text?.includes('Welcome')
      );
      expect(welcomeBlock).toBeDefined();
      expect(welcomeBlock?.text?.text).toContain('first standup');
    });

    it('shows yesterday plans with dropdowns for returning users', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A', 'Task B'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // Should have dropdown blocks for each plan
      const dropdownBlocks = modal.blocks.filter(b =>
        b.block_id?.startsWith('yesterday_item_')
      );
      expect(dropdownBlocks).toHaveLength(2);

      // Check first item
      expect(dropdownBlocks[0].text?.text).toContain('Task A');
      expect(dropdownBlocks[0].accessory?.type).toBe('static_select');
    });

    it('truncates long plan items in dropdown', () => {
      const longItem = 'A'.repeat(100);
      const yesterday: YesterdayData = {
        plans: [longItem],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      const dropdownBlock = modal.blocks.find(b =>
        b.block_id === 'yesterday_item_0'
      );
      expect(dropdownBlock?.text?.text?.length).toBeLessThanOrEqual(60);
      expect(dropdownBlock?.text?.text).toContain('...');
    });

    it('includes today_plans input block', () => {
      const modal = buildStandupModal('daily-il', null, []);

      const todayBlock = modal.blocks.find(b =>
        b.block_id === 'today_plans'
      );
      expect(todayBlock).toBeDefined();
      expect(todayBlock?.type).toBe('input');
      expect(todayBlock?.element?.type).toBe('plain_text_input');
      expect(todayBlock?.element?.multiline).toBe(true);
    });

    it('includes blockers input block with rich text', () => {
      const modal = buildStandupModal('daily-il', null, []);

      const blockersBlock = modal.blocks.find(b =>
        b.block_id === 'blockers'
      );
      expect(blockersBlock).toBeDefined();
      expect(blockersBlock?.type).toBe('input');
      expect(blockersBlock?.element?.type).toBe('rich_text_input');
      expect(blockersBlock?.optional).toBe(true);
    });

    it('includes custom questions', () => {
      const questions = [
        { text: "How're you feeling?", required: false },
        { text: 'Any PRs needing review?', required: false },
      ];

      const modal = buildStandupModal('daily-il', null, questions);

      const customBlocks = modal.blocks.filter(b =>
        b.block_id?.startsWith('custom_')
      );
      expect(customBlocks).toHaveLength(2);

      expect(customBlocks[0].label?.text).toBe("How're you feeling?");
      expect(customBlocks[1].label?.text).toBe('Any PRs needing review?');
    });

    it('respects field ordering', () => {
      const questions = [
        { text: 'Custom Q1', required: false, order: 5 },
      ];
      const fieldOrder = {
        unplanned: 10,
        today_plans: 20,
        blockers: 30,
      };

      const modal = buildStandupModal('daily-il', null, questions, fieldOrder);

      // Find indices of each field type
      const blockIds = modal.blocks
        .filter(b => b.block_id)
        .map(b => b.block_id);

      const customIdx = blockIds.indexOf('custom_0');
      const todayIdx = blockIds.indexOf('today_plans');
      const blockersIdx = blockIds.indexOf('blockers');

      // Custom (order 5) should come before today_plans (order 20)
      expect(customIdx).toBeLessThan(todayIdx);
      // today_plans (order 20) should come before blockers (order 30)
      expect(todayIdx).toBeLessThan(blockersIdx);
    });

    it('stores yesterday plans in private_metadata', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A', 'Task B'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      const metadata = JSON.parse(modal.private_metadata);
      expect(metadata.dailyName).toBe('daily-il');
      expect(metadata.yesterdayPlans).toEqual(['Task A', 'Task B']);
    });

    it('groups unplanned with yesterday section for returning users', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // Find the "yesterday" header and "unplanned" block
      const blocks = modal.blocks;
      const yesterdayHeaderIdx = blocks.findIndex(b =>
        b.text?.text?.includes("yesterday's plans")
      );
      const unplannedIdx = blocks.findIndex(b =>
        b.block_id === 'unplanned'
      );
      const dividerAfterUnplanned = blocks.findIndex((b, i) =>
        i > unplannedIdx && b.type === 'divider'
      );

      // Unplanned should appear after yesterday header but before the divider
      expect(unplannedIdx).toBeGreaterThan(yesterdayHeaderIdx);
      expect(unplannedIdx).toBeLessThan(dividerAfterUnplanned);
    });

    it('sets default dropdown option to "Carry over"', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      const dropdownBlock = modal.blocks.find(b =>
        b.block_id === 'yesterday_item_0'
      );

      expect(dropdownBlock?.accessory?.initial_option?.text?.text).toContain('Carry over');
    });

    it('interleaves custom questions with standard fields based on order', () => {
      const questions = [
        { text: 'Question at start', required: false, order: 5 },
        { text: 'Question in middle', required: false, order: 25 },
        { text: 'Question at end', required: false, order: 999 },
      ];
      const fieldOrder = {
        unplanned: 10,
        today_plans: 20,
        blockers: 30,
      };

      const modal = buildStandupModal('daily-il', null, questions, fieldOrder);

      // Get block IDs in order (excluding non-input blocks)
      const inputBlockIds = modal.blocks
        .filter(b => b.block_id && b.type === 'input')
        .map(b => b.block_id);

      // Expected order:
      // custom_0 (order 5) < unplanned (10) < today_plans (20) < custom_1 (25) < blockers (30) < custom_2 (999)
      expect(inputBlockIds).toEqual([
        'custom_0',      // order 5
        'unplanned',     // order 10
        'today_plans',   // order 20
        'custom_1',      // order 25
        'blockers',      // order 30
        'custom_2',      // order 999
      ]);
    });

    it('preserves question index in block_id regardless of sort order', () => {
      const questions = [
        { text: 'Third in config', required: false, order: 100 },
        { text: 'First in config', required: false, order: 1 },
        { text: 'Second in config', required: false, order: 50 },
      ];

      const modal = buildStandupModal('daily-il', null, questions);

      // Find custom blocks by their label text
      const customBlocks = modal.blocks.filter(b => b.block_id?.startsWith('custom_'));

      // Block IDs should match original array index, not sorted order
      const firstInConfig = customBlocks.find(b => b.label?.text === 'First in config');
      const secondInConfig = customBlocks.find(b => b.label?.text === 'Second in config');
      const thirdInConfig = customBlocks.find(b => b.label?.text === 'Third in config');

      expect(firstInConfig?.block_id).toBe('custom_1'); // Index 1 in original array
      expect(secondInConfig?.block_id).toBe('custom_2'); // Index 2 in original array
      expect(thirdInConfig?.block_id).toBe('custom_0'); // Index 0 in original array
    });
  });
});

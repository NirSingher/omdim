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
import type { LinearIssue } from '../lib/linear';
import type { UserPRData, GitHubPR } from '../lib/github';

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

    it('includes 4 dropdown options with In Progress', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      const dropdownBlock = modal.blocks.find(b =>
        b.block_id === 'yesterday_item_0'
      );
      const options = dropdownBlock?.accessory?.options as any[];
      expect(options).toHaveLength(4);
      expect(options.map((o: any) => o.value)).toEqual(['continue', 'in_progress', 'done', 'drop']);
      expect(options[1].text.text).toContain('In progress');
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

    it('includes Linear issue checkboxes when issues are provided', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix authentication bug',
          state: { name: 'In Progress', type: 'started' },
          priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
        {
          id: 'issue-2',
          identifier: 'ENG-124',
          title: 'Add new dashboard feature',
          state: { name: 'Todo', type: 'unstarted' },
          priority: 2,
          url: 'https://linear.app/issue/ENG-124',
        },
      ];

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      // Find the linear tickets block
      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');

      expect(linearBlock).toBeDefined();
      expect(linearBlock?.type).toBe('input');
      expect(linearBlock?.label?.text).toBe('🎫 Cycle tickets (select to add to plans)');
      expect(linearBlock?.optional).toBe(true);
      expect(linearBlock?.element?.type).toBe('checkboxes');
      expect(linearBlock?.element?.action_id).toBe('linear_tickets_input');
      expect(linearBlock?.element?.options).toHaveLength(2);
    });

    it('formats Linear issue checkboxes with identifier and title', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix bug',
          state: { name: 'In Progress', type: 'started' },
          priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
      ];

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      const option = linearBlock?.element?.options?.[0];

      expect(option?.text?.text).toContain('ENG-123');
      expect(option?.text?.text).toContain('Fix bug');
      expect(option?.description?.text).toBe('In Progress');
      expect(option?.value).toBe('issue-1');
    });

    it('truncates long Linear issue titles', () => {
      const longTitle = 'A'.repeat(100);
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: longTitle,
          state: { name: 'Todo', type: 'unstarted' },
          priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
      ];

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      const option = linearBlock?.element?.options?.[0];

      expect(option?.text?.text?.length).toBeLessThanOrEqual(60);
      expect(option?.text?.text).toContain('...');
    });

    it('limits Linear issues to max 10 checkboxes', () => {
      const linearIssues: LinearIssue[] = Array.from({ length: 15 }, (_, i) => ({
        id: `issue-${i}`,
        identifier: `ENG-${100 + i}`,
        title: `Issue ${i}`,
        state: { name: 'Todo', type: 'unstarted' },
        priority: 1,
        url: `https://linear.app/issue/ENG-${100 + i}`,
      }));

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');

      expect(linearBlock?.element?.options).toHaveLength(10);
    });

    it('shows context message when more than 10 issues available', () => {
      const linearIssues: LinearIssue[] = Array.from({ length: 15 }, (_, i) => ({
        id: `issue-${i}`,
        identifier: `ENG-${100 + i}`,
        title: `Issue ${i}`,
        state: { name: 'Todo', type: 'unstarted' },
        priority: 1,
        url: `https://linear.app/issue/ENG-${100 + i}`,
      }));

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      const contextBlock = modal.blocks.find(
        b => b.type === 'context' && b.elements?.[0]?.text?.includes('Showing 10 of')
      );

      expect(contextBlock).toBeDefined();
      expect(contextBlock?.elements?.[0]?.text).toContain('Showing 10 of 15 assigned tickets');
    });

    it('does not store integration maps in private_metadata (titles extracted from option text on submission)', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix bug',
          state: { name: 'In Progress', type: 'started' },
          priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
      ];

      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        linearIssues
      );

      const metadata = JSON.parse(modal.private_metadata);

      expect(metadata.linearIssueMap).toBeUndefined();
      expect(metadata.prMap).toBeUndefined();
    });

    it('filters out Linear issues that already appear in yesterday plans', () => {
      const yesterday: YesterdayData = {
        plans: ['[ENG-123] Fix authentication bug', 'Write unit tests'],
        completed: [],
        incomplete: [],
      };
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Fix authentication bug',
          state: { name: 'In Progress', type: 'started' },
          priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
        {
          id: 'issue-2',
          identifier: 'ENG-456',
          title: 'New feature',
          state: { name: 'Todo', type: 'unstarted' },
          priority: 2,
          url: 'https://linear.app/issue/ENG-456',
        },
      ];

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined, linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock).toBeDefined();
      // Only ENG-456 should remain (ENG-123 is in yesterday's plans)
      expect(linearBlock?.element?.options).toHaveLength(1);
      expect((linearBlock?.element?.options as any[])[0].value).toBe('issue-2');
    });

    it('filters out GitHub PRs that already appear in yesterday plans', () => {
      const yesterday: YesterdayData = {
        plans: ['[my-repo#42] Fix typo', 'Regular task'],
        completed: [],
        incomplete: [],
      };
      const prData: UserPRData = {
        reviewRequests: [{
          number: 99, title: 'New PR', url: 'https://github.com/org/other-repo/pull/99',
          author: 'alice', reviewsNeeded: 1, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false,
        }],
        awaitingReview: [{
          number: 42, title: 'Fix typo', url: 'https://github.com/org/my-repo/pull/42',
          author: 'me', reviewsNeeded: 1, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false,
        }],
        readyToMerge: [],
        draftPRs: [],
      };

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined, undefined, prData
      );

      // my-repo#42 should be filtered out of my_prs (awaitingReview)
      const myPrsBlock = modal.blocks.find(b => b.block_id === 'my_prs');
      expect(myPrsBlock).toBeUndefined(); // no PRs left after filtering

      // other-repo#99 should still show in review_requests
      const reviewBlock = modal.blocks.find(b => b.block_id === 'review_requests');
      expect(reviewBlock).toBeDefined();
      expect(reviewBlock?.element?.options).toHaveLength(1);
    });

    it('hides Linear block entirely when all issues are filtered out', () => {
      const yesterday: YesterdayData = {
        plans: ['[ENG-100] Only issue'],
        completed: [],
        incomplete: [],
      };
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1', identifier: 'ENG-100', title: 'Only issue',
          state: { name: 'In Progress', type: 'started' }, priority: 1,
          url: 'https://linear.app/issue/ENG-100',
        },
      ];

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined, linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock).toBeUndefined();
    });

    it('does not filter integration items when there are no yesterday plans', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1', identifier: 'ENG-123', title: 'Fix bug',
          state: { name: 'In Progress', type: 'started' }, priority: 1,
          url: 'https://linear.app/issue/ENG-123',
        },
      ];

      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined, linearIssues
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock).toBeDefined();
      expect(linearBlock?.element?.options).toHaveLength(1);
    });

    it('suppresses Linear checkboxes for recently done identifiers', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1', identifier: 'ENG-100', title: 'Recently done',
          state: { name: 'In Progress', type: 'started' }, priority: 1,
          url: 'https://linear.app/issue/ENG-100',
        },
        {
          id: 'issue-2', identifier: 'ENG-200', title: 'Still active',
          state: { name: 'In Progress', type: 'started' }, priority: 1,
          url: 'https://linear.app/issue/ENG-200',
        },
      ];
      const doneIdentifiers = new Set(['ENG-100']);

      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        linearIssues, undefined, undefined, doneIdentifiers
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock).toBeDefined();
      // Only ENG-200 should remain
      expect(linearBlock?.element?.options).toHaveLength(1);
      expect((linearBlock?.element?.options as any[])[0].value).toBe('issue-2');
    });

    it('hides Linear block when all issues are done-suppressed', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1', identifier: 'ENG-100', title: 'Done ticket',
          state: { name: 'In Progress', type: 'started' }, priority: 1,
          url: 'https://linear.app/issue/ENG-100',
        },
      ];
      const doneIdentifiers = new Set(['ENG-100']);

      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        linearIssues, undefined, undefined, doneIdentifiers
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock).toBeUndefined();
    });

    it('defaults yesterday dropdown to Done for auto-completed items', () => {
      const yesterday: YesterdayData = {
        plans: ['[ENG-100] Fix auth bug', 'Write tests', '[ENG-200] Add feature'],
        completed: [],
        incomplete: [],
      };
      const autoCompletedIds = new Set(['ENG-100']);

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, autoCompletedIds
      );

      // Find dropdown blocks
      const item0 = modal.blocks.find(b => b.block_id === 'yesterday_item_0');
      const item1 = modal.blocks.find(b => b.block_id === 'yesterday_item_1');
      const item2 = modal.blocks.find(b => b.block_id === 'yesterday_item_2');

      // ENG-100 should default to Done
      expect(item0?.accessory?.initial_option?.value).toBe('done');
      // "Write tests" (not a Linear item) should default to Carry over
      expect(item1?.accessory?.initial_option?.value).toBe('continue');
      // ENG-200 (not auto-completed) should default to Carry over
      expect(item2?.accessory?.initial_option?.value).toBe('continue');
    });

    it('auto-completed overrides in-progress default', () => {
      const yesterday: YesterdayData = {
        plans: ['[ENG-100] WIP ticket'],
        completed: [],
        incomplete: [],
        inProgressCount: 1, // First item was in progress
      };
      const autoCompletedIds = new Set(['ENG-100']);

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, autoCompletedIds
      );

      const item0 = modal.blocks.find(b => b.block_id === 'yesterday_item_0');
      // Auto-completed takes precedence over in-progress
      expect(item0?.accessory?.initial_option?.value).toBe('done');
    });

    it('does not include Linear block when no issues provided', () => {
      const modal = buildStandupModal(
        'daily-il',
        null,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        undefined
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');

      expect(linearBlock).toBeUndefined();
    });
  });
});

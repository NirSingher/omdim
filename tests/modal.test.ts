/**
 * Tests for lib/modal.ts - Slack modal building
 */

import { describe, it, expect, vi } from 'vitest';

// Mock config module (imports yaml)
vi.mock('../lib/config', () => ({
  getSchedule: vi.fn(),
  getDaily: vi.fn(),
  loadConfig: vi.fn(),
  getMaxPlanItems: vi.fn(() => 5),
}));

// Mock slack module
vi.mock('../lib/slack', () => ({
  openModal: vi.fn(),
}));

import { buildStandupModal, YesterdayData, applyExpandedSection, type Block } from '../lib/modal';
import type { LinearIssue } from '../lib/linear';
import type { UserPRData, GitHubPR } from '../lib/github';

const makeLinearIssues = (n: number): LinearIssue[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `issue-${i}`,
    identifier: `ENG-${100 + i}`,
    title: `Issue ${i}`,
    state: { name: 'Todo', type: 'unstarted' as const },
    priority: 1,
    url: `https://linear.app/issue/ENG-${100 + i}`,
  }));

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

    it('pre-checks Linear issues that are in progress', () => {
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
        {
          id: 'issue-3',
          identifier: 'ENG-125',
          title: 'Refactor payment module',
          state: { name: 'In Review', type: 'started' },
          priority: 3,
          url: 'https://linear.app/issue/ENG-125',
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
      const initialOptions = linearBlock?.element?.initial_options;

      expect(initialOptions).toBeDefined();
      expect(initialOptions).toHaveLength(2);
      expect(initialOptions?.[0]?.value).toBe('issue-1');
      expect(initialOptions?.[1]?.value).toBe('issue-3');
    });

    it('does not set initial_options when no issues are in progress', () => {
      const linearIssues: LinearIssue[] = [
        {
          id: 'issue-1',
          identifier: 'ENG-123',
          title: 'Backlog item',
          state: { name: 'Todo', type: 'unstarted' },
          priority: 2,
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
      expect(linearBlock?.element?.initial_options).toBeUndefined();
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

    it('limits Linear issues to max 3 checkboxes', () => {
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

      expect(linearBlock?.element?.options).toHaveLength(3);
    });

    it('shows Show all button when more than 3 issues available', () => {
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

      const actionsBlock = modal.blocks.find(
        b => b.type === 'actions' &&
          (b.elements as any[])?.some((el: any) => el.action_id === 'show_all_linear')
      );

      expect(actionsBlock).toBeDefined();
      const showAllButton = (actionsBlock?.elements as any[])?.find(
        (el: any) => el.action_id === 'show_all_linear'
      );
      expect(showAllButton).toBeDefined();
    });

    it('does not show Show all button when 3 or fewer linear issues', () => {
      const linearIssues: LinearIssue[] = Array.from({ length: 3 }, (_, i) => ({
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

      const showAllButton = modal.blocks.find(
        b => b.type === 'actions' &&
          (b.elements as any[])?.some((el: any) => el.action_id === 'show_all_linear')
      );
      expect(showAllButton).toBeUndefined();
    });

    it('shows all items when section is in expandedSections', () => {
      const linearIssues: LinearIssue[] = Array.from({ length: 5 }, (_, i) => ({
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
        linearIssues,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new Set(['linear'])
      );

      const linearBlock = modal.blocks.find(b => b.block_id === 'linear_tickets');
      expect(linearBlock?.element?.options).toHaveLength(5);

      const showAllButton = modal.blocks.find(
        b => b.type === 'actions' &&
          (b.elements as any[])?.some((el: any) => el.action_id === 'show_all_linear')
      );
      expect(showAllButton).toBeUndefined();
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

    it('stores prCategories in private_metadata when authored PRs are present', () => {
      const prData: UserPRData = {
        awaitingReview: [{
          number: 42, title: 'Fix auth', url: 'https://github.com/org/my-repo/pull/42',
          author: 'me', reviewsNeeded: 1, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false,
        }],
        readyToMerge: [{
          number: 99, title: 'Add caching', url: 'https://github.com/org/other-repo/pull/99',
          author: 'me', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false,
        }],
        draftPRs: [{
          number: 7, title: 'WIP feature', url: 'https://github.com/org/draft-repo/pull/7',
          author: 'me', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true,
        }],
        reviewRequests: [],
      };

      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined, undefined, prData
      );

      const metadata = JSON.parse(modal.private_metadata);
      expect(metadata.prCategories).toBeDefined();
      expect(metadata.prCategories['my-repo#42']).toBe('awaiting review');
      expect(metadata.prCategories['other-repo#99']).toBe('ready to merge');
      expect(metadata.prCategories['draft-repo#7']).toBe('draft');
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

  describe('yesterday items grouping by source', () => {
    it('groups items by source when mixed (manual, PR, Linear)', () => {
      const yesterday: YesterdayData = {
        plans: [
          'Manual task',
          '[repo#42] Fix typo',
          '[ENG-123] Auth refactor',
          'Another manual task',
        ],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // Should have group header context blocks when mixed
      const contextBlocks = modal.blocks.filter(
        (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('items')
      );
      expect(contextBlocks.length).toBe(3); // Manual, PR, Linear

      // Verify headers exist
      const headers = contextBlocks.map((b: any) => b.elements[0].text);
      expect(headers).toContain('*✍️ Manual items*');
      expect(headers).toContain('*📦 PR items*');
      expect(headers).toContain('*🎫 Linear items*');
    });

    it('does not show group headers when all items are from one source', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A', 'Task B', 'Task C'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // Should NOT have source group headers
      const groupHeaders = modal.blocks.filter(
        (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('items*')
      );
      expect(groupHeaders).toHaveLength(0);
    });

    it('preserves dropdown indices across groups', () => {
      const yesterday: YesterdayData = {
        plans: ['Manual task', '[repo#42] PR task', '[ENG-123] Linear task'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // All three items should have their original indices
      expect(modal.blocks.find(b => b.block_id === 'yesterday_item_0')).toBeDefined();
      expect(modal.blocks.find(b => b.block_id === 'yesterday_item_1')).toBeDefined();
      expect(modal.blocks.find(b => b.block_id === 'yesterday_item_2')).toBeDefined();
    });

    it('skips source-group headers when fewer than 4 yesterday items', () => {
      // 3 items from mixed sources: manual, PR, Linear
      const yesterday: YesterdayData = {
        plans: [
          'Manual task',
          '[repo#1] PR task',
          '[ENG-1] Linear task',
        ],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      // No context blocks with group header emoji markers should appear
      const groupHeaders = modal.blocks.filter(
        (b: any) =>
          b.type === 'context' &&
          b.elements?.[0]?.text &&
          (b.elements[0].text.includes('✍️') ||
            b.elements[0].text.includes('📦') ||
            b.elements[0].text.includes('🎫'))
      );
      expect(groupHeaders).toHaveLength(0);
    });

    it('shows source-group headers when 4 or more mixed-source yesterday items', () => {
      // 4 items from mixed sources: 2 manual, 1 PR, 1 Linear
      const yesterday: YesterdayData = {
        plans: [
          'Manual task A',
          'Manual task B',
          '[repo#1] PR task',
          '[ENG-1] Linear task',
        ],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal('daily-il', yesterday, []);

      const groupHeaders = modal.blocks.filter(
        (b: any) =>
          b.type === 'context' &&
          b.elements?.[0]?.text &&
          (b.elements[0].text.includes('✍️') ||
            b.elements[0].text.includes('📦') ||
            b.elements[0].text.includes('🎫'))
      );
      expect(groupHeaders.length).toBeGreaterThanOrEqual(2);

      const headerTexts = groupHeaders.map((b: any) => b.elements[0].text);
      expect(headerTexts.some((t: string) => t.includes('✍️'))).toBe(true);
      expect(headerTexts.some((t: string) => t.includes('📦'))).toBe(true);
      expect(headerTexts.some((t: string) => t.includes('🎫'))).toBe(true);
    });
  });

  describe('plan-size warning banner', () => {
    const findWarning = (blocks: { type: string; text?: { text?: string } }[]) =>
      blocks.find(b => b.type === 'section' && b.text?.text?.includes('Teams usually stay under'));

    it('shows warning when carry-over count meets threshold', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      const yesterday: YesterdayData = {
        plans: ['A', 'B', 'C', 'D', 'E'],
        completed: [],
        incomplete: [],
      };
      const modal = buildStandupModal('daily-il', yesterday, []);

      const warning = findWarning(modal.blocks);
      expect(warning).toBeDefined();
      expect(warning?.text?.text).toContain("planning 5 items today");
      expect(warning?.text?.text).toContain("under 5");
    });

    it('does not show warning when count is under threshold', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      const yesterday: YesterdayData = {
        plans: ['A', 'B'],
        completed: [],
        incomplete: [],
      };
      const modal = buildStandupModal('daily-il', yesterday, []);

      expect(findWarning(modal.blocks)).toBeUndefined();
    });

    it('does not show warning when max_plan_items is 0 (disabled)', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(0);

      const yesterday: YesterdayData = {
        plans: ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
        completed: [],
        incomplete: [],
      };
      const modal = buildStandupModal('daily-il', yesterday, []);

      expect(findWarning(modal.blocks)).toBeUndefined();
    });

    it('excludes auto-completed items from the count', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      const yesterday: YesterdayData = {
        plans: ['[LIN-1] A', '[LIN-2] B', 'C', 'D', 'E'],
        completed: [],
        incomplete: [],
      };
      // LIN-1 and LIN-2 are auto-completed → effective count = 3
      const modal = buildStandupModal(
        'daily-il',
        yesterday,
        [],
        undefined,
        undefined,
        'today',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new Set(['LIN-1', 'LIN-2'])
      );

      expect(findWarning(modal.blocks)).toBeUndefined();
    });

    it('uses "for tomorrow" wording in tomorrow mode', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(3);

      const yesterday: YesterdayData = {
        plans: ['A', 'B', 'C'],
        completed: [],
        incomplete: [],
      };
      const modal = buildStandupModal(
        'daily-il',
        yesterday,
        [],
        undefined,
        undefined,
        'tomorrow'
      );

      const warning = findWarning(modal.blocks);
      expect(warning).toBeDefined();
      expect(warning?.text?.text).toContain('for tomorrow');
    });

    it('includes prefill today_plans in the count', async () => {
      const { getMaxPlanItems } = await import('../lib/config');
      vi.mocked(getMaxPlanItems).mockReturnValue(5);

      const yesterday: YesterdayData = {
        plans: ['A', 'B'],
        completed: [],
        incomplete: [],
      };
      const modal = buildStandupModal(
        'daily-il',
        yesterday,
        [],
        undefined,
        undefined,
        'tomorrow',
        { todayPlans: ['X', 'Y', 'Z'] }
      );

      const warning = findWarning(modal.blocks);
      expect(warning).toBeDefined();
      expect(warning?.text?.text).toContain('5 items');
    });
  });

  describe('standup template sections', () => {
    it('hides blockers block when sections.blockers is false', () => {
      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { blockers: false, unplanned: true }
      );

      const blockersBlock = modal.blocks.find(b => b.block_id === 'blockers');
      expect(blockersBlock).toBeUndefined();
    });

    it('hides unplanned block when sections.unplanned is false (first-time user)', () => {
      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { blockers: true, unplanned: false }
      );

      const unplannedBlock = modal.blocks.find(b => b.block_id === 'unplanned');
      expect(unplannedBlock).toBeUndefined();
    });

    it('hides unplanned block when sections.unplanned is false (returning user)', () => {
      const yesterday: YesterdayData = {
        plans: ['Task A'],
        completed: [],
        incomplete: [],
      };

      const modal = buildStandupModal(
        'daily-il', yesterday, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { blockers: true, unplanned: false }
      );

      const unplannedBlock = modal.blocks.find(b => b.block_id === 'unplanned');
      expect(unplannedBlock).toBeUndefined();
    });

    it('hides both blockers and unplanned when both are false', () => {
      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { blockers: false, unplanned: false }
      );

      expect(modal.blocks.find(b => b.block_id === 'blockers')).toBeUndefined();
      expect(modal.blocks.find(b => b.block_id === 'unplanned')).toBeUndefined();
    });

    it('shows both by default when sections parameter is undefined', () => {
      const modal = buildStandupModal('daily-il', null, []);

      expect(modal.blocks.find(b => b.block_id === 'blockers')).toBeDefined();
      expect(modal.blocks.find(b => b.block_id === 'unplanned')).toBeDefined();
    });

    it('includes sections in private_metadata when provided', () => {
      const sections = { blockers: false, unplanned: true };
      const modal = buildStandupModal(
        'daily-il', null, [], undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        sections
      );

      const metadata = JSON.parse(modal.private_metadata);
      expect(metadata.sections).toEqual(sections);
    });

    it('omits sections from private_metadata when not provided', () => {
      const modal = buildStandupModal('daily-il', null, []);

      const metadata = JSON.parse(modal.private_metadata);
      expect(metadata.sections).toBeUndefined();
    });

    it('still shows today_plans and custom questions when sections are disabled', () => {
      const questions = [{ text: 'How are you?', required: false }];
      const modal = buildStandupModal(
        'daily-il', null, questions, undefined, undefined, 'today', undefined,
        undefined, undefined, undefined, undefined, undefined, undefined,
        { blockers: false, unplanned: false }
      );

      expect(modal.blocks.find(b => b.block_id === 'today_plans')).toBeDefined();
      expect(modal.blocks.find(b => b.block_id === 'custom_0')).toBeDefined();
    });
  });

  describe('applyExpandedSection', () => {
    // A collapsed modal (3 linear tickets shown out of 15) plus a PR section and a
    // yesterday item — the kind of view Slack echoes back on a "Show all" click.
    const collapsedView = (): Block[] => {
      const collapsed = buildStandupModal(
        'daily-il',
        { plans: ['Ship feature X'], completed: [], incomplete: [], inProgressCount: 1 },
        [], undefined, undefined, 'today', undefined,
        makeLinearIssues(15),
        {
          reviewRequests: [],
          awaitingReview: Array.from({ length: 6 }, (_, i): GitHubPR => ({
            number: i, title: `PR ${i}`, url: `https://github.com/org/repo/pull/${i}`,
            author: 'me', requestedReviewers: [], isDraft: false,
          })),
          readyToMerge: [], draftPRs: [],
        } as UserPRData,
        new Map(),
      );
      return collapsed.blocks;
    };

    // A full rebuild with only Linear data (expanded), as the handler produces.
    const rebuiltLinear = (): Block[] =>
      buildStandupModal(
        'daily-il',
        { plans: ['Ship feature X'], completed: [], incomplete: [] },
        [], undefined, undefined, 'today', undefined,
        makeLinearIssues(15),
        undefined, undefined, undefined, undefined, undefined, undefined,
        new Set(['linear']),
      ).blocks;

    it('expands the target section in place (3 → expanded count)', () => {
      const current = collapsedView();
      const before = current.find(b => b.block_id === 'linear_tickets');
      expect((before?.element?.options as unknown[])?.length).toBe(3);

      const result = applyExpandedSection(current, rebuiltLinear(), 'linear', undefined);
      const after = result.find(b => b.block_id === 'linear_tickets');
      expect((after?.element?.options as unknown[])?.length).toBeGreaterThan(3);
    });

    it('leaves the other integration section untouched (no GitHub re-fetch)', () => {
      const current = collapsedView();
      const prBefore = current.find(b => b.block_id === 'my_prs');
      const result = applyExpandedSection(current, rebuiltLinear(), 'linear', undefined);
      const prAfter = result.find(b => b.block_id === 'my_prs');
      // Same object content carried over verbatim — the PR section was not rebuilt.
      expect(prAfter).toEqual(prBefore);
      expect(result.find(b => b.block_id === 'my_prs_show_all')).toBeDefined();
    });

    it('drops the Show all button once everything fits the expanded limit', () => {
      const current = collapsedView();
      expect(current.find(b => b.block_id === 'linear_show_all')).toBeDefined();
      // 15 tickets < expanded limit of 20, so the button should disappear.
      const result = applyExpandedSection(current, rebuiltLinear(), 'linear', undefined);
      expect(result.find(b => b.block_id === 'linear_show_all')).toBeUndefined();
    });

    it('re-applies the user\'s yesterday selection from view state', () => {
      const current = collapsedView();
      // User changed the first yesterday item to "Done" since the modal opened.
      const state = {
        values: {
          yesterday_item_0: { item_status_0: { selected_option: { value: 'done' } } },
        },
      };
      const result = applyExpandedSection(current, rebuiltLinear(), 'linear', state);
      const yday = result.find(b => b.block_id === 'yesterday_item_0');
      expect((yday?.accessory?.initial_option as { value: string })?.value).toBe('done');
    });
  });
});

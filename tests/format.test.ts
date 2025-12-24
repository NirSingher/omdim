/**
 * Tests for lib/format.ts - Message formatting
 */

import { describe, it, expect, vi } from 'vitest';

// Mock slack module
vi.mock('../lib/slack', () => ({
  postMessage: vi.fn(),
  sendDM: vi.fn(),
}));

import {
  formatStandupBlocks,
  formatDailyDigest,
  formatWeeklySummary,
  formatManagerDigest,
  buildBottleneckBlocks,
} from '../lib/format';

describe('format utilities', () => {
  describe('formatStandupBlocks', () => {
    it('includes header with user mention', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const header = blocks[0];
      expect(header.type).toBe('section');
      expect(header.text?.text).toContain('<@U12345>');
      expect(header.text?.text).toContain('submitted their standup');
    });

    it('formats completed items with checkbox emoji', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['Finished task A', 'Completed task B'],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const yesterdayBlock = blocks.find(b => b.text?.text?.includes('Yesterday:'));
      expect(yesterdayBlock?.text?.text).toContain('☑️ Finished task A');
      expect(yesterdayBlock?.text?.text).toContain('☑️ Completed task B');
    });

    it('marks unplanned items with unplanned label', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: ['Fixed urgent bug'],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const yesterdayBlock = blocks.find(b => b.text?.text?.includes('Yesterday:'));
      expect(yesterdayBlock?.text?.text).toContain('☑️ Fixed urgent bug _(unplanned)_');
    });

    it('shows carried over items in today section', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: ['Ongoing work'],
        unplanned: [],
        todayPlans: ['New task'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('⬜ Ongoing work _(carried over)_');
      expect(todayBlock?.text?.text).toContain('⬜ New task');
    });

    it('adds separator between carried over and new items', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: ['Carried task'],
        unplanned: [],
        todayPlans: ['New task'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('───');
    });

    it('includes blockers section when present', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: 'Waiting on API access from <@U99999>',
        customAnswers: {},
      });

      const blockersBlock = blocks.find(b => b.text?.text?.includes('Blockers'));
      expect(blockersBlock?.text?.text).toContain('Waiting on API access from <@U99999>');
    });

    it('excludes blockers section when empty', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const blockersBlock = blocks.find(b => b.text?.text?.includes('Blockers'));
      expect(blockersBlock).toBeUndefined();
    });

    it('includes custom answers', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {
          "How're you feeling?": 'Great!',
          'Any PRs needing review?': 'PR #123',
        },
      });

      const feelingBlock = blocks.find(b => b.text?.text?.includes("How're you feeling?"));
      expect(feelingBlock?.text?.text).toContain('Great!');

      const prBlock = blocks.find(b => b.text?.text?.includes('PRs needing review'));
      expect(prBlock?.text?.text).toContain('PR #123');
    });

    it('sorts custom answers by question order', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {
          'Question A': 'Answer A',
          'Question B': 'Answer B',
          'Question C': 'Answer C',
        },
        questions: [
          { text: 'Question C', order: 1 },
          { text: 'Question A', order: 2 },
          { text: 'Question B', order: 3 },
        ],
      });

      // Find all custom answer blocks
      const customBlocks = blocks.filter(b =>
        b.type === 'section' &&
        b.text?.text?.startsWith('*Question')
      );

      expect(customBlocks.length).toBe(3);
      // Should be ordered: C, A, B (by order: 1, 2, 3)
      expect(customBlocks[0].text?.text).toContain('Question C');
      expect(customBlocks[1].text?.text).toContain('Question A');
      expect(customBlocks[2].text?.text).toContain('Question B');
    });

    it('interleaves custom answers with standard fields based on order', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['Done task'],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Plan 1'],
        blockers: 'A blocker',
        customAnswers: {
          'Question at start': 'Answer 1',
          'Question in middle': 'Answer 2',
        },
        questions: [
          { text: 'Question at start', order: 5 },
          { text: 'Question in middle', order: 25 },
        ],
        fieldOrder: {
          unplanned: 10,
          today_plans: 20,
          blockers: 30,
        },
      });

      // Get section blocks in order (excluding header and footer)
      const sectionBlocks = blocks.filter(b => b.type === 'section');

      // Find indices of each section type
      const findIndex = (text: string) =>
        sectionBlocks.findIndex(b => b.text?.text?.includes(text));

      const headerIdx = findIndex('submitted their standup');
      const questionStartIdx = findIndex('Question at start');
      const yesterdayIdx = findIndex('Yesterday:');
      const todayIdx = findIndex('Today:');
      const questionMiddleIdx = findIndex('Question in middle');
      const blockersIdx = findIndex('Blockers:');

      // Verify order: header, question@5, yesterday@10, today@20, question@25, blockers@30
      expect(headerIdx).toBe(0);
      expect(questionStartIdx).toBeLessThan(yesterdayIdx);
      expect(yesterdayIdx).toBeLessThan(todayIdx);
      expect(todayIdx).toBeLessThan(questionMiddleIdx);
      expect(questionMiddleIdx).toBeLessThan(blockersIdx);
    });

    it('places custom answer before yesterday when order is lower', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['Done task'],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Plan 1'],
        blockers: '',
        customAnswers: {
          "How're you feeling?": 'Great!',
        },
        questions: [
          { text: "How're you feeling?", order: 5 },
        ],
        fieldOrder: {
          unplanned: 10,
          today_plans: 20,
          blockers: 30,
        },
      });

      const sectionBlocks = blocks.filter(b => b.type === 'section');

      const feelingIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes("How're you feeling?")
      );
      const yesterdayIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes('Yesterday:')
      );

      // Question with order 5 should appear before yesterday (order 10)
      expect(feelingIdx).toBeLessThan(yesterdayIdx);
      expect(feelingIdx).toBe(1); // Right after header
    });

    it('places custom answer after blockers when order is higher', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Plan 1'],
        blockers: 'A blocker',
        customAnswers: {
          'PRs to review?': 'PR #123',
        },
        questions: [
          { text: 'PRs to review?', order: 999 },
        ],
        fieldOrder: {
          unplanned: 10,
          today_plans: 20,
          blockers: 30,
        },
      });

      const sectionBlocks = blocks.filter(b => b.type === 'section');

      const prIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes('PRs to review?')
      );
      const blockersIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes('Blockers:')
      );

      // Question with order 999 should appear after blockers (order 30)
      expect(prIdx).toBeGreaterThan(blockersIdx);
    });

    it('uses default field order when fieldOrder not provided', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['Done'],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Plan'],
        blockers: 'Blocker',
        customAnswers: {
          'Early question': 'Answer',
        },
        questions: [
          { text: 'Early question', order: 5 },
        ],
        // No fieldOrder - should use defaults (yesterday:10, today:20, blockers:30)
      });

      const sectionBlocks = blocks.filter(b => b.type === 'section');

      const questionIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes('Early question')
      );
      const yesterdayIdx = sectionBlocks.findIndex(b =>
        b.text?.text?.includes('Yesterday:')
      );

      // Question with order 5 should appear before yesterday (default order 10)
      expect(questionIdx).toBeLessThan(yesterdayIdx);
    });

    it('includes footer with daily name', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const footer = blocks[blocks.length - 1];
      expect(footer.type).toBe('context');
      expect(footer.elements?.[0]?.text).toContain('daily-il standup');
    });
  });

  describe('formatDailyDigest', () => {
    it('shows message when no submissions', () => {
      const result = formatDailyDigest('daily-il', '2025-12-18', []);

      expect(result).toContain('daily-il Digest');
      expect(result).toContain('2025-12-18');
      expect(result).toContain('No submissions yet');
    });

    it('formats submissions with user mentions', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-18T09:30:00Z'),
          date: '2025-12-18',
          yesterday_completed: ['Task A'],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: ['Task B', 'Task C'],
          blockers: null,
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatDailyDigest('daily-il', '2025-12-18', submissions);

      expect(result).toContain('<@U12345>');
      expect(result).toContain('✅ Completed: 1 item');
      expect(result).toContain('📋 Today: 2 items');
    });

    it('shows blockers in digest', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-18T09:30:00Z'),
          date: '2025-12-18',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: ['Task A'],
          blockers: 'Need access to production',
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatDailyDigest('daily-il', '2025-12-18', submissions);

      expect(result).toContain('🚧');
      expect(result).toContain('Need access to production');
    });
  });

  describe('formatWeeklySummary', () => {
    it('includes date range', () => {
      const result = formatWeeklySummary(
        'daily-il',
        '2025-12-12',
        '2025-12-18',
        [],
        []
      );

      expect(result).toContain('2025-12-12 to 2025-12-18');
    });

    it('shows participation stats', () => {
      const stats = [
        { slack_user_id: 'U12345', submission_count: 4, total_days: 5 },
        { slack_user_id: 'U67890', submission_count: 5, total_days: 5 },
      ];

      const result = formatWeeklySummary(
        'daily-il',
        '2025-12-12',
        '2025-12-18',
        [],
        stats
      );

      expect(result).toContain('Participation');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('4/5 days');
      expect(result).toContain('80%');
      expect(result).toContain('<@U67890>');
      expect(result).toContain('100%');
    });

    it('aggregates blockers from submissions', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-15T09:30:00Z'),
          date: '2025-12-15',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: [],
          blockers: 'Blocked on code review',
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatWeeklySummary(
        'daily-il',
        '2025-12-12',
        '2025-12-18',
        submissions,
        []
      );

      expect(result).toContain('Blockers this week');
      expect(result).toContain('Blocked on code review');
      expect(result).toContain('2025-12-15');
    });

    it('counts each line as separate blocker for multiline blockers', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-15T09:30:00Z'),
          date: '2025-12-15',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: [],
          blockers: 'Issue A\nIssue B\nIssue C',
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatWeeklySummary(
        'daily-il',
        '2025-12-12',
        '2025-12-18',
        submissions,
        []
      );

      // All three blocker lines should be listed
      expect(result).toContain('Issue A');
      expect(result).toContain('Issue B');
      expect(result).toContain('Issue C');
      // Each blocker line should have user attribution (bullet point format)
      const blockerLines = result.split('\n').filter(l => l.startsWith('•') && l.includes('<@U12345>'));
      expect(blockerLines.length).toBe(3);
    });

    it('shows celebration when no blockers', () => {
      const result = formatWeeklySummary(
        'daily-il',
        '2025-12-12',
        '2025-12-18',
        [],
        []
      );

      expect(result).toContain('None reported');
      expect(result).toContain('🎉');
    });
  });

  describe('formatManagerDigest', () => {
    it('includes daily label for daily period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).toContain('Daily Digest');
      expect(result).toContain('daily-il');
    });

    it('includes date range for weekly period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
      });

      expect(result).toContain('Weekly Digest');
      expect(result).toContain('2025-12-12 to 2025-12-18');
    });

    it('includes 4-week label for 4-week period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: '4-week',
        startDate: '2025-11-21',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 20,
      });

      expect(result).toContain('4-Week Digest');
    });

    it('shows summary stats', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-18T09:30:00Z'),
          date: '2025-12-18',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: [],
          blockers: null,
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions,
        stats: [{ slack_user_id: 'U12345', submission_count: 1, total_completed: 0, total_planned: 2, total_blockers: 0, avg_items_per_day: 2 }],
        totalWorkdays: 1,
      });

      expect(result).toContain('Summary');
      expect(result).toContain('1 submissions');
      expect(result).toContain('1/1 team members');
    });

    it('shows missing submissions for daily', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [{ slack_user_id: 'U12345', submission_count: 0, total_completed: 0, total_planned: 0, total_blockers: 0, avg_items_per_day: 0 }],
        totalWorkdays: 1,
        missingToday: ['U12345', 'U67890'],
      });

      expect(result).toContain('Not yet submitted');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('<@U67890>');
    });

    it('shows team performance with color coding', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [
          { slack_user_id: 'U111', submission_count: 5, total_completed: 10, total_planned: 12, total_blockers: 0, avg_items_per_day: 2.4 },
          { slack_user_id: 'U222', submission_count: 3, total_completed: 5, total_planned: 6, total_blockers: 1, avg_items_per_day: 2 },
          { slack_user_id: 'U333', submission_count: 1, total_completed: 0, total_planned: 0, total_blockers: 0, avg_items_per_day: 0 },
        ],
        totalWorkdays: 5,
      });

      expect(result).toContain('Team Performance');
      expect(result).toContain('🟢'); // U111: 100%
      expect(result).toContain('🟡'); // U222: 60%
      expect(result).toContain('🔴'); // U333: 20%
      expect(result).toContain('5/5 days');
      expect(result).toContain('3/5 days');
      expect(result).toContain('1/5 days');
    });

    it('shows blocker count warning', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-18T09:30:00Z'),
          date: '2025-12-18',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: [],
          blockers: 'Waiting on API access',
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions,
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).toContain('1 blocker');
      expect(result).toContain('Waiting on API access');
    });

    it('counts multiline blockers as separate items', () => {
      const submissions = [
        {
          id: 1,
          slack_user_id: 'U12345',
          daily_name: 'daily-il',
          submitted_at: new Date('2025-12-18T09:30:00Z'),
          date: '2025-12-18',
          yesterday_completed: [],
          yesterday_incomplete: [],
          unplanned: [],
          today_plans: [],
          blockers: 'Waiting on API access\nNeed design review\nBlocked by CI failure',
          custom_answers: null,
          slack_message_ts: null,
        },
      ];

      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions,
        stats: [],
        totalWorkdays: 1,
      });

      // Should count 3 blockers, not 1
      expect(result).toContain('3 blockers');
      // All three should be listed
      expect(result).toContain('Waiting on API access');
      expect(result).toContain('Need design review');
      expect(result).toContain('Blocked by CI failure');
    });

    it('shows celebration when no blockers', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).toContain('None reported');
      expect(result).toContain('🎉');
    });

    it('shows bottleneck items when provided', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        bottlenecks: [
          { id: 1, text: 'Fix auth timeout issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' },
          { id: 2, text: 'Update API docs', slack_user_id: 'U67890', carry_count: 3, days_pending: 3, type: 'carry' },
        ],
      });

      expect(result).toContain('Bottlenecks');
      expect(result).toContain('Carried 3+ days');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('Fix auth timeout issue');
      expect(result).toContain('5 days');
      expect(result).toContain('carried 4x');
    });

    it('shows high drop rate users when provided', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        dropStats: [
          { slack_user_id: 'U12345', total_items: 20, dropped_count: 8, drop_rate: 40 },
        ],
      });

      expect(result).toContain('Bottlenecks');
      expect(result).toContain('High drop rate');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('8/20 items dropped');
      expect(result).toContain('40%');
    });

    it('shows rankings for weekly period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        rankings: [
          { slack_user_id: 'U111', score: 92.5, participation_rate: 100, completion_rate: 85, items_done: 12, avg_carry_days: 0.5, drop_rate: 5, blocker_days: 0, rank: 1 },
          { slack_user_id: 'U222', score: 78.3, participation_rate: 80, completion_rate: 90, items_done: 8, avg_carry_days: 1.2, drop_rate: 10, blocker_days: 1, rank: 2 },
          { slack_user_id: 'U333', score: 45.0, participation_rate: 60, completion_rate: 50, items_done: 3, avg_carry_days: 2.5, drop_rate: 35, blocker_days: 2, rank: 3 },
        ],
      });

      expect(result).toContain('Team Rankings');
      expect(result).toContain('🥇');
      expect(result).toContain('<@U111>');
      expect(result).toContain('92.5 pts');
      expect(result).toContain('100% participation');
      expect(result).toContain('🥈');
      expect(result).toContain('<@U222>');
      expect(result).toContain('🥉');
      expect(result).toContain('<@U333>');
      expect(result).toContain('⚠️'); // Warning for high drop rate
    });

    it('does not show rankings for daily period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
        rankings: [
          { slack_user_id: 'U111', score: 92.5, participation_rate: 100, completion_rate: 85, items_done: 12, avg_carry_days: 0.5, drop_rate: 5, blocker_days: 0, rank: 1 },
        ],
      });

      expect(result).not.toContain('Team Rankings');
    });

    it('shows rankings for 4-week period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: '4-week',
        startDate: '2025-11-21',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 20,
        rankings: [
          { slack_user_id: 'U111', score: 92.5, participation_rate: 100, completion_rate: 85, items_done: 50, avg_carry_days: 0.3, drop_rate: 5, blocker_days: 1, rank: 1 },
        ],
      });

      expect(result).toContain('Team Rankings');
      expect(result).toContain('🥇');
    });

    it('shows trend indicators when trends are provided', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [
          {
            id: 1,
            slack_user_id: 'U12345',
            daily_name: 'daily-il',
            submitted_at: new Date(),
            date: '2025-12-18',
            yesterday_completed: [],
            yesterday_incomplete: [],
            unplanned: [],
            today_plans: [],
            blockers: null,
            custom_answers: null,
            slack_message_ts: null,
          },
        ],
        stats: [
          { slack_user_id: 'U12345', submission_count: 5, total_completed: 10, total_planned: 12, total_blockers: 1, avg_items_per_day: 2.4 },
        ],
        totalWorkdays: 5,
        trends: {
          current: {
            participation_rate: 85,
            completion_rate: 78,
            blocker_rate: 12,
            total_submissions: 5,
            total_participants: 1,
            total_items_completed: 10,
            total_items_dropped: 3,
            avg_items_per_day: 2.4,
          },
          previous: {
            participation_rate: 72,
            completion_rate: 78,
            blocker_rate: 18,
            total_submissions: 4,
            total_participants: 1,
            total_items_completed: 8,
            total_items_dropped: 2,
            avg_items_per_day: 2.0,
          },
        },
      });

      // Participation improved (72 -> 85)
      expect(result).toContain('Participation: 85% ↑');
      // Completion stayed same (78 -> 78)
      expect(result).toContain('Completion: 78% →');
      // Blockers decreased (18 -> 12), which is good, so should show ↑
      expect(result).toContain('Blockers: 12% ↑');
    });

    it('shows declining trends with down arrow', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [
          { slack_user_id: 'U12345', submission_count: 3, total_completed: 5, total_planned: 8, total_blockers: 2, avg_items_per_day: 2.7 },
        ],
        totalWorkdays: 5,
        trends: {
          current: {
            participation_rate: 60,
            completion_rate: 50,
            blocker_rate: 25,
            total_submissions: 3,
            total_participants: 1,
            total_items_completed: 5,
            total_items_dropped: 5,
            avg_items_per_day: 2.7,
          },
          previous: {
            participation_rate: 80,
            completion_rate: 75,
            blocker_rate: 10,
            total_submissions: 4,
            total_participants: 1,
            total_items_completed: 9,
            total_items_dropped: 3,
            avg_items_per_day: 2.5,
          },
        },
      });

      // Participation declined (80 -> 60)
      expect(result).toContain('Participation: 60% ↓');
      // Completion declined (75 -> 50)
      expect(result).toContain('Completion: 50% ↓');
      // Blockers increased (10 -> 25), which is bad, so should show ↓
      expect(result).toContain('Blockers: 25% ↓');
    });

    it('does not show trends for daily period', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
        trends: {
          current: {
            participation_rate: 85,
            completion_rate: 78,
            blocker_rate: 12,
            total_submissions: 5,
            total_participants: 1,
            total_items_completed: 10,
            total_items_dropped: 3,
            avg_items_per_day: 2.4,
          },
          previous: {
            participation_rate: 72,
            completion_rate: 65,
            blocker_rate: 18,
            total_submissions: 4,
            total_participants: 1,
            total_items_completed: 8,
            total_items_dropped: 2,
            avg_items_per_day: 2.0,
          },
        },
      });

      // Daily period shouldn't show completion trends (too noisy)
      expect(result).not.toContain('Completion:');
    });

    it('shows work alignment not configured when no integrations enabled', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        integrations: { github: false, linear: false },
      });

      expect(result).toContain('🔗 Work Alignment');
      expect(result).toContain('Not configured');
    });

    it('shows GitHub enabled when github integration is on', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        integrations: { github: true, linear: false },
      });

      expect(result).toContain('🔗 Work Alignment');
      expect(result).toContain('GitHub enabled');
    });

    it('shows both integrations when both enabled', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        integrations: { github: true, linear: true },
      });

      expect(result).toContain('🔗 Work Alignment');
      expect(result).toContain('GitHub + Linear enabled');
    });

    it('does not show work alignment section when integrations not provided', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
      });

      expect(result).not.toContain('Work Alignment');
    });
  });

  describe('buildBottleneckBlocks', () => {
    it('returns empty array when no bottlenecks', () => {
      const blocks = buildBottleneckBlocks([], 'daily-il');
      expect(blocks).toEqual([]);
    });

    it('creates header section for bottleneck items', () => {
      const bottlenecks = [
        { id: 1, text: 'Fix auth issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' as const },
      ];

      const blocks = buildBottleneckBlocks(bottlenecks, 'daily-il');

      // First block is the header section
      const headerSection = blocks[0];
      expect(headerSection.type).toBe('section');
      expect(headerSection.text?.text).toContain('Bottleneck Items');
    });

    it('creates section for each bottleneck item with snooze button', () => {
      const bottlenecks = [
        { id: 1, text: 'Fix auth issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' as const },
        { id: 2, text: 'Update docs', slack_user_id: 'U67890', carry_count: 3, days_pending: 3, type: 'carry' as const },
      ];

      const blocks = buildBottleneckBlocks(bottlenecks, 'daily-il');

      // Should have header + 2 item sections
      const sectionBlocks = blocks.filter(b => b.type === 'section' && b.accessory);
      expect(sectionBlocks.length).toBe(2);
    });

    it('includes item text and user mention in section', () => {
      const bottlenecks = [
        { id: 1, text: 'Fix auth issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' as const },
      ];

      const blocks = buildBottleneckBlocks(bottlenecks, 'daily-il');

      const sectionBlock = blocks.find(b => b.type === 'section' && b.accessory);
      expect(sectionBlock?.text?.text).toContain('Fix auth issue');
      expect(sectionBlock?.text?.text).toContain('<@U12345>');
      expect(sectionBlock?.text?.text).toContain('5 days');
    });

    it('includes snooze button with correct action_id', () => {
      const bottlenecks = [
        { id: 1, text: 'Fix auth issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' as const },
      ];

      const blocks = buildBottleneckBlocks(bottlenecks, 'daily-il');

      const sectionBlock = blocks.find(b => b.type === 'section' && b.accessory);
      expect(sectionBlock?.accessory?.type).toBe('button');
      expect(sectionBlock?.accessory?.action_id).toBe('snooze_bottleneck');
      expect(sectionBlock?.accessory?.text?.text).toBe('Snooze 7d');
    });

    it('includes item id and daily name in button value', () => {
      const bottlenecks = [
        { id: 42, text: 'Fix auth issue', slack_user_id: 'U12345', carry_count: 4, days_pending: 5, type: 'carry' as const },
      ];

      const blocks = buildBottleneckBlocks(bottlenecks, 'daily-il');

      const sectionBlock = blocks.find(b => b.type === 'section' && b.accessory);
      const value = JSON.parse(sectionBlock?.accessory?.value || '{}');
      expect(value.itemId).toBe(42);
      expect(value.dailyName).toBe('daily-il');
    });
  });
});

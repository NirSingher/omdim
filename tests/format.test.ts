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
  });
});

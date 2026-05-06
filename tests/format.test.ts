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
  formatPRDigestSection,
  formatLinearDigestSection,
  formatMemberPRSummary,
} from '../lib/format';
import type { TeamPRData } from '../lib/github';
import type { TeamLinearData, CycleProgress } from '../lib/linear';

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

    it('marks dropped items with red X in yesterday section', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['Finished task'],
        yesterdayIncomplete: [],
        yesterdayDropped: ['Cancelled task', 'No longer needed'],
        unplanned: [],
        todayPlans: ['Task 1'],
        blockers: '',
        customAnswers: {},
      });

      const yesterdayBlock = blocks.find(b => b.text?.text?.includes('Yesterday:'));
      expect(yesterdayBlock?.text?.text).toContain('☑️ Finished task');
      expect(yesterdayBlock?.text?.text).toContain('❌ Cancelled task _(dropped)_');
      expect(yesterdayBlock?.text?.text).toContain('❌ No longer needed _(dropped)_');
    });

    it('shows in-progress items with 🔄 emoji in today section', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        yesterdayInProgress: ['WIP task'],
        unplanned: [],
        todayPlans: ['New task'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('🔄 WIP task _(in progress)_');
      expect(todayBlock?.text?.text).toContain('⬜ New task');
    });

    it('shows ⚠️ for in-progress items with carry_count >= 3', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        yesterdayInProgress: ['Stuck task'],
        unplanned: [],
        todayPlans: [],
        blockers: '',
        customAnswers: {},
        inProgressCarryCounts: { 'Stuck task': 3 },
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('⚠️ Stuck task _(in progress)_');
    });

    it('renders in-progress items before carried-over items', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: ['Carried task'],
        yesterdayInProgress: ['WIP task'],
        unplanned: [],
        todayPlans: ['New task'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      const text = todayBlock?.text?.text || '';
      const wipIdx = text.indexOf('WIP task');
      const carriedIdx = text.indexOf('Carried task');
      const newIdx = text.indexOf('New task');
      expect(wipIdx).toBeLessThan(carriedIdx);
      expect(carriedIdx).toBeLessThan(newIdx);
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

    it('enriches PR items with clickable GitHub links', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: ['[my-repo#42] Fix typo'],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['[other-repo#99] Add feature'],
        blockers: '',
        customAnswers: {},
        githubOrg: 'thenvoi',
      });

      const yesterdayBlock = blocks.find(b => b.text?.text?.includes('Yesterday:'));
      expect(yesterdayBlock?.text?.text).toContain('<https://github.com/thenvoi/my-repo/pull/42|📦 my-repo#42>');

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('<https://github.com/thenvoi/other-repo/pull/99|📦 other-repo#99>');
    });

    it('enriches Linear items with clickable Linear links', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['[ENG-123] Fix auth bug'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('<https://linear.app/issue/ENG-123|🎫 ENG-123>');
      expect(todayBlock?.text?.text).toContain('Fix auth bug');
    });

    it('leaves manual items unchanged (no enrichment)', () => {
      const blocks = formatStandupBlocks('U12345', 'daily-il', {
        yesterdayCompleted: [],
        yesterdayIncomplete: [],
        unplanned: [],
        todayPlans: ['Ship the feature'],
        blockers: '',
        customAnswers: {},
      });

      const todayBlock = blocks.find(b => b.text?.text?.includes('Today:'));
      expect(todayBlock?.text?.text).toContain('⬜ Ship the feature');
      expect(todayBlock?.text?.text).not.toContain('<http');
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

  describe('formatManagerDigest (Option C: compact format)', () => {
    it('includes daily name and period in header', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).toContain('daily-il Daily');
      expect(result).toContain('Dec 18');
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

      expect(result).toContain('daily-il Weekly');
      expect(result).toContain('Dec 12-Dec 18');
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

      expect(result).toContain('daily-il 4-Week');
    });

    it('shows participation rate inline', () => {
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

      expect(result).toContain('100% participation');
    });

    it('shows missing submissions inline for daily', () => {
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

      expect(result).toContain('Not submitted:');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('<@U67890>');
    });

    it('shows team section with color coding', () => {
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

      expect(result).toContain('👥 *Team*');
      expect(result).toContain('🟢'); // U111: 100%
      expect(result).toContain('🟡'); // U222: 60%
      expect(result).toContain('🔴'); // U333: 20%
      expect(result).toContain('5/5');
      expect(result).toContain('3/5');
      expect(result).toContain('1/5');
    });

    it('shows blockers in Needs Attention section', () => {
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

      expect(result).toContain('Needs Attention');
      expect(result).toContain('🚧');
      expect(result).toContain('Waiting on API access');
    });

    it('shows multiline blockers with overflow indicator', () => {
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

      // First two blockers shown
      expect(result).toContain('Waiting on API access');
      expect(result).toContain('Need design review');
      // Third blocker shown as overflow
      expect(result).toContain('1 more');
    });

    it('does not show Needs Attention when no blockers or bottlenecks', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).not.toContain('Needs Attention');
    });

    it('shows bottleneck items in Needs Attention', () => {
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

      expect(result).toContain('Needs Attention');
      expect(result).toContain('🔥');
      expect(result).toContain('<@U12345>');
      expect(result).toContain('Fix auth timeout issue');
      expect(result).toContain('stuck 5 days');
    });

    it('shows drop rate warning in team section', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [
          { slack_user_id: 'U12345', submission_count: 3, total_completed: 5, total_planned: 8, total_blockers: 0, avg_items_per_day: 2.7 },
        ],
        totalWorkdays: 5,
        dropStats: [
          { slack_user_id: 'U12345', total_items: 20, dropped_count: 8, drop_rate: 40 },
        ],
      });

      expect(result).toContain('<@U12345>');
      expect(result).toContain('40% drops');
    });

    it('does not show rankings section (moved to full report)', () => {
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
        ],
      });

      // Rankings moved to full report command
      expect(result).not.toContain('Team Rankings');
      expect(result).not.toContain('🥇');
    });

    it('shows trend indicators inline', () => {
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

      // Compact inline format: "85% ↑ participation"
      expect(result).toContain('85% ↑ participation');
      expect(result).toContain('78% → completion');
    });

    it('shows declining trends with down arrow inline', () => {
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

      expect(result).toContain('60% ↓ participation');
      expect(result).toContain('50% ↓ completion');
    });

    it('shows report command hint for weekly/4-week', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
      });

      expect(result).toContain('/standup report daily-il week');
    });

    it('does not show report hint for daily', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
      });

      expect(result).not.toContain('/standup report');
    });

    it('does not show work alignment section (removed for compact format)', () => {
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

      expect(result).not.toContain('Work Alignment');
    });

    it('shows OOO users in daily digest', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
        oooToday: [
          { slackUserId: 'U111', endDate: '2025-12-20' },
          { slackUserId: 'U222', endDate: '2025-12-25' },
        ],
      });

      expect(result).toContain('Out today');
      expect(result).toContain('<@U111>');
      expect(result).toContain('<@U222>');
      expect(result).toContain('Dec 20');
      expect(result).toContain('Dec 25');
    });

    it('does not show OOO section in weekly digest', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'weekly',
        startDate: '2025-12-12',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 5,
        oooToday: [
          { slackUserId: 'U111', endDate: '2025-12-20' },
        ],
      });

      expect(result).not.toContain('Out today');
    });

    it('does not show OOO section when no one is OOO', () => {
      const result = formatManagerDigest({
        dailyName: 'daily-il',
        period: 'daily',
        startDate: '2025-12-18',
        endDate: '2025-12-18',
        submissions: [],
        stats: [],
        totalWorkdays: 1,
        oooToday: [],
      });

      expect(result).not.toContain('Out today');
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

  describe('formatPRDigestSection', () => {
    it('formats team PR data with 3 categories', () => {
      const teamPRData: TeamPRData[] = [
        {
          slackUserId: 'U1',
          githubUsername: 'alice',
          data: {
            draftPRs: [
              {
                number: 123,
                title: 'Draft PR',
                url: 'https://github.com/org/repo/pull/123',
                author: 'alice',
                reviewsNeeded: 0,
                requestedReviewers: [],
                createdAt: '2025-01-15T10:00:00Z',
                updatedAt: '2025-01-16T14:30:00Z',
                draft: true,
              },
            ],
            readyToMerge: [
              {
                number: 456,
                title: 'Approved PR',
                url: 'https://github.com/org/repo/pull/456',
                author: 'alice',
                reviewsNeeded: 0,
                requestedReviewers: [],
                createdAt: '2025-01-10T10:00:00Z',
                updatedAt: '2025-01-16T14:30:00Z',
                draft: false,
              },
            ],
            awaitingReview: [],
            reviewRequests: [
              {
                number: 789,
                title: 'Review needed',
                url: 'https://github.com/org/repo/pull/789',
                author: 'bob',
                reviewsNeeded: 0,
                requestedReviewers: [],
                createdAt: '2025-01-15T10:00:00Z',
                updatedAt: '2025-01-16T14:30:00Z',
                draft: false,
              },
            ],
          },
        },
      ];

      const result = formatPRDigestSection(teamPRData);

      expect(result).toContain('📦 PR Activity');
      expect(result).toContain('1 draft');
      expect(result).toContain('1 ready to merge');
      expect(result).toContain('1 to review');
    });

    it('returns empty string when no PR activity', () => {
      const teamPRData: TeamPRData[] = [
        {
          slackUserId: 'U1',
          githubUsername: 'alice',
          data: {
            draftPRs: [],
            readyToMerge: [],
            awaitingReview: [],
            reviewRequests: [],
          },
        },
      ];

      const result = formatPRDigestSection(teamPRData);
      expect(result).toBe('');
    });

    it('shows warning for members with many PRs', () => {
      const teamPRData: TeamPRData[] = [
        {
          slackUserId: 'U1',
          githubUsername: 'alice',
          data: {
            draftPRs: [
              { number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
              { number: 2, title: 'PR 2', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
              { number: 3, title: 'PR 3', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
            ],
            readyToMerge: [],
            awaitingReview: [],
            reviewRequests: [],
          },
        },
      ];

      const result = formatPRDigestSection(teamPRData);

      expect(result).toContain('⚠️ <@U1>');
      expect(result).toContain('3 draft');
    });

    it('shows warning for members with many review requests', () => {
      const teamPRData: TeamPRData[] = [
        {
          slackUserId: 'U2',
          githubUsername: 'bob',
          data: {
            draftPRs: [],
            readyToMerge: [],
            awaitingReview: [],
            reviewRequests: [
              { number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false },
              { number: 2, title: 'PR 2', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false },
              { number: 3, title: 'PR 3', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false },
            ],
          },
        },
      ];

      const result = formatPRDigestSection(teamPRData);

      expect(result).toContain('⚠️ <@U2>');
      expect(result).toContain('3 to review');
    });

    it('aggregates counts across team members', () => {
      const teamPRData: TeamPRData[] = [
        {
          slackUserId: 'U1',
          githubUsername: 'alice',
          data: {
            draftPRs: [{ number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true }],
            readyToMerge: [],
            awaitingReview: [],
            reviewRequests: [],
          },
        },
        {
          slackUserId: 'U2',
          githubUsername: 'bob',
          data: {
            draftPRs: [{ number: 2, title: 'PR 2', url: 'url', author: 'bob', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true }],
            readyToMerge: [{ number: 3, title: 'PR 3', url: 'url', author: 'bob', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false }],
            awaitingReview: [],
            reviewRequests: [],
          },
        },
      ];

      const result = formatPRDigestSection(teamPRData);

      expect(result).toContain('2 draft');
      expect(result).toContain('1 ready to merge');
    });
  });

  describe('formatLinearDigestSection', () => {
    it('formats cycle progress with team breakdown', () => {
      const cycleProgress: CycleProgress = {
        cycleName: 'Sprint 42',
        startDate: '2025-01-13',
        endDate: '2025-01-27',
        done: 10,
        inProgress: 5,
        todo: 8,
        completionPct: 43,
      };

      const teamData: TeamLinearData[] = [
        {
          slackUserId: 'U1',
          linearUserId: 'linear-1',
          data: {
            issues: [
              {
                id: 'issue-1',
                identifier: 'ENG-123',
                title: 'Fix bug',
                state: { name: 'In Progress', type: 'started' },
                priority: 1,
                url: 'url',
              },
              {
                id: 'issue-2',
                identifier: 'ENG-124',
                title: 'Add feature',
                state: { name: 'Todo', type: 'unstarted' },
                priority: 2,
                url: 'url',
              },
            ],
          },
        },
        {
          slackUserId: 'U2',
          linearUserId: 'linear-2',
          data: {
            issues: [
              {
                id: 'issue-3',
                identifier: 'ENG-125',
                title: 'Review code',
                state: { name: 'In Progress', type: 'started' },
                priority: 1,
                url: 'url',
              },
            ],
          },
        },
      ];

      const result = formatLinearDigestSection(teamData, cycleProgress);

      expect(result).toContain('🎫 Cycle: Sprint 42');
      expect(result).toContain('43% complete');
      expect(result).toContain('10 done');
      expect(result).toContain('5 in progress');
      expect(result).toContain('8 to do');
      expect(result).toContain('<@U1>: 1 in progress, 1 to do');
      expect(result).toContain('<@U2>: 1 in progress');
    });

    it('shows date range in short format', () => {
      const cycleProgress: CycleProgress = {
        cycleName: 'Sprint 42',
        startDate: '2025-01-13',
        endDate: '2025-01-27',
        done: 5,
        inProgress: 0,
        todo: 0,
        completionPct: 100,
      };

      const result = formatLinearDigestSection([], cycleProgress);

      expect(result).toContain('Jan 13');
      expect(result).toContain('Jan 27');
    });

    it('handles members with no issues', () => {
      const cycleProgress: CycleProgress = {
        cycleName: 'Sprint 42',
        startDate: '2025-01-13',
        endDate: '2025-01-27',
        done: 5,
        inProgress: 0,
        todo: 0,
        completionPct: 100,
      };

      const teamData: TeamLinearData[] = [
        {
          slackUserId: 'U1',
          linearUserId: 'linear-1',
          data: { issues: [] },
        },
      ];

      const result = formatLinearDigestSection(teamData, cycleProgress);

      // Should not include members with no issues
      expect(result).not.toContain('<@U1>');
    });

    it('distinguishes between started and unstarted issues', () => {
      const cycleProgress: CycleProgress = {
        cycleName: 'Sprint 42',
        startDate: '2025-01-13',
        endDate: '2025-01-27',
        done: 0,
        inProgress: 0,
        todo: 0,
        completionPct: 0,
      };

      const teamData: TeamLinearData[] = [
        {
          slackUserId: 'U1',
          linearUserId: 'linear-1',
          data: {
            issues: [
              {
                id: 'issue-1',
                identifier: 'ENG-123',
                title: 'Started task',
                state: { name: 'In Progress', type: 'started' },
                priority: 1,
                url: 'url',
              },
              {
                id: 'issue-2',
                identifier: 'ENG-124',
                title: 'Unstarted task 1',
                state: { name: 'Todo', type: 'unstarted' },
                priority: 1,
                url: 'url',
              },
              {
                id: 'issue-3',
                identifier: 'ENG-125',
                title: 'Unstarted task 2',
                state: { name: 'Todo', type: 'unstarted' },
                priority: 1,
                url: 'url',
              },
            ],
          },
        },
      ];

      const result = formatLinearDigestSection(teamData, cycleProgress);

      expect(result).toContain('<@U1>: 1 in progress, 2 to do');
    });
  });

  describe('formatMemberPRSummary', () => {
    it('formats all four PR categories', () => {
      const prData = {
        draftPRs: [{ number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true }],
        readyToMerge: [
          { number: 2, title: 'PR 2', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false },
          { number: 3, title: 'PR 3', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false },
        ],
        awaitingReview: [{ number: 5, title: 'PR 5', url: 'url', author: 'alice', reviewsNeeded: 1, requestedReviewers: ['bob'], createdAt: '', updatedAt: '', draft: false }],
        reviewRequests: [{ number: 4, title: 'PR 4', url: 'url', author: 'bob', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false }],
      };

      const result = formatMemberPRSummary(prData);

      expect(result).toBe('1 awaiting review · 1 draft · 2 ready · 1 to review');
    });

    it('omits empty categories', () => {
      const prData = {
        draftPRs: [],
        readyToMerge: [{ number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: false }],
        awaitingReview: [],
        reviewRequests: [],
      };

      const result = formatMemberPRSummary(prData);

      expect(result).toBe('1 ready');
      expect(result).not.toContain('draft');
      expect(result).not.toContain('to review');
      expect(result).not.toContain('awaiting');
    });

    it('returns empty string when no PRs', () => {
      const prData = {
        draftPRs: [],
        readyToMerge: [],
        awaitingReview: [],
        reviewRequests: [],
      };

      const result = formatMemberPRSummary(prData);

      expect(result).toBe('');
    });

    it('uses correct singular/plural forms', () => {
      const prData = {
        draftPRs: [
          { number: 1, title: 'PR 1', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
          { number: 2, title: 'PR 2', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
          { number: 3, title: 'PR 3', url: 'url', author: 'alice', reviewsNeeded: 0, requestedReviewers: [], createdAt: '', updatedAt: '', draft: true },
        ],
        readyToMerge: [],
        awaitingReview: [],
        reviewRequests: [],
      };

      const result = formatMemberPRSummary(prData);

      expect(result).toBe('3 draft');
    });
  });
});

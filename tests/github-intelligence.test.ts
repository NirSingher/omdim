/**
 * Tests for lib/github-intelligence.ts
 * Pure functions — no mocks required.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeForMatching,
  matchPlanToMergedPR,
  computeGitHubAlignment,
} from '../lib/github-intelligence';
import type { WorkItem } from '../lib/db';
import type { MergedPR } from '../lib/github';

// ============================================================================
// Fixtures
// ============================================================================

function makeWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 1,
    slack_user_id: 'U123',
    daily_name: 'eng-daily',
    text: 'Work on something',
    created_date: '2026-05-07',
    status: 'pending',
    carry_count: 0,
    completed_date: null,
    snoozed_until: null,
    submission_id: null,
    source: 'manual',
    source_ref: null,
    source_url: null,
    item_type: 'plan',
    ...overrides,
  };
}

function makeMergedPR(overrides: Partial<MergedPR> = {}): MergedPR {
  return {
    number: 42,
    title: 'Add user authentication flow',
    repo: 'backend',
    url: 'https://github.com/org/backend/pull/42',
    mergedAt: '2026-05-07T14:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// normalizeForMatching
// ============================================================================

describe('normalizeForMatching', () => {
  it('lowercases and splits on whitespace', () => {
    expect(normalizeForMatching('User Authentication Flow')).toEqual([
      'user', 'authentication', 'flow',
    ]);
  });

  it('removes stop words', () => {
    const result = normalizeForMatching('fix the broken auth for users');
    expect(result).not.toContain('fix');
    expect(result).not.toContain('the');
    expect(result).not.toContain('for');
    expect(result).toContain('broken');
    expect(result).toContain('auth');
    expect(result).toContain('users');
  });

  it('removes words shorter than 3 characters', () => {
    const result = normalizeForMatching('do an API db fix');
    expect(result).not.toContain('do');
    expect(result).not.toContain('an');
    expect(result).toContain('api');
  });

  it('strips punctuation and special characters', () => {
    const result = normalizeForMatching('[backend] user-auth (v2)');
    expect(result).toContain('backend');
    expect(result).toContain('user');
    expect(result).toContain('auth');
  });

  it('deduplicates words', () => {
    const result = normalizeForMatching('auth auth auth');
    expect(result).toEqual(['auth']);
  });

  it('returns empty array for all-stop-words input', () => {
    expect(normalizeForMatching('fix the add')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(normalizeForMatching('')).toEqual([]);
  });
});

// ============================================================================
// matchPlanToMergedPR
// ============================================================================

describe('matchPlanToMergedPR', () => {
  it('matches github_pr item by exact source_ref', () => {
    const item = makeWorkItem({
      source: 'github_pr',
      source_ref: 'backend#42',
      text: 'something unrelated',
    });
    const pr = makeMergedPR({ repo: 'backend', number: 42 });

    expect(matchPlanToMergedPR(item, [pr])).toEqual(pr);
  });

  it('excludes linear_ticket items entirely', () => {
    const item = makeWorkItem({
      source: 'linear_ticket',
      source_ref: 'ENG-123',
      text: 'User authentication flow',
    });
    const pr = makeMergedPR({ title: 'User authentication flow' });

    expect(matchPlanToMergedPR(item, [pr])).toBeNull();
  });

  it('matches manual item by keyword overlap ≥50%', () => {
    const item = makeWorkItem({ text: 'user authentication flow' });
    const pr = makeMergedPR({ title: 'Add user authentication flow' });

    expect(matchPlanToMergedPR(item, [pr])).toEqual(pr);
  });

  it('rejects manual item when keyword overlap <50%', () => {
    const item = makeWorkItem({ text: 'user authentication flow redesign' });
    const pr = makeMergedPR({ title: 'Fix database connection pooling' });

    expect(matchPlanToMergedPR(item, [pr])).toBeNull();
  });

  it('picks best match when multiple PRs qualify', () => {
    const item = makeWorkItem({ text: 'user authentication login flow' });
    const weakPR = makeMergedPR({ number: 10, title: 'Update user profile page' });
    const strongPR = makeMergedPR({ number: 11, title: 'User authentication login endpoint' });

    expect(matchPlanToMergedPR(item, [weakPR, strongPR])).toEqual(strongPR);
  });

  it('returns null when item text produces no keywords', () => {
    const item = makeWorkItem({ text: 'fix the add' }); // all stop words
    const pr = makeMergedPR();

    expect(matchPlanToMergedPR(item, [pr])).toBeNull();
  });

  it('falls back to keyword match when github_pr source_ref does not match', () => {
    const item = makeWorkItem({
      source: 'github_pr',
      source_ref: 'frontend#99',
      text: 'user authentication flow',
    });
    const pr = makeMergedPR({ repo: 'backend', number: 42, title: 'User authentication flow handler' });

    expect(matchPlanToMergedPR(item, [pr])).toEqual(pr);
  });

  it('returns null for empty mergedPRs array', () => {
    const item = makeWorkItem({ text: 'user authentication flow' });
    expect(matchPlanToMergedPR(item, [])).toBeNull();
  });
});

// ============================================================================
// computeGitHubAlignment
// ============================================================================

describe('computeGitHubAlignment', () => {
  it('returns aligned when all plans match PRs and vice versa', () => {
    const items = [
      makeWorkItem({ text: 'user authentication flow' }),
    ];
    const prs = [
      makeMergedPR({ title: 'Add user authentication flow' }),
    ];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.alignmentStatus).toBe('aligned');
    expect(result.plansWithoutWork).toEqual([]);
    expect(result.workWithoutPlans).toEqual([]);
  });

  it('detects plans without matching PRs', () => {
    const items = [
      makeWorkItem({ text: 'database migration script' }),
    ];
    const prs = [
      makeMergedPR({ title: 'Fix CSS layout issue' }),
    ];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.alignmentStatus).toBe('misaligned');
    expect(result.plansWithoutWork).toContain('database migration script');
  });

  it('detects merged PRs without matching plans', () => {
    const items = [
      makeWorkItem({ text: 'user authentication flow' }),
    ];
    const prs = [
      makeMergedPR({ title: 'Add user authentication flow' }),
      makeMergedPR({ number: 99, title: 'Emergency hotfix for payment processing' }),
    ];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.alignmentStatus).toBe('misaligned');
    expect(result.workWithoutPlans).toHaveLength(1);
    expect(result.workWithoutPlans[0].number).toBe(99);
  });

  it('excludes linear_ticket items from plansWithoutWork', () => {
    const items = [
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-100', text: 'Linear issue work' }),
    ];
    const prs: MergedPR[] = [];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.plansWithoutWork).toEqual([]);
  });

  it('includes github_pr items in matching (reduces workWithoutPlans)', () => {
    const items = [
      makeWorkItem({ source: 'github_pr', source_ref: 'backend#42', text: 'PR work' }),
    ];
    const prs = [
      makeMergedPR({ repo: 'backend', number: 42 }),
    ];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.alignmentStatus).toBe('aligned');
    expect(result.workWithoutPlans).toEqual([]);
  });

  it('returns aligned for empty inputs', () => {
    const result = computeGitHubAlignment('U123', [], []);

    expect(result.alignmentStatus).toBe('aligned');
    expect(result.plansWithoutWork).toEqual([]);
    expect(result.workWithoutPlans).toEqual([]);
  });

  it('sets slackUserId on the result', () => {
    const result = computeGitHubAlignment('U999', [], []);
    expect(result.slackUserId).toBe('U999');
  });

  it('handles mixed sources correctly', () => {
    const items = [
      makeWorkItem({ id: 1, text: 'user authentication flow' }),
      makeWorkItem({ id: 2, source: 'linear_ticket', source_ref: 'ENG-50', text: 'linear work' }),
      makeWorkItem({ id: 3, source: 'github_pr', source_ref: 'api#10', text: 'API cleanup' }),
      makeWorkItem({ id: 4, text: 'unrelated documentation task' }),
    ];
    const prs = [
      makeMergedPR({ title: 'User authentication flow handler' }),
      makeMergedPR({ number: 10, repo: 'api', title: 'API cleanup refactor' }),
      makeMergedPR({ number: 77, title: 'Surprise hotfix nobody planned' }),
    ];

    const result = computeGitHubAlignment('U123', items, prs);

    expect(result.plansWithoutWork).toEqual(['unrelated documentation task']);
    expect(result.workWithoutPlans).toHaveLength(1);
    expect(result.workWithoutPlans[0].number).toBe(77);
    expect(result.alignmentStatus).toBe('misaligned');
  });
});

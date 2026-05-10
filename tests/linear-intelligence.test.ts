/**
 * Tests for lib/linear-intelligence.ts
 * Pure functions — no mocks required.
 */

import { describe, it, expect } from 'vitest';
import {
  matchItemToIssue,
  computePriorityAlignment,
  computeLinearAlignment,
} from '../lib/linear-intelligence';
import type { WorkItem } from '../lib/db';
import type { LinearIssue } from '../lib/linear';

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

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-uuid-1',
    identifier: 'ENG-100',
    title: 'Default issue',
    state: { name: 'In Progress', type: 'started' },
    priority: 3,
    url: 'https://linear.app/team/issue/ENG-100',
    ...overrides,
  };
}

// ============================================================================
// matchItemToIssue
// ============================================================================

describe('matchItemToIssue', () => {
  it('matches linear_ticket source by source_ref to issue identifier', () => {
    const item = makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-123' });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).not.toBeNull();
    expect(result!.identifier).toBe('ENG-123');
  });

  it('matches manual source via extractLinearReferences from text', () => {
    const item = makeWorkItem({ source: 'manual', text: 'Fix ENG-123 bug in auth flow' });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).not.toBeNull();
    expect(result!.identifier).toBe('ENG-123');
  });

  it('returns null for github_pr items (excluded from matching)', () => {
    const item = makeWorkItem({ source: 'github_pr', source_ref: 'ENG-123' });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).toBeNull();
  });

  it('returns null when no issue matches the source_ref', () => {
    const item = makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-999' });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).toBeNull();
  });

  it('returns null for manual items without any Linear identifier in text', () => {
    const item = makeWorkItem({ source: 'manual', text: 'Fix the login bug and update docs' });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).toBeNull();
  });

  it('returns null for linear_ticket items with null source_ref', () => {
    const item = makeWorkItem({ source: 'linear_ticket', source_ref: null });
    const issue = makeLinearIssue({ identifier: 'ENG-123' });

    const result = matchItemToIssue(item, [issue]);

    expect(result).toBeNull();
  });
});

// ============================================================================
// computePriorityAlignment
// ============================================================================

describe('computePriorityAlignment', () => {
  it('returns on-track when all high-priority (1-2) items are covered by work items', () => {
    const workItems = [
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-1' }),
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-2' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 1 }), // Urgent
      makeLinearIssue({ identifier: 'ENG-2', priority: 2 }), // High
    ];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('on-track');
    expect(missedHighPriority).toHaveLength(0);
  });

  it('returns off-track when urgent (priority 1) items are missing from plans', () => {
    const workItems = [
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-2' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 1 }), // Urgent — not in plans
      makeLinearIssue({ identifier: 'ENG-2', priority: 2 }), // High — covered
    ];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('off-track');
    expect(missedHighPriority).toHaveLength(1);
    expect(missedHighPriority[0].identifier).toBe('ENG-1');
  });

  it('returns on-track when no high-priority items exist (all low priority)', () => {
    const workItems: WorkItem[] = [];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 3 }), // Medium
      makeLinearIssue({ identifier: 'ENG-2', priority: 4 }), // Low
    ];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('on-track');
    expect(missedHighPriority).toHaveLength(0);
  });

  it('treats priority 0 (No priority) as NOT high priority', () => {
    const workItems: WorkItem[] = [];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 0 }), // No priority
    ];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('on-track');
    expect(missedHighPriority).toHaveLength(0);
  });

  it('returns on-track with empty issues list', () => {
    const workItems = [makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-1' })];
    const issues: LinearIssue[] = [];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('on-track');
    expect(missedHighPriority).toHaveLength(0);
  });

  it('returns off-track with one High (priority 2) item missing from plans', () => {
    const workItems: WorkItem[] = [
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-10' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-10', priority: 3 }), // Medium — covered
      makeLinearIssue({ identifier: 'ENG-11', priority: 2 }), // High — NOT covered
    ];

    const { status, missedHighPriority } = computePriorityAlignment(workItems, issues);

    expect(status).toBe('off-track');
    expect(missedHighPriority).toHaveLength(1);
    expect(missedHighPriority[0].identifier).toBe('ENG-11');
  });
});

// ============================================================================
// computeLinearAlignment
// ============================================================================

describe('computeLinearAlignment', () => {
  it('full alignment: all Linear items in plans, all manual items reference Linear', () => {
    const workItems = [
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-1' }),
      makeWorkItem({ source: 'linear_ticket', source_ref: 'ENG-2' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 3 }),
      makeLinearIssue({ identifier: 'ENG-2', priority: 4 }),
    ];

    const result = computeLinearAlignment('U123', workItems, issues);

    expect(result.slackUserId).toBe('U123');
    expect(result.plansNotInLinear).toHaveLength(0);
    expect(result.linearNotInPlans).toHaveLength(0);
    expect(result.priorityAlignment).toBe('on-track');
    expect(result.missedHighPriority).toHaveLength(0);
  });

  it('partial alignment: some plans not in Linear, some Linear not in plans', () => {
    const workItems = [
      makeWorkItem({ id: 1, source: 'linear_ticket', source_ref: 'ENG-1' }),
      makeWorkItem({ id: 2, source: 'manual', text: 'Write docs — no Linear ticket' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 3 }), // covered
      makeLinearIssue({ identifier: 'ENG-2', priority: 3 }), // NOT in plans
    ];

    const result = computeLinearAlignment('U123', workItems, issues);

    expect(result.plansNotInLinear).toHaveLength(1);
    expect(result.plansNotInLinear[0]).toBe('Write docs — no Linear ticket');
    expect(result.linearNotInPlans).toHaveLength(1);
    expect(result.linearNotInPlans[0].identifier).toBe('ENG-2');
  });

  it('empty work items: all Linear issues flagged as not in plans', () => {
    const workItems: WorkItem[] = [];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 1 }),
      makeLinearIssue({ identifier: 'ENG-2', priority: 2 }),
    ];

    const result = computeLinearAlignment('U456', workItems, issues);

    expect(result.plansNotInLinear).toHaveLength(0);
    expect(result.linearNotInPlans).toHaveLength(2);
    // Priority off-track because urgent/high items are unaccounted
    expect(result.priorityAlignment).toBe('off-track');
    expect(result.missedHighPriority).toHaveLength(2);
  });

  it('empty Linear issues: manual items flagged as not in Linear', () => {
    const workItems = [
      makeWorkItem({ source: 'manual', text: 'Refactor auth module' }),
      makeWorkItem({ source: 'manual', text: 'Update README' }),
    ];
    const issues: LinearIssue[] = [];

    const result = computeLinearAlignment('U789', workItems, issues);

    expect(result.plansNotInLinear).toHaveLength(2);
    expect(result.plansNotInLinear).toContain('Refactor auth module');
    expect(result.plansNotInLinear).toContain('Update README');
    expect(result.linearNotInPlans).toHaveLength(0);
    expect(result.priorityAlignment).toBe('on-track');
  });

  it('GitHub PR items excluded from plans not in Linear', () => {
    const workItems = [
      makeWorkItem({ source: 'github_pr', source_ref: 'pr-42', text: 'PR: fix login' }),
      makeWorkItem({ source: 'manual', text: 'Deploy hotfix' }),
    ];
    const issues: LinearIssue[] = [];

    const result = computeLinearAlignment('U123', workItems, issues);

    // github_pr is not manual so it's excluded from plansNotInLinear
    expect(result.plansNotInLinear).toHaveLength(1);
    expect(result.plansNotInLinear[0]).toBe('Deploy hotfix');
    // github_pr also can't match any issue — no linearNotInPlans since issues is empty
    expect(result.linearNotInPlans).toHaveLength(0);
  });

  it('combined: cross-reference and priority alignment both computed correctly', () => {
    const workItems = [
      makeWorkItem({ id: 1, source: 'linear_ticket', source_ref: 'ENG-1' }),
      makeWorkItem({ id: 2, source: 'manual', text: 'Fix ENG-3 crash on iOS' }),
      makeWorkItem({ id: 3, source: 'manual', text: 'Team meeting prep' }),
    ];
    const issues = [
      makeLinearIssue({ identifier: 'ENG-1', priority: 1 }), // Urgent — covered by linear_ticket
      makeLinearIssue({ identifier: 'ENG-2', priority: 2 }), // High — NOT in plans (off-track)
      makeLinearIssue({ identifier: 'ENG-3', priority: 3 }), // Medium — covered by manual mention
    ];

    const result = computeLinearAlignment('U123', workItems, issues);

    // ENG-2 is assigned but not in any work item
    expect(result.linearNotInPlans).toHaveLength(1);
    expect(result.linearNotInPlans[0].identifier).toBe('ENG-2');

    // "Team meeting prep" doesn't reference any Linear issue
    expect(result.plansNotInLinear).toHaveLength(1);
    expect(result.plansNotInLinear[0]).toBe('Team meeting prep');

    // ENG-2 is High priority and missing
    expect(result.priorityAlignment).toBe('off-track');
    expect(result.missedHighPriority).toHaveLength(1);
    expect(result.missedHighPriority[0].identifier).toBe('ENG-2');
  });
});

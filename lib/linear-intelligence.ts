/**
 * Linear Intelligence — Phase 1 & 2
 * Pure data transformation: plan-vs-Linear cross-reference and priority alignment.
 * No Slack or DB dependencies.
 */

import { WorkItem } from './db';
import { LinearIssue, extractLinearReferences } from './linear';

// ============================================================================
// Types
// ============================================================================

export interface AlignmentResult {
  slackUserId: string;
  plansNotInLinear: string[];       // manual plan item texts with no Linear match
  linearNotInPlans: LinearIssue[];  // assigned issues missing from plans
  priorityAlignment: 'on-track' | 'off-track';
  missedHighPriority: LinearIssue[]; // urgent/high items not in plans
}

// ============================================================================
// Core Matching
// ============================================================================

/**
 * Match a work item to a Linear issue.
 * Rules (in priority order):
 *   1. item.source === 'linear_ticket' AND item.source_ref === issue.identifier
 *   2. item.source === 'manual' AND extractLinearReferences(item.text) contains issue.identifier
 *   3. github_pr items never match (excluded)
 */
export function matchItemToIssue(
  item: WorkItem,
  issues: LinearIssue[]
): LinearIssue | null {
  if (item.source === 'github_pr') return null;

  if (item.source === 'linear_ticket' && item.source_ref) {
    return issues.find(i => i.identifier === item.source_ref) ?? null;
  }

  if (item.source === 'manual') {
    const refs = extractLinearReferences(item.text);
    if (refs.length > 0) {
      return issues.find(i => refs.includes(i.identifier)) ?? null;
    }
  }

  return null;
}

// ============================================================================
// Priority Alignment
// ============================================================================

/**
 * Check if high-priority Linear issues (priority <= 2, i.e. Urgent/High) are in today's plans.
 * Priority 0 = No priority — treated as lowest, NOT high-priority.
 */
export function computePriorityAlignment(
  workItems: WorkItem[],
  linearIssues: LinearIssue[]
): { status: 'on-track' | 'off-track'; missedHighPriority: LinearIssue[] } {
  const highPriority = linearIssues.filter(i => i.priority >= 1 && i.priority <= 2);

  if (highPriority.length === 0) {
    return { status: 'on-track', missedHighPriority: [] };
  }

  // Build a set of all source_refs from work items for fast lookup
  const coveredRefs = new Set<string>(
    workItems
      .filter(item => item.source_ref != null)
      .map(item => item.source_ref as string)
  );

  const missed = highPriority.filter(issue => !coveredRefs.has(issue.identifier));

  return {
    status: missed.length > 0 ? 'off-track' : 'on-track',
    missedHighPriority: missed,
  };
}

// ============================================================================
// Main Alignment Computation
// ============================================================================

/**
 * Compute full plan-vs-Linear alignment for a single user.
 *
 * - plansNotInLinear: manual items that don't reference any assigned Linear issue
 * - linearNotInPlans: assigned Linear issues not covered by any work item
 * - priorityAlignment: whether all Urgent/High issues appear in plans
 */
export function computeLinearAlignment(
  slackUserId: string,
  workItems: WorkItem[],
  linearIssues: LinearIssue[]
): AlignmentResult {
  // ---- linear not in plans ----
  // For each Linear issue, check if any work item matches it
  const linearNotInPlans: LinearIssue[] = linearIssues.filter(issue => {
    return !workItems.some(item => {
      const matched = matchItemToIssue(item, [issue]);
      return matched !== null;
    });
  });

  // ---- plans not in Linear ----
  // For each manual work item, check if it matches any Linear issue
  const plansNotInLinear: string[] = workItems
    .filter(item => item.source === 'manual')
    .filter(item => matchItemToIssue(item, linearIssues) === null)
    .map(item => item.text);

  // ---- priority alignment ----
  const { status, missedHighPriority } = computePriorityAlignment(workItems, linearIssues);

  return {
    slackUserId,
    plansNotInLinear,
    linearNotInPlans,
    priorityAlignment: status,
    missedHighPriority,
  };
}

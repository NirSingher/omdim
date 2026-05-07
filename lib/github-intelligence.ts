/**
 * GitHub Intelligence — Phase 2
 * Pure data transformation: plan-vs-merged-PR cross-reference.
 * No Slack, DB, or HTTP dependencies.
 */

import { WorkItem } from './db';
import { MergedPR } from './github';

export type { MergedPR };

// ============================================================================
// Types
// ============================================================================

export interface GitHubAlignmentResult {
  slackUserId: string;
  plansWithoutWork: string[];     // plan item texts with no matching merged PR
  workWithoutPlans: MergedPR[];   // merged PRs not covered by any plan item
  alignmentStatus: 'aligned' | 'misaligned';
}

// ============================================================================
// Text Normalization
// ============================================================================

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'in', 'on', 'for', 'to', 'and', 'or', 'of',
  'with', 'from', 'by', 'at', 'as', 'it', 'fix', 'add', 'update',
  'implement', 'feat', 'chore', 'refactor',
]);

/**
 * Extract meaningful keywords from text for substring matching.
 * Lowercases, strips punctuation, splits on whitespace, removes stop words
 * and short words, and returns unique terms.
 */
export function normalizeForMatching(text: string): string[] {
  const cleaned = text
    .toLowerCase()
    .replace(/[[\](){}<>*#@!?,;:'"\\|/]/g, ' ') // strip punctuation/special chars
    .replace(/[^\w\s-]/g, ' ')                    // catch anything left
    .replace(/-/g, ' ');                           // treat hyphens as spaces

  const words = cleaned.split(/\s+/).filter(Boolean);

  const unique = new Set<string>();
  for (const word of words) {
    if (word.length >= 3 && !STOP_WORDS.has(word)) {
      unique.add(word);
    }
  }

  return Array.from(unique);
}

// ============================================================================
// Core Matching
// ============================================================================

/**
 * Match a work item to a merged PR.
 *
 * Priority order:
 *   1. Exact source_ref match: item.source === 'github_pr' AND source_ref === '{repo}#{number}'
 *   2. Keyword match: ≥50% of normalized plan keywords appear in the PR title
 *   3. linear_ticket items are excluded (handled by Linear intelligence)
 *
 * Returns the best-matching PR, or null if none found.
 */
export function matchPlanToMergedPR(
  item: WorkItem,
  mergedPRs: MergedPR[]
): MergedPR | null {
  // linear_ticket items are not matched here
  if (item.source === 'linear_ticket') return null;

  // Rule 1: exact source_ref match for github_pr items
  if (item.source === 'github_pr' && item.source_ref) {
    const exact = mergedPRs.find(
      pr => `${pr.repo}#${pr.number}` === item.source_ref
    );
    if (exact) return exact;
  }

  // Rule 2: keyword overlap match (applies to manual and github_pr items)
  const itemKeywords = normalizeForMatching(item.text);
  if (itemKeywords.length === 0) return null;

  let bestMatch: MergedPR | null = null;
  let bestOverlap = 0;

  for (const pr of mergedPRs) {
    const prKeywords = new Set(normalizeForMatching(pr.title));
    const matchCount = itemKeywords.filter(kw => prKeywords.has(kw)).length;
    const overlapRatio = matchCount / itemKeywords.length;

    if (overlapRatio >= 0.5 && matchCount > bestOverlap) {
      bestOverlap = matchCount;
      bestMatch = pr;
    }
  }

  return bestMatch;
}

// ============================================================================
// Main Alignment Computation
// ============================================================================

/**
 * Compute full plan-vs-GitHub alignment for a single user.
 *
 * - plansWithoutWork: manual items that don't match any merged PR
 * - workWithoutPlans: merged PRs that no work item matches
 * - alignmentStatus: 'misaligned' if either list is non-empty
 *
 * linear_ticket items are excluded from "plans without work" — they're
 * tracked by Linear intelligence.
 */
export function computeGitHubAlignment(
  slackUserId: string,
  workItems: WorkItem[],
  mergedPRs: MergedPR[]
): GitHubAlignmentResult {
  // ---- plans without work ----
  // Only manual items can be "unmatched plans"
  const plansWithoutWork: string[] = workItems
    .filter(item => item.source === 'manual')
    .filter(item => matchPlanToMergedPR(item, mergedPRs) === null)
    .map(item => item.text);

  // ---- work without plans ----
  // PRs that no work item (of any source) maps to
  const workWithoutPlans: MergedPR[] = mergedPRs.filter(pr => {
    return !workItems.some(item => {
      const matched = matchPlanToMergedPR(item, [pr]);
      return matched !== null;
    });
  });

  const alignmentStatus =
    plansWithoutWork.length > 0 || workWithoutPlans.length > 0
      ? 'misaligned'
      : 'aligned';

  return {
    slackUserId,
    plansWithoutWork,
    workWithoutPlans,
    alignmentStatus,
  };
}

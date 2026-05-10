/**
 * GitHub API client for fetching PR data
 * - Fetch user's PRs needing review
 * - Fetch PRs where user is requested as reviewer
 */

// ============================================================================
// Types
// ============================================================================

export interface GitHubPR {
  number: number;
  title: string;
  url: string;
  author: string;
  reviewsNeeded: number; // Count of pending review requests
  requestedReviewers: string[]; // GitHub logins of requested reviewers
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

export interface UserPRData {
  draftPRs: GitHubPR[]; // PRs authored by user that are still drafts
  readyToMerge: GitHubPR[]; // PRs authored by user that are approved
  awaitingReview: GitHubPR[]; // PRs authored by user, not draft, not yet approved
  reviewRequests: GitHubPR[]; // PRs where user is requested to review
}

// GitHub API response types
interface GitHubUser {
  login: string;
}

interface GitHubSearchItem {
  number: number;
  title: string;
  html_url: string;
  user: GitHubUser;
  created_at: string;
  updated_at: string;
  draft: boolean;
  requested_reviewers?: GitHubUser[];
  repository_url?: string; // e.g., "https://api.github.com/repos/org/repo"
  pull_request?: {
    merged_at: string | null;
  };
}

export interface GitHubReview {
  user: GitHubUser;
  submitted_at: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  body: string;
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchItem[];
}

// ============================================================================
// GitHub API Client
// ============================================================================

/**
 * Fetch draft PRs authored by a user
 */
export async function fetchDraftPRs(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  const query = `is:pr is:open author:${username} org:${org} draft:true`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for draft PRs: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: item.requested_reviewers?.length || 0,
      requestedReviewers: item.requested_reviewers?.map(r => r.login) || [],
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));
  } catch (error) {
    console.error('Failed to fetch draft PRs:', error);
    return [];
  }
}

/**
 * Fetch approved (ready to merge) PRs authored by a user
 */
export async function fetchApprovedPRs(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  const query = `is:pr is:open author:${username} org:${org} draft:false review:approved`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for approved PRs: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: item.requested_reviewers?.length || 0,
      requestedReviewers: item.requested_reviewers?.map(r => r.login) || [],
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));
  } catch (error) {
    console.error('Failed to fetch approved PRs:', error);
    return [];
  }
}

/**
 * Fetch PRs where the user is requested as a reviewer.
 * Fetches reviews for each PR and filters out those where the reviewer
 * has already acted and the ball is back in the author's court.
 */
export async function fetchReviewRequests(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  const query = `is:pr is:open review-requested:${username} org:${org}`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for review requests: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    const prs: GitHubPR[] = data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: 0,
      requestedReviewers: item.requested_reviewers?.map(r => r.login) || [],
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));

    if (prs.length === 0) return [];

    // Fetch reviews for all PRs in parallel; fail-open on errors
    const reviewsMap = new Map<number, GitHubReview[]>();
    await Promise.all(
      prs.map(async (pr) => {
        const repoMatch = pr.url.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
        if (!repoMatch) return; // fail-open: no repo info, keep PR

        const [, owner, repo] = repoMatch;
        try {
          const reviews = await fetchPRReviews(token, owner, repo, pr.number);
          reviewsMap.set(pr.number, reviews);
        } catch (err) {
          // fail-open: if reviews fetch fails, keep PR visible (don't add to map)
          console.warn(`Could not fetch reviews for PR #${pr.number}:`, err);
        }
      })
    );

    return filterReviewRequests(prs, reviewsMap, username);
  } catch (error) {
    console.error('Failed to fetch review requests:', error);
    return [];
  }
}

/**
 * Fetch non-draft PRs authored by a user that haven't been approved yet
 * (awaiting review from others)
 */
export async function fetchAwaitingReviewPRs(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  const query = `is:pr is:open author:${username} org:${org} draft:false -review:approved`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for awaiting review PRs: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: item.requested_reviewers?.length || 0,
      requestedReviewers: item.requested_reviewers?.map(r => r.login) || [],
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));
  } catch (error) {
    console.error('Failed to fetch awaiting review PRs:', error);
    return [];
  }
}

/**
 * Fetch all reviews for a specific PR
 */
export async function fetchPRReviews(
  token: string,
  owner: string,
  repo: string,
  prNumber: number
): Promise<GitHubReview[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'omdim-bot',
      },
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub API error fetching reviews for ${owner}/${repo}#${prNumber}: ${response.status} ${errorText}`);
  }

  return response.json() as Promise<GitHubReview[]>;
}

/**
 * Filter review-requested PRs to only those where the reviewer still needs to act.
 *
 * Rules (fail-open: when in doubt, keep the PR visible):
 * - Keep if reviewer has no reviews on this PR (fresh request)
 * - Hide if reviewer's latest non-PENDING review was submitted at or after pr.updated_at
 *   (reviewer acted, ball is in the author's court)
 * - Hide if someone (non-author) submitted APPROVED and no CHANGES_REQUESTED came after it
 * - PENDING reviews are ignored (not submitted yet)
 * - Reviews by the PR author are ignored
 */
export function filterReviewRequests(
  prs: GitHubPR[],
  reviewsMap: Map<number, GitHubReview[]>,
  username: string
): GitHubPR[] {
  return prs.filter((pr) => {
    const allReviews = reviewsMap.get(pr.number);

    // No review data available — fail-open, keep the PR
    if (allReviews === undefined) return true;

    // Ignore PENDING and reviews by the PR author
    const submittedReviews = allReviews.filter(
      (r) => r.state !== 'PENDING' && r.user.login.toLowerCase() !== pr.author.toLowerCase()
    );

    // Check if someone already approved and no CHANGES_REQUESTED supersedes it
    const approvals = submittedReviews
      .filter((r) => r.state === 'APPROVED')
      .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));

    if (approvals.length > 0) {
      const lastApproval = approvals[approvals.length - 1];
      const changesRequestedAfterApproval = submittedReviews.some(
        (r) => r.state === 'CHANGES_REQUESTED' && r.submitted_at > lastApproval.submitted_at
      );
      if (!changesRequestedAfterApproval) return false;
    }

    // Reviewer's own reviews
    const reviewerReviews = submittedReviews.filter(
      (r) => r.user.login.toLowerCase() === username.toLowerCase()
    );

    if (reviewerReviews.length === 0) return true;

    const latestReviewerReview = reviewerReviews[reviewerReviews.length - 1];

    // If reviewer's latest review is at or after PR's last update,
    // the ball is in the author's court — hide it
    if (latestReviewerReview.submitted_at >= pr.updatedAt) return false;

    return true;
  });
}

/**
 * Fetch PRs where the user previously reviewed but new updates were pushed since.
 * These PRs no longer have the user in review-requested (author didn't re-request),
 * but the PR was updated after the user's last review — likely needs re-review.
 */
export async function fetchPRsNeedingReReview(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  // Find PRs user reviewed but is NOT currently requested on
  const query = `is:pr is:open reviewed-by:${username} org:${org} -review-requested:${username} -author:${username}`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=10`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for re-review PRs: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    if (data.items.length === 0) return [];

    // For each PR, check if it was updated after the user's last review
    const prChecks = data.items.map(async (item): Promise<GitHubPR | null> => {
      // Extract owner/repo from html_url
      const repoMatch = item.html_url.match(/github\.com\/([^/]+)\/([^/]+)\/pull/);
      if (!repoMatch) return null;

      const [, owner, repo] = repoMatch;

      try {
        const reviews = await fetchPRReviews(token, owner, repo, item.number);

        // Find the user's latest review
        const userReviews = reviews.filter(
          (r) => r.user.login.toLowerCase() === username.toLowerCase()
        );

        if (userReviews.length === 0) return null;

        const latestReview = userReviews[userReviews.length - 1];
        const reviewDate = new Date(latestReview.submitted_at);
        const updatedDate = new Date(item.updated_at);

        // PR was updated after user's last review — needs re-review
        if (updatedDate > reviewDate) {
          return {
            number: item.number,
            title: item.title,
            url: item.html_url,
            author: item.user.login,
            reviewsNeeded: 0,
            requestedReviewers: item.requested_reviewers?.map(r => r.login) || [],
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            draft: item.draft,
          };
        }

        return null;
      } catch {
        return null;
      }
    });

    const results = await Promise.all(prChecks);
    return results.filter((pr): pr is GitHubPR => pr !== null);
  } catch (error) {
    console.error('Failed to fetch PRs needing re-review:', error);
    return [];
  }
}

/**
 * Fetch all PR data for a user in an org
 * Combines draft PRs, approved PRs, awaiting review PRs, and review requests
 */
export async function fetchUserPRData(
  token: string,
  username: string,
  org: string
): Promise<UserPRData> {
  // Fetch all five in parallel
  const [draftPRs, readyToMerge, awaitingReview, reviewRequests, reReviewPRs] = await Promise.all([
    fetchDraftPRs(token, username, org),
    fetchApprovedPRs(token, username, org),
    fetchAwaitingReviewPRs(token, username, org),
    fetchReviewRequests(token, username, org),
    fetchPRsNeedingReReview(token, username, org),
  ]);

  // Merge re-review PRs into reviewRequests, deduplicating by PR number
  const existingNumbers = new Set(reviewRequests.map((pr) => pr.number));
  const uniqueReReviewPRs = reReviewPRs.filter((pr) => !existingNumbers.has(pr.number));

  return {
    draftPRs,
    readyToMerge,
    awaitingReview,
    reviewRequests: [...reviewRequests, ...uniqueReReviewPRs],
  };
}

// ============================================================================
// Batch Operations
// ============================================================================

export interface TeamPRData {
  slackUserId: string;
  githubUsername: string;
  data: UserPRData;
}

/**
 * Fetch PR data for multiple users
 * Uses batching to avoid rate limits
 */
export async function fetchTeamPRData(
  token: string,
  org: string,
  users: Array<{ slackUserId: string; githubUsername: string }>
): Promise<TeamPRData[]> {
  const results: TeamPRData[] = [];

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (user) => {
        const data = await fetchUserPRData(token, user.githubUsername, org);
        return {
          slackUserId: user.slackUserId,
          githubUsername: user.githubUsername,
          data,
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

// ============================================================================
// Merged PR Fetching
// ============================================================================

export interface MergedPR {
  number: number;
  title: string;
  repo: string;
  url: string;
  mergedAt: string;
}

/**
 * Fetch PRs merged by a user in an org since a given date
 */
export async function fetchMergedPRs(
  token: string,
  username: string,
  org: string,
  since: string // ISO date string, e.g. "2026-05-07"
): Promise<MergedPR[]> {
  const query = `is:pr is:merged author:${username} org:${org} merged:>${since}`;

  try {
    const response = await fetch(
      `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=100`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'omdim-bot',
        },
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`GitHub API error for merged PRs (${username}): ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    return data.items.map((item) => {
      // Extract repo name from repository_url: "https://api.github.com/repos/{org}/{repo}"
      const repoParts = (item.repository_url || '').split('/');
      const repo = repoParts[repoParts.length - 1] || '';

      return {
        number: item.number,
        title: item.title,
        repo,
        url: item.html_url,
        mergedAt: item.pull_request?.merged_at || '',
      };
    });
  } catch (error) {
    console.error(`Failed to fetch merged PRs for ${username}:`, error);
    return [];
  }
}

export interface TeamMergedPRData {
  slackUserId: string;
  githubUsername: string;
  mergedPRs: MergedPR[];
}

/**
 * Fetch merged PRs for multiple users in an org since a given date
 * Uses batching to avoid rate limits
 */
export async function fetchTeamMergedPRs(
  token: string,
  org: string,
  users: Array<{ slackUserId: string; githubUsername: string }>,
  since: string
): Promise<TeamMergedPRData[]> {
  const results: TeamMergedPRData[] = [];

  // Process in batches of 5 to avoid rate limits
  const batchSize = 5;
  for (let i = 0; i < users.length; i += batchSize) {
    const batch = users.slice(i, i + batchSize);

    const batchResults = await Promise.all(
      batch.map(async (user) => {
        const mergedPRs = await fetchMergedPRs(token, user.githubUsername, org, since);
        return {
          slackUserId: user.slackUserId,
          githubUsername: user.githubUsername,
          mergedPRs,
        };
      })
    );

    results.push(...batchResults);
  }

  return results;
}

// ============================================================================
// PR Extraction Helpers
// ============================================================================

/**
 * Extract branch name from PR URL
 * e.g., "https://github.com/org/repo/pull/123" → PR #123 in org/repo
 */
export function extractPRSlug(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (match) {
    return `${match[2]}#${match[3]}`; // "repo#123"
  }
  return null;
}

/**
 * Format a short PR reference for display
 * Extracts repo name and PR number from URL
 */
export function formatPRRef(pr: GitHubPR): string {
  const slug = extractPRSlug(pr.url);
  return slug || `#${pr.number}`;
}


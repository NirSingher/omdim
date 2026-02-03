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
  createdAt: string;
  updatedAt: string;
  draft: boolean;
}

export interface UserPRData {
  authoredPRs: GitHubPR[]; // PRs authored by user awaiting review
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
}

interface GitHubSearchResponse {
  total_count: number;
  items: GitHubSearchItem[];
}

// ============================================================================
// GitHub API Client
// ============================================================================

/**
 * Fetch PRs authored by a user that are awaiting review
 * These are open PRs by the user in the org
 */
export async function fetchUserPRs(
  token: string,
  username: string,
  org: string
): Promise<GitHubPR[]> {
  const query = `is:pr is:open author:${username} org:${org} draft:false`;

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
      console.error(`GitHub API error for authored PRs: ${response.status} ${errorText}`);
      return [];
    }

    const data = await response.json() as GitHubSearchResponse;

    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: item.requested_reviewers?.length || 0,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));
  } catch (error) {
    console.error('Failed to fetch authored PRs:', error);
    return [];
  }
}

/**
 * Fetch PRs where the user is requested as a reviewer
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

    return data.items.map((item) => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user.login,
      reviewsNeeded: 0,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft,
    }));
  } catch (error) {
    console.error('Failed to fetch review requests:', error);
    return [];
  }
}

/**
 * Fetch all PR data for a user in an org
 * Combines authored PRs and review requests
 */
export async function fetchUserPRData(
  token: string,
  username: string,
  org: string
): Promise<UserPRData> {
  // Fetch both in parallel
  const [authoredPRs, reviewRequests] = await Promise.all([
    fetchUserPRs(token, username, org),
    fetchReviewRequests(token, username, org),
  ]);

  return { authoredPRs, reviewRequests };
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

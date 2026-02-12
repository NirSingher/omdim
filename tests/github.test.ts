/**
 * Tests for lib/github.ts - GitHub API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
global.fetch = vi.fn();

import {
  fetchDraftPRs,
  fetchApprovedPRs,
  fetchAwaitingReviewPRs,
  fetchReviewRequests,
  fetchUserPRData,
  extractPRSlug,
  formatPRRef,
  GitHubPR,
} from '../lib/github';

describe('github client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('fetchDraftPRs', () => {
    it('fetches draft PRs for a user in an org', async () => {
      const mockResponse = {
        total_count: 2,
        items: [
          {
            number: 123,
            title: 'WIP: Add new feature',
            html_url: 'https://github.com/myorg/repo1/pull/123',
            user: { login: 'alice' },
            created_at: '2025-01-15T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: true,
            requested_reviewers: [{ login: 'bob' }, { login: 'charlie' }],
          },
          {
            number: 124,
            title: 'Draft: Fix bug',
            html_url: 'https://github.com/myorg/repo2/pull/124',
            user: { login: 'alice' },
            created_at: '2025-01-14T09:00:00Z',
            updated_at: '2025-01-15T11:00:00Z',
            draft: true,
            requested_reviewers: [],
          },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchDraftPRs('token', 'alice', 'myorg');

      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(123);
      expect(result[0].title).toBe('WIP: Add new feature');
      expect(result[0].draft).toBe(true);
      expect(result[0].reviewsNeeded).toBe(2);
      expect(result[1].number).toBe(124);
      expect(result[1].reviewsNeeded).toBe(0);
    });

    it('constructs correct search query with draft:true filter', async () => {
      const mockResponse = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchDraftPRs('token', 'alice', 'myorg');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;

      // URL is encoded, check for encoded versions
      expect(url).toContain('is%3Apr');
      expect(url).toContain('is%3Aopen');
      expect(url).toContain('author%3Aalice');
      expect(url).toContain('org%3Amyorg');
      expect(url).toContain('draft%3Atrue');
    });

    it('returns empty array on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await fetchDraftPRs('token', 'alice', 'myorg');

      expect(result).toEqual([]);
    });

    it('includes correct headers', async () => {
      const mockResponse = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchDraftPRs('my-token', 'alice', 'myorg');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const options = fetchCall[1] as RequestInit;

      expect(options.headers).toMatchObject({
        'Authorization': 'Bearer my-token',
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'omdim-bot',
      });
    });
  });

  describe('fetchApprovedPRs', () => {
    it('fetches approved PRs for a user in an org', async () => {
      const mockResponse = {
        total_count: 1,
        items: [
          {
            number: 456,
            title: 'Ready to merge feature',
            html_url: 'https://github.com/myorg/repo/pull/456',
            user: { login: 'alice' },
            created_at: '2025-01-10T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
            requested_reviewers: [],
          },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchApprovedPRs('token', 'alice', 'myorg');

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(456);
      expect(result[0].title).toBe('Ready to merge feature');
      expect(result[0].draft).toBe(false);
    });

    it('constructs correct search query with review:approved filter', async () => {
      const mockResponse = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchApprovedPRs('token', 'alice', 'myorg');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;

      // URL is encoded, check for encoded versions
      expect(url).toContain('is%3Apr');
      expect(url).toContain('is%3Aopen');
      expect(url).toContain('author%3Aalice');
      expect(url).toContain('org%3Amyorg');
      expect(url).toContain('draft%3Afalse');
      expect(url).toContain('review%3Aapproved');
    });

    it('returns empty array on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await fetchApprovedPRs('token', 'alice', 'myorg');

      expect(result).toEqual([]);
    });
  });

  describe('fetchReviewRequests', () => {
    it('fetches PRs where user is requested as reviewer', async () => {
      const mockResponse = {
        total_count: 2,
        items: [
          {
            number: 789,
            title: 'Please review this PR',
            html_url: 'https://github.com/myorg/repo/pull/789',
            user: { login: 'bob' },
            created_at: '2025-01-15T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
          },
          {
            number: 790,
            title: 'Urgent review needed',
            html_url: 'https://github.com/myorg/repo/pull/790',
            user: { login: 'charlie' },
            created_at: '2025-01-16T09:00:00Z',
            updated_at: '2025-01-16T15:00:00Z',
            draft: false,
          },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchReviewRequests('token', 'alice', 'myorg');

      expect(result).toHaveLength(2);
      expect(result[0].number).toBe(789);
      expect(result[0].author).toBe('bob');
      expect(result[1].number).toBe(790);
      expect(result[1].author).toBe('charlie');
    });

    it('constructs correct search query with review-requested filter', async () => {
      const mockResponse = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchReviewRequests('token', 'alice', 'myorg');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;

      // URL is encoded, check for encoded versions
      expect(url).toContain('is%3Apr');
      expect(url).toContain('is%3Aopen');
      expect(url).toContain('review-requested%3Aalice');
      expect(url).toContain('org%3Amyorg');
    });

    it('returns empty array on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await fetchReviewRequests('token', 'alice', 'myorg');

      expect(result).toEqual([]);
    });
  });

  describe('fetchAwaitingReviewPRs', () => {
    it('fetches non-draft non-approved PRs authored by a user', async () => {
      const mockResponse = {
        total_count: 1,
        items: [
          {
            number: 555,
            title: 'Needs review',
            html_url: 'https://github.com/myorg/repo/pull/555',
            user: { login: 'alice' },
            created_at: '2025-01-15T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
            requested_reviewers: [{ login: 'bob' }, { login: 'charlie' }],
          },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchAwaitingReviewPRs('token', 'alice', 'myorg');

      expect(result).toHaveLength(1);
      expect(result[0].number).toBe(555);
      expect(result[0].requestedReviewers).toEqual(['bob', 'charlie']);
      expect(result[0].reviewsNeeded).toBe(2);
    });

    it('constructs correct search query with -review:approved filter', async () => {
      const mockResponse = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchAwaitingReviewPRs('token', 'alice', 'myorg');

      const fetchCall = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const url = fetchCall[0] as string;

      expect(url).toContain('is%3Apr');
      expect(url).toContain('is%3Aopen');
      expect(url).toContain('author%3Aalice');
      expect(url).toContain('org%3Amyorg');
      expect(url).toContain('draft%3Afalse');
      expect(url).toContain('-review%3Aapproved');
    });

    it('returns empty array on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => 'Forbidden',
      });

      const result = await fetchAwaitingReviewPRs('token', 'alice', 'myorg');

      expect(result).toEqual([]);
    });
  });

  describe('fetchUserPRData', () => {
    it('fetches all four PR categories in parallel', async () => {
      // Mock responses for all four endpoints
      const mockDrafts = {
        total_count: 1,
        items: [
          {
            number: 123,
            title: 'Draft PR',
            html_url: 'https://github.com/myorg/repo/pull/123',
            user: { login: 'alice' },
            created_at: '2025-01-15T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: true,
            requested_reviewers: [],
          },
        ],
      };

      const mockApproved = {
        total_count: 1,
        items: [
          {
            number: 456,
            title: 'Approved PR',
            html_url: 'https://github.com/myorg/repo/pull/456',
            user: { login: 'alice' },
            created_at: '2025-01-10T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
            requested_reviewers: [],
          },
        ],
      };

      const mockAwaitingReview = {
        total_count: 1,
        items: [
          {
            number: 555,
            title: 'Awaiting Review PR',
            html_url: 'https://github.com/myorg/repo/pull/555',
            user: { login: 'alice' },
            created_at: '2025-01-14T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
            requested_reviewers: [{ login: 'bob' }],
          },
        ],
      };

      const mockReviews = {
        total_count: 1,
        items: [
          {
            number: 789,
            title: 'Review request',
            html_url: 'https://github.com/myorg/repo/pull/789',
            user: { login: 'bob' },
            created_at: '2025-01-15T10:00:00Z',
            updated_at: '2025-01-16T14:30:00Z',
            draft: false,
          },
        ],
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => mockDrafts })
        .mockResolvedValueOnce({ ok: true, json: async () => mockApproved })
        .mockResolvedValueOnce({ ok: true, json: async () => mockAwaitingReview })
        .mockResolvedValueOnce({ ok: true, json: async () => mockReviews });

      const result = await fetchUserPRData('token', 'alice', 'myorg');

      expect(result.draftPRs).toHaveLength(1);
      expect(result.draftPRs[0].number).toBe(123);
      expect(result.readyToMerge).toHaveLength(1);
      expect(result.readyToMerge[0].number).toBe(456);
      expect(result.awaitingReview).toHaveLength(1);
      expect(result.awaitingReview[0].number).toBe(555);
      expect(result.awaitingReview[0].requestedReviewers).toEqual(['bob']);
      expect(result.reviewRequests).toHaveLength(1);
      expect(result.reviewRequests[0].number).toBe(789);
    });

    it('handles partial failures gracefully', async () => {
      const mockDrafts = { total_count: 0, items: [] };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => mockDrafts })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' })
        .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'Error' });

      const result = await fetchUserPRData('token', 'alice', 'myorg');

      // Should still return structure even with errors
      expect(result.draftPRs).toEqual([]);
      expect(result.readyToMerge).toEqual([]);
      expect(result.awaitingReview).toEqual([]);
      expect(result.reviewRequests).toEqual([]);
    });
  });

  describe('extractPRSlug', () => {
    it('extracts repo and number from GitHub PR URL', () => {
      const url = 'https://github.com/myorg/my-repo/pull/123';
      expect(extractPRSlug(url)).toBe('my-repo#123');
    });

    it('returns null for invalid URLs', () => {
      expect(extractPRSlug('https://example.com')).toBeNull();
      expect(extractPRSlug('not-a-url')).toBeNull();
    });

    it('handles different GitHub URL formats', () => {
      expect(extractPRSlug('https://github.com/org/repo/pull/456')).toBe('repo#456');
      expect(extractPRSlug('https://github.com/myorg/my-long-repo-name/pull/1')).toBe('my-long-repo-name#1');
    });
  });

  describe('formatPRRef', () => {
    it('formats PR with extracted repo slug', () => {
      const pr: GitHubPR = {
        number: 123,
        title: 'Test PR',
        url: 'https://github.com/myorg/my-repo/pull/123',
        author: 'alice',
        reviewsNeeded: 0,
        requestedReviewers: [],
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-16T14:30:00Z',
        draft: false,
      };

      expect(formatPRRef(pr)).toBe('my-repo#123');
    });

    it('falls back to number-only format if URL parsing fails', () => {
      const pr: GitHubPR = {
        number: 456,
        title: 'Test PR',
        url: 'invalid-url',
        author: 'alice',
        reviewsNeeded: 0,
        requestedReviewers: [],
        createdAt: '2025-01-15T10:00:00Z',
        updatedAt: '2025-01-16T14:30:00Z',
        draft: false,
      };

      expect(formatPRRef(pr)).toBe('#456');
    });
  });
});

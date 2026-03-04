/**
 * Tests for lib/linear.ts - Linear API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
global.fetch = vi.fn();

import {
  calculateCycleProgress,
  fetchUserAssignedIssues,
  fetchUserLinearData,
  fetchTeamCycleData,
} from '../lib/linear';

describe('linear client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('calculateCycleProgress', () => {
    it('calculates progress with completed, in-progress, and todo items', () => {
      const issues = [
        { state: { type: 'completed' } },
        { state: { type: 'completed' } },
        { state: { type: 'started' } },
        { state: { type: 'unstarted' } },
        { state: { type: 'unstarted' } },
      ];

      const progress = calculateCycleProgress(
        issues,
        'Sprint 42',
        '2025-01-13T00:00:00Z',
        '2025-01-27T00:00:00Z'
      );

      expect(progress.cycleName).toBe('Sprint 42');
      expect(progress.startDate).toBe('2025-01-13');
      expect(progress.endDate).toBe('2025-01-27');
      expect(progress.done).toBe(2);
      expect(progress.inProgress).toBe(1);
      expect(progress.todo).toBe(2);
      expect(progress.completionPct).toBe(40); // 2/5 = 40%
    });

    it('excludes canceled issues from all counts', () => {
      const issues = [
        { state: { type: 'completed' } },
        { state: { type: 'canceled' } },
        { state: { type: 'canceled' } },
        { state: { type: 'started' } },
      ];

      const progress = calculateCycleProgress(
        issues,
        'Sprint 42',
        '2025-01-13T00:00:00Z',
        '2025-01-27T00:00:00Z'
      );

      expect(progress.done).toBe(1);
      expect(progress.inProgress).toBe(1);
      expect(progress.todo).toBe(0);
      expect(progress.completionPct).toBe(50); // 1/2 = 50%
    });

    it('categorizes triage and backlog as todo', () => {
      const issues = [
        { state: { type: 'triage' } },
        { state: { type: 'backlog' } },
        { state: { type: 'unstarted' } },
      ];

      const progress = calculateCycleProgress(
        issues,
        'Sprint 42',
        '2025-01-13T00:00:00Z',
        '2025-01-27T00:00:00Z'
      );

      expect(progress.todo).toBe(3);
      expect(progress.completionPct).toBe(0);
    });

    it('handles empty issue list', () => {
      const progress = calculateCycleProgress(
        [],
        'Sprint 42',
        '2025-01-13T00:00:00Z',
        '2025-01-27T00:00:00Z'
      );

      expect(progress.done).toBe(0);
      expect(progress.inProgress).toBe(0);
      expect(progress.todo).toBe(0);
      expect(progress.completionPct).toBe(0);
    });

    it('rounds completion percentage correctly', () => {
      const issues = [
        { state: { type: 'completed' } },
        { state: { type: 'unstarted' } },
        { state: { type: 'unstarted' } },
      ];

      const progress = calculateCycleProgress(
        issues,
        'Sprint 42',
        '2025-01-13T00:00:00Z',
        '2025-01-27T00:00:00Z'
      );

      expect(progress.completionPct).toBe(33); // 1/3 = 33.33% → 33%
    });

    it('extracts date portion from ISO timestamps', () => {
      const progress = calculateCycleProgress(
        [],
        'Sprint 42',
        '2025-01-13T08:30:45.123Z',
        '2025-01-27T17:45:12.456Z'
      );

      expect(progress.startDate).toBe('2025-01-13');
      expect(progress.endDate).toBe('2025-01-27');
    });
  });

  describe('fetchUserAssignedIssues', () => {
    it('filters to only started issues and urgent (priority 1) issues', async () => {
      const mockResponse = {
        data: {
          user: {
            assignedIssues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-100',
                  title: 'In progress task',
                  state: { name: 'In Progress', type: 'started' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-100',
                },
                {
                  id: 'issue-2',
                  identifier: 'ENG-101',
                  title: 'Urgent backlog',
                  state: { name: 'Backlog', type: 'backlog' },
                  priority: 1,
                  url: 'https://linear.app/issue/ENG-101',
                },
                {
                  id: 'issue-3',
                  identifier: 'ENG-102',
                  title: 'Medium priority unstarted',
                  state: { name: 'Todo', type: 'unstarted' },
                  priority: 2,
                  url: 'https://linear.app/issue/ENG-102',
                },
                {
                  id: 'issue-4',
                  identifier: 'ENG-103',
                  title: 'Low priority triage',
                  state: { name: 'Triage', type: 'triage' },
                  priority: 4,
                  url: 'https://linear.app/issue/ENG-103',
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserAssignedIssues('token', 'user-1');

      // Only started (ENG-100) and urgent/priority-1 (ENG-101) should remain
      expect(result.issues).toHaveLength(2);
      const identifiers = result.issues.map((i) => i.identifier);
      expect(identifiers).toContain('ENG-100');
      expect(identifiers).toContain('ENG-101');
      // Non-started, non-urgent should be filtered out
      expect(identifiers).not.toContain('ENG-102');
      expect(identifiers).not.toContain('ENG-103');
    });

    it('keeps urgent issues even if unstarted', async () => {
      const mockResponse = {
        data: {
          user: {
            assignedIssues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-200',
                  title: 'Urgent unstarted',
                  state: { name: 'Todo', type: 'unstarted' },
                  priority: 1,
                  url: 'https://linear.app/issue/ENG-200',
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserAssignedIssues('token', 'user-1');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].identifier).toBe('ENG-200');
    });

    it('returns allActiveIdentifiers including pre-filter items', async () => {
      const mockResponse = {
        data: {
          user: {
            assignedIssues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-100',
                  title: 'In progress task',
                  state: { name: 'In Progress', type: 'started' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-100',
                },
                {
                  id: 'issue-2',
                  identifier: 'ENG-101',
                  title: 'Low priority unstarted',
                  state: { name: 'Todo', type: 'unstarted' },
                  priority: 4,
                  url: 'https://linear.app/issue/ENG-101',
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserAssignedIssues('token', 'user-1');

      // Only started issue should be in issues
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].identifier).toBe('ENG-100');

      // But allActiveIdentifiers should include both (pre-filter)
      expect(result.allActiveIdentifiers).toEqual(['ENG-100', 'ENG-101']);
    });

    it('returns empty when no issues match filter', async () => {
      const mockResponse = {
        data: {
          user: {
            assignedIssues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-300',
                  title: 'Low priority backlog',
                  state: { name: 'Backlog', type: 'backlog' },
                  priority: 4,
                  url: 'https://linear.app/issue/ENG-300',
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserAssignedIssues('token', 'user-1');

      expect(result.issues).toHaveLength(0);
    });
  });

  describe('fetchUserLinearData', () => {
    it('fetches issues assigned to a specific user in active cycle', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: {
                nodes: [
                  {
                    id: 'issue-1',
                    identifier: 'ENG-123',
                    title: 'Fix bug in auth',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-123',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-2',
                    identifier: 'ENG-124',
                    title: 'Add new feature',
                    state: { name: 'Todo', type: 'unstarted' },
                    priority: 2,
                    url: 'https://linear.app/issue/ENG-124',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-3',
                    identifier: 'ENG-125',
                    title: 'Other user issue',
                    state: { name: 'Todo', type: 'unstarted' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-125',
                    assignee: { id: 'user-2' },
                  },
                ],
              },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      expect(result.issues).toHaveLength(2);
      expect(result.issues[0].identifier).toBe('ENG-123');
      expect(result.issues[1].identifier).toBe('ENG-124');
    });

    it('filters out completed and canceled issues', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: {
                nodes: [
                  {
                    id: 'issue-1',
                    identifier: 'ENG-123',
                    title: 'Active issue',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-123',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-2',
                    identifier: 'ENG-124',
                    title: 'Completed issue',
                    state: { name: 'Done', type: 'completed' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-124',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-3',
                    identifier: 'ENG-125',
                    title: 'Canceled issue',
                    state: { name: 'Canceled', type: 'canceled' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-125',
                    assignee: { id: 'user-1' },
                  },
                ],
              },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].identifier).toBe('ENG-123');
    });

    it('sorts issues by priority then by state', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: {
                nodes: [
                  {
                    id: 'issue-1',
                    identifier: 'ENG-123',
                    title: 'Low priority unstarted',
                    state: { name: 'Todo', type: 'unstarted' },
                    priority: 4,
                    url: 'https://linear.app/issue/ENG-123',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-2',
                    identifier: 'ENG-124',
                    title: 'Urgent started',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-124',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-3',
                    identifier: 'ENG-125',
                    title: 'Urgent unstarted',
                    state: { name: 'Todo', type: 'unstarted' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-125',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-4',
                    identifier: 'ENG-126',
                    title: 'High priority started',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 2,
                    url: 'https://linear.app/issue/ENG-126',
                    assignee: { id: 'user-1' },
                  },
                ],
              },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      // Priority 1 first (urgent), then priority 2, then priority 4
      // Within same priority: started before unstarted
      expect(result.issues[0].identifier).toBe('ENG-124'); // priority 1, started
      expect(result.issues[1].identifier).toBe('ENG-125'); // priority 1, unstarted
      expect(result.issues[2].identifier).toBe('ENG-126'); // priority 2, started
      expect(result.issues[3].identifier).toBe('ENG-123'); // priority 4, unstarted
    });

    it('returns allActiveIdentifiers for cycle path (pre-filter)', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: {
                nodes: [
                  {
                    id: 'issue-1',
                    identifier: 'ENG-123',
                    title: 'Active issue',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-123',
                    assignee: { id: 'user-1' },
                  },
                  {
                    id: 'issue-2',
                    identifier: 'ENG-124',
                    title: 'Backlog item',
                    state: { name: 'Backlog', type: 'backlog' },
                    priority: 4,
                    url: 'https://linear.app/issue/ENG-124',
                    assignee: { id: 'user-1' },
                  },
                ],
              },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      // allActiveIdentifiers should include all non-completed user issues
      expect(result.allActiveIdentifiers).toEqual(['ENG-123', 'ENG-124']);
      // But issues list may be filtered differently
      expect(result.issues.length).toBeGreaterThanOrEqual(1);
    });

    it('returns allActiveIdentifiers for fallback path (pre-filter)', async () => {
      const cycleResponse = {
        data: { team: { activeCycle: null } },
      };
      const teamIssuesResponse = {
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-500',
                  title: 'Started task',
                  state: { name: 'In Progress', type: 'started' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-500',
                  assignee: { id: 'user-1' },
                },
                {
                  id: 'issue-2',
                  identifier: 'ENG-501',
                  title: 'Low priority unstarted',
                  state: { name: 'Todo', type: 'unstarted' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-501',
                  assignee: { id: 'user-1' },
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => cycleResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => teamIssuesResponse });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      // Only started issue in issues list
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].identifier).toBe('ENG-500');

      // But allActiveIdentifiers includes both
      expect(result.allActiveIdentifiers).toEqual(['ENG-500', 'ENG-501']);
    });

    it('falls back to team issues query when no active cycle, filtering to started + urgent', async () => {
      // First call: cycle query returns no active cycle
      const cycleResponse = {
        data: {
          team: {
            activeCycle: null,
          },
        },
      };

      // Second call: team issues fallback
      const teamIssuesResponse = {
        data: {
          team: {
            issues: {
              nodes: [
                {
                  id: 'issue-1',
                  identifier: 'ENG-500',
                  title: 'Started task',
                  state: { name: 'In Progress', type: 'started' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-500',
                  assignee: { id: 'user-1' },
                },
                {
                  id: 'issue-2',
                  identifier: 'ENG-501',
                  title: 'Urgent backlog',
                  state: { name: 'Backlog', type: 'backlog' },
                  priority: 1,
                  url: 'https://linear.app/issue/ENG-501',
                  assignee: { id: 'user-1' },
                },
                {
                  id: 'issue-3',
                  identifier: 'ENG-502',
                  title: 'Low priority unstarted',
                  state: { name: 'Todo', type: 'unstarted' },
                  priority: 3,
                  url: 'https://linear.app/issue/ENG-502',
                  assignee: { id: 'user-1' },
                },
                {
                  id: 'issue-4',
                  identifier: 'ENG-503',
                  title: 'Other user started',
                  state: { name: 'In Progress', type: 'started' },
                  priority: 2,
                  url: 'https://linear.app/issue/ENG-503',
                  assignee: { id: 'user-2' },
                },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => cycleResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => teamIssuesResponse });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      // Only user-1's started (ENG-500) and urgent (ENG-501) issues
      expect(result.issues).toHaveLength(2);
      const identifiers = result.issues.map((i) => i.identifier);
      expect(identifiers).toContain('ENG-500');
      expect(identifiers).toContain('ENG-501');
      expect(identifiers).not.toContain('ENG-502'); // not started, not urgent
      expect(identifiers).not.toContain('ENG-503'); // different user

      // Verify two API calls were made
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns empty when no active cycle and fallback also has no team', async () => {
      const cycleResponse = {
        data: {
          team: {
            activeCycle: null,
          },
        },
      };

      const teamIssuesResponse = {
        data: {
          team: null,
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => cycleResponse })
        .mockResolvedValueOnce({ ok: true, json: async () => teamIssuesResponse });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      expect(result.issues).toEqual([]);
    });

    it('returns empty array on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const result = await fetchUserLinearData('token', 'team-1', 'user-1');

      expect(result.issues).toEqual([]);
    });

    it('sends correct GraphQL query with team ID', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: { nodes: [] },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      await fetchUserLinearData('my-token', 'team-123', 'user-1');

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.linear.app/graphql',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Authorization': 'my-token',
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('team-123'),
        })
      );
    });
  });

  describe('fetchTeamCycleData', () => {
    it('partitions issues by user and calculates cycle progress', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: {
              id: 'cycle-1',
              name: 'Sprint 42',
              startsAt: '2025-01-13T00:00:00Z',
              endsAt: '2025-01-27T00:00:00Z',
              issues: {
                nodes: [
                  {
                    id: 'issue-1',
                    identifier: 'ENG-123',
                    title: 'User 1 issue',
                    state: { name: 'In Progress', type: 'started' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-123',
                    assignee: { id: 'linear-user-1' },
                  },
                  {
                    id: 'issue-2',
                    identifier: 'ENG-124',
                    title: 'User 2 issue',
                    state: { name: 'Done', type: 'completed' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-124',
                    assignee: { id: 'linear-user-2' },
                  },
                  {
                    id: 'issue-3',
                    identifier: 'ENG-125',
                    title: 'User 1 second issue',
                    state: { name: 'Todo', type: 'unstarted' },
                    priority: 2,
                    url: 'https://linear.app/issue/ENG-125',
                    assignee: { id: 'linear-user-1' },
                  },
                  {
                    id: 'issue-4',
                    identifier: 'ENG-126',
                    title: 'Other user (not in team)',
                    state: { name: 'Done', type: 'completed' },
                    priority: 1,
                    url: 'https://linear.app/issue/ENG-126',
                    assignee: { id: 'linear-user-3' },
                  },
                ],
              },
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const users = [
        { slackUserId: 'U1', linearUserId: 'linear-user-1' },
        { slackUserId: 'U2', linearUserId: 'linear-user-2' },
      ];

      const result = await fetchTeamCycleData('token', 'team-1', users);

      // Check team data
      expect(result.teamData).toHaveLength(2);

      // User 1 should have 2 issues (excluding completed/canceled)
      const user1Data = result.teamData.find(t => t.slackUserId === 'U1');
      expect(user1Data?.data.issues).toHaveLength(2);
      expect(user1Data?.data.issues[0].identifier).toBe('ENG-123');
      expect(user1Data?.data.issues[1].identifier).toBe('ENG-125');

      // User 2 should have 0 issues (the completed one is filtered out)
      const user2Data = result.teamData.find(t => t.slackUserId === 'U2');
      expect(user2Data?.data.issues).toHaveLength(0);

      // Cycle progress should include ALL issues (even non-team members)
      expect(result.cycleProgress).not.toBeNull();
      expect(result.cycleProgress?.cycleName).toBe('Sprint 42');
      expect(result.cycleProgress?.done).toBe(2); // ENG-124 + ENG-126
      expect(result.cycleProgress?.inProgress).toBe(1); // ENG-123
      expect(result.cycleProgress?.todo).toBe(1); // ENG-125
    });

    it('returns empty data when no active cycle exists', async () => {
      const mockResponse = {
        data: {
          team: {
            activeCycle: null,
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const users = [
        { slackUserId: 'U1', linearUserId: 'linear-user-1' },
        { slackUserId: 'U2', linearUserId: 'linear-user-2' },
      ];

      const result = await fetchTeamCycleData('token', 'team-1', users);

      expect(result.teamData).toHaveLength(2);
      expect(result.teamData[0].data.issues).toEqual([]);
      expect(result.teamData[1].data.issues).toEqual([]);
      expect(result.cycleProgress).toBeNull();
    });

    it('handles API errors gracefully', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const users = [
        { slackUserId: 'U1', linearUserId: 'linear-user-1' },
      ];

      const result = await fetchTeamCycleData('token', 'team-1', users);

      expect(result.teamData).toHaveLength(1);
      expect(result.teamData[0].data.issues).toEqual([]);
      expect(result.cycleProgress).toBeNull();
    });
  });
});

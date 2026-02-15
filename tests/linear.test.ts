/**
 * Tests for lib/linear.ts - Linear API client
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch globally
global.fetch = vi.fn();

import {
  calculateCycleProgress,
  fetchUserLinearData,
  fetchTeamCycleData,
  checkIssuesCompleted,
  fetchTeamDoneStateId,
  transitionIssueToDone,
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

    it('returns empty array when no active cycle exists', async () => {
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

  describe('checkIssuesCompleted', () => {
    it('returns completed and canceled issue IDs', async () => {
      const mockResponse = {
        data: {
          nodes: [
            { id: 'issue-1', state: { type: 'completed' } },
            { id: 'issue-2', state: { type: 'started' } },
            { id: 'issue-3', state: { type: 'canceled' } },
            { id: 'issue-4', state: { type: 'unstarted' } },
          ],
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const { checkIssuesCompleted } = await import('../lib/linear');
      const result = await checkIssuesCompleted('token', ['issue-1', 'issue-2', 'issue-3', 'issue-4']);

      expect(result.size).toBe(2);
      expect(result.has('issue-1')).toBe(true); // completed
      expect(result.has('issue-3')).toBe(true); // canceled
      expect(result.has('issue-2')).toBe(false); // started
      expect(result.has('issue-4')).toBe(false); // unstarted
    });

    it('returns empty set for active issues only', async () => {
      const mockResponse = {
        data: {
          nodes: [
            { id: 'issue-1', state: { type: 'started' } },
            { id: 'issue-2', state: { type: 'unstarted' } },
          ],
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const { checkIssuesCompleted } = await import('../lib/linear');
      const result = await checkIssuesCompleted('token', ['issue-1', 'issue-2']);

      expect(result.size).toBe(0);
    });

    it('handles empty input array', async () => {
      const { checkIssuesCompleted } = await import('../lib/linear');
      const result = await checkIssuesCompleted('token', []);

      expect(result.size).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns empty set on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const { checkIssuesCompleted } = await import('../lib/linear');
      const result = await checkIssuesCompleted('token', ['issue-1']);

      expect(result.size).toBe(0);
    });
  });

  describe('fetchTeamDoneStateId', () => {
    it('returns the first completed type state ID', async () => {
      const mockResponse = {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-1', name: 'Todo', type: 'unstarted' },
                { id: 'state-2', name: 'In Progress', type: 'started' },
                { id: 'state-3', name: 'Done', type: 'completed' },
                { id: 'state-4', name: 'Archive', type: 'completed' },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const { fetchTeamDoneStateId } = await import('../lib/linear');
      const result = await fetchTeamDoneStateId('token', 'team-1');

      expect(result).toBe('state-3'); // First completed type
    });

    it('returns null when no completed state exists', async () => {
      const mockResponse = {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-1', name: 'Todo', type: 'unstarted' },
                { id: 'state-2', name: 'In Progress', type: 'started' },
                { id: 'state-3', name: 'Canceled', type: 'canceled' },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      });

      const { fetchTeamDoneStateId } = await import('../lib/linear');
      const result = await fetchTeamDoneStateId('token', 'team-1');

      expect(result).toBeNull();
    });

    it('returns null on API error', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      const { fetchTeamDoneStateId } = await import('../lib/linear');
      const result = await fetchTeamDoneStateId('token', 'team-1');

      expect(result).toBeNull();
    });
  });

  describe('transitionIssueToDone', () => {
    it('successfully transitions issue to done state', async () => {
      // Mock fetchTeamDoneStateId response
      const mockStatesResponse = {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-done', name: 'Done', type: 'completed' },
              ],
            },
          },
        },
      };

      // Mock issueUpdate mutation response
      const mockUpdateResponse = {
        data: {
          issueUpdate: {
            success: true,
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatesResponse,
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockUpdateResponse,
        });

      const { transitionIssueToDone } = await import('../lib/linear');
      const result = await transitionIssueToDone('token', 'issue-1', 'team-1');

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns false when no done state found', async () => {
      // Mock fetchTeamDoneStateId response with no completed state
      const mockStatesResponse = {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-1', name: 'Todo', type: 'unstarted' },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => mockStatesResponse,
      });

      const { transitionIssueToDone } = await import('../lib/linear');
      const result = await transitionIssueToDone('token', 'issue-1', 'team-1');

      expect(result).toBe(false);
      expect(global.fetch).toHaveBeenCalledTimes(1); // Only fetched states, didn't try to update
    });

    it('returns false on API error during state fetch', async () => {
      (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const { transitionIssueToDone } = await import('../lib/linear');
      const result = await transitionIssueToDone('token', 'issue-1', 'team-1');

      expect(result).toBe(false);
    });

    it('returns false on API error during issue update', async () => {
      // Mock successful state fetch
      const mockStatesResponse = {
        data: {
          team: {
            states: {
              nodes: [
                { id: 'state-done', name: 'Done', type: 'completed' },
              ],
            },
          },
        },
      };

      (global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => mockStatesResponse,
        })
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          text: async () => 'Forbidden',
        });

      const { transitionIssueToDone } = await import('../lib/linear');
      const result = await transitionIssueToDone('token', 'issue-1', 'team-1');

      expect(result).toBe(false);
    });
  });
});

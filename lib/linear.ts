/**
 * Linear API client for fetching cycle and ticket data
 * - Fetch user's assigned issues in the active cycle
 * - Fetch team cycle progress for digests
 */

// ============================================================================
// Types
// ============================================================================

export interface LinearIssue {
  id: string;
  identifier: string; // e.g., "ENG-123"
  title: string;
  state: {
    name: string;
    type: string; // "triage", "backlog", "unstarted", "started", "completed", "canceled"
  };
  priority: number; // 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low
  url: string;
  teamId?: string; // Team ID the issue belongs to
}

export interface UserLinearData {
  issues: LinearIssue[];
}

export interface TeamLinearData {
  slackUserId: string;
  linearUserId: string;
  data: UserLinearData;
}

export interface CycleProgress {
  cycleName: string;
  startDate: string;
  endDate: string;
  done: number;
  inProgress: number;
  todo: number;
  completionPct: number;
}

// ============================================================================
// GraphQL Client
// ============================================================================

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

/**
 * Execute a GraphQL query against the Linear API
 */
async function linearQuery<T>(
  token: string,
  query: string,
  variables?: Record<string, unknown>
): Promise<T> {
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Linear API error: ${response.status} ${errorText}`);
  }

  const result = await response.json() as GraphQLResponse<T>;

  if (result.errors && result.errors.length > 0) {
    throw new Error(`Linear GraphQL error: ${result.errors[0].message}`);
  }

  if (!result.data) {
    throw new Error('Linear API returned no data');
  }

  return result.data;
}

// ============================================================================
// Data Fetching
// ============================================================================

// --- Cross-team assigned issues (no team_id required) ---

interface UserAssignedIssuesResponse {
  user: {
    assignedIssues: {
      nodes: Array<{
        id: string;
        identifier: string;
        title: string;
        state: { name: string; type: string };
        priority: number;
        url: string;
        team: { id: string };
      }>;
    };
  };
}

const USER_ASSIGNED_ISSUES_QUERY = `
  query UserAssignedIssues($userId: String!) {
    user(id: $userId) {
      assignedIssues(
        filter: {
          state: { type: { nin: ["completed", "canceled"] } }
        }
        first: 50
        orderBy: updatedAt
      ) {
        nodes {
          id
          identifier
          title
          state { name type }
          priority
          url
          team { id }
        }
      }
    }
  }
`;

/**
 * Fetch a user's assigned issues across all teams (no team_id needed).
 * Uses user(id:) query so it works with a shared workspace token.
 */
export async function fetchUserAssignedIssues(
  token: string,
  userId: string
): Promise<UserLinearData> {
  try {
    const data = await linearQuery<UserAssignedIssuesResponse>(
      token,
      USER_ASSIGNED_ISSUES_QUERY,
      { userId }
    );

    if (!data.user) {
      return { issues: [] };
    }

    const issues = data.user.assignedIssues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: { name: issue.state.name, type: issue.state.type },
      priority: issue.priority,
      url: issue.url,
      teamId: issue.team.id,
    }));

    // Sort by priority (1=Urgent first) then by state type (started before unstarted)
    const stateOrder: Record<string, number> = {
      'started': 0,
      'unstarted': 1,
      'triage': 2,
      'backlog': 3,
    };

    issues.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (stateOrder[a.state.type] ?? 99) - (stateOrder[b.state.type] ?? 99);
    });

    return { issues };
  } catch (error) {
    console.error('Failed to fetch assigned Linear issues:', error);
    return { issues: [] };
  }
}

// --- Team-scoped cycle issues ---

interface CycleIssuesResponse {
  team: {
    activeCycle: {
      id: string;
      name: string;
      startsAt: string;
      endsAt: string;
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          state: { name: string; type: string };
          priority: number;
          url: string;
          assignee: { id: string } | null;
        }>;
      };
    } | null;
  } | null;
}

const CYCLE_ISSUES_QUERY = `
  query TeamActiveCycle($teamId: String!) {
    team(id: $teamId) {
      activeCycle {
        id
        name
        startsAt
        endsAt
        issues {
          nodes {
            id
            identifier
            title
            state { name type }
            priority
            url
            assignee { id }
          }
        }
      }
    }
  }
`;

/**
 * Fetch a user's assigned issues in the active cycle
 */
export async function fetchUserLinearData(
  token: string,
  teamId: string,
  userId: string
): Promise<UserLinearData> {
  try {
    const data = await linearQuery<CycleIssuesResponse>(
      token,
      CYCLE_ISSUES_QUERY,
      { teamId }
    );

    if (!data.team?.activeCycle) {
      return { issues: [] };
    }

    const cycle = data.team.activeCycle;
    const userIssues = cycle.issues.nodes
      .filter((issue) => issue.assignee?.id === userId)
      .filter((issue) => issue.state.type !== 'completed' && issue.state.type !== 'canceled')
      .map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: { name: issue.state.name, type: issue.state.type },
        priority: issue.priority,
        url: issue.url,
        teamId,
      }));

    // Sort by priority (1=Urgent first) then by state type (started before unstarted)
    const stateOrder: Record<string, number> = {
      'started': 0,
      'unstarted': 1,
      'triage': 2,
      'backlog': 3,
    };

    userIssues.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (stateOrder[a.state.type] ?? 99) - (stateOrder[b.state.type] ?? 99);
    });

    return { issues: userIssues };
  } catch (error) {
    console.error(`Failed to fetch Linear data for user ${userId}:`, error);
    return { issues: [] };
  }
}

/**
 * Fetch cycle data for multiple team members
 * Single API call, then partition by user
 */
export async function fetchTeamCycleData(
  token: string,
  teamId: string,
  users: Array<{ slackUserId: string; linearUserId: string }>
): Promise<{ teamData: TeamLinearData[]; cycleProgress: CycleProgress | null }> {
  try {
    const data = await linearQuery<CycleIssuesResponse>(
      token,
      CYCLE_ISSUES_QUERY,
      { teamId }
    );

    if (!data.team?.activeCycle) {
      return {
        teamData: users.map((u) => ({
          slackUserId: u.slackUserId,
          linearUserId: u.linearUserId,
          data: { issues: [] },
        })),
        cycleProgress: null,
      };
    }

    const cycle = data.team.activeCycle;
    const allIssues = cycle.issues.nodes;

    // Partition issues by user
    const userIdSet = new Set(users.map((u) => u.linearUserId));
    const teamData: TeamLinearData[] = users.map((user) => {
      const userIssues = allIssues
        .filter((issue) => issue.assignee?.id === user.linearUserId)
        .filter((issue) => issue.state.type !== 'completed' && issue.state.type !== 'canceled')
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: { name: issue.state.name, type: issue.state.type },
          priority: issue.priority,
          url: issue.url,
        }));

      return {
        slackUserId: user.slackUserId,
        linearUserId: user.linearUserId,
        data: { issues: userIssues },
      };
    });

    // Calculate cycle progress from ALL issues (not just team members)
    const cycleProgress = calculateCycleProgress(
      allIssues.map((i) => ({ state: i.state })),
      cycle.name,
      cycle.startsAt,
      cycle.endsAt
    );

    return { teamData, cycleProgress };
  } catch (error) {
    console.error('Failed to fetch team cycle data:', error);
    return {
      teamData: users.map((u) => ({
        slackUserId: u.slackUserId,
        linearUserId: u.linearUserId,
        data: { issues: [] },
      })),
      cycleProgress: null,
    };
  }
}

/**
 * Calculate cycle progress from a list of issues
 */
export function calculateCycleProgress(
  issues: Array<{ state: { type: string } }>,
  cycleName: string,
  startDate: string,
  endDate: string
): CycleProgress {
  let done = 0;
  let inProgress = 0;
  let todo = 0;

  for (const issue of issues) {
    switch (issue.state.type) {
      case 'completed':
        done++;
        break;
      case 'canceled':
        // Don't count canceled issues
        break;
      case 'started':
        inProgress++;
        break;
      default:
        // triage, backlog, unstarted
        todo++;
        break;
    }
  }

  const total = done + inProgress + todo;
  const completionPct = total > 0 ? Math.round((done / total) * 100) : 0;

  return {
    cycleName,
    startDate: startDate.split('T')[0],
    endDate: endDate.split('T')[0],
    done,
    inProgress,
    todo,
    completionPct,
  };
}

// ============================================================================
// Sync: Check Issue Completion Status
// ============================================================================

interface IssueStatusResponse {
  nodes: Array<{
    id: string;
    state: { type: string };
  }>;
}

const CHECK_ISSUES_QUERY = `
  query CheckIssues($ids: [String!]!) {
    nodes(ids: $ids) {
      ... on Issue {
        id
        state { type }
      }
    }
  }
`;

/**
 * Check which Linear issues are now completed or canceled.
 * Returns a Set of issue IDs that are done.
 */
export async function checkIssuesCompleted(
  token: string,
  issueIds: string[]
): Promise<Set<string>> {
  if (issueIds.length === 0) return new Set();

  try {
    const data = await linearQuery<IssueStatusResponse>(
      token,
      CHECK_ISSUES_QUERY,
      { ids: issueIds }
    );

    const completedIds = new Set<string>();
    for (const node of data.nodes) {
      if (node.state?.type === 'completed' || node.state?.type === 'canceled') {
        completedIds.add(node.id);
      }
    }
    return completedIds;
  } catch (error) {
    console.error('Failed to check Linear issue status:', error);
    return new Set();
  }
}

// ============================================================================
// Sync: Transition Issue to Done
// ============================================================================

interface TeamWorkflowStatesResponse {
  team: {
    states: {
      nodes: Array<{
        id: string;
        name: string;
        type: string;
      }>;
    };
  };
}

const TEAM_WORKFLOW_STATES_QUERY = `
  query TeamStates($teamId: String!) {
    team(id: $teamId) {
      states {
        nodes {
          id
          name
          type
        }
      }
    }
  }
`;

/**
 * Fetch the "Done" state ID for a team (first state with type "completed").
 */
export async function fetchTeamDoneStateId(
  token: string,
  teamId: string
): Promise<string | null> {
  try {
    const data = await linearQuery<TeamWorkflowStatesResponse>(
      token,
      TEAM_WORKFLOW_STATES_QUERY,
      { teamId }
    );

    const doneState = data.team.states.nodes.find(s => s.type === 'completed');
    return doneState?.id || null;
  } catch (error) {
    console.error(`Failed to fetch done state for team ${teamId}:`, error);
    return null;
  }
}

interface IssueUpdateResponse {
  issueUpdate: {
    success: boolean;
  };
}

const ISSUE_UPDATE_MUTATION = `
  mutation UpdateIssue($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

/**
 * Transition a Linear issue to Done state.
 * Looks up the team's "completed" workflow state and applies it.
 */
export async function transitionIssueToDone(
  token: string,
  issueId: string,
  teamId: string
): Promise<boolean> {
  try {
    const doneStateId = await fetchTeamDoneStateId(token, teamId);
    if (!doneStateId) {
      console.error(`No completed state found for team ${teamId}`);
      return false;
    }

    const data = await linearQuery<IssueUpdateResponse>(
      token,
      ISSUE_UPDATE_MUTATION,
      { issueId, stateId: doneStateId }
    );

    return data.issueUpdate.success;
  } catch (error) {
    console.error(`Failed to transition issue ${issueId} to done:`, error);
    return false;
  }
}

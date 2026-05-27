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
}

export interface UserLinearData {
  issues: LinearIssue[];
  allActiveIdentifiers?: string[];  // All non-completed identifiers (pre-filter)
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
        cycle: { endsAt: string } | null;
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
          cycle { endsAt }
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

    const allIssues = data.user.assignedIssues.nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: { name: issue.state.name, type: issue.state.type },
      priority: issue.priority,
      url: issue.url,
      cycle: issue.cycle,
    }));

    const allActiveIdentifiers = allIssues.map(i => i.identifier);

    const now = new Date();
    const issues = allIssues.filter((issue) => {
      if (issue.state.type === 'started' || issue.priority === 1) return true;
      if (issue.cycle?.endsAt && new Date(issue.cycle.endsAt) > now) return true;
      return false;
    });

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

    return { issues, allActiveIdentifiers };
  } catch (error) {
    console.error('Failed to fetch assigned Linear issues:', error);
    return { issues: [] };
  }
}

// --- Team-scoped issues (fallback when no active cycle) ---

interface TeamIssuesResponse {
  team: {
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
}

const TEAM_ISSUES_QUERY = `
  query TeamIssues($teamId: String!) {
    team(id: $teamId) {
      issues(
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
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
          assignee { id }
        }
      }
    }
  }
`;

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
      // Fallback: fetch team issues directly, filtered to actionable items
      const fallbackData = await linearQuery<TeamIssuesResponse>(
        token,
        TEAM_ISSUES_QUERY,
        { teamId }
      );

      if (!fallbackData.team) {
        return { issues: [] };
      }

      const allUserFallback = fallbackData.team.issues.nodes
        .filter((issue) => issue.assignee?.id === userId)
        .map((issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: { name: issue.state.name, type: issue.state.type },
          priority: issue.priority,
          url: issue.url,
        }));

      const fallbackActiveIdentifiers = allUserFallback.map(i => i.identifier);
      const fallbackIssues = allUserFallback.filter(
        (issue) => issue.state.type === 'started' || issue.priority === 1
      );

      const stateOrder: Record<string, number> = {
        'started': 0,
        'unstarted': 1,
        'triage': 2,
        'backlog': 3,
      };

      fallbackIssues.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return (stateOrder[a.state.type] ?? 99) - (stateOrder[b.state.type] ?? 99);
      });

      return { issues: fallbackIssues, allActiveIdentifiers: fallbackActiveIdentifiers };
    }

    const cycle = data.team.activeCycle;
    const allUserIssues = cycle.issues.nodes
      .filter((issue) => issue.assignee?.id === userId)
      .filter((issue) => issue.state.type !== 'completed' && issue.state.type !== 'canceled')
      .map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: { name: issue.state.name, type: issue.state.type },
        priority: issue.priority,
        url: issue.url,
      }));

    const allActiveIdentifiers = allUserIssues.map(i => i.identifier);

    // Sort by priority (1=Urgent first) then by state type (started before unstarted)
    const stateOrder: Record<string, number> = {
      'started': 0,
      'unstarted': 1,
      'triage': 2,
      'backlog': 3,
    };

    allUserIssues.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return (stateOrder[a.state.type] ?? 99) - (stateOrder[b.state.type] ?? 99);
    });

    return { issues: allUserIssues, allActiveIdentifiers };
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

// ============================================================================
// Mutations & Utilities
// ============================================================================

export function extractLinearReferences(text: string): string[] {
  const matches = text.match(/\b([A-Z]+-\d+)\b/g);
  if (!matches) return [];
  return [...new Set(matches)];
}

interface WorkflowStatesResponse {
  team: {
    states: {
      nodes: Array<{ id: string; name: string; type: string }>;
    };
  };
}

const WORKFLOW_STATES_QUERY = `
  query WorkflowStates($teamId: String!) {
    team(id: $teamId) {
      states {
        nodes { id name type }
      }
    }
  }
`;

export async function fetchWorkflowStates(
  token: string,
  teamId: string
): Promise<Map<string, { id: string; name: string }>> {
  const data = await linearQuery<WorkflowStatesResponse>(
    token,
    WORKFLOW_STATES_QUERY,
    { teamId }
  );
  const map = new Map<string, { id: string; name: string }>();
  for (const state of data.team.states.nodes) {
    map.set(state.type, { id: state.id, name: state.name });
  }
  return map;
}

interface IssueUpdateResponse {
  issueUpdate: { success: boolean };
}

const ISSUE_UPDATE_MUTATION = `
  mutation IssueUpdate($issueId: String!, $stateId: String!) {
    issueUpdate(id: $issueId, input: { stateId: $stateId }) {
      success
    }
  }
`;

export async function updateIssueState(
  token: string,
  issueId: string,
  stateId: string
): Promise<boolean> {
  const data = await linearQuery<IssueUpdateResponse>(
    token,
    ISSUE_UPDATE_MUTATION,
    { issueId, stateId }
  );
  return data.issueUpdate.success;
}

export async function markIssuesInProgress(
  token: string,
  issueIds: string[],
  inProgressStateId: string
): Promise<{ updated: number; skipped: number }> {
  let updated = 0;
  let skipped = 0;
  for (const issueId of issueIds) {
    try {
      const success = await updateIssueState(token, issueId, inProgressStateId);
      if (success) {
        updated++;
      } else {
        skipped++;
      }
    } catch (error) {
      console.error(`Failed to update issue ${issueId}:`, error);
      skipped++;
    }
  }
  return { updated, skipped };
}

interface CommentCreateResponse {
  commentCreate: { success: boolean };
}

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
    }
  }
`;

export async function commentOnIssue(
  token: string,
  issueId: string,
  body: string
): Promise<boolean> {
  const data = await linearQuery<CommentCreateResponse>(
    token,
    COMMENT_CREATE_MUTATION,
    { issueId, body }
  );
  return data.commentCreate.success;
}

interface IssueByIdentifierResponse {
  issue: { id: string; identifier: string } | null;
}

const ISSUE_BY_IDENTIFIER_QUERY = `
  query IssueByIdentifier($id: String!) {
    issue(id: $id) { id identifier }
  }
`;

export async function resolveIdentifiers(
  token: string,
  identifiers: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const identifier of identifiers) {
    try {
      const data = await linearQuery<IssueByIdentifierResponse>(
        token,
        ISSUE_BY_IDENTIFIER_QUERY,
        { id: identifier }
      );
      if (data.issue) {
        map.set(data.issue.identifier, data.issue.id);
      }
    } catch (error) {
      console.error(`Failed to resolve identifier ${identifier}:`, error);
    }
  }
  return map;
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

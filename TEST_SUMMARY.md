# Test Coverage Summary

Comprehensive test coverage added for GitHub PR integration, Linear integration features, and 2-way sync functions.

## Test Files

### 1. `tests/linear.test.ts` (26 tests)

**Pure Function Tests:**
- `calculateCycleProgress()` - 6 tests
  - Various issue state distributions (completed, started, unstarted, canceled)
  - Empty lists
  - Correct percentage calculation and rounding
  - Date extraction from ISO timestamps

**API Client Tests:**
- `fetchUserLinearData()` - 6 tests
  - Fetches issues assigned to specific user
  - Filters out completed/canceled issues
  - Sorts by priority then state (urgent → started → unstarted)
  - Handles missing active cycle
  - Handles API errors gracefully
  - Sends correct GraphQL query with authorization

- `fetchTeamCycleData()` - 3 tests
  - Partitions issues by user
  - Calculates cycle progress from all issues (not just team members)
  - Handles missing active cycle
  - Handles API errors gracefully

**2-Way Sync Functions (NEW):**
- `checkIssuesCompleted()` - 4 tests
  - Returns Set of completed/canceled issue IDs
  - Returns empty set for active issues
  - Handles empty input
  - Returns empty set on API errors (graceful degradation)

- `fetchTeamDoneStateId()` - 3 tests
  - Returns first completed-type state ID
  - Returns null when no completed state exists
  - Returns null on API errors

- `transitionIssueToDone()` - 4 tests
  - Successfully transitions issue to done state
  - Returns false when no done state found
  - Returns false on API error during state fetch
  - Returns false on API error during issue update

### 2. `tests/github.test.ts` (34 tests)

**New Functions:**
- `fetchDraftPRs()` - 4 tests
  - Fetches draft PRs with correct filters
  - Constructs query with `draft:true`
  - Maps review counts correctly
  - Handles errors

- `fetchApprovedPRs()` - 3 tests
  - Fetches approved PRs with `review:approved` filter
  - Constructs correct query
  - Handles errors

**Updated Function:**
- `fetchUserPRData()` - 2 tests
  - Fetches all 3 categories in parallel (draftPRs, readyToMerge, reviewRequests)
  - Handles partial failures

**Helpers:**
- `extractPRSlug()` - 3 tests
- `formatPRRef()` - 2 tests

**2-Way Sync Functions (NEW):**
- `parsePRExternalId()` - 7 tests
  - Parses "org/repo#123" format back to {owner, repo, number}
  - Handles numeric repo names
  - Returns null for invalid formats (missing #, /, non-numeric number)
  - Returns null for empty string
  - Returns null for GitHub URL (not external ID format)

- `checkPRsMerged()` - 7 tests
  - Returns external IDs of merged PRs
  - Includes closed (non-merged) PRs
  - Handles mix of merged, open, and closed PRs
  - Returns empty set for empty input
  - Handles API errors gracefully (continues with successful calls)
  - Sends correct headers (Bearer token, Accept, User-Agent)
  - Checks multiple PRs in parallel (Promise.all)

## Updated Test Files

### 3. `tests/format.test.ts` (+14 tests, now 62 total)

**New Format Functions:**

**`formatPRDigestSection()` - 5 tests**
- Formats 3-category PR breakdown (draft, ready to merge, to review)
- Returns empty when no activity
- Shows warnings for members with many PRs (≥3)
- Shows warnings for high review request count (≥3)
- Aggregates counts across team

**`formatLinearDigestSection()` - 4 tests**
- Formats cycle progress with team breakdown
- Shows date range in short format
- Handles members with no issues
- Distinguishes started vs unstarted issues

**`formatMemberPRSummary()` - 4 tests**
- Formats all 3 PR categories
- Omits empty categories
- Returns empty string when no PRs
- Correct label formatting

**Existing Tests:**
- Updated `formatStandupBlocks()` tests remain unchanged (still covers PR data integration)

### 4. `tests/modal.test.ts` (+14 tests, now 36 total)

**Linear Integration Tests:**

**`buildStandupModal()` with Linear issues - 8 tests**
- Includes checkbox block when issues provided
- Formats checkboxes with identifier, title, and state
- Truncates long titles (>50 chars)
- Limits to max 10 checkboxes (Slack constraint)
- Shows context message when >10 issues available
- Does not store integration maps in private_metadata
- Filters out issues already in yesterday's plans
- Does not include Linear block when no issues

**2-Way Sync UI Features (NEW):**

**`externallyCompleted` auto-defaulting - 5 tests**
- Defaults matched items to "Done" when in externallyCompleted
- Defaults all items to "Carry over" when no externallyCompleted
- Defaults all items to "Carry over" when externallyCompleted is empty
- Matches exactly on text (case-sensitive)
- Handles multiple externally completed items

**`teamId:issueId` encoding - 4 tests**
- Encodes value as "teamId:issueId" when teamId present
- Encodes value as "issueId" only when teamId absent
- Handles mix of issues with and without teamId
- Handles empty string teamId as absent (falsy check)

## Coverage Summary

**Total Tests:** 274 (all passing)

**Test Distribution:**
- `tests/linear.test.ts`: 26 tests (+6 new for 2-way sync)
- `tests/github.test.ts`: 34 tests (+8 new for 2-way sync)
- `tests/modal.test.ts`: 36 tests (+6 new for 2-way sync)
- `tests/format.test.ts`: 62 tests
- `tests/commands.test.ts`: 40 tests
- `tests/interactions.test.ts`: 18 tests
- `tests/prompt.test.ts`: 32 tests
- `tests/slack.test.ts`: 21 tests
- `tests/home.test.ts`: 5 tests

**New 2-Way Sync Coverage:**
1. Linear issue status checking (completed/canceled detection)
2. Linear workflow state lookup and transition mutations
3. GitHub PR merge/close status checking
4. External ID parsing (org/repo#123 format)
5. Auto-default "Done" dropdown for externally completed items
6. teamId encoding for cross-team Linear issues
7. Parallel API calls and graceful error handling
8. Edge cases: empty data, API errors, invalid formats

## Testing Patterns Used

All tests follow existing patterns:
- Vitest with `vi.mock()` for dependencies
- Mock `fetch()` for API calls
- Arrange-Act-Assert structure
- Descriptive test names with `should` behavior
- Test both happy paths and error conditions
- Verify data transformations and filtering logic

/**
 * Integration tests for the HTTP handler (api/index.ts).
 *
 * These exercise the full fetch() entry point with properly-signed Slack
 * requests, mocking only the DB layer and outgoing Slack API calls.
 * Signature verification runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must appear before any import that touches the mocked modules
// ---------------------------------------------------------------------------

vi.mock('../lib/db', () => ({
  getDb: vi.fn(() => ({ query: vi.fn(() => Promise.resolve([])) })),
  getUserDailies: vi.fn(() => Promise.resolve([])),
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getPreviousSubmission: vi.fn(() => Promise.resolve(null)),
  getSubmissionsForDate: vi.fn(() => Promise.resolve([])),
  getSubmissionsInRange: vi.fn(() => Promise.resolve([])),
  saveSubmission: vi.fn(() => Promise.resolve({ id: 1, slack_message_ts: null })),
  markPromptSubmitted: vi.fn(() => Promise.resolve()),
  updateSubmissionMessageTs: vi.fn(() => Promise.resolve()),
  markItemsDone: vi.fn(() => Promise.resolve()),
  markItemsDropped: vi.fn(() => Promise.resolve()),
  incrementCarryCount: vi.fn(() => Promise.resolve()),
  markItemsInProgress: vi.fn(() => Promise.resolve()),
  getInProgressCarryCounts: vi.fn(() => Promise.resolve({})),
  createWorkItems: vi.fn(() => Promise.resolve()),
  linkItemsToSubmission: vi.fn(() => Promise.resolve()),
  addParticipant: vi.fn(() => Promise.resolve()),
  removeParticipant: vi.fn(() => Promise.resolve()),
  getParticipants: vi.fn(() => Promise.resolve([])),
  getParticipationStats: vi.fn(() => Promise.resolve([])),
  getTeamStats: vi.fn(() => Promise.resolve([])),
  getMissingSubmissions: vi.fn(() => Promise.resolve([])),
  countWorkdays: vi.fn(() => Promise.resolve(0)),
  getActiveOOOForDaily: vi.fn(() => Promise.resolve([])),
  setOOO: vi.fn(() => Promise.resolve()),
  clearOOO: vi.fn(() => Promise.resolve()),
  getUserOOO: vi.fn(() => Promise.resolve([])),
  getGitHubUsername: vi.fn(() => Promise.resolve(null)),
  setGitHubUsername: vi.fn(() => Promise.resolve()),
  getLinearUserId: vi.fn(() => Promise.resolve(null)),
  setLinearUserId: vi.fn(() => Promise.resolve()),
  getRecentlyDoneLinearItems: vi.fn(() => Promise.resolve([])),
  getDmStandupPreference: vi.fn(() => Promise.resolve(false)),
  getActiveWorkItems: vi.fn(() => Promise.resolve([])),
  getActiveWorkItemsBySourceRef: vi.fn(() => Promise.resolve([])),
  getActiveLinearWorkItems: vi.fn(() => Promise.resolve([])),
  updateWorkItemStatus: vi.fn(() => Promise.resolve()),
  addWorkItem: vi.fn(() => Promise.resolve()),
  updateSubmissionArrays: vi.fn(() => Promise.resolve()),
  getUsersWithGitHubLinks: vi.fn(() => Promise.resolve([])),
  getUsersWithLinearLinks: vi.fn(() => Promise.resolve([])),
  getBottleneckItems: vi.fn(() => Promise.resolve([])),
  getHighDropUsers: vi.fn(() => Promise.resolve([])),
  getPeriodStats: vi.fn(() => Promise.resolve([])),
  getTeamRankings: vi.fn(() => Promise.resolve([])),
  deleteOldSubmissions: vi.fn(() => Promise.resolve()),
  deleteOldPrompts: vi.fn(() => Promise.resolve()),
  setConfigOverride: vi.fn(() => Promise.resolve()),
  deleteConfigOverride: vi.fn(() => Promise.resolve()),
  getAllConfigOverrides: vi.fn(() => Promise.resolve([])),
  getBlockerStreaks: vi.fn(() => Promise.resolve([])),
  getUnplannedOverload: vi.fn(() => Promise.resolve([])),
  getOOOStartingOnDate: vi.fn(() => Promise.resolve([])),
  getOrCreatePrompt: vi.fn(() => Promise.resolve({ id: 1, sent: false, submitted: false })),
  updatePromptSent: vi.fn(() => Promise.resolve()),
  getAllParticipants: vi.fn(() => Promise.resolve([])),
  getUnpostedSubmissions: vi.fn(() => Promise.resolve([])),
  markSubmissionPosted: vi.fn(() => Promise.resolve()),
  healthCheck: vi.fn(() => Promise.resolve(true)),
  getCachedUser: vi.fn(() => Promise.resolve(null)),
  upsertCachedUser: vi.fn(() => Promise.resolve()),
  getStaleUsers: vi.fn(() => Promise.resolve([])),
  getUserSettings: vi.fn(() => Promise.resolve({ dmStandup: false, maxItems: null, stalePrDays: null, linearTeamFilter: null })),
  updateUserSetting: vi.fn(() => Promise.resolve()),
  getHighCarryItems: vi.fn(() => Promise.resolve([])),
  getPendingItems: vi.fn(() => Promise.resolve([])),
  wasReminderSent: vi.fn(() => Promise.resolve(false)),
  recordReminderSent: vi.fn(() => Promise.resolve()),
  snoozeItem: vi.fn(() => Promise.resolve()),
  clearSnooze: vi.fn(() => Promise.resolve()),
  getActiveOOO: vi.fn(() => Promise.resolve(null)),
}));

// Keep real: verifySlackSignature, parseCommandPayload, ephemeralResponse, parseRichText
// Mock: openModal, publishHomeView, sendDM, postMessage, updateMessage, sendDMWithBlocks
vi.mock('../lib/slack', async (importActual) => {
  const real = await importActual<typeof import('../lib/slack')>();
  return {
    ...real,
    openModal: vi.fn(() => Promise.resolve(true)),
    publishHomeView: vi.fn(() => Promise.resolve(true)),
    sendDM: vi.fn(() => Promise.resolve(true)),
    sendDMWithBlocks: vi.fn(() => Promise.resolve(true)),
    postMessage: vi.fn(() => Promise.resolve('ts.123')),
    updateMessage: vi.fn(() => Promise.resolve(true)),
  };
});

vi.mock('../lib/config', async (importActual) => {
  const real = await importActual<typeof import('../lib/config')>();
  return {
    ...real,
    loadConfigOverrides: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../lib/prompt', async (importActual) => {
  const real = await importActual<typeof import('../lib/prompt')>();
  return {
    ...real,
    getUserTimezone: vi.fn(() => Promise.resolve({ tz: 'UTC', tz_offset: 0 })),
    sendPromptDM: vi.fn(() => Promise.resolve(true)),
    hasScheduledTimePassed: vi.fn(() => true),
  };
});

vi.mock('../lib/format', async (importActual) => {
  const real = await importActual<typeof import('../lib/format')>();
  return {
    ...real,
    postStandupToChannel: vi.fn(() => Promise.resolve('ts.999')),
    sendStandupDM: vi.fn(() => Promise.resolve()),
  };
});

vi.mock('../lib/github', () => ({
  fetchUserPRData: vi.fn(() => Promise.resolve({ reviewRequests: [], myPRs: [], prData: null })),
  fetchMergedPRs: vi.fn(() => Promise.resolve([])),
  fetchTeamPRData: vi.fn(() => Promise.resolve({})),
  fetchTeamMergedPRs: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../lib/linear', () => ({
  fetchUserAssignedIssues: vi.fn(() => Promise.resolve([])),
  fetchUserLinearData: vi.fn(() => Promise.resolve(null)),
  extractLinearReferences: vi.fn(() => []),
  fetchWorkflowStates: vi.fn(() => Promise.resolve(new Map())),
  markIssuesInProgress: vi.fn(() => Promise.resolve({ updated: 0, skipped: 0 })),
  commentOnIssue: vi.fn(() => Promise.resolve()),
  resolveIdentifiers: vi.fn(() => Promise.resolve(new Map())),
  fetchTeamCycleData: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../lib/linear-intelligence', () => ({
  computeLinearAlignment: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../lib/github-intelligence', () => ({
  computeGitHubAlignment: vi.fn(() => Promise.resolve([])),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import worker from '../api/index';
import type { Env } from '../api/index';
import { vi as _vi } from 'vitest';
import { openModal, publishHomeView, sendDM } from '../lib/slack';
import { getUserDailies, getSubmissionForDate, saveSubmission, getPreviousSubmission } from '../lib/db';
import { sendPromptDM, hasScheduledTimePassed } from '../lib/prompt';
import { postStandupToChannel } from '../lib/format';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_SIGNING_SECRET = 'test-signing-secret-abc123';
const TEST_BOT_TOKEN = 'xoxb-test-token';
const TEST_USER_ID = 'UTEST123';
const DAILY_NAME = 'daily-test';

function makeEnv(): Env {
  return {
    SLACK_BOT_TOKEN: TEST_BOT_TOKEN,
    SLACK_SIGNING_SECRET: TEST_SIGNING_SECRET,
    DATABASE_URL: 'postgres://test-not-real',
  };
}

let waitUntilPromises: Promise<unknown>[] = [];

function makeCtx(): ExecutionContext {
  waitUntilPromises = [];
  return {
    waitUntil: (p: Promise<unknown>) => { waitUntilPromises.push(p); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
}

async function flushWaitUntil() {
  await Promise.allSettled(waitUntilPromises);
}

async function signBody(body: string, timestamp: string): Promise<string> {
  const sigBasestring = `v0:${timestamp}:${body}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(TEST_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(sigBasestring));
  const hex = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${hex}`;
}

function freshTimestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function commandRequest(fields: Record<string, string>): Promise<Request> {
  const params = new URLSearchParams(fields);
  const body = params.toString();
  const ts = freshTimestamp();
  const sig = await signBody(body, ts);
  return new Request('https://bot.example.com/api/slack/commands', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

async function interactRequest(payload: object): Promise<Request> {
  const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const ts = freshTimestamp();
  const sig = await signBody(body, ts);
  return new Request('https://bot.example.com/api/slack/interact', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

async function eventsRequest(payload: object): Promise<Request> {
  const body = JSON.stringify(payload);
  const ts = freshTimestamp();
  const sig = await signBody(body, ts);
  return new Request('https://bot.example.com/api/slack/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

function commandFields(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  return {
    command: '/standup',
    text: 'help',
    user_id: TEST_USER_ID,
    user_name: 'testuser',
    channel_id: 'C123',
    channel_name: 'general',
    team_id: 'T123',
    response_url: 'https://hooks.slack.com/commands/T123/test',
    trigger_id: 'tr.123.abc',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HTTP handler integration', () => {
  const env = makeEnv();
  let ctx: ExecutionContext;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
  });

  // =========================================================================
  // Health check
  // =========================================================================

  it('GET /api/health returns 200', async () => {
    const req = new Request('https://bot.example.com/api/health');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
  });

  // =========================================================================
  // Signature verification
  // =========================================================================

  it('rejects requests with invalid signature', async () => {
    const body = new URLSearchParams(commandFields()).toString();
    const req = new Request('https://bot.example.com/api/slack/commands', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'x-slack-request-timestamp': freshTimestamp(),
        'x-slack-signature': 'v0=0000000000000000000000000000000000000000000000000000000000000000',
      },
      body,
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('rejects requests with missing signature', async () => {
    const body = new URLSearchParams(commandFields()).toString();
    const req = new Request('https://bot.example.com/api/slack/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(401);
  });

  // =========================================================================
  // /standup help
  // =========================================================================

  it('/standup help returns help text', async () => {
    const req = await commandRequest(commandFields({ text: 'help' }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as { text: string };
    expect(json.text).toContain('/standup help');
    expect(vi.mocked(openModal)).not.toHaveBeenCalled();
  });

  // =========================================================================
  // /standup prompt <daily>
  // =========================================================================

  it('/standup prompt sends a DM', async () => {
    vi.mocked(getUserDailies).mockResolvedValueOnce([
      { daily_name: DAILY_NAME, slack_user_id: TEST_USER_ID },
    ] as any);
    vi.mocked(sendPromptDM).mockResolvedValueOnce(true);

    const req = await commandRequest(commandFields({ text: `prompt ${DAILY_NAME}` }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as { text: string };
    expect(json.text).toContain('Sent');
    expect(vi.mocked(sendPromptDM)).toHaveBeenCalledWith(
      TEST_BOT_TOKEN, TEST_USER_ID, DAILY_NAME
    );
  });

  // =========================================================================
  // /daily command → openModal
  // =========================================================================

  it('/daily opens the standup modal', async () => {
    vi.mocked(getUserDailies).mockResolvedValueOnce([
      { daily_name: DAILY_NAME, slack_user_id: TEST_USER_ID },
    ] as any);
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce(null);
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);

    const req = await commandRequest(commandFields({
      command: '/daily',
      text: '',
    }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    expect(vi.mocked(openModal)).toHaveBeenCalledTimes(1);
    const [token, triggerId, modal] = vi.mocked(openModal).mock.calls[0];
    expect(token).toBe(TEST_BOT_TOKEN);
    expect(triggerId).toBe('tr.123.abc');
    expect((modal as any).callback_id).toBe('standup_submission');
    expect((modal as any).type).toBe('modal');
  });

  it('/daily with specific daily name opens modal for that daily', async () => {
    vi.mocked(getUserDailies).mockResolvedValueOnce([
      { daily_name: DAILY_NAME, slack_user_id: TEST_USER_ID },
    ] as any);
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce(null);
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);

    const req = await commandRequest(commandFields({
      command: '/daily',
      text: DAILY_NAME,
    }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    expect(vi.mocked(openModal)).toHaveBeenCalledTimes(1);

    const modal = vi.mocked(openModal).mock.calls[0][2] as any;
    const metadata = JSON.parse(modal.private_metadata);
    expect(metadata.dailyName).toBe(DAILY_NAME);
  });

  it('/daily without trigger_id returns error', async () => {
    const req = await commandRequest(commandFields({
      command: '/daily',
      text: '',
      trigger_id: '',
    }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as { text: string };
    expect(json.text).toContain('Unable to open modal');
  });

  it('/daily for user not in any daily returns error', async () => {
    vi.mocked(getUserDailies).mockResolvedValueOnce([]);

    const req = await commandRequest(commandFields({
      command: '/daily',
      text: '',
    }));
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const json = await res.json() as { text: string };
    expect(json.text).toContain("not part of any dailies");
  });

  // =========================================================================
  // Modal submission (view_submission)
  // =========================================================================

  it('standup submission saves to DB and posts to channel', async () => {
    vi.mocked(saveSubmission).mockResolvedValueOnce({ id: 42, slack_message_ts: null } as any);
    vi.mocked(hasScheduledTimePassed).mockReturnValue(true);
    vi.mocked(postStandupToChannel).mockResolvedValueOnce('ts.posted');

    const payload = {
      type: 'view_submission',
      user: { id: TEST_USER_ID },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({
          dailyName: DAILY_NAME,
          mode: 'today',
          targetDate: '2026-05-09',
        }),
        state: {
          values: {
            today_plans: { plans_input: { value: 'Build feature X\nFix bug Y' } },
          },
        },
      },
    };

    const req = await interactRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    await flushWaitUntil();

    expect(vi.mocked(saveSubmission)).toHaveBeenCalledTimes(1);
    const saveCall = vi.mocked(saveSubmission).mock.calls[0];
    expect(saveCall[1]).toMatchObject({
      slackUserId: TEST_USER_ID,
      dailyName: DAILY_NAME,
      todayPlans: ['Build feature X', 'Fix bug Y'],
    });

    expect(vi.mocked(postStandupToChannel)).toHaveBeenCalledTimes(1);
  });

  it('standup submission returns validation error when no plans', async () => {
    const payload = {
      type: 'view_submission',
      user: { id: TEST_USER_ID },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({
          dailyName: DAILY_NAME,
          mode: 'today',
          targetDate: '2026-05-09',
        }),
        state: {
          values: {
            today_plans: { plans_input: { value: '' } },
          },
        },
      },
    };

    const req = await interactRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    const json = await res.json() as { response_action?: string; errors?: Record<string, string> };
    expect(json.response_action).toBe('errors');
    expect(json.errors?.today_plans).toBeDefined();
  });

  it('re-submit updates existing channel post instead of posting new', async () => {
    vi.mocked(saveSubmission).mockResolvedValueOnce({
      id: 42,
      slack_message_ts: 'existing.ts.123',
    } as any);
    vi.mocked(hasScheduledTimePassed).mockReturnValue(true);

    const payload = {
      type: 'view_submission',
      user: { id: TEST_USER_ID },
      view: {
        callback_id: 'standup_submission',
        private_metadata: JSON.stringify({
          dailyName: DAILY_NAME,
          mode: 'today',
          targetDate: '2026-05-09',
        }),
        state: {
          values: {
            today_plans: { plans_input: { value: 'Updated plan' } },
          },
        },
      },
    };

    const req = await interactRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    await flushWaitUntil();

    // Should NOT post a new message
    expect(vi.mocked(postStandupToChannel)).not.toHaveBeenCalled();
    // Should update the existing one
    const { updateMessage } = await import('../lib/slack');
    expect(vi.mocked(updateMessage)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateMessage).mock.calls[0][2]).toBe('existing.ts.123');
  });

  // =========================================================================
  // Edit standup button (block_actions)
  // =========================================================================

  it('home_edit_standup button opens modal with prefill', async () => {
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce({
      id: 99,
      slack_user_id: TEST_USER_ID,
      daily_name: DAILY_NAME,
      date: '2026-05-09',
      today_plans: ['Fix bug'],
      unplanned: [],
      blockers: '',
      custom_answers: {},
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      yesterday_dropped: [],
      slack_message_ts: 'ts.existing',
      posted: true,
    } as any);
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);

    const payload = {
      type: 'block_actions',
      user: { id: TEST_USER_ID },
      trigger_id: 'tr.edit.123',
      actions: [{ action_id: 'home_edit_standup', value: DAILY_NAME }],
    };

    const req = await interactRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    expect(vi.mocked(openModal)).toHaveBeenCalledTimes(1);
    const [token, triggerId, modal] = vi.mocked(openModal).mock.calls[0];
    expect(token).toBe(TEST_BOT_TOKEN);
    expect(triggerId).toBe('tr.edit.123');
    expect((modal as any).callback_id).toBe('standup_submission');
  });

  // =========================================================================
  // App Home opened event
  // =========================================================================

  it('app_home_opened publishes home view', async () => {
    vi.mocked(getUserDailies).mockResolvedValueOnce([
      { daily_name: DAILY_NAME, slack_user_id: TEST_USER_ID },
    ] as any);

    const payload = {
      type: 'event_callback',
      event: {
        type: 'app_home_opened',
        user: TEST_USER_ID,
        tab: 'home',
      },
    };

    const req = await eventsRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);

    expect(vi.mocked(publishHomeView)).toHaveBeenCalledTimes(1);
    const [token, userId] = vi.mocked(publishHomeView).mock.calls[0];
    expect(token).toBe(TEST_BOT_TOKEN);
    expect(userId).toBe(TEST_USER_ID);
  });

  it('url_verification challenge returns the challenge token', async () => {
    const payload = {
      type: 'url_verification',
      challenge: 'test-challenge-token-xyz',
    };

    const req = await eventsRequest(payload);
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe('test-challenge-token-xyz');
  });

  // =========================================================================
  // Route validation
  // =========================================================================

  it('unknown path returns 404', async () => {
    const req = new Request('https://bot.example.com/api/nonexistent');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(404);
  });

  it('GET on /api/slack/commands returns 405', async () => {
    const req = new Request('https://bot.example.com/api/slack/commands');
    const res = await worker.fetch(req, env, ctx);
    expect(res.status).toBe(405);
  });
});

/**
 * Tests for lib/handlers/webhooks.ts
 * Covers signature verification and Linear webhook processing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports that use them)
// ============================================================================

vi.mock('../lib/db', () => ({
  getActiveWorkItemsBySourceRef: vi.fn(),
  updateWorkItemStatus: vi.fn(() => Promise.resolve(true)),
  updateSubmissionArrays: vi.fn(() => Promise.resolve()),
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getInProgressCarryCounts: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../lib/slack', () => ({
  sendDM: vi.fn(() => Promise.resolve()),
  updateMessage: vi.fn(() => Promise.resolve(true)),
  publishHomeView: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../lib/config', () => ({
  getDaily: vi.fn(() => ({
    name: 'eng-daily',
    channel: 'C123',
    questions: [],
    field_order: [],
    integrations: {},
  })),
  getLinearIntelligenceConfig: vi.fn(() => ({
    enabled: true,
    cross_reference: true,
    auto_update: true,
    priority_alignment: true,
  })),
  getGitHubConfig: vi.fn(() => null),
}));

vi.mock('../lib/format', () => ({
  formatStandupBlocks: vi.fn(() => []),
}));

vi.mock('../lib/prompt', () => ({
  formatDate: vi.fn(() => '2026-05-07'),
  getUserDate: vi.fn(() => new Date('2026-05-07T10:00:00Z')),
}));

vi.mock('../lib/handlers/home', () => ({
  handleAppHomeOpened: vi.fn(() => Promise.resolve()),
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import { verifyLinearSignature, handleLinearWebhook, LinearWebhookPayload } from '../lib/handlers/webhooks';
import {
  getActiveWorkItemsBySourceRef,
  updateWorkItemStatus,
  updateSubmissionArrays,
  getSubmissionForDate,
} from '../lib/db';
import { sendDM, updateMessage } from '../lib/slack';
import { getDaily, getLinearIntelligenceConfig, getGitHubConfig } from '../lib/config';
import type { WorkItem } from '../lib/db';
import type { DbClient } from '../lib/db';
import type { Env } from '../api/index';

// ============================================================================
// Helpers
// ============================================================================

/** Compute a real HMAC-SHA256 signature using the Web Crypto API (Node 18+) */
async function signBody(body: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a minimal mock Request */
function makeRequest(body: string, signature: string): Request {
  return new Request('https://example.com/api/webhooks/linear', {
    method: 'POST',
    headers: { 'Linear-Signature': signature },
    body,
  });
}

/** Build a minimal env object */
function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_SIGNING_SECRET: 'slack-secret',
    DATABASE_URL: 'postgres://test',
    LINEAR_WEBHOOK_SECRET: 'webhook-secret-123',
    ...overrides,
  };
}

/** Build a minimal DbClient that never touches a real DB */
function makeDb(): DbClient {
  return {
    query: vi.fn(() => Promise.resolve([])),
  };
}

/** Build a valid LinearWebhookPayload for an issue state change */
function makeIssueUpdatePayload(overrides: Partial<LinearWebhookPayload['data']> = {}): LinearWebhookPayload {
  return {
    action: 'update',
    type: 'Issue',
    data: {
      id: 'uuid-1',
      identifier: 'ENG-123',
      title: 'Fix auth bug',
      state: { id: 'state-uuid', name: 'Done', type: 'completed' },
      priority: 2,
      url: 'https://linear.app/team/issue/ENG-123',
      ...overrides,
    },
    updatedFrom: { stateId: 'old-state-uuid' },
    url: 'https://linear.app/team/issue/ENG-123',
    createdAt: '2026-05-07T09:00:00Z',
    webhookTimestamp: 1746604800000,
  };
}

/** Build a minimal active WorkItem */
function makeActiveItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 42,
    slack_user_id: 'U123',
    daily_name: 'eng-daily',
    text: '[ENG-123] Fix auth bug',
    created_date: '2026-05-07',
    status: 'pending',
    carry_count: 0,
    completed_date: null,
    snoozed_until: null,
    submission_id: null,
    source: 'linear_ticket',
    source_ref: 'ENG-123',
    source_url: 'https://linear.app/team/issue/ENG-123',
    item_type: 'plan',
    ...overrides,
  };
}

// ============================================================================
// verifyLinearSignature
// ============================================================================

describe('verifyLinearSignature', () => {
  it('returns true for a valid HMAC-SHA256 signature', async () => {
    const body = JSON.stringify({ action: 'update', type: 'Issue' });
    const secret = 'my-webhook-secret';
    const signature = await signBody(body, secret);

    const result = await verifyLinearSignature(body, signature, secret);

    expect(result).toBe(true);
  });

  it('returns false for an invalid signature', async () => {
    const body = JSON.stringify({ action: 'update', type: 'Issue' });
    const secret = 'my-webhook-secret';
    const wrongSig = 'deadbeef'.repeat(8); // 64-char hex but wrong value

    const result = await verifyLinearSignature(body, wrongSig, secret);

    expect(result).toBe(false);
  });

  it('returns false for an empty signature', async () => {
    const body = JSON.stringify({ action: 'update', type: 'Issue' });
    const secret = 'my-webhook-secret';

    const result = await verifyLinearSignature(body, '', secret);

    expect(result).toBe(false);
  });
});

// ============================================================================
// handleLinearWebhook
// ============================================================================

describe('handleLinearWebhook', () => {
  const SECRET = 'webhook-secret-123';

  beforeEach(() => {
    // resetAllMocks clears both call history AND mock implementations set by mockReturnValue.
    // This prevents test-order contamination (e.g. a mockReturnValue set in test N affecting test N+1).
    vi.resetAllMocks();

    // Re-apply defaults that the module-level vi.mock factories provide.
    vi.mocked(getActiveWorkItemsBySourceRef).mockResolvedValue([makeActiveItem()]);
    vi.mocked(updateWorkItemStatus).mockResolvedValue(true);
    vi.mocked(updateSubmissionArrays).mockResolvedValue(undefined);
    vi.mocked(getSubmissionForDate).mockResolvedValue(null);
    vi.mocked(sendDM).mockResolvedValue(undefined as any);
    vi.mocked(updateMessage).mockResolvedValue(true as any);
    vi.mocked(getDaily).mockReturnValue({
      name: 'eng-daily',
      channel: 'C123',
      questions: [],
      field_order: [],
      integrations: {},
    } as any);
    vi.mocked(getLinearIntelligenceConfig).mockReturnValue({
      enabled: true,
      cross_reference: true,
      auto_update: true,
      priority_alignment: true,
    });
    vi.mocked(getGitHubConfig).mockReturnValue(null);
  });

  it('returns 200 and marks items done for a completed state change', async () => {
    const payload = makeIssueUpdatePayload({ state: { id: 's1', name: 'Done', type: 'completed' } });
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).toHaveBeenCalledWith(
      db,
      42,
      'done',
      '2026-05-07'
    );
  });

  it('returns 200 and marks items in_progress for a started state change', async () => {
    const payload = makeIssueUpdatePayload({ state: { id: 's2', name: 'In Progress', type: 'started' } });
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).toHaveBeenCalledWith(db, 42, 'in_progress', undefined);
  });

  it('returns 200 and skips processing for non-update actions', async () => {
    const payload: LinearWebhookPayload = {
      ...makeIssueUpdatePayload(),
      action: 'create',
    };
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and skips processing for non-Issue types', async () => {
    const payload: LinearWebhookPayload = {
      ...makeIssueUpdatePayload(),
      type: 'Comment',
    };
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('returns 200 when no matching work items found', async () => {
    vi.mocked(getActiveWorkItemsBySourceRef).mockResolvedValue([]);

    const payload = makeIssueUpdatePayload();
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('returns 401 for an invalid signature', async () => {
    const body = JSON.stringify(makeIssueUpdatePayload());
    const request = makeRequest(body, 'invalid-signature');
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(401);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and skips processing when LINEAR_WEBHOOK_SECRET is not configured', async () => {
    const body = JSON.stringify(makeIssueUpdatePayload());
    const request = makeRequest(body, 'any-sig');
    const db = makeDb();
    const env = makeEnv({ LINEAR_WEBHOOK_SECRET: undefined });

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('returns 200 and skips processing when auto_update is disabled in config', async () => {
    vi.mocked(getLinearIntelligenceConfig).mockReturnValue({
      enabled: true,
      cross_reference: true,
      auto_update: false, // disabled
      priority_alignment: true,
    });

    const payload = makeIssueUpdatePayload();
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });

  it('sends a DM notification when an item is auto-updated', async () => {
    const payload = makeIssueUpdatePayload({ state: { id: 's1', name: 'Done', type: 'completed' } });
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    await handleLinearWebhook(request, env, db);

    expect(sendDM).toHaveBeenCalledWith(
      env.SLACK_BOT_TOKEN,
      'U123',
      expect.stringContaining('ENG-123')
    );
    expect(sendDM).toHaveBeenCalledWith(
      env.SLACK_BOT_TOKEN,
      'U123',
      expect.stringContaining('marked done')
    );
  });

  it('handles idempotent delivery — item already done causes no error', async () => {
    // Item is already in 'done' status — updateWorkItemStatus resolves false (no rows updated)
    vi.mocked(getActiveWorkItemsBySourceRef).mockResolvedValue([
      makeActiveItem({ status: 'done' }),
    ]);
    vi.mocked(updateWorkItemStatus).mockResolvedValue(false);

    const payload = makeIssueUpdatePayload({ state: { id: 's1', name: 'Done', type: 'completed' } });
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    // Should complete without throwing
    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    // updateWorkItemStatus was still called — idempotency is the DB's concern
    expect(updateWorkItemStatus).toHaveBeenCalled();
  });

  it('updates the channel post when submission is posted', async () => {
    const submission = {
      id: 77,
      slack_user_id: 'U123',
      daily_name: 'eng-daily',
      submitted_at: new Date(),
      date: '2026-05-07',
      yesterday_completed: [],
      yesterday_incomplete: [],
      yesterday_in_progress: [],
      unplanned: [],
      today_plans: ['[ENG-123] Fix auth bug'],
      blockers: null,
      custom_answers: null,
      slack_message_ts: '1234567890.000100',
      posted: true,
      items_normalized: true,
    };
    vi.mocked(getActiveWorkItemsBySourceRef).mockResolvedValue([
      makeActiveItem({ submission_id: 77 }),
    ]);
    vi.mocked(getSubmissionForDate).mockResolvedValue(submission);

    const payload = makeIssueUpdatePayload({ state: { id: 's1', name: 'Done', type: 'completed' } });
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateMessage).toHaveBeenCalledWith(
      env.SLACK_BOT_TOKEN,
      'C123',
      '1234567890.000100',
      expect.any(String),
      expect.any(Array)
    );
  });

  it('skips state change processing when updatedFrom has no stateId', async () => {
    const payload: LinearWebhookPayload = {
      ...makeIssueUpdatePayload(),
      updatedFrom: {}, // No stateId — not a state change
    };
    const body = JSON.stringify(payload);
    const sig = await signBody(body, SECRET);
    const request = makeRequest(body, sig);
    const db = makeDb();
    const env = makeEnv();

    const response = await handleLinearWebhook(request, env, db);

    expect(response.status).toBe(200);
    expect(updateWorkItemStatus).not.toHaveBeenCalled();
  });
});

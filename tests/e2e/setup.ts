/**
 * Global setup for the e2e suite. Runs before every e2e test file.
 *
 * Responsibilities:
 *   1. Swap ONLY lib/db's `getDb` to return the PGlite-backed client — every
 *      other query function stays real, so real SQL runs against real Postgres.
 *   2. Install the fake Slack API at the fetch boundary and expose its recorder
 *      globally (scenarios read it via `slackRecorder()`).
 *   3. Initialize the DB once, truncate between tests, and pin the clock + TZ so
 *      date math is deterministic.
 *
 * Nothing else is mocked: signature verification, config loading (real
 * config.yaml), all handlers, formatting, and timezone logic run for real.
 * GitHub/Linear integration code short-circuits because their tokens are unset.
 */

import { beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { initTestDb, resetTestDb } from './harness/db';
import { installSlackFake, SlackRecorder } from './harness/slack';

// --- 1. DB: swap getDb → PGlite client, keep all query functions real --------
vi.mock('../../lib/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/db')>();
  const { getTestDbClient } = await import('./harness/db');
  return {
    ...real,
    getDb: () => getTestDbClient(),
  };
});

// --- 2. Slack fake -----------------------------------------------------------
let _slack: { recorder: SlackRecorder; uninstall: () => void } | null = null;

/** The active Slack recorder for the current test. */
export function slackRecorder(): SlackRecorder {
  if (!_slack) throw new Error('Slack fake not installed');
  return _slack.recorder;
}

/** Default "now" for tests that don't set their own — a Tuesday, after 10:00
 *  Jerusalem time (12:00Z = 15:00 IDT) so "post immediately" is the default. */
export const DEFAULT_NOW = new Date('2026-06-02T12:00:00.000Z');

beforeAll(async () => {
  await initTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  _slack = installSlackFake();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(DEFAULT_NOW);
});

afterEach(() => {
  vi.useRealTimers();
  _slack?.uninstall();
  _slack = null;
  vi.clearAllMocks();
});

afterAll(() => {
  // PGlite instance is process-scoped; nothing to tear down explicitly.
});

/**
 * E2E test database harness — a real Postgres engine in-process via PGlite.
 *
 * The production code talks to Neon through a single `DbClient.query(sql, params)`
 * seam (see lib/db.ts `getDb`). This harness provides a `DbClient` backed by
 * PGlite running the real `schema.sql`, so every query function in lib/db.ts
 * (saveSubmission, getSubmissionForDate, …) runs its actual SQL against actual
 * Postgres. That means UNIQUE constraints, JSONB coercion, and DATE parsing all
 * behave the way they do in production — including Neon's habit of returning
 * DATE columns as JS Date objects (PGlite does the same), which is exactly the
 * class of bug commit 30e05f8 fixed.
 *
 * A single PGlite instance is created lazily and reused across the whole test
 * run (WASM init is the slow part); `resetTestDb()` truncates between tests.
 */

import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { DbClient } from '../../../lib/db';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', '..', '..', 'schema.sql');

/** Every table in schema.sql — truncated between tests for isolation. */
const ALL_TABLES = [
  'participants',
  'submissions',
  'prompts',
  'slack_users',
  'work_items',
  'submission_items',
  'reminder_log',
  'ooo',
  'config_overrides',
];

let pg: PGlite | null = null;
let client: DbClient | null = null;

/**
 * Adapt PGlite to the production `DbClient` interface.
 * PGlite speaks the same `$1`-style parameterized SQL the lib/db.ts functions
 * already emit, so this is a thin wrapper: run the query, hand back `.rows`.
 * Undefined params are coerced to null (PGlite rejects `undefined`).
 */
function adapt(instance: PGlite): DbClient {
  return {
    query: async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> => {
      const safeParams = params?.map((p) => (p === undefined ? null : p));
      const result = await instance.query<T>(sql, safeParams);
      return result.rows;
    },
  };
}

/** Create the PGlite instance and load schema.sql (idempotent). */
export async function initTestDb(): Promise<DbClient> {
  if (!pg) {
    pg = new PGlite();
    const schema = readFileSync(SCHEMA_PATH, 'utf-8');
    await pg.exec(schema);
    client = adapt(pg);
  }
  return client!;
}

/**
 * The live DbClient. Throws if accessed before initTestDb() — the e2e setup
 * file initializes it before any test runs.
 */
export function getTestDbClient(): DbClient {
  if (!client) {
    throw new Error('Test DB not initialized — did the e2e setup file run initTestDb()?');
  }
  return client;
}

/** Truncate every table and reset SERIAL counters so IDs are deterministic. */
export async function resetTestDb(): Promise<void> {
  const db = getTestDbClient();
  await db.query(`TRUNCATE ${ALL_TABLES.join(', ')} RESTART IDENTITY CASCADE`);
}

// ----------------------------------------------------------------------------
// Inspection helpers — read raw rows so scenarios can assert on persistence.
// ----------------------------------------------------------------------------

/** Raw rows from any table (optionally filtered by daily). */
export async function rows<T = Record<string, unknown>>(table: string): Promise<T[]> {
  return getTestDbClient().query<T>(`SELECT * FROM ${table} ORDER BY id ASC`);
}

/** All submissions, newest date first. */
export async function allSubmissions<T = Record<string, unknown>>(): Promise<T[]> {
  return getTestDbClient().query<T>(`SELECT * FROM submissions ORDER BY date DESC, id ASC`);
}

/** All work_items in insertion order. */
export async function allWorkItems<T = Record<string, unknown>>(): Promise<T[]> {
  return getTestDbClient().query<T>(`SELECT * FROM work_items ORDER BY id ASC`);
}

/** All submission_items rows (the work_item ↔ submission link table). */
export async function allSubmissionItems<T = Record<string, unknown>>(): Promise<T[]> {
  return getTestDbClient().query<T>(`SELECT * FROM submission_items ORDER BY id ASC`);
}

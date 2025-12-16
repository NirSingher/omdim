import { Pool } from '@neondatabase/serverless';

// Unified query interface
export interface DbClient {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

let client: DbClient | null = null;

// Note: Cloudflare Workers doesn't support Node.js pg driver.
// Use Neon serverless driver for all database connections.
// For local testing, use wrangler dev with Neon DATABASE_URL.
export function getDb(databaseUrl: string): DbClient {
  if (client) {
    return client;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  client = {
    query: async <T>(sqlText: string, params?: unknown[]): Promise<T[]> => {
      const result = await pool.query(sqlText, params);
      return result.rows as T[];
    },
  };

  return client;
}

// Reset client (for testing)
export function resetDb(): void {
  client = null;
}

// Participant types
export interface Participant {
  id: number;
  slack_user_id: string;
  daily_name: string;
  schedule_name: string;
  time_override: string | null;
  created_at: Date;
}

// Add a participant to a daily
export async function addParticipant(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  scheduleName: string
): Promise<Participant> {
  const result = await db.query<Participant>(
    `INSERT INTO participants (slack_user_id, daily_name, schedule_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (slack_user_id, daily_name) DO UPDATE SET
       schedule_name = $4
     RETURNING *`,
    [slackUserId, dailyName, scheduleName, scheduleName]
  );
  return result[0];
}

// Remove a participant from a daily
export async function removeParticipant(
  db: DbClient,
  slackUserId: string,
  dailyName: string
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM participants
     WHERE slack_user_id = $1 AND daily_name = $2`,
    [slackUserId, dailyName]
  );
  return result.length >= 0; // DELETE succeeded
}

// Get all participants for a daily
export async function getParticipants(
  db: DbClient,
  dailyName: string
): Promise<Participant[]> {
  return db.query<Participant>(
    `SELECT * FROM participants
     WHERE daily_name = $1
     ORDER BY created_at ASC`,
    [dailyName]
  );
}

// Get all dailies a user is part of
export async function getUserDailies(
  db: DbClient,
  slackUserId: string
): Promise<Participant[]> {
  return db.query<Participant>(
    `SELECT * FROM participants
     WHERE slack_user_id = $1
     ORDER BY daily_name ASC`,
    [slackUserId]
  );
}

// Health check
export async function healthCheck(db: DbClient): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

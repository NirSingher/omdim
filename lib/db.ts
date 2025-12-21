/**
 * Database access layer using Neon serverless PostgreSQL
 * Handles all CRUD operations for participants, submissions, and prompts
 */

import { neon } from '@neondatabase/serverless';

// ============================================================================
// Database Client
// ============================================================================

/** Unified query interface for database operations */
export interface DbClient {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

/**
 * Create a database client using Neon's serverless driver
 * Note: Cloudflare Workers doesn't support connection pooling across requests
 */
export function getDb(databaseUrl: string): DbClient {
  const sql = neon(databaseUrl);

  return {
    query: async <T>(sqlText: string, params?: unknown[]): Promise<T[]> => {
      // neon() uses tagged templates, so we need to convert parameterized queries
      // Split SQL on $1, $2, etc. placeholders to create template parts
      if (!params || params.length === 0) {
        const strings = Object.assign([sqlText], { raw: [sqlText] });
        const result = await sql(strings as TemplateStringsArray);
        return result as T[];
      }

      // Split on $N placeholders while preserving order
      const parts = sqlText.split(/\$\d+/);
      const strings = Object.assign([...parts], { raw: parts });

      const result = await sql(strings as TemplateStringsArray, ...params);
      return result as T[];
    },
  };
}

// ============================================================================
// Slack Users Cache
// ============================================================================

export interface SlackUser {
  slack_user_id: string;
  display_name: string | null;
  tz: string | null;
  tz_offset: number;
  updated_at: Date;
}

/** Cache expiry time in hours */
const USER_CACHE_HOURS = 24;

/** Get cached user, returns null if not found or stale */
export async function getCachedUser(
  db: DbClient,
  slackUserId: string
): Promise<SlackUser | null> {
  const result = await db.query<SlackUser>(
    `SELECT * FROM slack_users
     WHERE slack_user_id = $1
       AND updated_at > NOW() - INTERVAL '${USER_CACHE_HOURS} hours'`,
    [slackUserId]
  );
  return result[0] || null;
}

/** Upsert user cache */
export async function upsertCachedUser(
  db: DbClient,
  user: { slackUserId: string; displayName?: string; tz?: string; tzOffset: number }
): Promise<SlackUser> {
  const result = await db.query<SlackUser>(
    `INSERT INTO slack_users (slack_user_id, display_name, tz, tz_offset, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (slack_user_id) DO UPDATE SET
       display_name = COALESCE($5, slack_users.display_name),
       tz = COALESCE($6, slack_users.tz),
       tz_offset = $7,
       updated_at = NOW()
     RETURNING *`,
    [
      user.slackUserId,
      user.displayName || null,
      user.tz || null,
      user.tzOffset,
      user.displayName || null,
      user.tz || null,
      user.tzOffset,
    ]
  );
  return result[0];
}

/** Get all stale users that need refreshing */
export async function getStaleUsers(db: DbClient): Promise<string[]> {
  const result = await db.query<{ slack_user_id: string }>(
    `SELECT DISTINCT p.slack_user_id
     FROM participants p
     LEFT JOIN slack_users su ON p.slack_user_id = su.slack_user_id
     WHERE su.slack_user_id IS NULL
        OR su.updated_at < NOW() - INTERVAL '${USER_CACHE_HOURS} hours'`
  );
  return result.map((r) => r.slack_user_id);
}

// ============================================================================
// Work Items (for analytics)
// ============================================================================

export interface WorkItem {
  id: number;
  slack_user_id: string;
  daily_name: string;
  text: string;
  created_date: string;
  status: 'pending' | 'done' | 'dropped' | 'carried';
  carry_count: number;
  completed_date: string | null;
  submission_id: number | null;
}

/** Create work items from today's plans */
export async function createWorkItems(
  db: DbClient,
  items: Array<{
    slackUserId: string;
    dailyName: string;
    text: string;
    date: string;
    submissionId: number;
  }>
): Promise<WorkItem[]> {
  if (items.length === 0) return [];

  const results: WorkItem[] = [];
  for (const item of items) {
    const result = await db.query<WorkItem>(
      `INSERT INTO work_items (slack_user_id, daily_name, text, created_date, status, submission_id)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [item.slackUserId, item.dailyName, item.text, item.date, item.submissionId]
    );
    if (result[0]) results.push(result[0]);
  }
  return results;
}

/** Mark items as done */
export async function markItemsDone(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  itemTexts: string[],
  completedDate: string
): Promise<number> {
  if (itemTexts.length === 0) return 0;

  let updated = 0;
  for (const text of itemTexts) {
    const result = await db.query<{ id: number }>(
      `UPDATE work_items
       SET status = 'done', completed_date = $1
       WHERE slack_user_id = $2 AND daily_name = $3 AND text = $4 AND status IN ('pending', 'carried')
       RETURNING id`,
      [completedDate, slackUserId, dailyName, text]
    );
    updated += result.length;
  }
  return updated;
}

/** Mark items as dropped */
export async function markItemsDropped(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  itemTexts: string[]
): Promise<number> {
  if (itemTexts.length === 0) return 0;

  let updated = 0;
  for (const text of itemTexts) {
    const result = await db.query<{ id: number }>(
      `UPDATE work_items
       SET status = 'dropped'
       WHERE slack_user_id = $1 AND daily_name = $2 AND text = $3 AND status IN ('pending', 'carried')
       RETURNING id`,
      [slackUserId, dailyName, text]
    );
    updated += result.length;
  }
  return updated;
}

/** Increment carry count for items being carried over */
export async function incrementCarryCount(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  itemTexts: string[]
): Promise<number> {
  if (itemTexts.length === 0) return 0;

  let updated = 0;
  for (const text of itemTexts) {
    const result = await db.query<{ id: number }>(
      `UPDATE work_items
       SET carry_count = carry_count + 1, status = 'carried'
       WHERE slack_user_id = $1 AND daily_name = $2 AND text = $3 AND status IN ('pending', 'carried')
       RETURNING id`,
      [slackUserId, dailyName, text]
    );
    updated += result.length;
  }
  return updated;
}

/** Get items with high carry count (for alerts) */
export async function getHighCarryItems(
  db: DbClient,
  threshold: number = 3
): Promise<WorkItem[]> {
  return db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE carry_count >= $1 AND status IN ('pending', 'carried')
     ORDER BY carry_count DESC, created_date ASC`,
    [threshold]
  );
}

/** Get pending items for a user/daily (for pre-fill) */
export async function getPendingItems(
  db: DbClient,
  slackUserId: string,
  dailyName: string
): Promise<WorkItem[]> {
  return db.query<WorkItem>(
    `SELECT * FROM work_items
     WHERE slack_user_id = $1 AND daily_name = $2 AND status IN ('pending', 'carried')
     ORDER BY created_date ASC`,
    [slackUserId, dailyName]
  );
}

// ============================================================================
// Participants
// ============================================================================

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

// ============================================================================
// Health Check
// ============================================================================

export async function healthCheck(db: DbClient): Promise<boolean> {
  try {
    await db.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database health check failed:', error);
    return false;
  }
}

// ============================================================================
// Prompts
// ============================================================================

export interface Prompt {
  id: number;
  slack_user_id: string;
  daily_name: string;
  date: string;
  last_prompted_at: Date | null;
  submitted: boolean;
}

// Get or create prompt record for today
export async function getOrCreatePrompt(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  date: string
): Promise<Prompt> {
  const result = await db.query<Prompt>(
    `INSERT INTO prompts (slack_user_id, daily_name, date)
     VALUES ($1, $2, $3)
     ON CONFLICT (slack_user_id, daily_name, date) DO NOTHING
     RETURNING *`,
    [slackUserId, dailyName, date]
  );

  if (result.length > 0) {
    return result[0];
  }

  // Record already existed, fetch it
  const existing = await db.query<Prompt>(
    `SELECT * FROM prompts
     WHERE slack_user_id = $1 AND daily_name = $2 AND date = $3`,
    [slackUserId, dailyName, date]
  );
  return existing[0];
}

// Update prompt after sending
export async function updatePromptSent(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  date: string
): Promise<void> {
  await db.query(
    `UPDATE prompts
     SET last_prompted_at = NOW()
     WHERE slack_user_id = $1 AND daily_name = $2 AND date = $3`,
    [slackUserId, dailyName, date]
  );
}

// Mark prompt as submitted
export async function markPromptSubmitted(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  date: string
): Promise<void> {
  await db.query(
    `UPDATE prompts
     SET submitted = true
     WHERE slack_user_id = $1 AND daily_name = $2 AND date = $3`,
    [slackUserId, dailyName, date]
  );
}

// Get all participants who need prompting
export async function getAllParticipants(db: DbClient): Promise<Participant[]> {
  return db.query<Participant>(
    `SELECT * FROM participants ORDER BY daily_name, created_at`
  );
}

// ============================================================================
// Submissions
// ============================================================================

export interface Submission {
  id: number;
  slack_user_id: string;
  daily_name: string;
  submitted_at: Date;
  date: string;
  yesterday_completed: string[] | null;
  yesterday_incomplete: string[] | null;
  unplanned: string[] | null;
  today_plans: string[] | null;
  blockers: string | null;
  custom_answers: Record<string, string> | null;
  slack_message_ts: string | null;
}

// Get the most recent previous submission for a user (regardless of how many days ago)
export async function getPreviousSubmission(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  todayDate: string
): Promise<Submission | null> {
  // Get the most recent submission before today
  const result = await db.query<Submission>(
    `SELECT * FROM submissions
     WHERE slack_user_id = $1 AND daily_name = $2 AND date < $3
     ORDER BY date DESC
     LIMIT 1`,
    [slackUserId, dailyName, todayDate]
  );
  return result[0] || null;
}

// Save a submission
export async function saveSubmission(
  db: DbClient,
  submission: {
    slackUserId: string;
    dailyName: string;
    date: string;
    yesterdayCompleted: string[];
    yesterdayIncomplete: string[];
    unplanned: string[];
    todayPlans: string[];
    blockers: string;
    customAnswers: Record<string, string>;
  }
): Promise<Submission> {
  // Use unique parameter numbers (no reuse) for tagged template conversion
  const result = await db.query<Submission>(
    `INSERT INTO submissions (
       slack_user_id, daily_name, date,
       yesterday_completed, yesterday_incomplete, unplanned,
       today_plans, blockers, custom_answers
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (slack_user_id, daily_name, date) DO UPDATE SET
       yesterday_completed = $10,
       yesterday_incomplete = $11,
       unplanned = $12,
       today_plans = $13,
       blockers = $14,
       custom_answers = $15,
       submitted_at = NOW()
     RETURNING *`,
    [
      submission.slackUserId,
      submission.dailyName,
      submission.date,
      JSON.stringify(submission.yesterdayCompleted),
      JSON.stringify(submission.yesterdayIncomplete),
      JSON.stringify(submission.unplanned),
      JSON.stringify(submission.todayPlans),
      submission.blockers,
      JSON.stringify(submission.customAnswers),
      // Duplicate values for ON CONFLICT
      JSON.stringify(submission.yesterdayCompleted),
      JSON.stringify(submission.yesterdayIncomplete),
      JSON.stringify(submission.unplanned),
      JSON.stringify(submission.todayPlans),
      submission.blockers,
      JSON.stringify(submission.customAnswers),
    ]
  );
  return result[0];
}

// Update submission with message timestamp
export async function updateSubmissionMessageTs(
  db: DbClient,
  submissionId: number,
  messageTs: string
): Promise<void> {
  await db.query(
    `UPDATE submissions SET slack_message_ts = $1 WHERE id = $2`,
    [messageTs, submissionId]
  );
}

// Get all submissions for a daily on a specific date
export async function getSubmissionsForDate(
  db: DbClient,
  dailyName: string,
  date: string
): Promise<Submission[]> {
  return db.query<Submission>(
    `SELECT * FROM submissions
     WHERE daily_name = $1 AND date = $2
     ORDER BY submitted_at ASC`,
    [dailyName, date]
  );
}

// Get submissions for a daily within a date range
export async function getSubmissionsInRange(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string
): Promise<Submission[]> {
  return db.query<Submission>(
    `SELECT * FROM submissions
     WHERE daily_name = $1 AND date >= $2 AND date <= $3
     ORDER BY date DESC, submitted_at ASC`,
    [dailyName, startDate, endDate]
  );
}

// Get participation stats for a daily within a date range
export interface ParticipationStats {
  slack_user_id: string;
  submission_count: number;
  total_days: number;
}

export async function getParticipationStats(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string
): Promise<ParticipationStats[]> {
  return db.query<ParticipationStats>(
    `SELECT
       p.slack_user_id,
       COUNT(s.id) as submission_count,
       (SELECT COUNT(DISTINCT date) FROM submissions WHERE daily_name = $1 AND date >= $2 AND date <= $3) as total_days
     FROM participants p
     LEFT JOIN submissions s ON p.slack_user_id = s.slack_user_id
       AND s.daily_name = $4 AND s.date >= $5 AND s.date <= $6
     WHERE p.daily_name = $7
     GROUP BY p.slack_user_id
     ORDER BY submission_count DESC`,
    [dailyName, startDate, endDate, dailyName, startDate, endDate, dailyName]
  );
}

// ============================================================================
// Team Statistics
// ============================================================================

export interface TeamMemberStats {
  slack_user_id: string;
  submission_count: number;
  total_completed: number;
  total_planned: number;
  total_blockers: number;
  avg_items_per_day: number;
}

/** Get comprehensive team statistics for a date range */
export async function getTeamStats(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string
): Promise<TeamMemberStats[]> {
  return db.query<TeamMemberStats>(
    `SELECT
       p.slack_user_id,
       COUNT(s.id) as submission_count,
       COALESCE(SUM(jsonb_array_length(s.yesterday_completed::jsonb) + jsonb_array_length(s.unplanned::jsonb)), 0) as total_completed,
       COALESCE(SUM(jsonb_array_length(s.today_plans::jsonb)), 0) as total_planned,
       SUM(CASE WHEN s.blockers IS NOT NULL AND s.blockers != '' THEN 1 ELSE 0 END) as total_blockers,
       CASE WHEN COUNT(s.id) > 0 THEN
         ROUND(COALESCE(SUM(jsonb_array_length(s.today_plans::jsonb))::numeric, 0) / COUNT(s.id)::numeric, 1)
       ELSE 0 END as avg_items_per_day
     FROM participants p
     LEFT JOIN submissions s ON p.slack_user_id = s.slack_user_id
       AND s.daily_name = $1 AND s.date >= $2 AND s.date <= $3
     WHERE p.daily_name = $4
     GROUP BY p.slack_user_id
     ORDER BY submission_count DESC`,
    [dailyName, startDate, endDate, dailyName]
  );
}

/** Get list of users who haven't submitted today */
export async function getMissingSubmissions(
  db: DbClient,
  dailyName: string,
  date: string
): Promise<string[]> {
  const result = await db.query<{ slack_user_id: string }>(
    `SELECT p.slack_user_id
     FROM participants p
     LEFT JOIN submissions s ON p.slack_user_id = s.slack_user_id
       AND s.daily_name = $1 AND s.date = $2
     WHERE p.daily_name = $3 AND s.id IS NULL`,
    [dailyName, date, dailyName]
  );
  return result.map((r) => r.slack_user_id);
}

/** Count total workdays in a date range for a schedule */
export function countWorkdays(days: string[], startDate: string, endDate: string): number {
  const dayMap: Record<string, number> = {
    sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  };
  const workdayNums = days.map((d) => dayMap[d.toLowerCase()]);

  let count = 0;
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current <= end) {
    if (workdayNums.includes(current.getDay())) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

// ============================================================================
// Data Retention (Cleanup)
// ============================================================================

/** Delete old submissions (older than specified date) */
export async function deleteOldSubmissions(
  db: DbClient,
  beforeDate: string
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM submissions WHERE date < $1 RETURNING *
     )
     SELECT COUNT(*) as count FROM deleted`,
    [beforeDate]
  );
  return parseInt(result[0]?.count || '0', 10);
}

/** Delete old prompts (older than specified date) */
export async function deleteOldPrompts(
  db: DbClient,
  beforeDate: string
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM prompts WHERE date < $1 RETURNING *
     )
     SELECT COUNT(*) as count FROM deleted`,
    [beforeDate]
  );
  return parseInt(result[0]?.count || '0', 10);
}

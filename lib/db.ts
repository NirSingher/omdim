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
  snoozed_until: string | null;
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

// Mark prompt as submitted (creates record if needed for tomorrow mode)
export async function markPromptSubmitted(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  date: string
): Promise<void> {
  await db.query(
    `INSERT INTO prompts (slack_user_id, daily_name, date, submitted)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (slack_user_id, daily_name, date) DO UPDATE
     SET submitted = true`,
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
  posted: boolean;
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
    posted?: boolean; // false for scheduled (tomorrow) submissions
  }
): Promise<Submission> {
  const posted = submission.posted ?? true; // Default to true for backward compatibility
  // Use unique parameter numbers (no reuse) for tagged template conversion
  const result = await db.query<Submission>(
    `INSERT INTO submissions (
       slack_user_id, daily_name, date,
       yesterday_completed, yesterday_incomplete, unplanned,
       today_plans, blockers, custom_answers, posted
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (slack_user_id, daily_name, date) DO UPDATE SET
       yesterday_completed = $11,
       yesterday_incomplete = $12,
       unplanned = $13,
       today_plans = $14,
       blockers = $15,
       custom_answers = $16,
       posted = $17,
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
      posted,
      // Duplicate values for ON CONFLICT
      JSON.stringify(submission.yesterdayCompleted),
      JSON.stringify(submission.yesterdayIncomplete),
      JSON.stringify(submission.unplanned),
      JSON.stringify(submission.todayPlans),
      submission.blockers,
      JSON.stringify(submission.customAnswers),
      posted,
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

// Get a user's submission for a specific date
export async function getSubmissionForDate(
  db: DbClient,
  slackUserId: string,
  dailyName: string,
  date: string
): Promise<Submission | null> {
  const result = await db.query<Submission>(
    `SELECT * FROM submissions
     WHERE slack_user_id = $1 AND daily_name = $2 AND date = $3`,
    [slackUserId, dailyName, date]
  );
  return result[0] || null;
}

// Get all unposted submissions (for scheduled posts cron)
// Returns submissions where posted = FALSE, filtered by code for timezone handling
export async function getUnpostedSubmissions(
  db: DbClient
): Promise<Submission[]> {
  return db.query<Submission>(
    `SELECT * FROM submissions
     WHERE posted = FALSE
     ORDER BY date ASC, submitted_at ASC`,
    []
  );
}

// Mark a submission as posted
export async function markSubmissionPosted(
  db: DbClient,
  submissionId: number,
  messageTs: string
): Promise<void> {
  await db.query(
    `UPDATE submissions
     SET posted = TRUE, slack_message_ts = $1
     WHERE id = $2`,
    [messageTs, submissionId]
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

/** Get list of users who haven't submitted today (excludes OOO users) */
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
     LEFT JOIN ooo ON p.slack_user_id = ooo.slack_user_id
       AND ooo.daily_name = $3
       AND $4 BETWEEN ooo.start_date AND ooo.end_date
     WHERE p.daily_name = $5 AND s.id IS NULL AND ooo.id IS NULL`,
    [dailyName, date, dailyName, date, dailyName]
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

// ============================================================================
// Bottleneck Detection
// ============================================================================

export interface BottleneckItem {
  id: number;
  text: string;
  slack_user_id: string;
  carry_count: number;
  days_pending: number;
  type: 'carry' | 'dropped';
}

/** Get bottleneck items (carried at/above threshold, not snoozed) */
export async function getBottleneckItems(
  db: DbClient,
  dailyName: string,
  threshold: number = 3
): Promise<BottleneckItem[]> {
  return db.query<BottleneckItem>(
    `SELECT
       id,
       text,
       slack_user_id,
       carry_count,
       (CURRENT_DATE - created_date) as days_pending,
       'carry' as type
     FROM work_items
     WHERE daily_name = $1
       AND carry_count >= $2
       AND status IN ('pending', 'carried')
       AND (snoozed_until IS NULL OR snoozed_until <= CURRENT_DATE)
     ORDER BY carry_count DESC, created_date ASC
     LIMIT 10`,
    [dailyName, threshold]
  );
}

export interface DropStats {
  slack_user_id: string;
  total_items: number;
  dropped_count: number;
  drop_rate: number;
}

/** Get users with high drop rates in a date range */
export async function getHighDropUsers(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string,
  dropThreshold: number = 30 // percentage
): Promise<DropStats[]> {
  return db.query<DropStats>(
    `SELECT
       slack_user_id,
       COUNT(*) as total_items,
       SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) as dropped_count,
       ROUND(
         SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100,
         0
       ) as drop_rate
     FROM work_items
     WHERE daily_name = $1
       AND created_date >= $2
       AND created_date <= $3
     GROUP BY slack_user_id
     HAVING SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END)::numeric / NULLIF(COUNT(*), 0) * 100 >= $4
     ORDER BY drop_rate DESC`,
    [dailyName, startDate, endDate, dropThreshold]
  );
}

/** Snooze a bottleneck item for a number of days */
export async function snoozeItem(
  db: DbClient,
  itemId: number,
  days: number
): Promise<void> {
  await db.query(
    `UPDATE work_items
     SET snoozed_until = CURRENT_DATE + ($1 || ' days')::INTERVAL
     WHERE id = $2`,
    [days, itemId]
  );
}

/** Clear snooze on an item */
export async function clearSnooze(
  db: DbClient,
  itemId: number
): Promise<void> {
  await db.query(
    `UPDATE work_items SET snoozed_until = NULL WHERE id = $1`,
    [itemId]
  );
}

// ============================================================================
// Period Statistics (for trend analysis)
// ============================================================================

export interface PeriodStats {
  participation_rate: number;   // % of possible submissions received
  completion_rate: number;      // % of items completed vs dropped/carried
  blocker_rate: number;         // % of submissions with blockers
  total_submissions: number;
  total_participants: number;
  total_items_completed: number;
  total_items_dropped: number;
  avg_items_per_day: number;
}

/**
 * Get aggregate statistics for a period (for trend comparison)
 */
export async function getPeriodStats(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string,
  totalWorkdays: number
): Promise<PeriodStats> {
  // Get submission stats
  const submissionResult = await db.query<{
    submission_count: number;
    total_completed: number;
    total_planned: number;
    blocker_count: number;
  }>(
    `SELECT
       COUNT(s.id) as submission_count,
       COALESCE(SUM(jsonb_array_length(s.yesterday_completed::jsonb) + jsonb_array_length(s.unplanned::jsonb)), 0) as total_completed,
       COALESCE(SUM(jsonb_array_length(s.today_plans::jsonb)), 0) as total_planned,
       SUM(CASE WHEN s.blockers IS NOT NULL AND s.blockers != '' THEN 1 ELSE 0 END) as blocker_count
     FROM submissions s
     WHERE s.daily_name = $1 AND s.date >= $2 AND s.date <= $3`,
    [dailyName, startDate, endDate]
  );

  // Get participant count
  const participantResult = await db.query<{ count: number }>(
    `SELECT COUNT(*) as count FROM participants WHERE daily_name = $1`,
    [dailyName]
  );

  // Get work item stats for the period
  const itemResult = await db.query<{
    total_done: number;
    total_dropped: number;
  }>(
    `SELECT
       SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as total_done,
       SUM(CASE WHEN status = 'dropped' THEN 1 ELSE 0 END) as total_dropped
     FROM work_items
     WHERE daily_name = $1 AND created_date >= $2 AND created_date <= $3`,
    [dailyName, startDate, endDate]
  );

  const submissionCount = Number(submissionResult[0]?.submission_count) || 0;
  const totalCompleted = Number(submissionResult[0]?.total_completed) || 0;
  const totalPlanned = Number(submissionResult[0]?.total_planned) || 0;
  const blockerCount = Number(submissionResult[0]?.blocker_count) || 0;
  const participantCount = Number(participantResult[0]?.count) || 0;
  const itemsDone = Number(itemResult[0]?.total_done) || 0;
  const itemsDropped = Number(itemResult[0]?.total_dropped) || 0;

  const maxPossibleSubmissions = totalWorkdays * participantCount;
  const participationRate = maxPossibleSubmissions > 0
    ? Math.round((submissionCount / maxPossibleSubmissions) * 100)
    : 0;

  const totalItems = itemsDone + itemsDropped;
  const completionRate = totalItems > 0
    ? Math.round((itemsDone / totalItems) * 100)
    : 100;

  const blockerRate = submissionCount > 0
    ? Math.round((blockerCount / submissionCount) * 100)
    : 0;

  const avgItemsPerDay = submissionCount > 0
    ? Math.round((totalPlanned / submissionCount) * 10) / 10
    : 0;

  return {
    participation_rate: participationRate,
    completion_rate: completionRate,
    blocker_rate: blockerRate,
    total_submissions: submissionCount,
    total_participants: participantCount,
    total_items_completed: itemsDone,
    total_items_dropped: itemsDropped,
    avg_items_per_day: avgItemsPerDay,
  };
}

// ============================================================================
// Team Rankings
// ============================================================================

export interface TeamMemberRanking {
  slack_user_id: string;
  score: number;
  participation_rate: number;
  completion_rate: number;
  items_done: number;
  avg_carry_days: number;
  drop_rate: number;
  blocker_days: number;
  rank: number;
}

/**
 * Get team rankings based on formula:
 * Score = (Participation × 30) + (Completion × 25) + (Items Done × 0.5)
 *         - (Avg Carry Days × 5) - (Drop Penalty 10 if >30%) - (Blocker Days × 2)
 */
export async function getTeamRankings(
  db: DbClient,
  dailyName: string,
  startDate: string,
  endDate: string,
  totalWorkdays: number
): Promise<TeamMemberRanking[]> {
  // Complex query that calculates all ranking factors
  const result = await db.query<{
    slack_user_id: string;
    submission_count: number;
    total_completed: number;
    total_planned: number;
    total_dropped: number;
    total_carried: number;
    avg_carry_days: number;
    blocker_days: number;
  }>(
    `SELECT
       p.slack_user_id,
       COUNT(DISTINCT s.id) as submission_count,
       COALESCE(SUM(jsonb_array_length(s.yesterday_completed::jsonb) + jsonb_array_length(s.unplanned::jsonb)), 0) as total_completed,
       COALESCE(SUM(jsonb_array_length(s.today_plans::jsonb)), 0) as total_planned,
       (SELECT COUNT(*) FROM work_items w WHERE w.slack_user_id = p.slack_user_id AND w.daily_name = $1 AND w.status = 'dropped' AND w.created_date >= $2 AND w.created_date <= $3) as total_dropped,
       (SELECT COUNT(*) FROM work_items w WHERE w.slack_user_id = p.slack_user_id AND w.daily_name = $4 AND w.status = 'carried' AND w.created_date >= $5 AND w.created_date <= $6) as total_carried,
       COALESCE((SELECT AVG(w.carry_count) FROM work_items w WHERE w.slack_user_id = p.slack_user_id AND w.daily_name = $7 AND w.created_date >= $8 AND w.created_date <= $9), 0) as avg_carry_days,
       SUM(CASE WHEN s.blockers IS NOT NULL AND s.blockers != '' THEN 1 ELSE 0 END) as blocker_days
     FROM participants p
     LEFT JOIN submissions s ON p.slack_user_id = s.slack_user_id
       AND s.daily_name = $10 AND s.date >= $11 AND s.date <= $12
     WHERE p.daily_name = $13
     GROUP BY p.slack_user_id`,
    [
      dailyName, startDate, endDate,
      dailyName, startDate, endDate,
      dailyName, startDate, endDate,
      dailyName, startDate, endDate,
      dailyName
    ]
  );

  // Calculate scores and ranks
  const rankings: TeamMemberRanking[] = result.map(row => {
    const submissionCount = Number(row.submission_count) || 0;
    const totalCompleted = Number(row.total_completed) || 0;
    const totalPlanned = Number(row.total_planned) || 0;
    const totalDropped = Number(row.total_dropped) || 0;
    const totalCarried = Number(row.total_carried) || 0;
    const avgCarryDays = Number(row.avg_carry_days) || 0;
    const blockerDays = Number(row.blocker_days) || 0;

    // Calculate rates
    const participationRate = totalWorkdays > 0
      ? Math.round((submissionCount / totalWorkdays) * 100)
      : 0;

    const totalItems = totalCompleted + totalDropped + totalCarried;
    const completionRate = totalItems > 0
      ? Math.round((totalCompleted / totalItems) * 100)
      : 100; // If no items, consider 100% completion

    const dropRate = totalItems > 0
      ? Math.round((totalDropped / totalItems) * 100)
      : 0;

    // Calculate score using the formula
    let score = 0;
    score += participationRate * 0.30; // Max 30 pts
    score += completionRate * 0.25;    // Max 25 pts
    score += totalCompleted * 0.5;     // 0.5 per item done
    score -= avgCarryDays * 5;         // -5 per avg carry day
    score -= dropRate > 30 ? 10 : 0;   // -10 if drop rate > 30%
    score -= blockerDays * 2;          // -2 per blocker day

    return {
      slack_user_id: row.slack_user_id,
      score: Math.round(score * 10) / 10, // Round to 1 decimal
      participation_rate: participationRate,
      completion_rate: completionRate,
      items_done: totalCompleted,
      avg_carry_days: Math.round(avgCarryDays * 10) / 10,
      drop_rate: dropRate,
      blocker_days: blockerDays,
      rank: 0, // Will be set below
    };
  });

  // Sort by score descending and assign ranks
  rankings.sort((a, b) => b.score - a.score);
  rankings.forEach((r, i) => r.rank = i + 1);

  return rankings;
}

// ============================================================================
// Out of Office (OOO)
// ============================================================================

export interface OOORecord {
  id: number;
  slack_user_id: string;
  daily_name: string;
  start_date: string;
  end_date: string;
  created_at: Date;
}

/** Set OOO period for a user (upserts based on dates) */
export async function setOOO(
  db: DbClient,
  userId: string,
  dailyName: string,
  startDate: string,
  endDate: string
): Promise<OOORecord> {
  const result = await db.query<OOORecord>(
    `INSERT INTO ooo (slack_user_id, daily_name, start_date, end_date)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (slack_user_id, daily_name, start_date, end_date) DO UPDATE SET
       end_date = $5
     RETURNING *`,
    [userId, dailyName, startDate, endDate, endDate]
  );
  return result[0];
}

/** Clear all OOO periods for a user/daily */
export async function clearOOO(
  db: DbClient,
  userId: string,
  dailyName: string
): Promise<number> {
  const result = await db.query<{ count: string }>(
    `WITH deleted AS (
       DELETE FROM ooo WHERE slack_user_id = $1 AND daily_name = $2 RETURNING *
     ) SELECT COUNT(*) as count FROM deleted`,
    [userId, dailyName]
  );
  return parseInt(result[0]?.count || '0', 10);
}

/** Check if user is OOO on a specific date */
export async function getActiveOOO(
  db: DbClient,
  userId: string,
  dailyName: string,
  date: string
): Promise<OOORecord | null> {
  const result = await db.query<OOORecord>(
    `SELECT * FROM ooo
     WHERE slack_user_id = $1 AND daily_name = $2
       AND $3 BETWEEN start_date AND end_date
     LIMIT 1`,
    [userId, dailyName, date]
  );
  return result[0] || null;
}

/** Get all current and future OOO periods for a user/daily */
export async function getUserOOO(
  db: DbClient,
  userId: string,
  dailyName: string
): Promise<OOORecord[]> {
  return db.query<OOORecord>(
    `SELECT * FROM ooo
     WHERE slack_user_id = $1 AND daily_name = $2
       AND end_date >= CURRENT_DATE
     ORDER BY start_date`,
    [userId, dailyName]
  );
}

/** Get all active OOO for a daily on a specific date (for batch lookups) */
export async function getActiveOOOForDaily(
  db: DbClient,
  dailyName: string,
  date: string
): Promise<OOORecord[]> {
  return db.query<OOORecord>(
    `SELECT * FROM ooo
     WHERE daily_name = $1
       AND $2 BETWEEN start_date AND end_date`,
    [dailyName, date]
  );
}

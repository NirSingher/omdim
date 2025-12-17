import { neon } from '@neondatabase/serverless';

// Unified query interface
export interface DbClient {
  query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
}

// Note: Cloudflare Workers doesn't support connection pooling across requests.
// Use Neon's HTTP-based query function instead of Pool.
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

// Prompt types
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

// Submission types
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

// Delete old submissions (older than specified date)
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

// Delete old prompts (older than specified date)
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

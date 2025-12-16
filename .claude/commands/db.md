# Database Work

Database action: **$ARGUMENTS**

## Instructions

1. Read `architecture.md` for schema definition
2. Perform the requested database action

## Actions

### `schema`
Generate or update the full `schema.sql` file.

### `query <name>`
Write a database query function for `lib/db.ts`.

Common queries:
- `getParticipants` - All participants for a daily
- `getParticipantDailies` - All dailies for a user
- `addParticipant` - Add user to daily
- `removeParticipant` - Remove user from daily
- `getSubmission` - Get submission by user/daily/date
- `getLastSubmission` - Get most recent submission for user/daily
- `saveSubmission` - Insert or update submission
- `getTodaySubmissions` - All submissions for a daily today
- `getWeekSubmissions` - Submissions for last 28 days
- `getPromptStatus` - Check if user was prompted today
- `updatePromptStatus` - Record prompt sent
- `markSubmitted` - Mark prompt as submitted
- `cleanupOldData` - Delete data older than 28 days

### `migrate <description>`
Create a migration for schema changes.

## Output

Provide:
1. SQL or TypeScript code
2. Usage example
3. Any indexes needed for performance

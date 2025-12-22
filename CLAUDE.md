# Omdim - Claude Code Instructions

## Project Overview
Async daily standup Slack bot. Serverless on Vercel with Postgres.

## Key Docs
- `requirements.md` - Product requirements
- `architecture.md` - Technical design
- `implementation-plan.md` - Step-by-step build plan with checkpoints
- `roadmap.md` - Future phases

## Tech Stack
- Runtime: Node.js + TypeScript
- Framework: Vercel serverless functions
- Database: Postgres (Neon/Supabase)
- Slack SDK: `@slack/web-api`
- Config: YAML

## Project Structure
```
api/
  slack/
    commands.ts    # Slash command handler
    interact.ts    # Modal/button interactions
  cron/
    prompt.ts      # 30-min prompt job
    cleanup.ts     # Weekly data cleanup
lib/
  slack.ts         # Slack API helpers
  db.ts            # Database queries
  config.ts        # YAML config loader
  modal.ts         # Block Kit modal builder
  format.ts        # Message formatting
config.yaml        # Dailies, schedules, admins
schema.sql         # Database schema
```

## Conventions

### Code Style
- Use async/await, not callbacks
- Type everything - no `any`
- Keep functions small and focused
- Error handling: catch at boundaries, log details, return user-friendly messages

### Slack Patterns
- Verify request signatures on all endpoints
- Parse user IDs from `<@U...>` format in command text
- Use Block Kit for all rich messages
- Respond within 3 seconds, use `response_url` for slow operations

### Database
- Use parameterized queries (prevent SQL injection)
- Timestamps in UTC
- JSONB for flexible arrays (plans, answers)

### Environment Variables
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
DATABASE_URL=postgres://...
```

## Testing Checkpoints
Each implementation step has a checkpoint. Verify the checkpoint works before moving to the next step. See `implementation-plan.md` for details.

## Commands Available
- `/implement <step>` - Implement a specific step from the plan
- `/checkpoint <step>` - Verify a checkpoint passes
- `/slack-ui <component>` - Build Slack Block Kit components
- `/db <action>` - Database schema or query work

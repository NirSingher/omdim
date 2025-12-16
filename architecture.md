# Standup Bot - Architecture

## Overview

Serverless architecture on Vercel (recommended) or AWS Lambda. Event-driven design with Slack webhooks and scheduled cron jobs.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Slack     │────▶│   Vercel     │────▶│  Database   │
│  Webhooks   │     │  Functions   │     │  (Postgres) │
└─────────────┘     └──────────────┘     └─────────────┘
                           ▲
                           │
                    ┌──────┴──────┐
                    │  Cron Jobs  │
                    │  (Vercel)   │
                    └─────────────┘
```

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js / TypeScript | Best Slack SDK support, Vercel-native |
| Framework | Next.js API routes or plain Vercel functions | Simple, built-in cron support |
| Database | Neon / Supabase (Postgres) | Free tier, serverless-friendly |
| Slack SDK | `@slack/bolt` or `@slack/web-api` | Official, well-maintained |
| Config | YAML file in repo | Simple, version-controlled |

---

## Components

### 1. API Endpoints

```
/api/slack/events      # Slack event subscriptions (if needed)
/api/slack/commands    # Slash command handler
/api/slack/interact    # Modal submissions, button clicks
/api/cron/prompt       # Trigger daily prompts (runs every 30 min)
/api/cron/cleanup      # Data retention cleanup (runs weekly)
```

### 2. Cron Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| `prompt` | Every 30 min | Check who needs prompting, send/re-send DMs |
| `cleanup` | Weekly (Sun 3am) | Delete submissions and prompts older than 28 days |

**Prompt Logic**:
```
for each user in active dailies:
  if today is user's workday AND within prompt window:
    if no submission today AND (never prompted OR last prompt > 30 min ago):
      send prompt DM
      record prompt timestamp
```

**Cleanup Logic**:
```sql
DELETE FROM submissions WHERE date < NOW() - INTERVAL '28 days';
DELETE FROM prompts WHERE date < NOW() - INTERVAL '28 days';
```

### 3. Database Schema

```sql
-- Assigned users to dailies
CREATE TABLE participants (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  schedule_name TEXT NOT NULL,
  time_override TIME,  -- null = use schedule default
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(slack_user_id, daily_name)
);

-- Daily submissions
CREATE TABLE submissions (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  submitted_at TIMESTAMP DEFAULT NOW(),
  date DATE NOT NULL,  -- the standup date
  yesterday_completed JSONB,  -- ["item1", "item2"]
  yesterday_incomplete JSONB, -- ["item3"]
  unplanned JSONB,            -- ["item4"]
  today_plans JSONB,          -- ["plan1", "plan2"]
  blockers TEXT,
  custom_answers JSONB,       -- {"question": "answer"}
  slack_message_ts TEXT,      -- posted message ID
  UNIQUE(slack_user_id, daily_name, date)
);

-- Track prompt status
CREATE TABLE prompts (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  date DATE NOT NULL,
  last_prompted_at TIMESTAMP,
  submitted BOOLEAN DEFAULT FALSE,
  UNIQUE(slack_user_id, daily_name, date)
);
```

### 4. Config File

Stored in repo as `config.yaml`, loaded at runtime.

**Note**: Use channel names (e.g., `#eng-standup`) - Slack API accepts these directly.

```yaml
dailies:
  - name: "engineering"
    channel: "#eng-standup"
    schedule: "il-team"
    questions:
      - text: "PRs needing review?"
        required: false

schedules:
  - name: "il-team"
    days: [sun, mon, tue, wed, thu]
    default_time: "09:00"
  - name: "us-team"
    days: [mon, tue, wed, thu, fri]
    default_time: "09:00"

admins:
  - "U12345678"
```

---

## Key Flows

### Prompt Flow (Cron)

```
1. Cron triggers /api/cron/prompt every 30 min
2. Load config, fetch all participants
3. For each participant:
   a. Get user timezone from Slack API (cache it)
   b. Check if current time in user's TZ is past their prompt time
   c. Check if today is a workday for their schedule
   d. Check prompts table - already submitted? recently prompted?
   e. If should prompt: send DM with "Open Standup" button
   f. Update prompts.last_prompted_at
```

### Submission Flow

```
1. User clicks "Open Standup" button
2. /api/slack/interact receives interaction
3. Fetch user's last submission (for yesterday's plans)
4. Build modal:
   - If has yesterday: show plans as checkboxes
   - Pre-fill "Today's plans" with yesterday's incomplete items
   - Add custom questions from config
5. User fills form, submits
6. /api/slack/interact receives submission
7. Parse modal values, save to submissions table
8. Post formatted message to configured channel
9. Mark prompts.submitted = true
```

### Slash Commands

**How IDs work**: Slack auto-converts mentions in command text:
- `@alice` → `<@U12345678>` (user ID)
- `#eng-standup` → `<#C12345678>` (channel ID)

Admins type human-readable names; bot parses the IDs from the payload.

```
/standup add @user daily-name
  → Parse user ID from <@U...> in text
  → Check admin permission
  → Add to participants table
  → Fetch user timezone from Slack API

/standup remove @user daily-name
  → Check admin permission
  → Remove from participants table

/standup list daily-name
  → Return all participants (display names fetched from Slack)

/standup digest daily-name
  → Fetch today's submissions for that daily
  → Format and DM to requester

/standup week daily-name
  → Fetch last 28 days of submissions
  → Calculate completion rates, aggregate blockers
  → Format and DM to requester
```

---

## Project Structure

```
standup-bot/
├── api/
│   ├── slack/
│   │   ├── commands.ts    # Slash command handler
│   │   └── interact.ts    # Button clicks, modal submissions
│   └── cron/
│       ├── prompt.ts      # Scheduled prompt job
│       └── cleanup.ts     # Weekly data retention cleanup
├── lib/
│   ├── slack.ts           # Slack API helpers
│   ├── db.ts              # Database queries
│   ├── config.ts          # Load/parse YAML config
│   ├── modal.ts           # Build Block Kit modals
│   └── format.ts          # Format messages for posting
├── config.yaml            # Dailies, schedules, admins
├── schema.sql             # Database schema
├── vercel.json            # Cron configuration
└── package.json
```

### vercel.json

```json
{
  "crons": [
    {
      "path": "/api/cron/prompt",
      "schedule": "*/30 * * * *"
    },
    {
      "path": "/api/cron/cleanup",
      "schedule": "0 3 * * 0"
    }
  ]
}
```

---

## Slack App Setup

### 1. Create App
- Go to api.slack.com/apps → Create New App
- Choose "From scratch"

### 2. OAuth Scopes (Bot Token)
```
chat:write
im:write
users:read
commands
```

### 3. Slash Commands
```
/standup → https://your-app.vercel.app/api/slack/commands
```

### 4. Interactivity
```
Request URL: https://your-app.vercel.app/api/slack/interact
```

### 5. Install to Workspace
- Install app, copy Bot Token
- Add to Vercel env vars: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`

---

## Environment Variables

```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
DATABASE_URL=postgres://...
```

---

## Cost Estimate

| Service | Free Tier | Expected Usage |
|---------|-----------|----------------|
| Vercel | 100K fn invocations/mo | ~5K/mo (20 users) |
| Neon Postgres | 3GB storage, 1 compute | < 100MB |
| **Total** | **$0/mo** | |

---

## Future Considerations (not v1)

- Cache Slack user data to reduce API calls
- Rate limiting for slash commands
- Audit log for admin actions
- Backup/export submissions

🏗️

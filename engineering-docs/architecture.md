# Omdim - Architecture

## Overview

Serverless architecture with multiple hosting options. Event-driven design with Slack webhooks and scheduled cron jobs.

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Slack     │────▶│  Serverless  │────▶│  Database   │
│  Webhooks   │     │  Functions   │     │  (Postgres) │
└─────────────┘     └──────────────┘     └─────────────┘
                           ▲
                           │
                    ┌──────┴──────┐
                    │  Cron Jobs  │
                    └─────────────┘
```

---

## Hosting Options (No Credit Card Required)

| Platform | Functions | Cron | Free Tier | Notes |
|----------|-----------|------|-----------|-------|
| **Vercel** | ✅ Native | ✅ 1 cron (we use 1) | 100K invocations/mo | Full support |
| **Netlify** | ✅ Native | ✅ Unlimited | 125K invocations/mo | Full support |
| **Cloudflare** | ✅ Workers | ✅ 2 crons (we use 1) | 100K requests/day | Fastest cold starts |
| **Supabase** | ✅ Edge Functions | ✅ pg_cron | 500K invocations/mo | DB + functions in one |

### Database Options

| Service | Free Tier | Notes |
|---------|-----------|-------|
| **Supabase** | 500MB, 2 projects | Postgres + Auth + Edge Functions |
| **Neon** | 3GB, 1 project | Serverless Postgres, auto-suspend |
| **PlanetScale** | 1 billion row reads/mo | MySQL (not Postgres) |

---

## Tech Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | Node.js / TypeScript | Best Slack SDK support, works on all platforms |
| Hosting | Vercel / Netlify / Cloudflare / Supabase | All have free tiers, no credit card |
| Database | Supabase / Neon (Postgres) | Free tier, serverless-friendly |
| Slack SDK | `@slack/web-api` | Official, lightweight |
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
/api/cron/digest       # Manager digests (daily at 2pm UTC, weekly on configured day)
```

### 2. Cron Jobs

| Job | Schedule | Action |
|-----|----------|--------|
| `prompt + digest` | Every 30 min | Check who needs prompting; send digests at configured time |
| `cleanup` | Daily at 3am UTC | Delete submissions and prompts older than 28 days |

> **Free tier note**: Cloudflare Workers free tier allows 2 cron triggers. We use just 1 cron (`*/30 * * * *`) for both prompts and digests, leaving a slot available. Digest time is configurable via `digest_time` in config.yaml (default: 14:00 UTC).

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

-- Track individual work items for analytics
CREATE TABLE work_items (
  id SERIAL PRIMARY KEY,
  slack_user_id TEXT NOT NULL,
  daily_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, done, dropped, carried
  carry_count INTEGER NOT NULL DEFAULT 0,
  completed_date DATE,
  snoozed_until DATE,  -- null = not snoozed, date = hidden from bottlenecks
  submission_id INTEGER REFERENCES submissions(id) ON DELETE SET NULL
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
    managers: ["U123", "U456"]      # Multiple managers for digests
    weekly_digest_day: "fri"        # sun/mon/tue/wed/thu/fri/sat
    bottleneck_threshold: 3         # Days before flagging carried items
    # Field order: lower numbers appear first in modal
    field_order:
      unplanned: 10
      today_plans: 20
      blockers: 30
    questions:
      - text: "How're you feeling?"
        required: false
        order: 5      # Before unplanned
      - text: "PRs needing review?"
        required: false
        order: 25     # Between today_plans and blockers

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
   - If has yesterday's plans: show each item with radio buttons
     (✅ Done / ➡️ Continue / ❌ Drop), defaulting to "Continue"
   - Add custom questions from config (sorted by order)
   - Add standard fields: unplanned, today_plans, blockers (sorted by order)
5. User fills form, submits
6. /api/slack/interact receives submission
7. Parse radio selections:
   - "Done" items → yesterdayCompleted
   - "Continue" items → yesterdayIncomplete (carried over)
   - "Drop" items → discarded
8. Save to submissions table
9. Post formatted message to configured channel
10. Mark prompts.submitted = true
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
omdim/
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

### wrangler.toml (Cloudflare Workers)

```toml
[triggers]
crons = ["*/30 * * * *", "0 14 * * *"]
# First cron: prompt job every 30 min
# Second cron: digest job at 2pm UTC daily (handles both daily + weekly digests)
```

### vercel.json (Alternative)

```json
{
  "crons": [
    { "path": "/api/cron/prompt", "schedule": "*/30 * * * *" },
    { "path": "/api/cron/digest", "schedule": "0 14 * * *" },
    { "path": "/api/cron/cleanup", "schedule": "0 3 * * 0" }
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

All platforms support this bot on free tier:

| Setup | Functions | Database | Cost |
|-------|-----------|----------|------|
| Vercel + Neon | 100K/mo | 3GB | $0 |
| Vercel + Supabase | 100K/mo | 500MB | $0 |
| Netlify + Supabase | 125K/mo | 500MB | $0 |
| Cloudflare + Neon | 100K/day | 3GB | $0 |
| Supabase (all-in-one) | 500K/mo | 500MB | $0 |

Expected usage for 20 users: ~5K function calls/month, <100MB storage

---

## Future Considerations (not v1)

- Cache Slack user data to reduce API calls
- Rate limiting for slash commands
- Audit log for admin actions
- Backup/export submissions

🏗️

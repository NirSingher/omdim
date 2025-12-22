# Omdim - Implementation Plan

## Prerequisites

### Slack App
- [x] Create Slack app at api.slack.com/apps

### Hosting Platform (choose one - all free, no credit card)
- [ ] **Vercel** - vercel.com
- [x] **Cloudflare Workers** - cloudflare.com
- [ ] **Netlify** - netlify.com
- [ ] **Supabase Edge Functions** - supabase.com

### Database (choose one - all free, no credit card)
- [ ] **Supabase Postgres** - 500MB free
- [x] **Neon Postgres** - 3GB free

### Environment Variables
- [x] Configure `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `DATABASE_URL`

---

## Step 1: Project Scaffold ✅

- [x] Initialize project with TypeScript (`package.json`, `tsconfig.json`)
- [x] Install dependencies: `@slack/web-api`, `pg`, `yaml`
- [x] Create folder structure (`api/`, `lib/`)
- [x] Set up database connection (`lib/db.ts`)
- [x] Create schema.sql
- [x] Create Cloudflare Workers entry point (`api/index.ts`)
- [x] Create health endpoint (`api/health.ts`)
- [x] Create platform configs (`wrangler.toml`, `vercel.json`)
- [x] Run schema.sql on database

**🧪 Checkpoint 1**: ✅ Deploy to chosen platform, verify `/api/health` returns 200

---

## Step 2: Config Loading ✅

- [x] Create `config.yaml.example` with test daily and schedule
- [x] Copy to `config.yaml` and customize
- [x] Implement `lib/config.ts` to parse YAML
- [x] Validate config structure on load
- [x] Set up local Docker PostgreSQL for development

**🧪 Checkpoint 2**: ✅ Log loaded config on deploy, verify structure

---

## Step 3: Slack Auth & Slash Command Base ✅

- [x] Implement request signature verification (`lib/slack.ts`)
- [x] Create `/api/slack/commands` endpoint in `api/index.ts`
- [x] Parse command text, route to handlers
- [x] Respond with ephemeral acknowledgment

**🧪 Checkpoint 3**: ✅ `/standup help` returns usage text in Slack

---

## Step 4: Admin Commands ✅

- [x] Implement `/standup add @user daily-name`
  - Parse user ID from mention
  - Check admin permission
  - Insert into participants table
- [x] Implement `/standup remove @user daily-name`
- [x] Implement `/standup list daily-name`

**🧪 Checkpoint 4**: ✅ Add/remove/list users via Slack, verify in DB

---

## Step 5: Prompt Cron Job ✅

- [x] Create prompt handler in `api/index.ts`
- [x] Fetch participants with their schedules
- [x] Get user timezone from Slack API
- [x] Determine who needs prompting (workday + time + not submitted)
- [x] Send DM with "Open Standup" button
- [x] Record prompt in `prompts` table

**🧪 Checkpoint 5**: ✅ Trigger cron manually, receive DM with button

---

## Step 6: Standup Modal ✅

- [x] Handle button clicks in `/api/slack/interact`
- [x] Implement `lib/modal.ts` to build Block Kit modal
- [x] Fetch yesterday's submission for pre-fill
- [x] Build modal with:
  - Checkboxes for yesterday's plans
  - Text input for unplanned completions
  - Text input for today's plans (pre-filled with incomplete)
  - Text input for blockers
  - Custom questions from config

**🧪 Checkpoint 6**: ✅ Click button, modal opens with correct fields

---

## Step 7: Submission Handling ✅

- [x] Handle modal submission in `/api/slack/interact`
- [x] Parse checkbox values and text inputs (one item per line)
- [x] Save to `submissions` table
- [x] Mark `prompts.submitted = true`

**🧪 Checkpoint 7**: ✅ Submit modal, verify data in DB

---

## Step 8: Channel Posting ✅

- [x] Implement `lib/format.ts` to format standup message
- [x] Post to configured channel after submission
- [x] Store `slack_message_ts` in submission record

**🧪 Checkpoint 8**: ✅ Submit standup, see formatted post in channel

---

## Step 9: Reminder Loop ✅

- [x] Update cron to check `last_prompted_at`
- [x] Re-prompt users who haven't submitted and were prompted >30 min ago
- [x] Stop prompting after submission

**🧪 Checkpoint 9**: ✅ Implemented in `lib/prompt.ts` - `shouldReprompt()` checks 30-min interval

---

## Step 10: Digests ✅

- [x] Implement `/standup digest daily-name`
  - Query today's submissions
  - Format summary
  - DM to requester
- [x] Implement `/standup week daily-name`
  - Query last 7 days
  - Calculate completion rates
  - Aggregate blockers
  - DM to requester

**🧪 Checkpoint 10**: ✅ Request digest, receive formatted DM

---

## Step 11: Data Cleanup ✅

- [x] Implement cleanup in `/api/cron/cleanup` endpoint
- [x] Delete submissions older than 28 days
- [x] Delete prompts older than 28 days
- [x] Add cron schedule to platform config (`wrangler.toml` / `vercel.json`)

**🧪 Checkpoint 11**: ✅ Cleanup logic implemented in both HTTP endpoint and scheduled handler

---

## Step 12: First-Day Handling ✅

- [x] Detect when user has no previous submission
- [x] Skip "Yesterday's plans" section in modal
- [x] Handle empty pre-fill gracefully

**🧪 Checkpoint 12**: ✅ Modal checks `isFirstDay` and omits yesterday section

---

## Step 13: Edge Cases & Polish ✅

- [x] Handle user not in any daily (cron only processes participants)
- [x] Handle invalid daily name in commands (`getDaily()` check returns error)
- [x] Handle Slack API errors gracefully (try/catch in all handlers)
- [x] Add logging for debugging (console.log throughout)
- [x] Test timezone edge cases (uses user's tz_offset from Slack)

**🧪 Checkpoint 13**: ✅ Error scenarios return friendly messages

---

## Step 14: Digest Enhancements ✅

### Phase 1: Multiple Managers + Config ✅
- [x] Add `managers` array support (backward compatible with single `manager`)
- [x] Add `weekly_digest_day` config (default: friday)
- [x] Add `bottleneck_threshold` config (default: 3 days)
- [x] Update digest sending to iterate all managers

### Phase 2: Bottleneck Detection ✅
- [x] Add `snoozed_until` column to `work_items` table
- [x] Implement `getBottleneckItems()` - items carried 3+ days
- [x] Implement `getHighDropUsers()` - users with >30% drop rate
- [x] Implement `snoozeItem()` - hide item from bottlenecks temporarily
- [x] Format bottleneck section in digest

### Phase 3: Team Rankings ✅
- [x] Implement `getTeamRankings()` with scoring formula:
  ```
  Score = (Participation × 30) + (Completion × 25) + (Items × 0.5)
          - (Avg Carry Days × 5) - (Drop Penalty 10) - (Blocker Days × 2)
  ```
- [x] Add rankings section to weekly/4-week digests (not daily - too noisy)
- [x] Display medals (🥇🥈🥉) for top 3

### Phase 4: Trend Analysis ✅
- [x] Implement `getPeriodStats()` for comparison
- [x] Add trend indicators (↑↓→) to participation/completion rates
- [x] Compare current period to previous period

### Phase 5: Work Alignment Placeholder ✅
- [x] Add `integrations` config schema (github, linear)
- [x] Display "Not configured" placeholder in digest
- [x] Show enabled integrations when configured

### Phase 6: Snooze Button Interaction ✅
- [x] Add snooze button to bottleneck items in digest
- [x] Handle snooze interaction in `/api/slack/interact`
- [x] Allow 7-day snooze per item

**🧪 Checkpoint 14**: ✅ All phases complete. Automated digests sent to all managers at 2pm UTC with rankings, bottlenecks with interactive snooze buttons, drop rate alerts, trend indicators (↑↓→), and work alignment placeholder.

---

## Final Validation

- [x] End-to-end test with 2+ users
- [x] Test both schedules (different workdays)
- [x] Verify channel posts are formatted correctly
- [x] Verify digests include all submissions
- [x] Monitor platform logs for errors

---

📋

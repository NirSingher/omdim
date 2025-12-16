# Standup Bot - Implementation Plan

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

## Step 5: Prompt Cron Job

- [ ] Create `/api/cron/prompt.ts`
- [ ] Fetch participants with their schedules
- [ ] Get user timezone from Slack API
- [ ] Determine who needs prompting (workday + time + not submitted)
- [ ] Send DM with "Open Standup" button
- [ ] Record prompt in `prompts` table

**🧪 Checkpoint 5**: Trigger cron manually, receive DM with button

---

## Step 6: Standup Modal

- [ ] Create `/api/slack/interact.ts` for button clicks
- [ ] Implement `lib/modal.ts` to build Block Kit modal
- [ ] Fetch yesterday's submission for pre-fill
- [ ] Build modal with:
  - Checkboxes for yesterday's plans
  - Text input for unplanned completions
  - Text input for today's plans (pre-filled with incomplete)
  - Text input for blockers
  - Custom questions from config

**🧪 Checkpoint 6**: Click button, modal opens with correct fields

---

## Step 7: Submission Handling

- [ ] Handle modal submission in `/api/slack/interact.ts`
- [ ] Parse checkbox values and text inputs
- [ ] Save to `submissions` table
- [ ] Mark `prompts.submitted = true`

**🧪 Checkpoint 7**: Submit modal, verify data in DB

---

## Step 8: Channel Posting

- [ ] Implement `lib/format.ts` to format standup message
- [ ] Post to configured channel after submission
- [ ] Store `slack_message_ts` in submission record

**🧪 Checkpoint 8**: Submit standup, see formatted post in channel

---

## Step 9: Reminder Loop

- [ ] Update cron to check `last_prompted_at`
- [ ] Re-prompt users who haven't submitted and were prompted >30 min ago
- [ ] Stop prompting after submission

**🧪 Checkpoint 9**: Don't submit, receive reminder after 30 min

---

## Step 10: Digests

- [ ] Implement `/standup digest daily-name`
  - Query today's submissions
  - Format summary
  - DM to requester
- [ ] Implement `/standup week daily-name`
  - Query last 28 days
  - Calculate completion rates
  - Aggregate blockers
  - DM to requester

**🧪 Checkpoint 10**: Request digest, receive formatted DM

---

## Step 11: Data Cleanup

- [ ] Create `/api/cron/cleanup.ts`
- [ ] Delete submissions older than 28 days
- [ ] Delete prompts older than 28 days
- [x] Add cron schedule to platform config (`wrangler.toml` / `vercel.json`)

**🧪 Checkpoint 11**: Insert old test data, trigger cleanup, verify deleted

---

## Step 12: First-Day Handling

- [ ] Detect when user has no previous submission
- [ ] Skip "Yesterday's plans" section in modal
- [ ] Handle empty pre-fill gracefully

**🧪 Checkpoint 12**: New user submits standup without yesterday section

---

## Step 13: Edge Cases & Polish

- [ ] Handle user not in any daily
- [ ] Handle invalid daily name in commands
- [ ] Handle Slack API errors gracefully
- [ ] Add logging for debugging
- [ ] Test timezone edge cases (DST, etc.)

**🧪 Checkpoint 13**: Error scenarios return friendly messages

---

## Final Validation

- [ ] End-to-end test with 2+ users
- [ ] Test both schedules (different workdays)
- [ ] Verify channel posts are formatted correctly
- [ ] Verify digests include all submissions
- [ ] Monitor platform logs for errors

---

📋

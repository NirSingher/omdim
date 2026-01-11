# User-Initiated Daily - Implementation Plan

## Overview

Allow users to initiate their own daily standup via `/daily` command or App Home button. If today's daily is already submitted, open modal for tomorrow (posts at scheduled time).

---

## Step 1: Schema - Add Posted Flag ✅

- [x] Add `posted` column to submissions table
- [x] Default `TRUE` for backward compatibility (existing submissions are already posted)
- [x] Update schema.sql for new deployments
- [x] Create migration script: `scripts/migrate-posted.ts`
- [x] Update `lib/db.ts`: Submission interface, saveSubmission, getSubmissionForDate, getUnpostedSubmissions, markSubmissionPosted

```sql
ALTER TABLE submissions ADD COLUMN posted BOOLEAN DEFAULT TRUE;
```

**🧪 Checkpoint 1**: Migration runs, `posted` column exists with default `TRUE`

---

## Step 2: `/daily` Slash Command ✅

- [x] Add `/daily` command handler in `lib/handlers/commands.ts` (`handleDaily`)
- [x] Get user's dailies (reuse `getUserDailies`)
- [x] Check if today's submission exists (`getSubmissionForDate`)
- [x] If no submission → open modal for today
- [x] If submitted → check for scheduled tomorrow submission
- [x] Open modal with correct mode and pre-fill data
- [x] Add `getSubmissionForDate` query to `lib/db.ts` (done in Step 1)
- [x] Update modal builder to accept `mode` parameter
- [x] Store mode and targetDate in private_metadata
- [x] Update `api/index.ts` to route `/daily` command

**Files:** `lib/handlers/commands.ts`, `lib/modal.ts`, `api/index.ts`

**🧪 Checkpoint 2**: `/daily` opens modal for today; if today done, opens for tomorrow

---

## Step 3: Modal Tomorrow Mode ✅

- [x] Add `mode: 'today' | 'tomorrow'` parameter to `buildStandupModal` (done in Step 2)
- [x] Update title to show target date (e.g., "Tomorrow's Standup")
- [x] Store mode in `private_metadata` (done in Step 2)
- [x] Accept optional `SubmissionPrefill` for editing scheduled submissions
- [x] Pre-fill `today_plans` and `unplanned` fields when editing
- [x] Update label to "Tomorrow's plans" when in tomorrow mode
- [x] Yesterday section still included (uses today's submission as "yesterday")

**Files:** `lib/modal.ts`, `lib/handlers/commands.ts`

**Note:** Slack's `rich_text_input` doesn't support initial values, so `blockers` and custom questions cannot be pre-filled.

**🧪 Checkpoint 3**: Modal shows correct date in title, includes yesterday section

---

## Step 4: Submission Handler - Tomorrow Mode ✅

- [x] Parse `mode` and `targetDate` from `private_metadata`
- [x] Detect `mode: 'tomorrow'` and use `targetDate` for submission date
- [x] Save with `date = tomorrow`, `posted = false`
- [x] Send confirmation DM with scheduled time (instead of posting to channel)
- [x] Skip marking prompt as submitted (it's for tomorrow)
- [x] Skip work item tracking (will happen when posted)
- [x] On re-submit: upsert works via `saveSubmission` ON CONFLICT clause

**Files:** `lib/handlers/interactions.ts`

**🧪 Checkpoint 4a**: Tomorrow submission saves with `posted=false`, confirmation DM shows scheduled time
**🧪 Checkpoint 4b**: Re-opening `/daily` after scheduling pre-fills modal, re-submit updates

---

## Step 5: Scheduled Post Cron ✅

- [x] Add `runScheduledPosts` function to `lib/prompt.ts`
- [x] Add `hasScheduledTimePassed` helper function
- [x] Query all unposted submissions (timezone filtering done in code)
- [x] For each: check date matches user's today, scheduled time has passed
- [x] Check OOO status - if OOO, mark as posted (cancelled) and skip
- [x] Post to channel using `postStandupToChannel`
- [x] Mark as posted with message timestamp
- [x] Track work items (markItemsDone, incrementCarryCount, createWorkItems)
- [x] Update `getUnpostedSubmissions` to return all unposted (no date filter)
- [x] Call from existing 30-min cron in `api/index.ts`

**Files:** `lib/prompt.ts`, `lib/db.ts`, `api/index.ts`

**🧪 Checkpoint 5**: Scheduled submissions post at user's scheduled time, OOO respected

---

## Step 6: App Home Tab ✅

- [x] Create `lib/handlers/home.ts` with `buildHomeView` and `handleAppHomeOpened`
- [x] Build Home view with "Start Daily" / "Fill Tomorrow" button for each daily
- [x] Show status: ✅ Today done, 📅 Tomorrow scheduled, ⏳ Not submitted
- [x] Add `publishHomeView` function to `lib/slack.ts`
- [x] Add `/api/slack/events` endpoint to `api/index.ts`
- [x] Handle `app_home_opened` event (including URL verification challenge)
- [x] Add `home_start_daily` button handler in `interactions.ts`
- [x] Button triggers same modal flow as `/daily` (today/tomorrow logic)

**Files:** `lib/handlers/home.ts` (new), `lib/slack.ts`, `lib/handlers/interactions.ts`, `api/index.ts`

**Slack App Config:**
1. Enable App Home tab
2. Subscribe to `app_home_opened` event → `/api/slack/events`

**🧪 Checkpoint 6**: App Home shows button per daily, clicking opens correct modal

---

## Step 7: Slack App Config ✅

- [x] Add `/daily` slash command → `/api/slack/commands`
- [x] Enable Home Tab in app settings
- [x] Subscribe to Events API: `app_home_opened`
- [x] Update Request URL for events endpoint

**🧪 Checkpoint 7**: All Slack integrations working end-to-end ✅

---

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| User fills tomorrow, opens `/daily` again | Modal opens pre-filled, re-submit overwrites |
| User fills tomorrow, scheduled time passes | Post at user's scheduled time (per timezone) |
| User fills tomorrow, then sets OOO | Skip post (OOO checked at posting time) |
| User is in multiple dailies | Show picker (same as current prompt) |
| Tomorrow is not a workday | Still allow (user explicitly chose to) |
| User fills "tomorrow" near midnight | Use date calculated at submission time |

---

✌️

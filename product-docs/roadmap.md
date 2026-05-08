# Omdim Roadmap

## Shipped

### MVP ✅
See `requirements.md` and `architecture.md`

### Testing Infrastructure ✅
- [x] Unit tests for core logic (modal building, formatting, date/timezone)
- [x] Integration tests for Slack payload parsing
- [x] Mock Slack API responses for handler testing

### Automated Digests ✅
- [x] Scheduled daily digest at 2pm UTC
- [x] Scheduled weekly digest on configurable day per-daily
- [x] Multiple managers per daily
- [x] Bottleneck detection (carried items, high drop rates)
- [x] Snooze button for bottleneck items (7-day snooze via interactive button)
- [x] Compact "Option C" digest format (action-first, ~15 lines)
- [x] `/standup report <daily> [day|week|month]` - full report with individual breakdowns
- [x] Team rankings (moved to full report command)

### Out of Office (OOO) ✅
- [x] `/standup ooo tomorrow` - skip next prompt
- [x] `/standup ooo 2024-12-25 to 2025-01-02` - date range
- [x] `/standup ooo clear` - cancel OOO
- [x] `/standup ooo` - show current OOO status
- [x] Show OOO status in `/standup list`
- [x] Skip prompts and exclude from "missing" stats during OOO

### "All Dailies" Support ✅
- [x] Support `all` as daily name in commands (e.g., `/standup digest all`)
- [x] Runs command for each defined daily sequentially
- [x] Combines output into single response where appropriate
- [x] Works with: `prompt`, `digest`, `report`, `list`

### GitHub Integration ✅

**User Linking**
- [x] Link GitHub username to Slack user (config `user_mapping` + self-service `/link github`)
- [x] App Home linked accounts section with link/unlink buttons

**PR Review Tracking**
- [x] Fetch open PRs by category: draft, awaiting review, ready to merge, review requests
- [x] PR checkboxes in standup modal (pre-checked, grouped by category)
- [x] Reviewer tagging in standup messages (`<@U123>` for mapped users)
- [x] Unmapped reviewer dropdowns in modal for self-service linking
- [x] Stale review detection (>3 days) in manager digest
- [x] Review load analytics (pending reviews per team member) in digest
- [x] PR re-review detection after updates since last review

### Linear Integration ✅
- [x] Fetch assigned issues from current cycle (active + upcoming)
- [x] Linear ticket checkboxes in standup modal (pre-checked)
- [x] Link Linear user to Slack user (config `user_mapping` + self-service `/link linear`)
- [x] App Home linked accounts section with link/unlink buttons
- [x] Auto-detect completed Linear tickets

### Send Daily Back to Submitter ✅
- [x] DM copy of standup post to submitter after submission
- [x] Per-user opt-out toggle via App Home

### App Home Enhancements ✅
- [x] Linked accounts section with link/unlink buttons
- [x] Daily status with PR and Linear ticket summaries
- [x] Enriched stats: planned, carried over, and dropped counts

### Stats & Analytics (Partially Done)
- [x] Completion rates by user/team
- [x] Average items per standup (planned vs completed)
- [x] Blocker frequency
- [x] Trend comparison to previous period (↑↓→ indicators)

### Alerts & Thresholds (Partially Done)

| Alert | Trigger | Action | Status |
|-------|---------|--------|--------|
| Carry-over streak | Same item carried 3+ days | Shown in digest | ✅ Done |
| High drop rate | >30% drops | Flagged in digest | ✅ Done |
| Missing standups | Not submitted today | Shown in daily digest | ✅ Done |

### In-Progress Status (Partial)
- [x] "In Progress" status option for yesterday's items in standup modal
- [x] In-progress items persisted in DB

### Plan Size Warning (First Version) ✅
- [x] Global `max_plan_items` config (default: 5, set to 0 to disable)
- [x] Soft warning banner shown inside the standup modal when carry-over + in-progress + prefill today plans meet the threshold
- [x] Post-submit DM when the submitted plan count meets the threshold
- [x] Static warning copy; non-blocking; not dismissible
- [x] Counts all plan items regardless of source (manual, PR, Linear)

### App Home: Today's Plans ✅
- [x] Show today's submitted plan items in the App Home tab (done / in-progress / planned / carried / dropped)
- [x] DM copy defaults to off — App Home is the primary place to review your plan
- [x] DM copy toggle still available in Preferences for users who prefer it
- [x] App Home refreshes after submission so user sees plan immediately
- [x] Source context per item (PR link, Linear ticket identifier) shown inline

### Standup Modal Reorganization ✅
- [x] Yesterday items grouped by source: manual → PR → Linear (with section headers when mixed)
- [x] Clearer section headers: "✍️ Manual items", "📦 PR items", "🎫 Linear items"
- [x] Context hints on PR and My PR sections explaining what each shows
- [x] Reduced cognitive load through visual separation between source types

### Readable Standup Post ✅
- [x] Integration items enriched with clickable links: PR items link to GitHub, Linear items to Linear
- [x] Source icons: 📦 for PRs, 🎫 for Linear tickets; manual items unchanged
- [x] Reader can tell at a glance where each item came from

### Report OOO to Daily ✅
- [x] Post OOO notice to daily channel when a user's OOO period begins (at digest time)
- [x] Include OOO users in the daily digest (e.g., "Out today: @alice, @bob")
- [x] Show return date alongside name
- [ ] Optional per-daily toggle in config (deferred to Dynamic Configuration)

---

### Schedule-Aware Prompting ✅
- [x] Read `schedule` config per-daily to determine working days
- [x] Skip cron-triggered prompts on off-days (e.g., weekends)
- [x] OOO and off-day logic combined: neither prompts nor counts as "missing"
- [x] `/standup force-prompt` still works on off-days (manual override)
- [x] Daily digest and OOO channel notices skip off-days (timezone-aware)

---

### Visual Polish ✅
- [x] ✅ for completed items (was ☑️)
- [x] ➡️ for carried-over items (was ⬜)
- [x] ❌ for dropped items (unchanged)
- [x] 🎯 for new plan items, ⚡ for unplanned items (was ☑️)
- [x] Consistent emoji across standup post, App Home, and DM

### Plan Size Warning (Follow-on) ✅
- [x] Per-daily override: `max_plan_items` in daily config
- [ ] Live validation (deferred — Slack modal limitations)
- [x] Digest surfacing for users who routinely over-plan (avg plan count in team section)
- [x] Distinguish net-new vs carried-over items in the count (breakdown in warning DM + modal)

---

### Team Summary Post ✅
- [x] Post channel-level summary at digest time
- [x] One line per person: name + top 1–2 plan items
- [x] Blockers called out in a separate section
- [x] Each line links to the person's full standup post (↗)
- [x] Opt-in per-daily via `team_summary: true` config

---

### CI Pipeline ✅
- [x] GitHub Actions workflow: type check + test on push/PR to main and dev

---

### User Settings Pane ✅
- [x] Max items shown per list (PRs, Linear tickets) — per-user `max_items` setting
- [x] OOO management UI (set/clear from App Home via date picker modal)
- [x] Per-Linear-team filter: `linear_team_filter` setting
- [x] Stale PR threshold override: `stale_pr_days` setting (default 3)
- [x] Consolidated all settings under "⚙️ Settings" section in App Home

### In-Progress Item Tracking (Full) ✅
- [x] In-progress items auto-carry to today (no re-prompting needed)
- [x] Track consecutive in-progress days per item in DB (`carry_count` increments daily)
- [x] Items in-progress for 3+ days flagged as "needs attention" in digest (`🔄`) and report
- [x] Visual indicator in standup post: `🔄 Day X` / `⚠️ Day X — needs attention`

---

### Dynamic Configuration ✅
- [x] Hot-reload config changes without redeploying (DB overrides loaded per-request)
- [x] Pause/resume dailies: `/standup pause <daily>` / `/standup resume <daily>`
- [x] Admin command to reload config: `/standup config reload`
- [x] Store config overrides in DB (`config_overrides` table, takes precedence over YAML)
- [x] Paused dailies shown with ⏸️ in `/standup list`

### Force Prompt Command (Full) ✅
- [x] `/standup force-prompt <daily>` - force prompt yourself
- [x] `/standup prompt all <daily>` - admin command to prompt all participants
- [x] Confirmation modal before mass-prompting (shows participant count)
- [x] Summary DM: "Sent prompts to 7 users in daily-il"

---

### Admin Management ✅
- [x] `/standup admin add @user` - add admin (super-admin only)
- [x] `/standup admin remove @user` - remove admin
- [x] `/standup admin list` - show all admins (super-admins + DB admins)
- [x] Super-admins defined in config (can manage other admins)
- [x] DB admins stored via `config_overrides` table
- [x] `/standup manager add <daily> @user` - admin assigns a daily manager
- [x] `/standup manager remove <daily> @user` - admin removes a daily manager
- [x] `/standup manager list <daily>` - show managers for a daily
- [x] Daily managers merged from YAML + DB (deduplicated)

---

### Remaining Stats & Analytics ✅
- [x] Blocker streak tracking: consecutive days with blockers per user, surfaced in digest (🚧) and full report
- [x] Unplanned overload alert: flag users with >70% unplanned work (⚡) in digest and report
- [x] Unplanned rate trend comparison in full report Period Trends section
- ~~Trend visualization (sparklines in Slack?)~~ — Skipped: Slack Block Kit doesn't support sparklines; existing ↑↓→ indicators are sufficient

---

### GitHub PR Filtering ✅
- [x] Exclude PRs where reviewer already commented/reviewed and PR not updated since (ball in author's court)
- [x] Hide PRs already approved by someone else (no action needed)
- [x] "Ball in court" heuristic: reviewer's latest review timestamp vs PR's `updated_at`
- [x] Fail-open design: if reviews can't be fetched, PR stays visible
- [x] Extracted `fetchPRReviews()` helper, shared by review-request filtering and re-review detection

---

### Linear Enhancements ✅
- [x] Mark issues as "in progress" when selected as today's plan in standup modal
- [x] Auto-resolve identifiers to Linear issue UUIDs via GraphQL API
- [x] Fetch team workflow states to find correct "started" state ID
- [x] Link blockers to Linear issues: extract references (e.g., ENG-123) from blockers text, post comment on the Linear issue
- [x] Fire-and-forget: non-blocking, wrapped in try/catch so submission never fails due to Linear errors
- [x] Full test coverage: 52 tests for all new Linear functions

### App Home: Today's Tasks Management ✅
- [x] Interactive task list in App Home with per-item overflow menus (done / in-progress / drop)
- [x] Quick-add new items via modal (triggered by "Add Item" button)
- [x] Mark items done / in-progress / drop from App Home
- [x] Source tags shown per item (manual, PR, Linear)
- [x] Real-time sync: changes in App Home update the standup post in the channel via chat.update
- [x] Backward compat: JSONB fallback for submissions without work_item records
- [ ] Full integration context (live PR status, Linear ticket state) — deferred
- [ ] Bidirectional sync from channel post edits — deferred (Slack limitation)

### Linear Intelligence ✅

**Cross-Reference Plans vs Linear**
- [x] Match plan items to assigned Linear issues (source_ref exact match + text regex fallback)
- [x] Flag in digest: "Plans not in Linear" and "Linear items not in plans"
- [x] Gated on `intelligence.enabled: true` in daily config
- [x] GitHub PR items excluded from "plans not in Linear"
- [ ] Weekly report: plan-to-Linear alignment score per user — deferred
- [ ] Configurable strictness: `off` / `soft` / `strict` — deferred

**Priority Alignment Reporting**
- [x] Compare active standup items against Linear priority ordering
- [x] Digest: per-user alignment summary (on-track / off-track)
- [x] Flags Urgent (P1) and High (P2) issues missing from plans
- [ ] Individual DM: alignment report to off-track individuals — deferred

**Auto-Update Items from Linear Status**
- [x] Webhook endpoint (`POST /api/webhooks/linear`) for Linear status change events
- [x] HMAC-SHA256 signature verification
- [x] Auto-mark standup items Done/In Progress based on Linear state
- [x] Notify user in DM when auto-updates happen
- [x] Update channel post and refresh App Home after auto-update
- [x] Gated on `intelligence.auto_update` config per-daily

### GitHub Work Alignment ✅
- [x] Compare "today's plans" keywords to merged PR titles (keyword overlap matching)
- [x] Surface misalignment in manager digest: "plans without matching PRs" and "merged PRs unplanned"
- [x] Auto-populate yesterday's work from merged PRs in standup modal
- [x] GitHub Search API integration (`is:pr is:merged author:X org:Y`)
- [x] Config: `intelligence.github.work_alignment` and `auto_populate` per-daily
- [x] Dedup merged PRs against existing yesterday items by source_ref
- [x] Cap auto-populated merged PRs at 5 (modal block limit)

---

## Up Next

### Blocker @-Mention Notifications ✅
- [x] Detect `<@U...>` mentions in blocker text, DM mentioned participants
- [x] Skip self-mentions and non-participants
- [x] Today-mode only (no DMs for queued/tomorrow submissions)

### Nudge Reminder ✅
- [x] Per-daily `nudge_minutes_before` config (0 to disable, default 0)
- [x] DM participants who haven't submitted, N minutes before digest time
- [x] Respect OOO, paused dailies, non-workdays

### Standup Templates
- [ ] Per-daily `sections` config: toggle `blockers` and `unplanned` on/off
- [ ] `today_plans` and `yesterday` always shown (locked)
- [ ] Backward compatible defaults (all sections on)

### Weekly Personal Recap DM
- [ ] Friday DM to each participant: completed, carried, dropped, merged PRs, blockers
- [ ] Per-daily `weekly_recap` config (default true)
- [ ] Piggyback on existing weekly digest cron

### Edit After Submit
- [ ] "Edit Standup" button on channel post and App Home
- [ ] Reopen modal pre-filled with today's plans/unplanned
- [ ] Work item reconciliation on re-submit, channel post updated in place

---

## Later

### Performance & Scaling
- [ ] Cache user profiles (display name, timezone) in DB
- [ ] Rate limit slash commands per user (e.g., 10/min)

### Configurable Digest & Report Cadence
- [ ] `digest_schedule` config: cron-like or named cadence (e.g., `daily@14:00`, `every_other_day`)
- [ ] `report_schedule` config: cadence for full report (e.g., `weekly@fri`, `biweekly@fri`)
- [ ] Both respect the daily's timezone/schedule context
- [ ] Backward compatible: defaults to current behavior if not set

### Flexible Digest & Report Recipients
- [ ] `managers` list expanded: any Slack user, not just participants
- [ ] Admin-assigned via `/standup manager add <daily> @user`
- [ ] DB-stored manager list (supplements config `managers`)
- [ ] `digest_recipients` and `report_recipients` config arrays per daily (optional override)
- [ ] Self-subscribe command: `/standup subscribe <daily> digest|report`

---

## Future Considerations

- Analytics dashboard (web UI with Slack OAuth)
- Manager dashboard
- AI-generated standup summaries
- Mobile-friendly standup submission
- Drizzle ORM for type-safe queries and migrations

---

## Open Questions

1. **Alerts**: DM only or also post to a manager channel?
2. **Stats**: Store aggregated stats or compute on-demand?
3. **In-progress threshold**: Is 3 days the right default, or should it be configurable per-daily?
4. ~~**Linear sync direction**: Webhook vs polling?~~ → TBD when we get there
5. ~~**Priority misalignment**: Block submission or advisory?~~ → Advisory only (decided)

🗺️

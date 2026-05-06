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

## Up Next

### Team Summary Post
Post a single consolidated summary to the daily channel with the key items from each team member's standup.

- [ ] After all standups are in (or at digest time), post a channel-level summary
- [ ] One line per person: name + top 1–2 items (highest-signal plans or blockers)
- [ ] Blockers called out in a separate section so they're impossible to miss
- [ ] Linkable: each person's line links to their full standup post in the thread
- [ ] Configurable per-daily: opt-in via config toggle

### CI Pipeline
- [ ] GitHub Actions for automated test runs

---

## Planned

### User Settings Pane
Per-user self-service configuration in App Home (consolidates existing toggles + new controls).

- [ ] Max items shown per list (PRs, Linear tickets) — in modal and standup post
- [ ] OOO management UI (set/clear from App Home, currently command-only)
- [ ] Per-Linear-team filter: which teams' cycles to include
- [ ] Stale PR threshold override (default 3 days)
- [ ] Consolidate existing DM-copy opt-out toggle into Settings section

### In-Progress Item Tracking (Full)
Build on the existing in-progress status to add smart carry-over and attention flagging.

- [ ] In-progress items auto-carry to today (no re-prompting needed)
- [ ] Track consecutive in-progress days per item in DB
- [ ] Items in-progress for 3+ days flagged as "needs attention" in digest and report
- [ ] Visual indicator in standup post (e.g., 🔄 Day 3)

### Dynamic Configuration
- [ ] Hot-reload config changes without redeploying
- [ ] Pause/resume dailies via config flag (`enabled: false`)
- [ ] Admin command to reload config: `/standup config reload`
- [ ] Store config overrides in DB (takes precedence over YAML)

### Force Prompt Command (Full)
- [x] `/standup force-prompt <daily>` - force prompt yourself
- [ ] `/standup prompt all <daily>` - admin command to prompt all participants
- [ ] Confirmation step before mass-prompting
- [ ] Show summary: "Sent prompts to 7 users"

### Admin Management
- [ ] `/standup admin add @user` - add admin (super-admin only)
- [ ] `/standup admin remove @user` - remove admin
- [ ] `/standup admin list` - show all admins
- [ ] Define super-admins in config (can manage other admins)
- [ ] `/standup manager add <daily> @user` - admin assigns a daily manager
- [ ] `/standup manager remove <daily> @user` - admin removes a daily manager
- [ ] `/standup manager list <daily>` - show managers for a daily
- [ ] Daily managers receive digest and report without being reporters

### Remaining Stats & Analytics
- [ ] Blocker resolution time tracking
- [ ] Trend visualization (sparklines in Slack?)
- [ ] Unplanned overload alert (>70% unplanned work)

### GitHub PR Filtering
- [ ] Exclude PRs where user has commented and is awaiting author response
- [ ] Only show review requests that actually need the user's action
- [ ] Detect "ball in their court" vs "ball in your court" via comment recency

### Linear Enhancements
- [ ] Mark issues as "in progress" when added to standup
- [ ] Link blockers to Linear issues

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

### App Home: Today's Tasks Management
View and manage today's standup items directly from the App Home tab.

- [ ] Show today's planned items as an editable list in App Home
- [ ] Quick-add new items inline
- [ ] Mark items done / in-progress / drop from App Home
- [ ] Show integration context (linked PR status, Linear ticket state) alongside each item
- [ ] Real-time sync: changes in App Home reflect in the standup post (and vice versa)

### GitHub Work Alignment
- [ ] Compare "today's plans" keywords to commit messages/PR titles
- [ ] Surface misalignment: "You said X but worked on Y"
- [ ] Auto-populate yesterday's work from commits

### Linear Intelligence

**Cross-Reference Plans vs Linear**
- [ ] Match plan items to assigned Linear issues (fuzzy title match + issue ID)
- [ ] Flag in digest: "Plans not in Linear" and "Linear items not in plans"
- [ ] Weekly report: plan-to-Linear alignment score per user
- [ ] Configurable strictness: `off` / `soft` / `strict`

**Auto-Update Items from Linear Status**
- [ ] Webhook or poll for Linear status changes on linked issues
- [ ] Auto-mark standup items Done/In Progress based on Linear state
- [ ] Notify user in DM when auto-updates happen

**Priority Alignment Reporting**
- [ ] Compare active standup items against Linear priority ordering
- [ ] Digest: per-user alignment summary (on-track / off-track)
- [ ] Individual DM: alignment report to off-track individuals

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

# Omdim Roadmap

## Phase 1: Foundation

### MVP (Done)
See `requirements.md` and `architecture.md`

### Testing Infrastructure ✅
- [x] Unit tests for core logic (modal building, formatting, date/timezone)
- [x] Integration tests for Slack payload parsing
- [x] Mock Slack API responses for handler testing
- [ ] CI pipeline (GitHub Actions)

### Stats & Analytics (Partially Done)
- [x] Completion rates by user/team
- [x] Average items per standup (planned vs completed)
- [x] Blocker frequency
- [x] Trend comparison to previous period (↑↓→ indicators)
- [ ] Blocker resolution time tracking
- [ ] Trend visualization (sparklines in Slack?)

### Automated Digests ✅
- [x] Scheduled daily digest at 2pm UTC
- [x] Scheduled weekly digest on configurable day per-daily
- [x] Multiple managers per daily
- [x] Bottleneck detection (carried items, high drop rates)
- [x] Snooze button for bottleneck items (7-day snooze via interactive button)
- [x] Compact "Option C" digest format (action-first, ~15 lines)
- [x] `/standup report <daily> [day|week|month]` - full report with individual breakdowns
- [x] Team rankings (moved to full report command)

---

## Phase 1.5: Operational Improvements

### Dynamic Configuration
- [ ] Hot-reload config changes without redeploying
- [ ] Pause/resume dailies via config flag (`enabled: false`)
- [ ] Admin command to reload config: `/standup config reload`
- [ ] Store config overrides in DB (takes precedence over YAML)

### Out of Office (OOO) ✅
- [x] `/standup ooo tomorrow` - skip next prompt
- [x] `/standup ooo 2024-12-25 to 2025-01-02` - date range
- [x] `/standup ooo clear` - cancel OOO
- [x] `/standup ooo` - show current OOO status
- [x] Show OOO status in `/standup list`
- [x] Skip prompts and exclude from "missing" stats during OOO

### Admin Management
- [ ] `/standup admin add @user` - add admin (super-admin only)
- [ ] `/standup admin remove @user` - remove admin
- [ ] `/standup admin list` - show all admins
- [ ] Define super-admins in config (can manage other admins)

### Force Prompt Command (Partial)
- [x] `/standup force-prompt <daily>` - dev mode command to force prompt yourself
- [ ] `/standup prompt all <daily>` - admin command to prompt all participants
- [ ] `/standup force-prompt all <daily>` - admin command to prompt all participants
- [ ] Confirmation step before mass-prompting
- [ ] Show summary: "Sent prompts to 7 users"

### Visual Polish
- [ ] Improve checkbox rendering in standup messages
- [ ] Use `:white_check_mark:` / `:ballot_box_with_check:` for done items
- [ ] Use `:arrow_right:` for continued items
- [ ] Use `:x:` for dropped items
- [ ] Consider emoji prefixes for plan items (🎯 planned, ⚡ unplanned)

### "All Dailies" Support ✅
- [x] Support `all` as daily name in commands (e.g., `/standup digest all`)
- [x] Runs command for each defined daily sequentially
- [x] Combines output into single response where appropriate
- [x] Works with: `prompt`, `digest`, `report`, `list`

---

## Phase 2: Performance & Insights

### Cache Slack Data
- [ ] Cache user profiles (display name, timezone) in DB
- [ ] Refresh on user update events or daily
- [ ] Reduces Slack API calls per prompt cycle

### Rate Limiting
- [ ] Limit slash commands per user (e.g., 10/min)
- [ ] Prevent abuse of digest generation
- [ ] Return friendly error on limit hit

### Alerts & Thresholds (Partially Done)
Configurable alerts when patterns emerge:

| Alert | Trigger | Action | Status |
|-------|---------|--------|--------|
| Carry-over streak | Same item carried 3+ days | Shown in digest | ✅ Done |
| High drop rate | >30% drops | Flagged in digest | ✅ Done |
| Unplanned overload | >70% unplanned work | Team-level flag | Pending |
| Missing standups | Not submitted today | Shown in daily digest | ✅ Done |

```yaml
dailies:
  - name: "engineering"
    managers: ["U123", "U456"]    # Multiple managers
    weekly_digest_day: "fri"      # sun-sat
    bottleneck_threshold: 3       # Days before flagging
```

---

## Phase 3: Integrations

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

**Work Alignment**
- [ ] Compare "today's plans" keywords to commit messages/PR titles
- [ ] Surface misalignment: "You said X but worked on Y"
- [ ] Auto-populate yesterday's work from commits

```yaml
integrations:
  github:
    enabled: true
    org: "your-org"
    user_mapping:
      - slack_user_id: "U123"
        external_username: "github-user"
```

### Linear Integration ✅

- [x] Fetch assigned issues from current cycle (active + upcoming)
- [x] Linear ticket checkboxes in standup modal (pre-checked)
- [x] Link Linear user to Slack user (config `user_mapping` + self-service `/link linear`)
- [x] App Home linked accounts section with link/unlink buttons
- [ ] Mark issues as "in progress" when added to standup
- [ ] Link blockers to Linear issues

---

## Phase 4: Status Tracking & Smart Digests

### In-Progress Item Tracking (Partial)
Items gain a 4th status: **In Progress** (alongside Done, Carry Over, Drop).

- [x] Add "In Progress" status option to yesterday's items in standup modal
- [ ] In-progress items auto-carry to today under the same status (no re-prompting needed)
- [ ] Track consecutive in-progress days per item in DB
- [ ] Items in-progress for 3+ days flagged as "needs attention" in digest and report
- [ ] Visual indicator in standup post (e.g., 🔄 Day 3)

### Configurable Digest & Report Cadence
Digest and full report schedules are set per-daily in config (replacing the hardcoded 2pm UTC / weekly pattern).

- [ ] `digest_schedule` config: cron-like or named cadence (e.g., `daily@14:00`, `every_other_day`)
- [ ] `report_schedule` config: cadence for full report (e.g., `weekly@fri`, `biweekly@fri`)
- [ ] Both respect the daily's timezone/schedule context
- [ ] Backward compatible: defaults to current behavior if not set

```yaml
dailies:
  - name: "engineering-daily"
    digest_schedule: "daily@14:00"     # When to send digest
    report_schedule: "weekly@fri"      # When to send full report
```

### Flexible Digest & Report Recipients
Any Slack member can be configured to receive digest and/or report per daily — not just managers.

- [ ] `digest_recipients` and `report_recipients` config arrays per daily
- [ ] Each entry specifies a Slack user ID
- [ ] Falls back to `managers` list if recipients not configured
- [ ] Self-subscribe command: `/standup subscribe <daily> digest|report`
- [ ] Unsubscribe: `/standup unsubscribe <daily> digest|report`

```yaml
dailies:
  - name: "engineering-daily"
    managers: ["U123"]
    digest_recipients: ["U123", "U456", "U789"]   # Broader than managers
    report_recipients: ["U123"]                     # Narrower for full report
```

---

## Phase 5: Linear Intelligence

> Builds on Phase 3 Linear Integration. Requires Linear sync to be active.

### Cross-Reference Plans vs Linear
Compare what people commit to in standups with what's actually assigned in Linear.

- [ ] On standup submission, match plan items to assigned Linear issues (fuzzy title match + issue ID detection)
- [ ] Flag in digest: "Plans not in Linear" and "Linear items not in plans"
- [ ] Weekly report section: plan-to-Linear alignment score per user
- [ ] Configurable strictness: `off` / `soft` (info only) / `strict` (prompt user to reconcile)

### Auto-Update Items from Linear Status
When a Linear issue's status changes, reflect it in the user's standup items automatically.

- [ ] Webhook or poll for Linear status changes on linked issues
- [ ] If Linear issue moves to "Done" → auto-mark standup item as Done
- [ ] If Linear issue moves to "In Progress" → auto-mark standup item as In Progress
- [ ] Notify user in DM when auto-updates happen: "Linear updated: [issue] → Done"
- [ ] Configurable: `auto_sync: true|false` per daily

### Priority Misalignment Detection
Flag in digest when someone is working on lower-priority items while higher-priority Linear items are available.

- [ ] Pull priority/urgency from Linear for user's assigned issues
- [ ] Compare active standup items against Linear priority ordering
- [ ] Digest flag: "Working on P3 while P1 items are unstarted"
- [ ] Respect context — only flag when higher-priority items are unblocked and actionable
- [ ] Configurable sensitivity: `off` / `flag_in_digest` / `dm_user`

```yaml
integrations:
  linear:
    enabled: true
    priority_tracking: "flag_in_digest"   # off | flag_in_digest | dm_user
    plan_alignment: "soft"                # off | soft | strict
    auto_sync: true
```

---

## Future Considerations

- Analytics dashboard (web UI with Slack OAuth)
- ~~Slack app home tab~~ ✅ (linked accounts, start daily button)
- Manager dashboard
- AI-generated standup summaries
- Mobile-friendly standup submission

---

## Open Questions

1. **Alerts**: DM only or also post to a manager channel?
2. ~~**GitHub**: OAuth flow or static token per workspace?~~ → Static token (decided)
3. **Stats**: Store aggregated stats or compute on-demand?
4. **In-progress threshold**: Is 3 days the right default, or should it be configurable per-daily?
5. **Linear sync direction**: Webhook (real-time, needs public endpoint) vs polling (simpler, slight delay)?
6. **Priority misalignment**: Should this block standup submission (strict mode) or purely advisory?
7. **Self-subscribe**: Should non-managers be able to self-subscribe to digests, or admin-only?

---

## Backlog

### Developer Experience
- [ ] Integrate Drizzle ORM for type-safe queries and migrations
- [ ] CI pipeline (GitHub Actions)

🗺️

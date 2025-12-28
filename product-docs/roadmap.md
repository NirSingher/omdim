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

> **Note**: Config schema supports `integrations` placeholder for future GitHub/Linear integration. Work alignment section removed from digest for compactness - will be re-added when integrations are implemented.

### GitHub Integration

**Work Alignment**
- [ ] Link GitHub username to Slack user
- [ ] Compare "today's plans" keywords to commit messages/PR titles
- [ ] Surface misalignment: "You said X but worked on Y"
- [ ] Auto-populate yesterday's work from commits

**PR Review Tracking**
- [ ] Fetch open PRs needing review from user
- [ ] Auto-populate "PRs needing review" field
- [ ] Track PR review turnaround time
- [ ] Alert on stale PRs (>48h without review)

```yaml
integrations:
  github:
    enabled: false
    org: "your-org"
    user_mapping:
      - slack_user_id: "U123"
        external_username: "github-user"
```

### Linear Integration
- [ ] Auto-pull assigned issues as "Today's plan" suggestions
- [ ] Mark issues as "in progress" when added to standup
- [ ] Link blockers to Linear issues

---

## Future Considerations

- Analytics dashboard (web UI with Slack OAuth)
- Slack app home tab with personal stats
- Manager dashboard
- AI-generated standup summaries
- Mobile-friendly standup submission

---

## Open Questions

1. **Alerts**: DM only or also post to a manager channel?
2. **GitHub**: OAuth flow or static token per workspace?
3. **Stats**: Store aggregated stats or compute on-demand?

---

## Backlog

### Developer Experience
- [ ] Integrate Drizzle ORM for type-safe queries and migrations
- [ ] CI pipeline (GitHub Actions)

🗺️

# Omdim Roadmap

## Phase 1: Foundation

### MVP (Done)
See `requirements.md` and `architecture.md`

### Testing Infrastructure
- [ ] Unit tests for core logic (modal building, formatting, date/timezone)
- [ ] Integration tests for Slack payload parsing
- [ ] Mock Slack API responses for handler testing
- [ ] CI pipeline (GitHub Actions)

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

### Stats & Analytics
- [ ] Completion rates by user/team
- [ ] Average items per standup (planned vs completed)
- [ ] Blocker frequency and resolution time
- [ ] Trend visualization (sparklines in Slack?)

### Weekly Automation
- [ ] Scheduled weekly digest (Friday PM or Monday AM)
- [ ] Configurable per-daily (different cadence per team)
- [ ] Channel post vs DM to managers option

### Alerts & Thresholds
Configurable alerts when patterns emerge:

| Alert | Trigger | Action |
|-------|---------|--------|
| Carry-over streak | Same item carried 3+ days | DM user + optional manager flag |
| High drop rate | >50% drops in a week | DM user |
| Unplanned overload | >70% unplanned work | Team-level flag |
| Missing standups | 2+ consecutive misses | DM user |

```yaml
alerts:
  carryover_threshold: 3  # days
  drop_rate_threshold: 0.5
  unplanned_threshold: 0.7
  missing_threshold: 2
  notify_managers: true
```

---

## Phase 3: Integrations

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
github:
  org: "your-org"
  token_env: "GITHUB_TOKEN"
  user_mapping:
    U12345678: "github-username"
  features:
    work_alignment: true
    pr_tracking: true
    stale_pr_alert_hours: 48
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

🗺️

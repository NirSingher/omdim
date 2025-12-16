# Standup Bot - Roadmap

## Phase 1: MVP
See `requirements.md` and `architecture.md`

---

## Phase 2: Performance & Insights

### Cache Slack Data
- Cache user profiles (display name, timezone) in DB
- Refresh on user update events or daily
- Reduces Slack API calls per prompt cycle

### Rate Limiting
- Limit slash commands per user (e.g., 10/min)
- Prevent abuse of digest generation
- Return friendly error on limit hit

### Analytics Dashboard
- Web UI showing:
  - Submission rates by team/user
  - Blocker frequency and patterns
  - Completion rate trends (planned vs actual)
- Auth via Slack OAuth or simple token

---

## Phase 3: Integrations

### Linear Integration
- Auto-pull assigned issues as "Today's plan" suggestions
- Mark issues as "in progress" when added to standup
- Link blockers to Linear issues

### GitHub Integration
- Show recent commits/PRs as "What I did" suggestions
- Auto-populate PRs needing review
- Link to open PR discussions as potential blockers

---

🗺️

# Contributing

## Git Workflow

### Branch Strategy

```
main        ← production-ready, synced with origin
  └── dev   ← integration branch, work-in-progress
       └── feature/*, bugfix/*, etc.  ← your work here
```

- **All feature branches are based off `dev`**
- `main` receives merges from `dev` when ready for release
- `hotfix/*` branches are the exception — based off `main` for urgent fixes

### Branch Naming

| Prefix | Use Case | Example |
|--------|----------|---------|
| `feature/` | New functionality | `feature/slack-home-tab` |
| `bugfix/` | Non-urgent fixes | `bugfix/timezone-offset` |
| `hotfix/` | Urgent production fixes | `hotfix/auth-crash` |
| `chore/` | Maintenance, deps, refactoring | `chore/upgrade-vitest` |
| `docs/` | Documentation only | `docs/api-reference` |

### Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>: <description>

[optional body]
```

**Types:**
- `feat:` — new feature
- `fix:` — bug fix
- `docs:` — documentation
- `chore:` — maintenance, deps
- `refactor:` — code change that doesn't fix/add
- `test:` — adding/updating tests

**Examples:**
```
feat: add snooze button to bottleneck items
fix: sort custom answers by question order
chore: upgrade typescript to 5.3
docs: add git workflow to CONTRIBUTING.md
```

### Pull Request Process

1. Create branch from `dev`:
   ```bash
   git checkout dev
   git pull origin dev
   git checkout -b feature/my-feature
   ```

2. Make changes, commit with conventional commits

3. Run tests before pushing:
   ```bash
   npm test
   ```

4. Push and create PR:
   ```bash
   git push -u origin feature/my-feature
   gh pr create --base dev
   ```

5. After approval, rebase merge to `dev`

6. Delete the feature branch after merge

### Hotfix Process

For urgent production fixes:

```bash
git checkout main
git checkout -b hotfix/critical-fix
# ... fix and test ...
git push -u origin hotfix/critical-fix
gh pr create --base main
# After merge to main, also merge to dev:
git checkout dev
git merge hotfix/critical-fix
```

---

## Local Development Setup

### Prerequisites

- Node.js 18+
- [ngrok](https://ngrok.com) account (free)
- Slack workspace with admin access
- Neon database (free tier)

### 1. Clone and Install

```bash
git clone <repo>
cd omdim
npm install
```

### 2. Create Neon Database

> **Note**: Cloudflare Workers uses the Neon serverless driver which requires WebSocket connections. Local PostgreSQL won't work - you must use Neon even for local development.

1. Sign up at [neon.tech](https://neon.tech) (free, no credit card)
2. Create a new project
3. Copy the connection string
4. Run the schema:
   ```bash
   psql "your-neon-connection-string" -f schema.sql
   ```

### 3. Configure Environment

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret
DATABASE_URL=postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require
CRON_SECRET=any-random-string
```

### 4. Create Config

```bash
cp config.yaml.example config.yaml
# Edit config.yaml with your settings
```

### 5. Start ngrok

```bash
ngrok http 8787
```

Copy the `https://xxx.ngrok-free.dev` URL.

### 6. Configure Slack App

Go to [api.slack.com/apps](https://api.slack.com/apps) → Your app:

**Slash Commands** → Edit `/standup`:
- Request URL: `https://YOUR-NGROK-URL/api/slack/commands`

**Interactivity & Shortcuts**:
- Request URL: `https://YOUR-NGROK-URL/api/slack/interact`

### 7. Start Dev Server

```bash
npm run dev
```

### 8. Test

In Slack:
```
/standup help
```

## Notes

- ngrok URL changes on restart — update Slack app URLs accordingly
- This codebase is optimized for **Cloudflare Workers** deployment
- The Neon serverless driver uses WebSocket connections, which is why local PostgreSQL isn't supported
- Neon free tier (3GB) is more than enough for development and small teams

## Platform Support

The current implementation targets **Cloudflare Workers**. The code structure uses:
- `api/index.ts` - Single entry point with `fetch` and `scheduled` handlers
- `@neondatabase/serverless` - WebSocket-based PostgreSQL driver for edge environments

For other platforms (Vercel, Netlify, Supabase), you would need to:
1. Create platform-specific entry points
2. Optionally use the standard `pg` driver (supports local PostgreSQL)

# Contributing

## Local Development Setup

### Prerequisites

- Node.js 18+
- Docker (for local PostgreSQL)
- [ngrok](https://ngrok.com) account (free)
- Slack workspace with admin access

### 1. Clone and Install

```bash
git clone <repo>
cd standup-bot
npm install
```

### 2. Start Local PostgreSQL

```bash
docker run -d \
  --name standup-postgres \
  -e POSTGRES_USER=standup \
  -e POSTGRES_PASSWORD=standup \
  -e POSTGRES_DB=standup \
  -p 5433:5432 \
  postgres:16-alpine

# Run schema
psql "postgresql://standup:standup@localhost:5433/standup" -f schema.sql
```

### 3. Configure Environment

```bash
cp .dev.vars.example .dev.vars
```

Edit `.dev.vars`:
```
SLACK_BOT_TOKEN=xoxb-your-token
SLACK_SIGNING_SECRET=your-secret
DATABASE_URL=postgresql://standup:standup@localhost:5433/standup
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
- Local PostgreSQL runs on port 5433 to avoid conflicts
- Use `docker stop standup-postgres` / `docker start standup-postgres` to manage the container

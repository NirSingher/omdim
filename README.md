# omdim

Slack bot for managing you Daily Standups. Build to be serverless hosted for free. Oriented to keep track from one daily to another and help manager get the digest that they need.

## Features

- **Timezone-aware prompts** - Each user gets prompted at their local time
- **Continuity tracking** - Yesterday's plans with Done/Continue/Drop options per item
- **Flexible schedules** - Support for different work weeks (Sun-Thu, Mon-Fri, etc.)
- **Custom questions** - Add team-specific questions with @mention support
- **Configurable field order** - Control the order of all fields in the standup modal
- **On-demand digests** - Daily and weekly summaries via DM
- **Zero cost** - Runs entirely on free tiers, no credit card required

## Prerequisites

- Node.js 18+
- A Slack workspace where you can install apps

## Hosting Options (All Free, No Credit Card)

| Platform | Best For | Cron Support | Free Tier Limit |
|----------|----------|--------------|-----------------|
| **Cloudflare** ⭐ | Recommended | ✅ Cron Triggers | Unlimited |
| **Vercel** | Alternative | ⚠️ Limited | 1 cron/day (need external cron) |
| **Netlify** | Alternative | ✅ Scheduled functions | Unlimited |
| **Supabase** | All-in-one (DB + functions) | ✅ pg_cron | Unlimited |

> **Note**: This codebase is optimized for **Cloudflare Workers**. Other platforms would require adapting the entry point structure. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Database Options (All Free, No Credit Card)

| Service | Free Tier | Notes |
|---------|-----------|-------|
| **Neon** ⭐ | 3GB storage | Required for Cloudflare Workers |
| **Supabase** | 500MB storage | Works with Vercel/Netlify |

> **Note**: Cloudflare Workers requires the Neon serverless driver (WebSocket-based). Local PostgreSQL is not supported for development - use Neon's free tier instead.

---

## Setup

### 1. Create Slack App

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name it "Standup Bot" and select your workspace

#### OAuth & Permissions

Add these **Bot Token Scopes**:
- `chat:write` - Post messages to channels
- `im:write` - Send DMs to users
- `users:read` - Read user profiles and timezones
- `commands` - Register slash commands

#### Install App

1. Go to **Install App** in the sidebar
2. Click **Install to Workspace**
3. Copy the **Bot User OAuth Token** (starts with `xoxb-`)
4. Go to **Basic Information** and copy the **Signing Secret**

> **Note**: We'll configure Slash Commands and Interactivity URLs after deploying (Step 4).

### 2. Create Database

#### Option A: Supabase

1. Sign up at [supabase.com](https://supabase.com) (no credit card)
2. Create a new project
3. Go to **SQL Editor** and paste the contents of `schema.sql`, then run
4. Go to **Settings** → **Database** → **Connection string** (URI)

#### Option B: Neon

1. Sign up at [neon.tech](https://neon.tech) (no credit card)
2. Create a new project
3. Copy the connection string
4. Run schema using `psql`:
   ```bash
   psql "your-connection-string" -f schema.sql
   ```

<details>
<summary><strong>Installing psql</strong></summary>

**macOS:**
```bash
brew install libpq
brew link --force libpq
```

**Ubuntu/Debian:**
```bash
sudo apt-get update
sudo apt-get install postgresql-client
```

**Windows:**
Download from [postgresql.org/download/windows](https://www.postgresql.org/download/windows/) and install (select "Command Line Tools" only if you don't need the full server).

**Verify installation:**
```bash
psql --version
```
</details>

### 3. Deploy to Cloudflare Workers

1. Sign up at [cloudflare.com](https://cloudflare.com) (no credit card)

2. Install Wrangler and login:
   ```bash
   npm i -g wrangler
   wrangler login
   ```

3. Deploy (wrangler.toml is already configured):
   ```bash
   npm install
   wrangler deploy
   ```

4. Set secrets:
   ```bash
   wrangler secret put SLACK_BOT_TOKEN
   wrangler secret put SLACK_SIGNING_SECRET
   wrangler secret put DATABASE_URL
   ```

5. Your app URL: `https://standup-bot.<your-subdomain>.workers.dev`

> **Note**: Cloudflare free tier doesn't support day-of-week in cron, so cleanup runs daily at 3am UTC instead of weekly.

### 4. Configure Slack URLs

Now that you have your app URL, go back to your Slack app settings:

#### Slash Commands

1. Go to **Slash Commands** → **Create New Command**
2. Set:
   - **Command**: `/standup`
   - **Request URL**: `https://YOUR-APP-URL/api/slack/commands`
   - **Description**: Manage daily standups
   - **Escape channels, users, and links sent to your app**: ✅ Check this box
3. Save

> **Important**: The "Escape channels, users, and links" option is required for @mentions to work in commands like `/standup add @user daily-name`.

#### Interactivity

1. Go to **Interactivity & Shortcuts**
2. Toggle **Interactivity** to ON
3. Set **Request URL**: `https://YOUR-APP-URL/api/slack/interact`
4. Save

### 5. Configure Bot

Copy the example config and customize:
```bash
cp config.yaml.example config.yaml
```

Edit `config.yaml`:

```yaml
dailies:
  - name: "engineering"
    channel: "#eng-standup"
    schedule: "il-team"
    # Control field order (lower numbers appear first)
    field_order:
      unplanned: 10
      today_plans: 20
      blockers: 30
    questions:
      - text: "How're you feeling?"
        required: false
        order: 5      # Appears before unplanned (10)
      - text: "Any PRs needing review?"
        required: false
        order: 25     # Appears between today_plans (20) and blockers (30)

schedules:
  - name: "il-team"
    days: [sun, mon, tue, wed, thu]
    default_time: "09:00"
  - name: "us-team"
    days: [mon, tue, wed, thu, fri]
    default_time: "09:00"

admins:
  - "U12345678"  # Your Slack user ID
```

**Field ordering**: Standard fields (`unplanned`, `today_plans`, `blockers`) and custom questions are sorted by their `order` value. Lower numbers appear earlier in the modal.

**Finding your Slack user ID**: Click your profile in Slack → three dots menu → "Copy member ID"

Redeploy after changing config.

### 6. Add Bot to Channel

The bot needs to be in the channel to post standups:

1. Go to your standup channel (e.g., `#daily-standup`)
2. Click the channel name → **Settings** → **Integrations**
3. Click **Add apps**
4. Find and add your Standup Bot

### 7. Add Team Members

In Slack:

```
/standup add @alice engineering
/standup add @bob engineering
/standup list engineering
```

---

## Usage

### For Team Members

1. Receive a DM at your scheduled time with "Open Standup" button
2. Click to open the standup form
3. For each of yesterday's plans, choose:
   - ✅ **Done** - Mark as completed
   - ➡️ **Continue** - Carry over to today (default)
   - ❌ **Drop** - Remove from plans
4. Add any unplanned work you completed
5. Enter today's new plans and any blockers
6. Submit → Your update posts to the team channel

### For Admins

```
/standup add @user <daily-name>     # Add user to a daily
/standup remove @user <daily-name>  # Remove user
/standup list <daily-name>          # List participants
```

### For Managers

```
/standup digest <daily-name>        # Today's team updates (DM)
/standup week <daily-name>          # Weekly summary (DM)
```

---

## Local Development

### Cloudflare Workers (Recommended)

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your Neon DATABASE_URL and Slack credentials

npm install
npm run dev

# Test health endpoint
curl http://localhost:8787/api/health
```

> **Important**: You must use a Neon DATABASE_URL even for local development. See [CONTRIBUTING.md](CONTRIBUTING.md) for full setup instructions.

### Testing with Slack

Use [ngrok](https://ngrok.com) to expose your local server:

```bash
ngrok http 8787

# Update Slack app URLs to ngrok URL temporarily
```

---

## Troubleshooting

### Bot not responding to commands

1. Check function logs for errors (platform dashboard)
2. Verify `SLACK_SIGNING_SECRET` is correct
3. Ensure slash command URL matches your deployment

### Users not receiving prompts

1. Check that user is added to a daily (`/standup list <daily>`)
2. Verify user's timezone in Slack profile
3. Check cron job logs

### Database connection errors

1. Verify `DATABASE_URL` is set correctly
2. Check that connection pooling is enabled (Supabase: use pooler URL)
3. Run `schema.sql` if tables don't exist

---

## License

MIT
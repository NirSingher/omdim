# omdim

Slack bot for managing you Daily Standups. Build to be serverless hosted for free. Oriented to keep track from one daily to another and help manager get the digest that they need.

## Features

- **Timezone-aware prompts** - Each user gets prompted at their local time
- **Continuity tracking** - Yesterday's plans shown as checkboxes, incomplete items carry forward
- **Flexible schedules** - Support for different work weeks (Sun-Thu, Mon-Fri, etc.)
- **On-demand digests** - Daily and weekly summaries via DM
- **Zero cost** - Runs entirely on free tiers, no credit card required

## Prerequisites

- Node.js 18+
- A Slack workspace where you can install apps

## Hosting Options (All Free, No Credit Card)

| Platform | Best For | Cron Support | Free Tier Limit |
|----------|----------|--------------|-----------------|
| **Vercel** | Simplest setup | ⚠️ Limited | 1 cron/day (need external cron) |
| **Netlify** | Good alternative | ✅ Scheduled functions | Unlimited |
| **Cloudflare** | Fastest performance | ✅ Cron Triggers | Unlimited |
| **Supabase** | All-in-one (DB + functions) | ✅ pg_cron | Unlimited |

> **Note**: Vercel free tier only allows 1 cron job per day. For the 30-min prompt loop, use Netlify/Cloudflare/Supabase, or add an external cron service (see below).

## Database Options (All Free, No Credit Card)

| Service | Free Tier |
|---------|-----------|
| **Supabase** | 500MB storage |
| **Neon** | 3GB storage |

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

### 3. Deploy

Choose one platform:

---

#### Option A: Vercel

> ⚠️ Vercel free tier only allows 1 cron/day. You'll need an external cron service for the 30-min prompts.

1. Sign up at [vercel.com](https://vercel.com) (no credit card)

2. Install and deploy:
   ```bash
   npm i -g vercel
   npm install
   vercel
   ```

3. Set environment variables in Vercel dashboard:
   | Variable | Value |
   |----------|-------|
   | `SLACK_BOT_TOKEN` | `xoxb-...` |
   | `SLACK_SIGNING_SECRET` | From Slack app |
   | `DATABASE_URL` | Your Postgres connection string |
   | `CRON_SECRET` | Random string for securing cron endpoints |

4. Set up external cron (free):
   - Go to [cron-job.org](https://cron-job.org) (free, no credit card)
   - Create a job for `https://your-project.vercel.app/api/cron/prompt?secret=YOUR_CRON_SECRET`
   - Schedule: `*/30 * * * *` (every 30 minutes)
   - Create another for `/api/cron/cleanup` at `0 3 * * 0` (weekly)

5. Your app URL: `https://your-project.vercel.app`

---

#### Option B: Netlify

1. Sign up at [netlify.com](https://netlify.com) (no credit card)

2. Create `netlify.toml`:
   ```toml
   [build]
     command = "npm run build"
     functions = "netlify/functions"

   [functions]
     node_bundler = "esbuild"

   # Cron job for prompts (every 30 min)
   [[edge_functions]]
     schedule = "*/30 * * * *"
     path = "/api/cron/prompt"

   # Cron job for cleanup (weekly)
   [[edge_functions]]
     schedule = "0 3 * * 0"
     path = "/api/cron/cleanup"
   ```

3. Deploy:
   ```bash
   npm i -g netlify-cli
   npm install
   netlify deploy --prod
   ```

4. Set environment variables in Netlify dashboard → Site settings → Environment variables

5. Your app URL: `https://your-site.netlify.app`

---

#### Option C: Cloudflare Workers

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

---

#### Option D: Supabase (All-in-One)

Use Supabase for both database AND functions:

1. Sign up at [supabase.com](https://supabase.com) (no credit card)

2. Create project and run `schema.sql` in SQL Editor

3. Create Edge Functions:
   ```bash
   supabase init
   supabase functions new slack-commands
   supabase functions new slack-interact
   supabase functions new cron-prompt
   ```

4. Deploy:
   ```bash
   supabase functions deploy
   ```

5. Set up cron in SQL Editor:
   ```sql
   SELECT cron.schedule(
     'standup-prompt',
     '*/30 * * * *',
     $$SELECT net.http_post(
       url := 'https://your-project.supabase.co/functions/v1/cron-prompt',
       headers := '{"Authorization": "Bearer YOUR_ANON_KEY"}'::jsonb
     )$$
   );
   ```

6. Your app URL: `https://your-project.supabase.co/functions/v1`

---

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
    questions:
      - text: "Any PRs needing review?"
        required: false

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

**Finding your Slack user ID**: Click your profile in Slack → three dots menu → "Copy member ID"

Redeploy after changing config.

### 6. Add Team Members

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
3. Check off completed items from yesterday
4. Add any unplanned work you did
5. Enter today's plans and any blockers
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

### Cloudflare Workers

```bash
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your credentials

npm install
npm run dev

# Test health endpoint
curl http://localhost:8787/api/health
```

### Vercel

```bash
cp .env.example .env
# Edit .env with your credentials

npm install
vercel dev

# Test health endpoint
curl http://localhost:3000/api/health
```

### Netlify

```bash
cp .env.example .env
# Edit .env with your credentials

npm install
netlify dev

# Test health endpoint
curl http://localhost:8888/api/health
```

### Testing with Slack

For local Slack testing, use [ngrok](https://ngrok.com) to expose your local server:

```bash
# Pick the port for your platform: 8787 (Cloudflare), 3000 (Vercel), 8888 (Netlify)
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
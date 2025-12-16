# Standup Bot - Requirements

## Problem
Daily standups interrupt flow when done synchronously. Team members across timezones struggle to find common meeting times. Written async standups lack structure and continuity between days.

## Solution
A Slack bot that:
- Prompts each user at their preferred time/timezone
- Pre-fills today's form with yesterday's plans for easy tracking
- Posts individual updates to a configured channel
- Provides on-demand digests (daily/weekly)

---

## Core Features

### 1. Standup Collection

**Trigger**: Bot DMs each user at their scheduled time with a button to open the standup modal.

**Reminders**: If user hasn't submitted, bot re-prompts every 30 minutes until they do.

**Modal Form**:
| Section | Behavior |
|---------|----------|
| Yesterday's plans | Pre-filled checklist from previous standup. User checks off completed items. |
| Unplanned completions | Free text to add things done that weren't planned |
| Today's plans | Free text or structured list (auto-populated with incomplete items from yesterday) |
| Blockers | Free text (can be empty) |
| Custom questions | Configurable per-daily, marked as optional or required |

**First day**: Skip "Yesterday's plans" section entirely.

**Output**: Individual post to configured channel showing:
- ✅ Completed from plan
- ❌ Not completed (carried over to today)
- ➕ Unplanned completions
- 📋 Today's plan
- 🚧 Blockers (if any)

### 2. Scheduling

| Config | Options |
|--------|---------|
| Prompt time | Per-user, in their local timezone (auto-read from Slack profile) |
| Active days | Per-schedule (e.g., Sun-Thu vs Mon-Fri) |
| Schedules | Multiple named schedules supported |

Users assigned to a schedule inherit its defaults but can override time personally.

### 3. User Management

**Method**: Admin assignment only

**Commands**:
```
/standup add @user <daily-name>        # Assign user to a daily
/standup remove @user <daily-name>     # Remove user from a daily
/standup list <daily-name>             # Show all participants
/standup list @user                    # Show user's assigned dailies
```

**User data pulled from Slack automatically**:
- Display name
- Timezone (from Slack profile)
- Slack user ID

### 4. Configuration

**Config file** (YAML):
```yaml
dailies:
  - name: "engineering-daily"
    channel: "#eng-standup"
    schedule: "il-team"
    questions:
      - text: "Any PRs needing review?"
        required: false
      - text: "OOO tomorrow?"
        required: false

schedules:
  - name: "il-team"
    days: [sun, mon, tue, wed, thu]
    default_time: "09:00"
  - name: "us-team"
    days: [mon, tue, wed, thu, fri]
    default_time: "09:00"

admins:
  - "U12345678"  # Slack user IDs who can manage
```

**Note**: Timezone is per-user from Slack, not per-schedule.

### 5. Digests

| Digest | Trigger | Content |
|--------|---------|---------|
| Daily | `/standup digest <daily-name>` | All members' posts for today (DM to requester) |
| Weekly | `/standup week <daily-name>` | Per-person summary: completion rate, blockers, patterns |

Digests are private - sent only to requester via DM.

---

## User Flows

### Daily Flow (Team Member)
1. Receive DM at scheduled time: "Time for standup! [Open Form]"
2. Click button → Modal opens with yesterday's plans as checkboxes
3. Check completed items, add unplanned work, write today's plan
4. Submit → Bot posts to configured channel

### Admin Flow
1. Edit `config.yaml` to define dailies, schedules, custom questions
2. Use `/standup add @user <daily>` to assign participants
3. Bot handles the rest

### Manager/Lead Flow
1. `/standup digest engineering-daily` → Today's team updates in DM
2. `/standup week engineering-daily` → Weekly rollup in DM

---

## Slack App Requirements

**Scopes**:
- `users:read` - Read user profiles & timezones
- `chat:write` - Post to channels
- `im:write` - DM users
- `commands` - Slash commands

**Features**:
- Slash commands
- Interactive modals (Block Kit)
- Scheduled messages or external scheduler

---

## Out of Scope (v1)
- Self-enrollment
- Jira/Linear/GitHub integration
- Automatic holiday detection
- Analytics dashboard

🔧

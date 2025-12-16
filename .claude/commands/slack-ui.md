# Slack UI Component

Build Slack Block Kit component: **$ARGUMENTS**

## Instructions

1. Read `requirements.md` for UX requirements
2. Read `architecture.md` for message formats
3. Build the requested component using Slack Block Kit

## Components

### `prompt-dm`
The DM sent to users to start their standup.
- Friendly greeting
- "Open Standup" button
- Note about schedule

### `standup-modal`
The modal form for submitting standup.
- Yesterday's plans as checkboxes (if exists)
- Unplanned completions text input
- Today's plans text input (pre-filled with incomplete)
- Blockers text input
- Custom questions from config

### `channel-post`
The message posted to the standup channel.
- User mention and timestamp
- ✅ Completed items
- ❌ Incomplete items (carried over)
- ➕ Unplanned completions
- 📋 Today's plans
- 🚧 Blockers (if any)
- Custom question answers

### `digest-dm`
Daily digest sent via DM.
- Summary header
- Per-user standup summaries
- Users who haven't submitted

### `weekly-dm`
Weekly digest sent via DM.
- Date range
- Per-user stats (completion rate, blockers)
- Team patterns

## Output

Provide:
1. Block Kit JSON structure
2. TypeScript function to generate it dynamically
3. Test the JSON at https://app.slack.com/block-kit-builder

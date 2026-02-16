# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.2.1] - 2026-02-16

### Fixed
- **PR checkbox selections respected at post time** — stop re-fetching all PRs when submitting; use the user's actual checkbox selections
- **Deduplicate integration items** — Linear tickets and GitHub PRs already in yesterday's plans no longer appear twice

### Changed
- Refactored `/daily` command to reuse shared fetch helpers from interactions handler, fetching Linear issues and GitHub PRs in parallel

## [1.2.0] - 2026-02-12

### Added
- **GitHub PR integration** — draft PRs, ready-to-merge PRs, and review requests appear as checkboxes in the standup modal. Users self-link via `/standup github link <username>` or App Home
- **Linear issue integration** — current and previous cycle issues appear in the standup modal. Users self-link via `/standup linear link <user-id>` or App Home
- **"In Progress" status** — new dropdown option for yesterday's items. Renders with 🔄 in Today section; shows ⚠️ when carried 3+ times
- **Channel reminder before daily** — configurable heads-up message in the standup channel (`reminder_minutes_before` in config, default 90)
- **App Home linked accounts** — see GitHub/Linear connection status and link/unlink with buttons in the Home tab
- Admin `user_mapping` in config for pre-linking GitHub/Linear accounts

### Fixed
- **Scheduled standups not posting** — Neon returns DATE columns as ISO strings, which never matched the expected format. Tomorrow standups now post reliably
- Standups submitted before scheduled time are now queued correctly
- Tomorrow standups no longer trigger re-prompting
- JSONB fields parsed correctly in scheduled post handler
- Skip prompts for dailies removed from config
- Duplicate `#` in channel name confirmation DM removed

## [1.1.0] - 2026-02-01

### Added
- Configurable digest time via `digest_time` in config.yaml
- Dropped items shown in yesterday section with ❌
- Emoji rendering in modal input labels
- "Today plans" only required if nothing carried over from yesterday

### Changed
- Upgraded Wrangler to v4.58.0

## [1.0.0] - 2026-01-15

### Added
- Core async standup flow: timezone-aware prompts, standup modal, channel posting
- User-initiated standups via `/daily` command and App Home
- Schedule tomorrow's standup with automatic posting
- Continuity tracking: Done/Continue/Drop for yesterday's plans
- Flexible schedules (Sun-Thu, Mon-Fri, custom)
- Custom questions with configurable field ordering
- Daily, weekly, and 4-week digest summaries
- Out of Office (OOO) feature
- Varied reminder messages with lateness prefix
- Admin commands: add/remove users, list participants
- Compact digest format and `/standup report` command

[Unreleased]: https://github.com/NirSingher/omdim/compare/v1.2.1...HEAD
[1.2.1]: https://github.com/NirSingher/omdim/compare/v1.2.0...v1.2.1
[1.2.0]: https://github.com/NirSingher/omdim/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/NirSingher/omdim/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/NirSingher/omdim/releases/tag/v1.0.0

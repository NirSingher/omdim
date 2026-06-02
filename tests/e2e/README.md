# End-to-end tests

These tests drive the **real worker** (`api/index.ts`) the way Slack would — with
genuinely signed requests — and verify both sides of every boundary: what the bot
**persisted** and what it **sent Slack**.

```
npm run test:e2e        # watch mode
npm run test:e2e:run    # single run (CI)
```

They run under a separate config (`vitest.e2e.config.ts`) so the main unit suite
(`npm test`) stays fast and unaffected.

## What's real vs. faked

| Layer | In these tests | Why |
|-------|----------------|-----|
| Worker entry, routing, **signature verification** | **real** | full request path is exercised |
| Config (`config.yaml`), handlers, formatting, timezone math | **real** | no behavior is stubbed away |
| Database | **real Postgres** via [PGlite](https://pglite.dev) running the real `schema.sql` | catches SQL errors, `UNIQUE` constraints, JSONB/DATE quirks a stub can't |
| Slack API | **fake** at the `fetch` boundary (`harness/slack.ts`) | records what the bot sends; serves `users.info` |
| GitHub / Linear | not called | their tokens are left unset, so integration code short-circuits |
| Clock | faked `Date` (`vi.setSystemTime`), `TZ=UTC` | deterministic date math |

Only **one thing** is mocked at the module level: `lib/db`'s `getDb` is swapped to
return the PGlite client. Every other `lib/db` query function runs its actual SQL.

> **DATE columns come back as JS `Date` objects** from PGlite — exactly like Neon.
> Normalize with `toDateString()` (from `lib/prompt`) in assertions instead of
> string-matching. This fidelity is the point: it's the class of bug commit
> `30e05f8` fixed.

## Harness pieces (`tests/e2e/harness/`)

- **`db.ts`** — PGlite singleton + `schema.sql` loader, the `DbClient` adapter,
  `resetTestDb()` (truncate between tests), and row-inspection helpers
  (`allSubmissions`, `allWorkItems`, `allSubmissionItems`, `rows`).
- **`slack.ts`** — installs the `fetch` fake and a `SlackRecorder` with query
  helpers: `channelPosts()`, `dmsTo(user)`, `modalsOpened`, `lastModal()`,
  `messageUpdates`, `homeViews`. Throws on any non-Slack host so an accidental
  real network call fails loudly.
- **`actor.ts`** — the Slack simulator: `slashCommand()`, `interact()`,
  `clickButton()`, `selectOption()`, `event()`, and `submitOpenedModal()` which
  reads the modal the bot just opened and submits it (closing the
  open→fill→submit loop). Also `makeEnv()` and a drainable `waitUntil`.
- **`../setup.ts`** — wires the `getDb` mock, installs the Slack fake, resets the
  DB, and pins the clock before each test. Exposes `slackRecorder()`.

## Writing a new scenario

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { SlackActor, makeEnv } from './harness/actor';
import { getTestDbClient, allSubmissions } from './harness/db';
import { slackRecorder } from './setup';
import { addParticipant } from '../../lib/db';

describe('e2e: my scenario', () => {
  let actor: SlackActor;

  beforeEach(async () => {
    const recorder = slackRecorder();
    recorder.setUser('U_X');                                  // serves users.info
    await addParticipant(getTestDbClient(), 'U_X', 'daily-test', 'il-team');
    actor = new SlackActor(recorder, makeEnv());
  });

  it('does the thing', async () => {
    await actor.slashCommand({ command: '/daily', user_id: 'U_X' });
    await actor.submitOpenedModal({ userId: 'U_X', todayPlans: 'A\nB' });

    expect((await allSubmissions()).length).toBe(1);          // persisted
    expect(slackRecorder().channelPosts()).toHaveLength(1);   // posted
  });
});
```

Notes:
- The default clock is **2026-06-02 12:00 UTC** (Tue, 15:00 IDT) — past the
  `il-team` 10:00 schedule, so submissions post immediately. Use
  `vi.setSystemTime(...)` to move time (e.g. before 10:00 IDT to test queuing).
- `daily-test` (channel `#daily-bot-test`, schedule `il-team`) is the real daily
  in `config.yaml`. Seed participants for it; no config mocking needed.
- To test crons, call the real functions directly, e.g.
  `runScheduledPosts(getTestDbClient(), TEST_BOT_TOKEN, makeEnv())`.

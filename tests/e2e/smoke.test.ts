/**
 * Smoke test — proves the e2e harness is wired correctly before scenarios rely
 * on it: the db mock swaps in PGlite, real query functions persist & read back,
 * the Slack fake records calls, and the worker's signature check runs for real.
 */

import { describe, it, expect } from 'vitest';
import { SlackActor, makeEnv } from './harness/actor';
import { getTestDbClient } from './harness/db';
import { slackRecorder } from './setup';
import { saveSubmission, getSubmissionForDate } from '../../lib/db';

describe('e2e harness smoke test', () => {
  it('getDb is swapped: real query functions persist and read back via PGlite', async () => {
    const db = getTestDbClient();

    const saved = await saveSubmission(db, {
      slackUserId: 'U_SMOKE',
      dailyName: 'daily-test',
      date: '2026-06-02',
      yesterdayCompleted: [],
      yesterdayIncomplete: ['carried'],
      unplanned: [],
      todayPlans: ['plan one', 'plan two'],
      blockers: '',
      customAnswers: {},
    });

    expect(saved.id).toBe(1); // RESTART IDENTITY → deterministic
    const readBack = await getSubmissionForDate(db, 'U_SMOKE', 'daily-test', '2026-06-02');
    expect(readBack).not.toBeNull();
    expect(readBack!.today_plans).toEqual(['plan one', 'plan two']);
    expect(readBack!.yesterday_incomplete).toEqual(['carried']);
  });

  it('drives a real signed request through the worker entry point', async () => {
    const actor = new SlackActor(slackRecorder(), makeEnv());
    const { status, json } = await actor.slashCommand({ command: '/standup', text: 'help' });
    expect(status).toBe(200);
    expect(JSON.stringify(json)).toContain('/standup');
  });

  it('Slack fake records calls and serves users.info', async () => {
    const recorder = slackRecorder();
    recorder.setUser('U_TZ', { tz: 'Asia/Jerusalem', tz_offset: 10800 });

    // Hit users.info through the real lib/slack helper path indirectly:
    const res = await fetch('https://slack.com/api/users.info?user=U_TZ');
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.user.tz).toBe('Asia/Jerusalem');
    expect(recorder.byMethod('users.info').length).toBe(1);
  });
});

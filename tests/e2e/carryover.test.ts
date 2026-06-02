/**
 * E2E: carry-over across two days.
 *
 * Day 1: submit plans A + B (posts to channel, creates work items).
 * Day 2: open /daily — the modal must pre-load A + B as "yesterday's plans"
 *        (read back from the persisted day-1 submission). Submit marking A done,
 *        B continue, and add C. Assert the day-2 submission and the work_items'
 *        status/carry_count reflect the transitions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackActor, makeEnv } from './harness/actor';
import { getTestDbClient, allSubmissions, allWorkItems } from './harness/db';
import { slackRecorder } from './setup';
import { addParticipant } from '../../lib/db';
import { toDateString } from '../../lib/prompt';

const BOB = 'U_BOB';
const DAY1 = new Date('2026-06-01T12:00:00.000Z'); // Mon, 15:00 IDT (after 10:00)
const DAY2 = new Date('2026-06-02T12:00:00.000Z'); // Tue, 15:00 IDT

describe('e2e: carry-over across days', () => {
  let actor: SlackActor;

  beforeEach(async () => {
    const recorder = slackRecorder();
    recorder.setUser(BOB);
    await addParticipant(getTestDbClient(), BOB, 'daily-test', 'il-team');
    actor = new SlackActor(recorder, makeEnv());
  });

  it("pre-loads yesterday's plans and records the carry transitions", async () => {
    // --- Day 1 ---
    vi.setSystemTime(DAY1);
    await actor.slashCommand({ command: '/daily', user_id: BOB });
    await actor.submitOpenedModal({ userId: BOB, todayPlans: 'Task A\nTask B' });

    let subs = await allSubmissions<any>();
    expect(subs).toHaveLength(1);
    // PGlite returns DATE columns as JS Date objects (same as Neon) — normalize
    // with the production helper rather than string-matching.
    expect(toDateString(subs[0].date)).toBe('2026-06-01');

    // --- Day 2: modal must show yesterday's A + B ---
    vi.setSystemTime(DAY2);
    slackRecorder().reset();
    slackRecorder().setUser(BOB);

    await actor.slashCommand({ command: '/daily', user_id: BOB });
    const modal = slackRecorder().lastModal();
    const meta = JSON.parse(modal.private_metadata);
    expect(meta.mode).toBe('today');
    expect(meta.yesterdayPlans).toEqual(['Task A', 'Task B']);

    // Submit: A done, B continue, add C
    await actor.submitOpenedModal({
      userId: BOB,
      yesterdaySelections: { 0: 'done', 1: 'continue' },
      todayPlans: 'Task C',
    });

    // --- Day-2 submission persisted with the right split ---
    subs = await allSubmissions<any>();
    expect(subs).toHaveLength(2);
    const day2 = subs.find((s) => toDateString(s.date) === '2026-06-02')!;
    expect(day2.yesterday_completed).toEqual(['Task A']);
    expect(day2.yesterday_incomplete).toEqual(['Task B']);
    expect(day2.today_plans).toEqual(['Task C']);

    // --- Work items reflect transitions ---
    const items = await allWorkItems<any>();
    const byText = Object.fromEntries(items.map((i) => [i.text, i]));
    expect(byText['Task A'].status).toBe('done');
    expect(toDateString(byText['Task A'].completed_date)).toBe('2026-06-02');
    expect(byText['Task B'].status).toBe('carried');
    expect(byText['Task B'].carry_count).toBe(1);
    expect(byText['Task C'].status).toBe('pending');

    // --- Day-2 channel post: carried B + new C under Today, A summarized as done ---
    const posts = slackRecorder().channelPosts();
    expect(posts).toHaveLength(1);
    const blocks = JSON.stringify(posts[0].body.blocks);
    expect(blocks).toContain('Task B'); // carried over
    expect(blocks).toContain('Task C'); // new plan
    expect(blocks).toContain('1 done'); // Task A completed, summarized as a count
  });
});

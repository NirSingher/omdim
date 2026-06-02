/**
 * E2E: queued submission posts when its scheduled time arrives.
 *
 * Submitting before the schedule's posting time queues the standup
 * (posted=false, no channel post yet, confirmation DM). Later, the scheduled
 * cron posts it. This exercises the exact DATE-handling path that commit 30e05f8
 * fixed: getUnpostedSubmissions → toDateString(submission.date) compared against
 * getDateInTimezone(scheduleTz). Because PGlite returns DATE as a JS Date object
 * (like Neon), a regression in that parsing would make the cron silently skip.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SlackActor, makeEnv, TEST_BOT_TOKEN } from './harness/actor';
import { getTestDbClient, allSubmissions, allWorkItems } from './harness/db';
import { slackRecorder } from './setup';
import { addParticipant } from '../../lib/db';
import { runScheduledPosts } from '../../lib/prompt';

const CAROL = 'U_CAROL';
const BEFORE_TIME = new Date('2026-06-02T05:00:00.000Z'); // 08:00 IDT — before 10:00
const AFTER_TIME = new Date('2026-06-02T08:00:00.000Z'); // 11:00 IDT — after 10:00

describe('e2e: scheduled (queued) post', () => {
  let actor: SlackActor;

  beforeEach(async () => {
    const recorder = slackRecorder();
    recorder.setUser(CAROL);
    await addParticipant(getTestDbClient(), CAROL, 'daily-test', 'il-team');
    actor = new SlackActor(recorder, makeEnv());
  });

  it('queues before the posting time, then the cron posts it after', async () => {
    // --- Submit before 10:00 → queued, not posted ---
    vi.setSystemTime(BEFORE_TIME);
    await actor.slashCommand({ command: '/daily', user_id: CAROL });
    await actor.submitOpenedModal({ userId: CAROL, todayPlans: 'Ship the thing' });

    let subs = await allSubmissions<any>();
    expect(subs).toHaveLength(1);
    expect(subs[0].posted).toBe(false);
    expect(subs[0].slack_message_ts).toBeNull();

    // No channel post yet; user got a "scheduled" confirmation DM.
    expect(slackRecorder().channelPosts()).toHaveLength(0);
    const dm = slackRecorder().dmsTo(CAROL);
    expect(dm.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(dm.map((d) => d.body.text))).toContain('scheduled');

    // --- Time passes to after 10:00; run the scheduled-posts cron ---
    vi.setSystemTime(AFTER_TIME);
    slackRecorder().reset();
    slackRecorder().setUser(CAROL);

    const stats = await runScheduledPosts(getTestDbClient(), TEST_BOT_TOKEN, makeEnv());
    expect(stats).toMatchObject({ posted: 1, errors: 0 });

    // --- Now it's posted to the channel and marked posted in the DB ---
    const posts = slackRecorder().channelPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.channel).toBe('#daily-bot-test');
    expect(JSON.stringify(posts[0].body.blocks)).toContain('Ship the thing');

    subs = await allSubmissions<any>();
    expect(subs[0].posted).toBe(true);
    expect(subs[0].slack_message_ts).toBeTruthy();

    // Work items are tracked at post time (not at queue time).
    const items = await allWorkItems<any>();
    expect(items.map((i) => i.text)).toContain('Ship the thing');
  });

  it('does not post a queued submission whose time has not yet arrived', async () => {
    vi.setSystemTime(BEFORE_TIME);
    await actor.slashCommand({ command: '/daily', user_id: CAROL });
    await actor.submitOpenedModal({ userId: CAROL, todayPlans: 'Not yet' });

    slackRecorder().reset();
    slackRecorder().setUser(CAROL);

    // Still before 10:00 — cron should skip, nothing posted.
    const stats = await runScheduledPosts(getTestDbClient(), TEST_BOT_TOKEN, makeEnv());
    expect(stats).toMatchObject({ posted: 0 });
    expect(slackRecorder().channelPosts()).toHaveLength(0);

    const subs = await allSubmissions<any>();
    expect(subs[0].posted).toBe(false);
  });
});

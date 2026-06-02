/**
 * E2E: first-time standup submission.
 *
 * Journey: a participant runs `/daily`, the bot opens the modal, they fill in
 * today's plans and submit. We assert on BOTH sides of the boundary:
 *   - what the bot persisted (submissions row, work_items, submission_items),
 *   - what the bot sent Slack (a channel post with the plans in its blocks).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SlackActor, makeEnv } from './harness/actor';
import { getTestDbClient, allSubmissions, allWorkItems, allSubmissionItems } from './harness/db';
import { slackRecorder } from './setup';
import { addParticipant } from '../../lib/db';

const ALICE = 'U_ALICE';

describe('e2e: first standup submission', () => {
  let actor: SlackActor;

  beforeEach(async () => {
    const recorder = slackRecorder();
    recorder.setUser(ALICE);
    await addParticipant(getTestDbClient(), ALICE, 'daily-test', 'il-team');
    actor = new SlackActor(recorder, makeEnv());
  });

  it('opens the standup modal on /daily', async () => {
    const { status, json } = await actor.slashCommand({ command: '/daily', user_id: ALICE });
    expect(status).toBe(200);
    expect(JSON.stringify(json)).toContain('Opening standup');

    const recorder = slackRecorder();
    expect(recorder.modalsOpened).toHaveLength(1);
    expect(recorder.lastModal().callback_id).toBe('standup_submission');
  });

  it('persists the submission and posts it to the channel', async () => {
    await actor.slashCommand({ command: '/daily', user_id: ALICE });
    const { status } = await actor.submitOpenedModal({
      userId: ALICE,
      todayPlans: 'Build login page\nFix flaky test',
    });
    expect(status).toBe(200);

    // --- Persistence ---
    const subs = await allSubmissions<any>();
    expect(subs).toHaveLength(1);
    const sub = subs[0];
    expect(sub.slack_user_id).toBe(ALICE);
    expect(sub.daily_name).toBe('daily-test');
    expect(sub.today_plans).toEqual(['Build login page', 'Fix flaky test']);
    expect(sub.posted).toBe(true);
    // posted immediately (15:00 IDT is past the 10:00 schedule) → message ts recorded
    expect(sub.slack_message_ts).toBeTruthy();

    // Work items: one per plan, manual source, pending status
    const items = await allWorkItems<any>();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text)).toEqual(['Build login page', 'Fix flaky test']);
    expect(items.every((i) => i.status === 'pending')).toBe(true);
    expect(items.every((i) => i.source === 'manual' && i.item_type === 'plan')).toBe(true);

    // Link rows tie the work items to the submission as today_plan
    const links = await allSubmissionItems<any>();
    expect(links).toHaveLength(2);
    expect(links.every((l) => l.role === 'today_plan' && l.submission_id === sub.id)).toBe(true);

    // --- Slack output ---
    const recorder = slackRecorder();
    const posts = recorder.channelPosts();
    expect(posts).toHaveLength(1);
    expect(posts[0].body.channel).toBe('#daily-bot-test');
    const blocksJson = JSON.stringify(posts[0].body.blocks);
    expect(blocksJson).toContain('Build login page');
    expect(blocksJson).toContain('Fix flaky test');
  });

  it('rejects an empty submission with a validation error and persists nothing', async () => {
    await actor.slashCommand({ command: '/daily', user_id: ALICE });
    const { status, json } = await actor.submitOpenedModal({ userId: ALICE, todayPlans: '' });

    expect(status).toBe(200);
    expect(json.response_action).toBe('errors');
    expect(json.errors.today_plans).toBeTruthy();

    const subs = await allSubmissions();
    expect(subs).toHaveLength(0);
    expect(slackRecorder().channelPosts()).toHaveLength(0);
  });
});

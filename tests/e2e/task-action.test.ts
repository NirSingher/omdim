/**
 * E2E: task overflow-menu action from App Home.
 *
 * After a standup is posted, the user marks an item "done" from the App Home
 * task list. Assert the whole chain: the work item flips to done, the
 * submission's JSONB arrays are re-derived from work-item state, the channel
 * post is updated in place, and the App Home view is re-published. This relies
 * on getActiveWorkItems running against real Postgres (the query the harness
 * just exposed as broken).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SlackActor, makeEnv } from './harness/actor';
import { getTestDbClient, allSubmissions, allWorkItems } from './harness/db';
import { slackRecorder } from './setup';
import { addParticipant } from '../../lib/db';

const DAVE = 'U_DAVE';

describe('e2e: App Home task action', () => {
  let actor: SlackActor;

  beforeEach(async () => {
    const recorder = slackRecorder();
    recorder.setUser(DAVE);
    await addParticipant(getTestDbClient(), DAVE, 'daily-test', 'il-team');
    actor = new SlackActor(recorder, makeEnv());
  });

  it('marks an item done → updates DB, channel post, and App Home', async () => {
    // Submit two plans (posts to channel, creates work items).
    await actor.slashCommand({ command: '/daily', user_id: DAVE });
    await actor.submitOpenedModal({ userId: DAVE, todayPlans: 'Task A\nTask B' });

    const sub = (await allSubmissions<any>())[0];
    const items = await allWorkItems<any>();
    const taskA = items.find((i) => i.text === 'Task A')!;
    expect(taskA.status).toBe('pending');

    slackRecorder().reset();
    slackRecorder().setUser(DAVE);

    // Mark Task A done via the overflow menu (task_action).
    const value = JSON.stringify({ itemId: taskA.id, dailyName: 'daily-test', action: 'done' });
    const { status } = await actor.selectOption('task_action', value, { userId: DAVE });
    expect(status).toBe(200);

    // --- Work item flipped to done ---
    const after = await allWorkItems<any>();
    expect(after.find((i) => i.text === 'Task A')!.status).toBe('done');

    // --- Submission arrays re-derived: A → completed, B stays a plan ---
    const sub2 = (await allSubmissions<any>())[0];
    expect(sub2.yesterday_completed).toEqual(['Task A']);
    expect(sub2.today_plans).toEqual(['Task B']);

    // --- Channel post updated in place (same ts) ---
    const updates = slackRecorder().messageUpdates;
    expect(updates).toHaveLength(1);
    expect(updates[0].body.channel).toBe('#daily-bot-test');
    expect(updates[0].body.ts).toBe(sub.slack_message_ts);

    // --- App Home re-published with the task list ---
    const homes = slackRecorder().homeViews;
    expect(homes.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(homes[homes.length - 1].body.view)).toContain('Task B');
  });
});

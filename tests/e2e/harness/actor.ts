/**
 * The Slack "actor" — simulates Slack sending signed requests to the worker.
 *
 * Every request is signed with a real HMAC (the worker verifies signatures for
 * real — that path is NOT mocked), so these tests exercise the full entry point
 * in api/index.ts: signature check → routing → handler → DB → Slack fake.
 *
 * It also models the round trip a human makes: the bot opens a modal (captured
 * by the Slack fake), the actor reads that modal back, fills it in, and submits
 * it as a `view_submission` — closing the open→fill→submit loop without
 * hand-authoring private_metadata.
 */

import worker from '../../../api/index';
import type { Env } from '../../../api/index';
import type { SlackRecorder } from './slack';

export const TEST_SIGNING_SECRET = 'e2e-signing-secret';
export const TEST_BOT_TOKEN = 'xoxb-e2e-token';

// ----------------------------------------------------------------------------
// Env + ExecutionContext
// ----------------------------------------------------------------------------

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SLACK_BOT_TOKEN: TEST_BOT_TOKEN,
    SLACK_SIGNING_SECRET: TEST_SIGNING_SECRET,
    DATABASE_URL: 'postgres://e2e-not-used', // getDb is swapped to PGlite in setup
    ...overrides,
  };
}

/**
 * An ExecutionContext whose waitUntil collects background promises so the test
 * can await them. handleStandupSubmission and the task handlers do their DB +
 * Slack work inside waitUntil — `drain()` flushes it before assertions.
 */
export class TestExecutionContext {
  private promises: Promise<unknown>[] = [];

  ctx: ExecutionContext = {
    waitUntil: (p: Promise<unknown>) => {
      this.promises.push(p);
    },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;

  async drain(): Promise<void> {
    // Loop: a drained promise may schedule more background work.
    while (this.promises.length > 0) {
      const batch = this.promises;
      this.promises = [];
      await Promise.allSettled(batch);
    }
  }
}

// ----------------------------------------------------------------------------
// Request signing
// ----------------------------------------------------------------------------

async function sign(body: string, timestamp: string): Promise<string> {
  const base = `v0:${timestamp}:${body}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(TEST_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(base));
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${hex}`;
}

/**
 * Timestamp for signing. The worker's signature check compares this against
 * `Date.now()`. When a test fakes `Date` (vi.setSystemTime), BOTH the actor and
 * the worker observe the same faked clock — so the timestamps match (skew 0)
 * and the signature stays valid regardless of how far "now" is moved.
 */
function epochSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

async function signedRequest(
  path: string,
  body: string,
  contentType: string,
): Promise<Request> {
  const ts = epochSeconds();
  const sig = await sign(body, ts);
  return new Request(`https://bot.example.com${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'x-slack-request-timestamp': ts,
      'x-slack-signature': sig,
    },
    body,
  });
}

// ----------------------------------------------------------------------------
// Actor
// ----------------------------------------------------------------------------

export interface SlashCommandFields {
  command?: string;
  text?: string;
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  channel_name?: string;
  team_id?: string;
  response_url?: string;
  trigger_id?: string;
}

export class SlackActor {
  constructor(
    private recorder: SlackRecorder,
    private env: Env = makeEnv(),
  ) {}

  /** Run a slash command (/standup, /daily). Returns parsed JSON response. */
  async slashCommand(fields: SlashCommandFields): Promise<{ status: number; json: any }> {
    const full: Record<string, string> = {
      command: '/standup',
      text: '',
      user_id: 'U_TEST',
      user_name: 'tester',
      channel_id: 'C_GENERAL',
      channel_name: 'general',
      team_id: 'T_TEST',
      response_url: 'https://hooks.slack.com/commands/T_TEST/x',
      trigger_id: `trigger.${this.recorder.nextTs()}`,
      ...stripUndefined(fields),
    };
    const body = new URLSearchParams(full).toString();
    const req = await signedRequest('/api/slack/commands', body, 'application/x-www-form-urlencoded');
    return this.run(req);
  }

  /** Send an interaction payload (block_actions / view_submission). */
  async interact(payload: object): Promise<{ status: number; json: any }> {
    const body = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const req = await signedRequest('/api/slack/interact', body, 'application/x-www-form-urlencoded');
    return this.run(req);
  }

  /** Send an Events API payload (app_home_opened, url_verification). */
  async event(payload: object): Promise<{ status: number; json: any }> {
    const body = JSON.stringify(payload);
    const req = await signedRequest('/api/slack/events', body, 'application/json');
    return this.run(req);
  }

  /** Click a block button: action_id + value, optional trigger. */
  async clickButton(
    actionId: string,
    value: string,
    opts: { userId?: string; triggerId?: string } = {},
  ): Promise<{ status: number; json: any }> {
    return this.interact({
      type: 'block_actions',
      trigger_id: opts.triggerId ?? `trigger.${this.recorder.nextTs()}`,
      user: { id: opts.userId ?? 'U_TEST' },
      actions: [{ action_id: actionId, value }],
    });
  }

  /** Select an option from an overflow/static menu (task_action style). */
  async selectOption(
    actionId: string,
    optionValue: string,
    opts: { userId?: string } = {},
  ): Promise<{ status: number; json: any }> {
    return this.interact({
      type: 'block_actions',
      trigger_id: `trigger.${this.recorder.nextTs()}`,
      user: { id: opts.userId ?? 'U_TEST' },
      actions: [{ action_id: actionId, value: '', selected_option: { value: optionValue } }],
    });
  }

  /**
   * Submit the standup modal the bot most recently opened.
   *
   * Reads the captured modal's private_metadata so callback_id/dailyName/mode/
   * targetDate all match what the bot built, then fills:
   *   - yesterday item dropdowns by `yesterdaySelections` (index → status),
   *   - the free-text today_plans / unplanned / blockers inputs.
   * This mirrors a user filling the actual modal Slack rendered.
   */
  async submitOpenedModal(opts: {
    userId?: string;
    yesterdaySelections?: Record<number, 'done' | 'continue' | 'in_progress' | 'drop'>;
    todayPlans?: string;
    unplanned?: string;
    blockers?: string;
  } = {}): Promise<{ status: number; json: any }> {
    const modal = this.recorder.lastModal();
    if (!modal) throw new Error('No modal has been opened to submit');
    const metadata = JSON.parse(modal.private_metadata) as {
      dailyName: string;
      yesterdayPlans?: string[];
      mode?: string;
      targetDate?: string;
    };

    const values: Record<string, any> = {};
    const yesterdayPlans = metadata.yesterdayPlans ?? [];
    yesterdayPlans.forEach((_item, i) => {
      const status = opts.yesterdaySelections?.[i] ?? 'continue';
      values[`yesterday_item_${i}`] = {
        [`item_status_${i}`]: { selected_option: { value: status } },
      };
    });
    if (opts.todayPlans !== undefined) {
      values.today_plans = { plans_input: { value: opts.todayPlans } };
    }
    if (opts.unplanned !== undefined) {
      values.unplanned = { unplanned_input: { value: opts.unplanned } };
    }
    if (opts.blockers !== undefined) {
      values.blockers = {
        blockers_input: {
          rich_text_value: {
            type: 'rich_text',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: opts.blockers }] },
            ],
          },
        },
      };
    }

    return this.interact({
      type: 'view_submission',
      trigger_id: `trigger.${this.recorder.nextTs()}`,
      user: { id: opts.userId ?? 'U_TEST' },
      view: {
        callback_id: modal.callback_id,
        private_metadata: modal.private_metadata,
        state: { values },
      },
    });
  }

  private async run(req: Request): Promise<{ status: number; json: any }> {
    const exec = new TestExecutionContext();
    const res = await worker.fetch(req, this.env, exec.ctx);
    await exec.drain();
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, json };
  }
}

function stripUndefined(obj: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = String(v);
  }
  return out;
}

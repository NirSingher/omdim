/**
 * Fake Slack API at the `fetch` boundary.
 *
 * The bot makes every Slack call through `fetch('https://slack.com/api/<method>')`
 * in lib/slack.ts. This installs a `globalThis.fetch` that:
 *   - records each Slack call (method + parsed JSON body) into a recorder,
 *   - returns a realistic `{ ok: true, ts }` (or method-specific) response so the
 *     REAL lib/slack.ts code path runs end to end,
 *   - serves `users.info` from a configurable user directory (so timezone logic
 *     runs for real — no need to mock lib/prompt),
 *   - throws on any non-Slack host, turning an accidental real network call
 *     (GitHub, Linear, Neon) into a loud test failure instead of a silent hang.
 *
 * Scenarios assert against the recorder: "the bot posted these blocks to this
 * channel", "it opened a modal with this callback_id", etc.
 */

export interface SlackCall {
  /** API method, e.g. "chat.postMessage", "views.open". */
  method: string;
  /** Parsed JSON request body. */
  body: any;
}

/** Default timezone served by users.info unless overridden per user. */
const DEFAULT_TZ = { tz: 'Asia/Jerusalem', tz_offset: 10800 };

export class SlackRecorder {
  /** Every Slack API call in order. */
  calls: SlackCall[] = [];

  /** users.info directory: userId → tz info. */
  private users = new Map<string, { tz: string; tz_offset: number }>();

  /** Monotonic ts generator so each posted message gets a unique id. */
  private tsCounter = 1000;

  /** Configure the timezone returned by users.info for a given user. */
  setUser(userId: string, tz: Partial<{ tz: string; tz_offset: number }> = {}): void {
    this.users.set(userId, { ...DEFAULT_TZ, ...tz });
  }

  userTz(userId: string): { tz: string; tz_offset: number } {
    return this.users.get(userId) ?? DEFAULT_TZ;
  }

  nextTs(): string {
    this.tsCounter += 1;
    return `${this.tsCounter}.0001`;
  }

  // --- Query helpers used by scenario assertions -------------------------

  /** All calls to a given API method. */
  byMethod(method: string): SlackCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** chat.postMessage calls (channel posts + DMs both go through this). */
  get posts(): SlackCall[] {
    return this.byMethod('chat.postMessage');
  }

  /** chat.postMessage calls targeting a real channel (starts with "#" or "C"). */
  channelPosts(): SlackCall[] {
    return this.posts.filter((c) => /^[#C]/.test(String(c.body.channel)));
  }

  /** chat.postMessage calls targeting a user DM (channel is a Uxxx id). */
  dms(): SlackCall[] {
    return this.posts.filter((c) => /^U/.test(String(c.body.channel)));
  }

  /** DMs sent to a specific user. */
  dmsTo(userId: string): SlackCall[] {
    return this.posts.filter((c) => c.body.channel === userId);
  }

  get modalsOpened(): SlackCall[] {
    return this.byMethod('views.open');
  }

  get modalsUpdated(): SlackCall[] {
    return this.byMethod('views.update');
  }

  get homeViews(): SlackCall[] {
    return this.byMethod('views.publish');
  }

  get messageUpdates(): SlackCall[] {
    return this.byMethod('chat.update');
  }

  /** The most recently opened modal view object (what views.open received). */
  lastModal(): any | undefined {
    const m = this.modalsOpened;
    return m.length ? m[m.length - 1].body.view : undefined;
  }

  reset(): void {
    this.calls = [];
    this.tsCounter = 1000;
    // user directory intentionally NOT cleared — scenarios set it up per test
    this.users.clear();
  }
}

/**
 * Install the fake. Returns the recorder and an uninstall function.
 * Pass the recorder around to assert on what the bot sent Slack.
 */
export function installSlackFake(): { recorder: SlackRecorder; uninstall: () => void } {
  const recorder = new SlackRecorder();
  const realFetch = globalThis.fetch;

  const fake = async (input: any, init?: any): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.url;

    if (!url.startsWith('https://slack.com/api/')) {
      throw new Error(
        `Unexpected non-Slack fetch in e2e test: ${url}\n` +
          `(GitHub/Linear/Neon calls must not happen — leave their tokens unset.)`,
      );
    }

    const method = url.replace('https://slack.com/api/', '').split('?')[0];

    // users.info is sent as GET with a query param; everything else is POST JSON.
    if (method === 'users.info') {
      const u = new URL(url);
      const userId = u.searchParams.get('user') || '';
      recorder.calls.push({ method, body: { user: userId } });
      const tz = recorder.userTz(userId);
      return jsonResponse({ ok: true, user: { id: userId, tz: tz.tz, tz_offset: tz.tz_offset } });
    }

    const body = init?.body ? JSON.parse(init.body) : {};
    recorder.calls.push({ method, body });

    return jsonResponse(responseFor(method, recorder));
  };

  globalThis.fetch = fake as typeof fetch;

  return {
    recorder,
    uninstall: () => {
      globalThis.fetch = realFetch;
    },
  };
}

/** Method-specific canned success responses, matching what lib/slack.ts reads. */
function responseFor(method: string, recorder: SlackRecorder): object {
  switch (method) {
    case 'chat.postMessage':
      return { ok: true, ts: recorder.nextTs() };
    case 'chat.update':
      return { ok: true, ts: recorder.nextTs() };
    case 'views.open':
    case 'views.update':
    case 'views.publish':
      return { ok: true };
    default:
      return { ok: true };
  }
}

function jsonResponse(obj: object): Response {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

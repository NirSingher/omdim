/**
 * Notification abstraction layer
 * Provides a unified interface for sending messages to different targets:
 * - Channels
 * - DMs
 * - Threads
 */

import { postMessage } from './slack';

// ============================================================================
// Types
// ============================================================================

/** Target for a notification */
export type NotificationTarget =
  | { type: 'channel'; channelId: string }
  | { type: 'dm'; userId: string }
  | { type: 'thread'; channelId: string; threadTs: string };

/** Result of sending a notification */
export interface NotificationResult {
  success: boolean;
  messageTs?: string;
  error?: string;
}

/** Options for sending a notification */
export interface NotifyOptions {
  /** Slack bot token */
  token: string;
  /** Where to send the notification */
  target: NotificationTarget;
  /** Plain text fallback */
  text: string;
  /** Block Kit blocks (optional) */
  blocks?: unknown[];
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Send a notification to the specified target
 */
export async function notify(options: NotifyOptions): Promise<NotificationResult> {
  const { token, target, text, blocks } = options;

  try {
    let channelOrUser: string;
    let threadTs: string | undefined;

    switch (target.type) {
      case 'channel':
        channelOrUser = target.channelId;
        break;
      case 'dm':
        channelOrUser = target.userId;
        break;
      case 'thread':
        channelOrUser = target.channelId;
        threadTs = target.threadTs;
        break;
    }

    const messageTs = await postMessageWithThread(token, channelOrUser, text, blocks, threadTs);

    if (messageTs) {
      return { success: true, messageTs };
    } else {
      return { success: false, error: 'Failed to send message' };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Send multiple notifications (fire-and-forget, logs errors)
 */
export async function notifyMany(
  token: string,
  targets: NotificationTarget[],
  text: string,
  blocks?: unknown[]
): Promise<{ sent: number; failed: number }> {
  const results = await Promise.all(
    targets.map(target => notify({ token, target, text, blocks }))
  );

  const sent = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  if (failed > 0) {
    const errors = results.filter(r => !r.success).map(r => r.error);
    console.error(`Failed to send ${failed} notifications:`, errors);
  }

  return { sent, failed };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Post a message with optional thread_ts
 */
async function postMessageWithThread(
  slackToken: string,
  channel: string,
  text: string,
  blocks?: unknown[],
  threadTs?: string
): Promise<string | null> {
  try {
    const body: Record<string, unknown> = {
      channel,
      text,
      mrkdwn: true,
    };

    if (blocks) {
      body.blocks = blocks;
    }

    if (threadTs) {
      body.thread_ts = threadTs;
    }

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const result = await response.json() as { ok: boolean; ts?: string; error?: string };

    if (!result.ok) {
      console.error('Failed to post message:', result.error);
      return null;
    }

    return result.ts || null;
  } catch (error) {
    console.error('Error posting message:', error);
    return null;
  }
}

// ============================================================================
// Convenience Functions
// ============================================================================

/** Send a DM to a user */
export async function notifyUser(
  token: string,
  userId: string,
  text: string,
  blocks?: unknown[]
): Promise<NotificationResult> {
  return notify({
    token,
    target: { type: 'dm', userId },
    text,
    blocks,
  });
}

/** Post to a channel */
export async function notifyChannel(
  token: string,
  channelId: string,
  text: string,
  blocks?: unknown[]
): Promise<NotificationResult> {
  return notify({
    token,
    target: { type: 'channel', channelId },
    text,
    blocks,
  });
}

/** Reply in a thread */
export async function notifyThread(
  token: string,
  channelId: string,
  threadTs: string,
  text: string,
  blocks?: unknown[]
): Promise<NotificationResult> {
  return notify({
    token,
    target: { type: 'thread', channelId, threadTs },
    text,
    blocks,
  });
}

// ============================================================================
// Target Builders
// ============================================================================

/** Create a channel target */
export function toChannel(channelId: string): NotificationTarget {
  return { type: 'channel', channelId };
}

/** Create a DM target */
export function toUser(userId: string): NotificationTarget {
  return { type: 'dm', userId };
}

/** Create a thread target */
export function toThread(channelId: string, threadTs: string): NotificationTarget {
  return { type: 'thread', channelId, threadTs };
}

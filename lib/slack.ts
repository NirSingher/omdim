/**
 * Slack API utilities and helpers
 * - Request signature verification
 * - Payload parsing
 * - API calls (messages, modals, user info)
 * - Rich text parsing
 */

// ============================================================================
// Rich Text Types (from Slack Block Kit)
// ============================================================================

export interface RichTextElement {
  type: string;
  text?: string;
  user_id?: string;
  channel_id?: string;
  url?: string;
  elements?: RichTextElement[];
}

export interface RichTextBlock {
  type: string;
  elements?: RichTextElement[];
}

// ============================================================================
// Request Verification
// ============================================================================

/**
 * Verify Slack request signature using Web Crypto API (Cloudflare Workers compatible)
 * @see https://api.slack.com/authentication/verifying-requests-from-slack
 */
export async function verifySlackSignature(
  signingSecret: string,
  signature: string | null,
  timestamp: string | null,
  body: string
): Promise<boolean> {
  if (!signature || !timestamp) {
    return false;
  }

  // Check timestamp is within 5 minutes
  const time = Math.floor(Date.now() / 1000);
  if (Math.abs(time - parseInt(timestamp)) > 60 * 5) {
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;

  // Use Web Crypto API
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(sigBasestring)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const mySignature = `v0=${hashHex}`;

  return mySignature === signature;
}

// ============================================================================
// Payload Parsing
// ============================================================================

/**
 * Parse Slack slash command payload from URL-encoded body
 */
export interface SlackCommandPayload {
  command: string;
  text: string;
  user_id: string;
  user_name: string;
  channel_id: string;
  channel_name: string;
  team_id: string;
  response_url: string;
  trigger_id: string;
}

export function parseCommandPayload(body: string): SlackCommandPayload {
  const params = new URLSearchParams(body);
  return {
    command: params.get('command') || '',
    text: params.get('text') || '',
    user_id: params.get('user_id') || '',
    user_name: params.get('user_name') || '',
    channel_id: params.get('channel_id') || '',
    channel_name: params.get('channel_name') || '',
    team_id: params.get('team_id') || '',
    response_url: params.get('response_url') || '',
    trigger_id: params.get('trigger_id') || '',
  };
}

/**
 * Parse user ID from Slack mention format <@U12345678>
 */
export function parseUserId(text: string): string | null {
  const match = text.match(/<@(U[A-Z0-9]+)(?:\|[^>]*)?>/);
  return match ? match[1] : null;
}

// ============================================================================
// Response Helpers
// ============================================================================

/** Slack command response type */
export interface SlackCommandResponse {
  response_type: 'ephemeral' | 'in_channel';
  text: string;
}

/**
 * Create ephemeral response (only visible to user who triggered command)
 */
export function ephemeralResponse(text: string): SlackCommandResponse {
  return {
    response_type: 'ephemeral',
    text,
  };
}

/**
 * Create in-channel response (visible to everyone)
 */
export function inChannelResponse(text: string): SlackCommandResponse {
  return {
    response_type: 'in_channel',
    text,
  };
}

// ============================================================================
// Rich Text Parsing
// ============================================================================

/**
 * Parse Slack rich_text_input value to mrkdwn string
 * Converts user mentions, channel mentions, and links to Slack format
 */
export function parseRichText(richText: RichTextBlock | undefined): string {
  if (!richText?.elements) return '';

  const parts: string[] = [];

  for (const block of richText.elements) {
    if (block.elements) {
      for (const el of block.elements) {
        if (el.type === 'text' && el.text) {
          parts.push(el.text);
        } else if (el.type === 'user' && el.user_id) {
          parts.push(`<@${el.user_id}>`);
        } else if (el.type === 'channel' && el.channel_id) {
          parts.push(`<#${el.channel_id}>`);
        } else if (el.type === 'link' && el.url) {
          parts.push(el.url);
        }
      }
    }
  }

  return parts.join('').trim();
}

// ============================================================================
// Slack API Calls
// ============================================================================

/**
 * Post a message to a Slack channel
 * @returns Message timestamp (ts) if successful, null otherwise
 */
export async function postMessage(
  slackToken: string,
  channel: string,
  text: string,
  blocks?: unknown[]
): Promise<string | null> {
  try {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        channel,
        text,
        blocks,
        mrkdwn: true,
      }),
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

/**
 * Send a DM to a user (channel = user ID)
 */
export async function sendDM(
  slackToken: string,
  userId: string,
  text: string
): Promise<boolean> {
  const result = await postMessage(slackToken, userId, text);
  return result !== null;
}

/**
 * Open a modal dialog
 */
export async function openModal(
  slackToken: string,
  triggerId: string,
  view: unknown
): Promise<boolean> {
  try {
    const response = await fetch('https://slack.com/api/views.open', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        trigger_id: triggerId,
        view,
      }),
    });

    const data = await response.json() as { ok: boolean; error?: string };

    if (!data.ok) {
      console.error('Failed to open modal:', data.error);
      return false;
    }

    return true;
  } catch (error) {
    console.error('Error opening modal:', error);
    return false;
  }
}

/**
 * Get user info from Slack API (timezone data)
 */
export async function getUserInfo(
  slackToken: string,
  userId: string
): Promise<{ tz: string; tz_offset: number } | null> {
  try {
    const response = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json',
      },
    });

    const data = await response.json() as {
      ok: boolean;
      user?: { tz: string; tz_offset: number };
      error?: string;
    };

    if (!data.ok || !data.user) {
      console.error(`Failed to get user info for ${userId}:`, data.error);
      return null;
    }

    return {
      tz: data.user.tz,
      tz_offset: data.user.tz_offset,
    };
  } catch (error) {
    console.error(`Error fetching user info for ${userId}:`, error);
    return null;
  }
}

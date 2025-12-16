/**
 * Verify Slack request signature (Web Crypto API for Cloudflare Workers)
 * https://api.slack.com/authentication/verifying-requests-from-slack
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

/**
 * Parse Slack slash command payload
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

/**
 * Create ephemeral response (only visible to user who triggered command)
 */
export function ephemeralResponse(text: string) {
  return {
    response_type: 'ephemeral',
    text,
  };
}

/**
 * Create in-channel response (visible to everyone)
 */
export function inChannelResponse(text: string) {
  return {
    response_type: 'in_channel',
    text,
  };
}

/**
 * Tests for lib/slack.ts - Slack utilities
 */

import { describe, it, expect } from 'vitest';
import {
  parseUserId,
  parseCommandPayload,
  ephemeralResponse,
  inChannelResponse,
  parseRichText,
} from '../lib/slack';

describe('slack utilities', () => {
  describe('parseUserId', () => {
    it('extracts user ID from mention format', () => {
      expect(parseUserId('<@U12345678>')).toBe('U12345678');
    });

    it('handles mention with display name', () => {
      expect(parseUserId('<@U12345678|john>')).toBe('U12345678');
    });

    it('returns null for invalid format', () => {
      expect(parseUserId('U12345678')).toBe(null);
      expect(parseUserId('@john')).toBe(null);
      expect(parseUserId('')).toBe(null);
    });

    it('extracts from text with surrounding content', () => {
      expect(parseUserId('add <@UABCD1234> to team')).toBe('UABCD1234');
    });
  });

  describe('parseCommandPayload', () => {
    it('parses URL-encoded slash command payload', () => {
      const body = 'command=%2Fstandup&text=add+%3C%40U123%3E+daily&user_id=U456&channel_id=C789';

      const result = parseCommandPayload(body);

      expect(result.command).toBe('/standup');
      expect(result.text).toBe('add <@U123> daily');
      expect(result.user_id).toBe('U456');
      expect(result.channel_id).toBe('C789');
    });

    it('handles empty text', () => {
      const body = 'command=%2Fstandup&text=&user_id=U456';

      const result = parseCommandPayload(body);

      expect(result.text).toBe('');
    });

    it('provides defaults for missing fields', () => {
      const body = 'command=%2Fstandup';

      const result = parseCommandPayload(body);

      expect(result.command).toBe('/standup');
      expect(result.text).toBe('');
      expect(result.user_id).toBe('');
    });
  });

  describe('ephemeralResponse', () => {
    it('creates ephemeral response object', () => {
      const response = ephemeralResponse('Hello!');

      expect(response.response_type).toBe('ephemeral');
      expect(response.text).toBe('Hello!');
    });

    it('preserves markdown formatting', () => {
      const response = ephemeralResponse('*bold* and _italic_');

      expect(response.text).toBe('*bold* and _italic_');
    });
  });

  describe('inChannelResponse', () => {
    it('creates in_channel response object', () => {
      const response = inChannelResponse('Hello everyone!');

      expect(response.response_type).toBe('in_channel');
      expect(response.text).toBe('Hello everyone!');
    });
  });

  describe('parseRichText', () => {
    it('returns empty string for undefined', () => {
      expect(parseRichText(undefined)).toBe('');
    });

    it('returns empty string for empty elements', () => {
      expect(parseRichText({ type: 'rich_text' })).toBe('');
      expect(parseRichText({ type: 'rich_text', elements: [] })).toBe('');
    });

    it('extracts plain text', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Hello world' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe('Hello world');
    });

    it('converts user mentions', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Need help from ' },
              { type: 'user', user_id: 'U12345' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe('Need help from <@U12345>');
    });

    it('converts channel mentions', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'See ' },
              { type: 'channel', channel_id: 'C12345' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe('See <#C12345>');
    });

    it('includes links', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Check ' },
              { type: 'link', url: 'https://example.com' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe('Check https://example.com');
    });

    it('handles multiple sections', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'First line' },
            ],
          },
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Second line' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe('First lineSecond line');
    });

    it('handles complex mixed content', () => {
      const richText = {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Blocked by ' },
              { type: 'user', user_id: 'UABC123' },
              { type: 'text', text: ' - see ' },
              { type: 'link', url: 'https://jira.example.com/ABC-123' },
            ],
          },
        ],
      };

      expect(parseRichText(richText)).toBe(
        'Blocked by <@UABC123> - see https://jira.example.com/ABC-123'
      );
    });
  });
});

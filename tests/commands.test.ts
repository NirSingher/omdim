/**
 * Integration tests for lib/handlers/commands.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config module
vi.mock('../lib/config', () => ({
  isAdmin: vi.fn(),
  getDaily: vi.fn(),
  getSchedule: vi.fn(),
  getDailies: vi.fn(),
  getConfigError: vi.fn(() => null),
}));

// Mock db module
vi.mock('../lib/db', () => ({
  addParticipant: vi.fn(),
  removeParticipant: vi.fn(),
  getParticipants: vi.fn(),
  getSubmissionsForDate: vi.fn(),
  getSubmissionsInRange: vi.fn(),
  getParticipationStats: vi.fn(),
  getUserDailies: vi.fn(),
  getTeamStats: vi.fn(),
  getMissingSubmissions: vi.fn(),
  countWorkdays: vi.fn(),
}));

// Mock slack module
vi.mock('../lib/slack', () => ({
  parseUserId: vi.fn(),
  ephemeralResponse: vi.fn((text: string) => ({ response_type: 'ephemeral', text })),
  sendDM: vi.fn(),
}));

// Mock prompt module
vi.mock('../lib/prompt', () => ({
  getUserTimezone: vi.fn(),
  getUserDate: vi.fn(),
  formatDate: vi.fn(),
  sendPromptDM: vi.fn(),
}));

// Mock format module
vi.mock('../lib/format', () => ({
  formatDailyDigest: vi.fn(),
  formatWeeklySummary: vi.fn(),
  formatManagerDigest: vi.fn(),
}));

import {
  handleHelp,
  handleAdd,
  handleRemove,
  handleList,
  handleDigest,
  handlePrompt,
  handleWeek,
  handleCommand,
  CommandContext,
} from '../lib/handlers/commands';

import { isAdmin, getDaily, getSchedule, getDailies, getConfigError } from '../lib/config';
import { addParticipant, removeParticipant, getParticipants, getSubmissionsInRange, getUserDailies, getTeamStats, getMissingSubmissions, countWorkdays } from '../lib/db';
import { parseUserId, sendDM } from '../lib/slack';
import { getUserTimezone, getUserDate, formatDate, sendPromptDM } from '../lib/prompt';
import { formatManagerDigest } from '../lib/format';

describe('command handlers', () => {
  const mockDb = {} as any;
  const mockToken = 'xoxb-test-token';

  const createContext = (args: string[]): CommandContext => ({
    userId: 'U12345',
    args,
    db: mockDb,
    slackToken: mockToken,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfigError).mockReturnValue(null);
  });

  describe('handleHelp', () => {
    it('returns help text with all commands', () => {
      const response = handleHelp();

      expect(response.response_type).toBe('ephemeral');
      expect(response.text).toContain('/standup help');
      expect(response.text).toContain('/standup prompt');
      expect(response.text).toContain('/standup add');
      expect(response.text).toContain('/standup remove');
      expect(response.text).toContain('/standup list');
      expect(response.text).toContain('/standup digest');
      expect(response.text).toContain('/standup report');
      // Commands include period options
      expect(response.text).toContain('day');
      expect(response.text).toContain('week');
      expect(response.text).toContain('month');
    });
  });

  describe('handleAdd', () => {
    it('requires admin privileges', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);

      const response = await handleAdd(createContext(['add', '<@U999>', 'daily-il']));

      expect(response.text).toContain('Only admins');
    });

    it('validates user mention and daily name', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue(null);

      const response = await handleAdd(createContext(['add']));

      expect(response.text).toContain('Usage:');
    });

    it('validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U999');
      vi.mocked(getDaily).mockReturnValue(null);

      const response = await handleAdd(createContext(['add', '<@U999>', 'nonexistent']));

      expect(response.text).toContain('not found');
    });

    it('adds participant successfully', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U999');
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', channel: '#standup', schedule: 'default' } as any);
      vi.mocked(addParticipant).mockResolvedValue({} as any);

      const response = await handleAdd(createContext(['add', '<@U999>', 'daily-il']));

      expect(addParticipant).toHaveBeenCalledWith(mockDb, 'U999', 'daily-il', 'default');
      expect(response.text).toContain('Added');
      expect(response.text).toContain('U999');
    });

    it('handles database errors gracefully', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U999');
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'default' } as any);
      vi.mocked(addParticipant).mockRejectedValue(new Error('DB error'));

      const response = await handleAdd(createContext(['add', '<@U999>', 'daily-il']));

      expect(response.text).toContain('Failed to add');
    });
  });

  describe('handleRemove', () => {
    it('requires admin privileges', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);

      const response = await handleRemove(createContext(['remove', '<@U999>', 'daily-il']));

      expect(response.text).toContain('Only admins');
    });

    it('removes participant successfully', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U999');
      vi.mocked(removeParticipant).mockResolvedValue();

      const response = await handleRemove(createContext(['remove', '<@U999>', 'daily-il']));

      expect(removeParticipant).toHaveBeenCalledWith(mockDb, 'U999', 'daily-il');
      expect(response.text).toContain('Removed');
    });
  });

  describe('handleList', () => {
    it('lists available dailies when no name provided', async () => {
      vi.mocked(getDailies).mockReturnValue([
        { name: 'daily-il', channel: '#il-standup' },
        { name: 'daily-us', channel: '#us-standup' },
      ] as any);

      const response = await handleList(createContext(['list']));

      expect(response.text).toContain('Available dailies');
      expect(response.text).toContain('daily-il');
      expect(response.text).toContain('daily-us');
    });

    it('validates daily exists', async () => {
      vi.mocked(getDaily).mockReturnValue(null);

      const response = await handleList(createContext(['list', 'nonexistent']));

      expect(response.text).toContain('not found');
    });

    it('shows empty message when no participants', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getParticipants).mockResolvedValue([]);

      const response = await handleList(createContext(['list', 'daily-il']));

      expect(response.text).toContain('no participants');
    });

    it('lists participants with mentions', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getParticipants).mockResolvedValue([
        { slack_user_id: 'U111' },
        { slack_user_id: 'U222' },
      ] as any);

      const response = await handleList(createContext(['list', 'daily-il']));

      expect(response.text).toContain('<@U111>');
      expect(response.text).toContain('<@U222>');
    });
  });

  describe('handlePrompt', () => {
    it('requires user to be in a daily', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([]);

      const response = await handlePrompt(createContext(['prompt']));

      expect(response.text).toContain('not part of any dailies');
    });

    it('auto-selects when user is in only one daily', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(sendPromptDM).mockResolvedValue(true);

      const response = await handlePrompt(createContext(['prompt']));

      expect(sendPromptDM).toHaveBeenCalledWith(mockToken, 'U12345', 'daily-il');
      expect(response.text).toContain('Sent');
    });

    it('shows list when user is in multiple dailies', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([
        { daily_name: 'daily-il' },
        { daily_name: 'daily-us' },
      ] as any);

      const response = await handlePrompt(createContext(['prompt']));

      expect(response.text).toContain('multiple dailies');
      expect(response.text).toContain('daily-il');
      expect(response.text).toContain('daily-us');
    });

    it('sends prompt for specified daily', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(sendPromptDM).mockResolvedValue(true);

      const response = await handlePrompt(createContext(['prompt', 'daily-il']));

      expect(sendPromptDM).toHaveBeenCalledWith(mockToken, 'U12345', 'daily-il');
    });

    it('validates user is participant of specified daily', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-us' }] as any);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);

      const response = await handlePrompt(createContext(['prompt', 'daily-il']));

      expect(response.text).toContain("not part of");
    });
  });

  describe('handleDigest', () => {
    it('requires daily name', async () => {
      const response = await handleDigest(createContext(['digest']));

      expect(response.text).toContain('Usage:');
    });

    it('validates daily exists', async () => {
      vi.mocked(getDaily).mockReturnValue(null);

      const response = await handleDigest(createContext(['digest', 'nonexistent']));

      expect(response.text).toContain('not found');
    });

    it('validates period option', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'il-team' } as any);

      const response = await handleDigest(createContext(['digest', 'daily-il', 'invalid']));

      expect(response.text).toContain('Invalid period');
    });

    it('sends daily digest as DM', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'il-team' } as any);
      vi.mocked(getSchedule).mockReturnValue({ name: 'il-team', days: ['sun', 'mon', 'tue', 'wed', 'thu'], default_time: '10:00' } as any);
      vi.mocked(getUserTimezone).mockResolvedValue({ tz_offset: 7200 });
      vi.mocked(getUserDate).mockReturnValue(new Date('2025-12-18'));
      vi.mocked(formatDate).mockReturnValue('2025-12-18');
      vi.mocked(getSubmissionsInRange).mockResolvedValue([]);
      vi.mocked(getTeamStats).mockResolvedValue([]);
      vi.mocked(countWorkdays).mockReturnValue(1);
      vi.mocked(getMissingSubmissions).mockResolvedValue([]);
      vi.mocked(formatManagerDigest).mockReturnValue('Digest content');
      vi.mocked(sendDM).mockResolvedValue({} as any);

      const response = await handleDigest(createContext(['digest', 'daily-il']));

      expect(formatManagerDigest).toHaveBeenCalledWith(expect.objectContaining({
        dailyName: 'daily-il',
        period: 'daily',
      }));
      expect(sendDM).toHaveBeenCalledWith(mockToken, 'U12345', 'Digest content');
      expect(response.text).toContain('Daily digest sent');
    });

    it('sends weekly digest as DM', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'il-team' } as any);
      vi.mocked(getSchedule).mockReturnValue({ name: 'il-team', days: ['sun', 'mon', 'tue', 'wed', 'thu'], default_time: '10:00' } as any);
      vi.mocked(getUserTimezone).mockResolvedValue({ tz_offset: 7200 });
      vi.mocked(getUserDate).mockReturnValue(new Date('2025-12-18'));
      vi.mocked(formatDate).mockImplementation((d) => d.toISOString().split('T')[0]);
      vi.mocked(getSubmissionsInRange).mockResolvedValue([]);
      vi.mocked(getTeamStats).mockResolvedValue([]);
      vi.mocked(countWorkdays).mockReturnValue(5);
      vi.mocked(formatManagerDigest).mockReturnValue('Weekly digest content');
      vi.mocked(sendDM).mockResolvedValue({} as any);

      const response = await handleDigest(createContext(['digest', 'daily-il', 'weekly']));

      expect(formatManagerDigest).toHaveBeenCalledWith(expect.objectContaining({
        dailyName: 'daily-il',
        period: 'weekly',
      }));
      expect(response.text).toContain('Weekly digest sent');
    });

    it('sends 4-week digest as DM', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'il-team' } as any);
      vi.mocked(getSchedule).mockReturnValue({ name: 'il-team', days: ['sun', 'mon', 'tue', 'wed', 'thu'], default_time: '10:00' } as any);
      vi.mocked(getUserTimezone).mockResolvedValue({ tz_offset: 7200 });
      vi.mocked(getUserDate).mockReturnValue(new Date('2025-12-18'));
      vi.mocked(formatDate).mockImplementation((d) => d.toISOString().split('T')[0]);
      vi.mocked(getSubmissionsInRange).mockResolvedValue([]);
      vi.mocked(getTeamStats).mockResolvedValue([]);
      vi.mocked(countWorkdays).mockReturnValue(20);
      vi.mocked(formatManagerDigest).mockReturnValue('4-week digest content');
      vi.mocked(sendDM).mockResolvedValue({} as any);

      const response = await handleDigest(createContext(['digest', 'daily-il', '4-week']));

      expect(formatManagerDigest).toHaveBeenCalledWith(expect.objectContaining({
        dailyName: 'daily-il',
        period: '4-week',
      }));
      expect(response.text).toContain('4-week digest sent');
    });
  });

  describe('handleWeek', () => {
    it('shows deprecation message when no daily name', async () => {
      const response = await handleWeek(createContext(['week']));

      expect(response.text).toContain('deprecated');
    });

    it('redirects to digest weekly', async () => {
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', schedule: 'il-team' } as any);
      vi.mocked(getSchedule).mockReturnValue({ name: 'il-team', days: ['sun', 'mon', 'tue', 'wed', 'thu'], default_time: '10:00' } as any);
      vi.mocked(getUserTimezone).mockResolvedValue({ tz_offset: 7200 });
      vi.mocked(getUserDate).mockReturnValue(new Date('2025-12-18'));
      vi.mocked(formatDate).mockImplementation((d) => d.toISOString().split('T')[0]);
      vi.mocked(getSubmissionsInRange).mockResolvedValue([]);
      vi.mocked(getTeamStats).mockResolvedValue([]);
      vi.mocked(countWorkdays).mockReturnValue(5);
      vi.mocked(formatManagerDigest).mockReturnValue('Weekly summary');
      vi.mocked(sendDM).mockResolvedValue({} as any);

      const response = await handleWeek(createContext(['week', 'daily-il']));

      expect(formatManagerDigest).toHaveBeenCalledWith(expect.objectContaining({
        period: 'weekly',
      }));
    });
  });

  describe('handleCommand router', () => {
    it('routes to help handler', async () => {
      const response = await handleCommand('help', createContext(['help']));
      expect(response.text).toContain('/standup');
    });

    it('returns error for unknown command', async () => {
      const response = await handleCommand('unknown', createContext(['unknown']));
      expect(response.text).toContain('Unknown command');
      expect(response.text).toContain('/standup help');
    });

    it('routes add command', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('add', createContext(['add']));
      expect(response.text).toContain('admin');
    });

    it('routes remove command', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('remove', createContext(['remove']));
      expect(response.text).toContain('admin');
    });

    it('routes list command', async () => {
      vi.mocked(getDailies).mockReturnValue([]);
      const response = await handleCommand('list', createContext(['list']));
      expect(response.text).toContain('dailies');
    });

    it('routes prompt command', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([]);
      const response = await handleCommand('prompt', createContext(['prompt']));
      expect(response.text).toContain('not part of');
    });

    it('routes digest command', async () => {
      const response = await handleCommand('digest', createContext(['digest']));
      expect(response.text).toContain('Usage');
    });

    it('routes week command (deprecated)', async () => {
      const response = await handleCommand('week', createContext(['week']));
      expect(response.text).toContain('deprecated');
    });
  });
});

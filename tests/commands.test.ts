/**
 * Integration tests for lib/handlers/commands.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config module
vi.mock('../lib/config', () => ({
  isAdmin: vi.fn(),
  isSuperAdmin: vi.fn(),
  getAdmins: vi.fn(() => ({ superAdmins: [], dbAdmins: [] })),
  getOverride: vi.fn(() => undefined),
  getDaily: vi.fn(),
  getLinearConfig: vi.fn(() => null),
  getGitHubConfig: vi.fn(() => null),
  getMaxPlanItems: vi.fn(() => 0),
  getSchedule: vi.fn(),
  getDailies: vi.fn(),
  getDailyManagers: vi.fn(() => []),
  getAllDailiesIncludingDisabled: vi.fn(),
  isDailyEnabled: vi.fn(() => true),
  getConfigError: vi.fn(() => null),
  clearConfigCache: vi.fn(),
  loadConfigOverrides: vi.fn(() => Promise.resolve()),
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
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getPreviousSubmission: vi.fn(() => Promise.resolve(null)),
  getTeamStats: vi.fn(),
  getMissingSubmissions: vi.fn(),
  countWorkdays: vi.fn(),
  getActiveOOOForDaily: vi.fn(() => []),
  setOOO: vi.fn(),
  clearOOO: vi.fn(),
  getUserOOO: vi.fn(() => []),
  setConfigOverride: vi.fn(),
  deleteConfigOverride: vi.fn(),
  getBlockerStreaks: vi.fn(() => []),
  getUnplannedOverload: vi.fn(() => []),
}));

// Mock slack module
vi.mock('../lib/slack', () => ({
  parseUserId: vi.fn(),
  ephemeralResponse: vi.fn((text: string) => ({ response_type: 'ephemeral', text })),
  sendDM: vi.fn(),
  openModal: vi.fn(() => Promise.resolve(true)),
  openModalAndGetViewId: vi.fn(() => Promise.resolve('V_LOADING')),
  updateModal: vi.fn(() => Promise.resolve(true)),
}));

// Mock interactions module (integration fetchers used by /daily)
vi.mock('../lib/handlers/interactions', () => ({
  fetchLinearIssuesForUser: vi.fn(() => Promise.resolve({ issues: [], allActiveIdentifiers: [] })),
  fetchGitHubPRsForUser: vi.fn(() => Promise.resolve({})),
}));

// Mock prompt module
vi.mock('../lib/prompt', () => ({
  getUserTimezone: vi.fn(() => ({ tz_offset: 0 })),
  getUserDate: vi.fn(() => new Date('2024-01-15')),
  formatDate: vi.fn(() => '2024-01-15'),
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
  handleOOO,
  handleCommand,
  handleDaily,
  CommandContext,
} from '../lib/handlers/commands';

import { isAdmin, isSuperAdmin, getAdmins, getOverride, getDaily, getLinearConfig, getGitHubConfig, getSchedule, getDailies, getDailyManagers, getConfigError, getAllDailiesIncludingDisabled, isDailyEnabled, clearConfigCache, loadConfigOverrides } from '../lib/config';
import { addParticipant, removeParticipant, getParticipants, getSubmissionsInRange, getUserDailies, getTeamStats, getMissingSubmissions, countWorkdays, setOOO, clearOOO, getUserOOO, setConfigOverride, deleteConfigOverride } from '../lib/db';
import { parseUserId, sendDM, openModal, openModalAndGetViewId, updateModal } from '../lib/slack';
import { fetchLinearIssuesForUser, fetchGitHubPRsForUser } from '../lib/handlers/interactions';
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
    it('lists all dailies with participants when no name provided', async () => {
      vi.mocked(getAllDailiesIncludingDisabled).mockReturnValue([
        { name: 'daily-il', channel: '#il-standup' },
        { name: 'daily-us', channel: '#us-standup' },
      ] as any);
      vi.mocked(getParticipants)
        .mockResolvedValueOnce([{ slack_user_id: 'U111' }] as any)
        .mockResolvedValueOnce([{ slack_user_id: 'U222' }, { slack_user_id: 'U333' }] as any);

      const response = await handleList(createContext(['list']));

      expect(response.text).toContain('daily-il');
      expect(response.text).toContain('daily-us');
      expect(response.text).toContain('<@U111>');
      expect(response.text).toContain('<@U222>');
    });

    it('lists all dailies with participants when "all" provided', async () => {
      vi.mocked(getAllDailiesIncludingDisabled).mockReturnValue([
        { name: 'daily-il', channel: '#il-standup' },
      ] as any);
      vi.mocked(getParticipants).mockResolvedValue([{ slack_user_id: 'U111' }] as any);

      const response = await handleList(createContext(['list', 'all']));

      expect(response.text).toContain('daily-il');
      expect(response.text).toContain('<@U111>');
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

  describe('handleOOO', () => {
    it('requires user to be in a daily', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([]);

      const response = await handleOOO(createContext(['ooo']));

      expect(response.text).toContain('not part of any dailies');
    });

    it('shows current OOO status when no subcommand', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(getUserOOO).mockResolvedValue([]);

      const response = await handleOOO(createContext(['ooo']));

      expect(response.text).toContain('OOO Status');
      expect(response.text).toContain('daily-il');
    });

    it('sets OOO for tomorrow', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(setOOO).mockResolvedValue({} as any);

      const response = await handleOOO(createContext(['ooo', 'tomorrow']));

      expect(setOOO).toHaveBeenCalled();
      expect(response.text).toContain('Out of office tomorrow');
    });

    it('clears OOO periods', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(clearOOO).mockResolvedValue(1);

      const response = await handleOOO(createContext(['ooo', 'clear']));

      expect(clearOOO).toHaveBeenCalled();
      expect(response.text).toContain('Cleared');
    });

    it('sets OOO for date range', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
      vi.mocked(setOOO).mockResolvedValue({} as any);

      const response = await handleOOO(createContext(['ooo', '2025-01-01', 'to', '2025-01-05']));

      expect(setOOO).toHaveBeenCalledWith(mockDb, 'U12345', 'daily-il', '2025-01-01', '2025-01-05');
      expect(response.text).toContain('Out of office from');
    });

    it('shows usage for invalid subcommand', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);

      const response = await handleOOO(createContext(['ooo', 'invalid']));

      expect(response.text).toContain('OOO Usage');
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
      vi.mocked(getAllDailiesIncludingDisabled).mockReturnValue([]);
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

    it('routes config reload command', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getAllDailiesIncludingDisabled).mockReturnValue([
        { name: 'daily-il' },
      ] as any);
      const response = await handleCommand('config', createContext(['config', 'reload']));
      expect(response.text).toContain('Config reloaded');
    });

    it('routes pause command', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(isDailyEnabled).mockReturnValue(true);
      const response = await handleCommand('pause', createContext(['pause', 'daily-il']));
      expect(response.text).toContain('paused');
      expect(setConfigOverride).toHaveBeenCalled();
    });

    it('routes resume command', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(isDailyEnabled).mockReturnValue(false);
      const response = await handleCommand('resume', createContext(['resume', 'daily-il']));
      expect(response.text).toContain('active');
      expect(deleteConfigOverride).toHaveBeenCalled();
    });
  });

  describe('dynamic configuration commands', () => {
    it('config reload requires admin', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('config', createContext(['config', 'reload']));
      expect(response.text).toContain('admin');
    });

    it('pause requires admin', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('pause', createContext(['pause', 'daily-il']));
      expect(response.text).toContain('admin');
    });

    it('resume requires admin', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('resume', createContext(['resume', 'daily-il']));
      expect(response.text).toContain('admin');
    });

    it('pause requires daily name', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      const response = await handleCommand('pause', createContext(['pause']));
      expect(response.text).toContain('Usage');
    });

    it('pause validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue(undefined);
      const response = await handleCommand('pause', createContext(['pause', 'nonexistent']));
      expect(response.text).toContain('Unknown daily');
    });

    it('pause shows message when already paused', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(isDailyEnabled).mockReturnValue(false);
      const response = await handleCommand('pause', createContext(['pause', 'daily-il']));
      expect(response.text).toContain('already paused');
    });

    it('resume shows message when already active', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(isDailyEnabled).mockReturnValue(true);
      const response = await handleCommand('resume', createContext(['resume', 'daily-il']));
      expect(response.text).toContain('already active');
    });

    it('list shows paused indicator', async () => {
      vi.mocked(getAllDailiesIncludingDisabled).mockReturnValue([
        { name: 'daily-il', channel: '#il-standup' },
      ] as any);
      vi.mocked(isDailyEnabled).mockReturnValue(false);
      vi.mocked(getParticipants).mockResolvedValue([{ slack_user_id: 'U111' }] as any);

      const response = await handleList(createContext(['list']));
      expect(response.text).toContain('⏸️');
    });
  });

  describe('admin management', () => {
    it('admin list shows super-admins and db admins', async () => {
      vi.mocked(getAdmins).mockReturnValue({ superAdmins: ['U_SUPER'], dbAdmins: ['U_DB1'] });
      const response = await handleCommand('admin', createContext(['admin', 'list']));
      expect(response.text).toContain('U_SUPER');
      expect(response.text).toContain('U_DB1');
      expect(response.text).toContain('Super-admins');
    });

    it('admin list omits DB admins section when there are none', async () => {
      vi.mocked(getAdmins).mockReturnValue({ superAdmins: ['U_SUPER'], dbAdmins: [] });
      const response = await handleCommand('admin', createContext(['admin', 'list']));
      expect(response.text).toContain('U_SUPER');
      expect(response.text).not.toContain('Admins (added)');
    });

    it('admin list works for non-super-admins', async () => {
      vi.mocked(getAdmins).mockReturnValue({ superAdmins: ['U_SUPER'], dbAdmins: [] });
      vi.mocked(isSuperAdmin).mockReturnValue(false);
      const response = await handleCommand('admin', createContext(['admin', 'list']));
      expect(response.text).toContain('U_SUPER');
    });

    it('admin add requires super-admin', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(false);
      vi.mocked(parseUserId).mockReturnValue('U_NEW');
      const response = await handleCommand('admin', createContext(['admin', 'add', '<@U_NEW>']));
      expect(response.text).toContain('super-admin');
    });

    it('admin add succeeds for super-admin', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U_NEW');
      vi.mocked(isAdmin).mockReturnValue(false);
      vi.mocked(getOverride).mockReturnValue(undefined);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      const response = await handleCommand('admin', createContext(['admin', 'add', '<@U_NEW>']));
      expect(response.text).toContain('now an admin');
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'global', 'admins', ['U_NEW'], 'U12345');
    });

    it('admin add appends to existing DB admins list', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U_NEW');
      vi.mocked(isAdmin).mockReturnValue(false);
      vi.mocked(getOverride).mockReturnValue(['U_EXISTING_DB']);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      await handleCommand('admin', createContext(['admin', 'add', '<@U_NEW>']));
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'global', 'admins', ['U_EXISTING_DB', 'U_NEW'], 'U12345');
    });

    it('admin add rejects if already admin', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U_EXISTING');
      vi.mocked(isAdmin).mockReturnValue(true);

      const response = await handleCommand('admin', createContext(['admin', 'add', '<@U_EXISTING>']));
      expect(response.text).toContain('already an admin');
    });

    it('admin add requires user mention', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue(null);

      const response = await handleCommand('admin', createContext(['admin', 'add']));
      expect(response.text).toContain('Usage');
    });

    it('admin remove requires user mention', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue(null);

      const response = await handleCommand('admin', createContext(['admin', 'remove']));
      expect(response.text).toContain('Usage');
    });

    it('admin remove succeeds', async () => {
      vi.mocked(isSuperAdmin).mockImplementation((id) => id === 'U12345');
      vi.mocked(parseUserId).mockReturnValue('U_DB1');
      vi.mocked(getOverride).mockReturnValue(['U_DB1', 'U_DB2']);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      const response = await handleCommand('admin', createContext(['admin', 'remove', '<@U_DB1>']));
      expect(response.text).toContain('no longer an admin');
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'global', 'admins', ['U_DB2'], 'U12345');
    });

    it('admin remove rejects super-admin removal', async () => {
      vi.mocked(isSuperAdmin).mockImplementation((id) => id === 'U_SUPER' || id === 'U12345');
      vi.mocked(parseUserId).mockReturnValue('U_SUPER');

      const response = await handleCommand('admin', createContext(['admin', 'remove', '<@U_SUPER>']));
      expect(response.text).toContain('Cannot remove a super-admin');
    });

    it('admin remove rejects if not a DB admin', async () => {
      vi.mocked(isSuperAdmin).mockImplementation((id) => id === 'U12345');
      vi.mocked(parseUserId).mockReturnValue('U_UNKNOWN');
      vi.mocked(getOverride).mockReturnValue([]);

      const response = await handleCommand('admin', createContext(['admin', 'remove', '<@U_UNKNOWN>']));
      expect(response.text).toContain('not a DB-added admin');
    });

    it('admin remove rejects if override list is undefined (no DB admins ever added)', async () => {
      vi.mocked(isSuperAdmin).mockImplementation((id) => id === 'U12345');
      vi.mocked(parseUserId).mockReturnValue('U_UNKNOWN');
      vi.mocked(getOverride).mockReturnValue(undefined);

      const response = await handleCommand('admin', createContext(['admin', 'remove', '<@U_UNKNOWN>']));
      expect(response.text).toContain('not a DB-added admin');
    });

    it('admin with unknown action returns usage', async () => {
      vi.mocked(isSuperAdmin).mockReturnValue(true);

      const response = await handleCommand('admin', createContext(['admin', 'badaction']));
      expect(response.text).toContain('Usage');
      expect(response.text).toContain('admin');
    });
  });

  describe('manager management', () => {
    it('manager commands require admin', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handleCommand('manager', createContext(['manager', 'list', 'daily-il']));
      expect(response.text).toContain('Only admins');
    });

    it('manager list shows managers for a daily as Slack mentions', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getDailyManagers).mockReturnValue(['U_MGR1', 'U_MGR2']);

      const response = await handleCommand('manager', createContext(['manager', 'list', 'daily-il']));
      expect(response.text).toContain('<@U_MGR1>');
      expect(response.text).toContain('<@U_MGR2>');
    });

    it('manager list shows empty message', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getDailyManagers).mockReturnValue([]);

      const response = await handleCommand('manager', createContext(['manager', 'list', 'daily-il']));
      expect(response.text).toContain('no managers');
    });

    it('manager list requires daily name', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      const response = await handleCommand('manager', createContext(['manager', 'list']));
      expect(response.text).toContain('Usage');
    });

    it('manager list validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue(undefined);
      const response = await handleCommand('manager', createContext(['manager', 'list', 'fake']));
      expect(response.text).toContain('not found');
    });

    it('manager add succeeds', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_NEW_MGR' : null);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getDailyManagers).mockReturnValue([]);
      vi.mocked(getOverride).mockReturnValue(undefined);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      const response = await handleCommand('manager', createContext(['manager', 'add', 'daily-il', '<@U_NEW_MGR>']));
      expect(response.text).toContain('now a manager');
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'daily-il', 'managers', ['U_NEW_MGR'], 'U12345');
    });

    it('manager add appends to existing DB managers list', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_NEW_MGR' : null);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getDailyManagers).mockReturnValue(['U_YAML_MGR']);
      vi.mocked(getOverride).mockReturnValue(['U_YAML_MGR']);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      await handleCommand('manager', createContext(['manager', 'add', 'daily-il', '<@U_NEW_MGR>']));
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'daily-il', 'managers', ['U_YAML_MGR', 'U_NEW_MGR'], 'U12345');
    });

    it('manager add rejects duplicate', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U_EXISTING_MGR');
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getDailyManagers).mockReturnValue(['U_EXISTING_MGR']);

      const response = await handleCommand('manager', createContext(['manager', 'add', 'daily-il', '<@U_EXISTING_MGR>']));
      expect(response.text).toContain('already a manager');
    });

    it('manager add requires daily name and user mention', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue(null);

      const response = await handleCommand('manager', createContext(['manager', 'add']));
      expect(response.text).toContain('Usage');
    });

    it('manager add validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_NEW_MGR' : null);
      vi.mocked(getDaily).mockReturnValue(undefined);

      const response = await handleCommand('manager', createContext(['manager', 'add', 'nonexistent', '<@U_NEW_MGR>']));
      expect(response.text).toContain('not found');
    });

    it('manager remove succeeds', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_MGR1' : null);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getOverride).mockReturnValue(['U_MGR1', 'U_MGR2']);
      vi.mocked(setConfigOverride).mockResolvedValue();
      vi.mocked(loadConfigOverrides).mockResolvedValue();

      const response = await handleCommand('manager', createContext(['manager', 'remove', 'daily-il', '<@U_MGR1>']));
      expect(response.text).toContain('no longer a manager');
      expect(setConfigOverride).toHaveBeenCalledWith(mockDb, 'daily-il', 'managers', ['U_MGR2'], 'U12345');
    });

    it('manager remove rejects if not a DB manager', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue('U_YAML_MGR');
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getOverride).mockReturnValue([]);

      const response = await handleCommand('manager', createContext(['manager', 'remove', 'daily-il', '<@U_YAML_MGR>']));
      expect(response.text).toContain('not a DB-added manager');
    });

    it('manager remove rejects YAML-only managers (override undefined)', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_YAML_MGR' : null);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getOverride).mockReturnValue(undefined);

      const response = await handleCommand('manager', createContext(['manager', 'remove', 'daily-il', '<@U_YAML_MGR>']));
      expect(response.text).toContain('not a DB-added manager');
      expect(response.text).toContain('YAML managers must be removed from config');
    });

    it('manager remove requires daily name and user mention', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockReturnValue(null);

      const response = await handleCommand('manager', createContext(['manager', 'remove']));
      expect(response.text).toContain('Usage');
    });

    it('manager remove validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(parseUserId).mockImplementation((text) => text.includes('<@') ? 'U_MGR1' : null);
      vi.mocked(getDaily).mockReturnValue(undefined);

      const response = await handleCommand('manager', createContext(['manager', 'remove', 'nonexistent', '<@U_MGR1>']));
      expect(response.text).toContain('not found');
    });

    it('manager with no action shows usage', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      const response = await handleCommand('manager', createContext(['manager']));
      expect(response.text).toContain('Usage');
    });

    it('manager with unknown action shows usage', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      const response = await handleCommand('manager', createContext(['manager', 'badaction', 'daily-il']));
      expect(response.text).toContain('Usage');
    });
  });

  describe('mass prompt (prompt all <daily>)', () => {
    const createContextWithTrigger = (args: string[]): CommandContext => ({
      userId: 'U12345',
      args,
      db: mockDb,
      slackToken: mockToken,
      triggerId: 'test-trigger-id',
    });

    it('requires admin', async () => {
      vi.mocked(isAdmin).mockReturnValue(false);
      const response = await handlePrompt(createContextWithTrigger(['prompt', 'all', 'daily-il']));
      expect(response.text).toContain('admin');
    });

    it('validates daily exists', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue(undefined);
      const response = await handlePrompt(createContextWithTrigger(['prompt', 'all', 'nonexistent']));
      expect(response.text).toContain('not found');
    });

    it('shows error when no participants', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getParticipants).mockResolvedValue([]);
      const response = await handlePrompt(createContextWithTrigger(['prompt', 'all', 'daily-il']));
      expect(response.text).toContain('No participants');
    });

    it('opens confirmation modal with participant count', async () => {
      vi.mocked(isAdmin).mockReturnValue(true);
      vi.mocked(getDaily).mockReturnValue({ name: 'daily-il' } as any);
      vi.mocked(getParticipants).mockResolvedValue([
        { slack_user_id: 'U111' },
        { slack_user_id: 'U222' },
        { slack_user_id: 'U333' },
      ] as any);

      const response = await handlePrompt(createContextWithTrigger(['prompt', 'all', 'daily-il']));

      expect(openModal).toHaveBeenCalled();
      const modalCall = vi.mocked(openModal).mock.calls[0];
      const view = modalCall[2] as any;
      expect(view.callback_id).toBe('mass_prompt_confirm');
      expect(view.blocks[0].text.text).toContain('3 participants');
    });

    it('falls through to self-prompt when only `prompt all` (no daily name)', async () => {
      vi.mocked(getUserDailies).mockResolvedValue([
        { daily_name: 'daily-il' },
      ] as any);
      vi.mocked(sendPromptDM).mockResolvedValue(true);

      const response = await handlePrompt(createContextWithTrigger(['prompt', 'all']));
      expect(response.text).toContain('Sent prompts for 1 dailies');
    });
  });
});

describe('handleDaily — instant modal open + background fill', () => {
  const makeCtx = (over: Partial<CommandContext> = {}) => {
    const promises: Promise<unknown>[] = [];
    const ctx = {
      userId: 'U12345',
      args: ['daily-il'],
      db: {} as any,
      slackToken: 'xoxb-test',
      triggerId: 'trig-1',
      env: {},
      waitUntil: (p: Promise<unknown>) => { promises.push(p); },
      ...over,
    } as CommandContext;
    return { ctx, promises };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getUserDailies).mockResolvedValue([{ daily_name: 'daily-il' }] as any);
    vi.mocked(getDaily).mockReturnValue({ name: 'daily-il', questions: [] } as any);
    vi.mocked(getUserTimezone).mockResolvedValue({ tz_offset: 0 } as any);
    vi.mocked(getUserDate).mockReturnValue(new Date('2024-01-15'));
    vi.mocked(formatDate).mockReturnValue('2024-01-15');
    vi.mocked(openModal).mockResolvedValue(true);
    vi.mocked(openModalAndGetViewId).mockResolvedValue('V_LOADING');
    vi.mocked(updateModal).mockResolvedValue(true);
    vi.mocked(fetchLinearIssuesForUser).mockResolvedValue({ issues: [], allActiveIdentifiers: [] } as any);
    vi.mocked(fetchGitHubPRsForUser).mockResolvedValue({} as any);
  });

  it('opens a loading modal immediately, then fills via views.update in the background', async () => {
    vi.mocked(getLinearConfig).mockReturnValue({ tokenEnvVar: 'LINEAR_TOKEN' } as any);
    const { ctx, promises } = makeCtx();

    const res = await handleDaily(ctx);

    // Modal opened immediately, with a loading indicator.
    expect(openModalAndGetViewId).toHaveBeenCalledTimes(1);
    const loadingView = vi.mocked(openModalAndGetViewId).mock.calls[0][2] as any;
    expect(loadingView.blocks.some((b: any) => b.block_id === 'integrations_loading')).toBe(true);
    expect((res as any).text).toContain('Opening standup');

    // The modal is opened BEFORE integrations are fetched (the whole point —
    // the trigger_id is consumed inside the 3s window, fetches come after).
    expect(vi.mocked(openModalAndGetViewId).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(fetchLinearIssuesForUser).mock.invocationCallOrder[0]);
    // The fill (views.update) has NOT happened on the critical path.
    expect(updateModal).not.toHaveBeenCalled();

    // Background work fetches integrations and updates the same view.
    await Promise.all(promises);
    expect(fetchLinearIssuesForUser).toHaveBeenCalledTimes(1);
    expect(fetchGitHubPRsForUser).toHaveBeenCalledTimes(1);
    expect(updateModal).toHaveBeenCalledTimes(1);
    expect(vi.mocked(updateModal).mock.calls[0][1]).toBe('V_LOADING');
    const filledView = vi.mocked(updateModal).mock.calls[0][2] as any;
    expect(filledView.blocks.some((b: any) => b.block_id === 'integrations_loading')).toBe(false);
  });

  it('falls back to a synchronous open (no views.update) when waitUntil is unavailable', async () => {
    vi.mocked(getLinearConfig).mockReturnValue({ tokenEnvVar: 'LINEAR_TOKEN' } as any);
    const { ctx } = makeCtx({ waitUntil: undefined });

    await handleDaily(ctx);

    expect(openModal).toHaveBeenCalledTimes(1);
    expect(openModalAndGetViewId).not.toHaveBeenCalled();
    expect(updateModal).not.toHaveBeenCalled();
    expect(fetchLinearIssuesForUser).toHaveBeenCalledTimes(1);
  });

  it('opens directly without a background fill when the daily has no integrations', async () => {
    vi.mocked(getLinearConfig).mockReturnValue(null);
    vi.mocked(getGitHubConfig).mockReturnValue(null);
    const { ctx } = makeCtx();

    await handleDaily(ctx);

    expect(openModal).toHaveBeenCalledTimes(1);
    expect(openModalAndGetViewId).not.toHaveBeenCalled();
    expect(updateModal).not.toHaveBeenCalled();
  });
});

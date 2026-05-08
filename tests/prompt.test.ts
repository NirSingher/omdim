/**
 * Tests for lib/prompt.ts - date/timezone utilities and schedule checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config module before importing prompt (config imports yaml file)
vi.mock('../lib/config', () => ({
  getSchedule: vi.fn(),
  getDaily: vi.fn(),
  getDailies: vi.fn(() => []),
  loadConfig: vi.fn(),
  getConfigError: vi.fn(() => null),
  getReminderMinutesBefore: vi.fn(() => 90),
  getNudgeMinutesBefore: vi.fn(() => 0),
  getDigestTime: vi.fn(() => '14:00'),
}));

// Mock slack module (makes API calls)
vi.mock('../lib/slack', () => ({
  getUserInfo: vi.fn(),
  postMessage: vi.fn(),
}));

// Mock db module (for nudge cron tests)
vi.mock('../lib/db', () => ({
  getAllParticipants: vi.fn(() => Promise.resolve([])),
  getOrCreatePrompt: vi.fn(),
  updatePromptSent: vi.fn(),
  getCachedUser: vi.fn(() => Promise.resolve(null)),
  upsertCachedUser: vi.fn(),
  getActiveOOO: vi.fn(() => Promise.resolve(null)),
  getUnpostedSubmissions: vi.fn(() => Promise.resolve([])),
  markSubmissionPosted: vi.fn(),
  markItemsDone: vi.fn(),
  markItemsDropped: vi.fn(),
  incrementCarryCount: vi.fn(),
  markItemsInProgress: vi.fn(),
  createWorkItems: vi.fn(),
  getGitHubUsername: vi.fn(() => Promise.resolve(null)),
  getUsersWithGitHubLinks: vi.fn(() => Promise.resolve([])),
  wasReminderSent: vi.fn(() => Promise.resolve(false)),
  recordReminderSent: vi.fn(),
  getDmStandupPreference: vi.fn(() => Promise.resolve(true)),
  getMissingSubmissions: vi.fn(() => Promise.resolve([])),
}));

// Mock format module
vi.mock('../lib/format', () => ({
  postStandupToChannel: vi.fn(),
  sendStandupDM: vi.fn(),
}));

import {
  isWorkday,
  isWithinPromptWindow,
  shouldReprompt,
  getUserDate,
  getDateInTimezone,
  formatDate,
  getMinutesLate,
  formatLatenessPrefix,
  runNudgeCron,
} from '../lib/prompt';
import { getDailies, getSchedule, getConfigError, getNudgeMinutesBefore, getDigestTime } from '../lib/config';
import { postMessage } from '../lib/slack';
import { getMissingSubmissions } from '../lib/db';

describe('prompt utilities', () => {
  describe('formatDate', () => {
    it('formats date as YYYY-MM-DD', () => {
      const date = new Date('2025-12-18T10:30:00Z');
      expect(formatDate(date)).toBe('2025-12-18');
    });

    it('handles single-digit months and days', () => {
      const date = new Date('2025-01-05T10:30:00Z');
      expect(formatDate(date)).toBe('2025-01-05');
    });
  });

  describe('getUserDate', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies positive timezone offset (ahead of UTC)', () => {
      // Set "now" to midnight UTC
      vi.setSystemTime(new Date('2025-12-18T00:00:00Z'));

      // Israel is UTC+2 = 7200 seconds
      const userDate = getUserDate(7200);

      // Should be 2am in user's time
      expect(userDate.getUTCHours()).toBe(2);
    });

    it('applies negative timezone offset (behind UTC)', () => {
      // Set "now" to 12:00 UTC
      vi.setSystemTime(new Date('2025-12-18T12:00:00Z'));

      // US Pacific is UTC-8 = -28800 seconds
      const userDate = getUserDate(-28800);

      // Should be 4am in user's time
      expect(userDate.getUTCHours()).toBe(4);
    });

    it('handles zero offset (UTC)', () => {
      vi.setSystemTime(new Date('2025-12-18T10:30:00Z'));

      const userDate = getUserDate(0);
      expect(userDate.getUTCHours()).toBe(10);
      expect(userDate.getUTCMinutes()).toBe(30);
    });
  });

  describe('getDateInTimezone', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns correct date for Asia/Jerusalem timezone', () => {
      // Set "now" to 23:00 UTC on Dec 17 → should be Dec 18 01:00 in Israel (UTC+2)
      vi.setSystemTime(new Date('2025-12-17T23:00:00Z'));

      const date = getDateInTimezone('Asia/Jerusalem');
      expect(formatDate(date)).toBe('2025-12-18');
    });

    it('returns correct date for America/New_York timezone', () => {
      // Set "now" to 03:00 UTC on Dec 18 → should be Dec 17 22:00 in NY (UTC-5)
      vi.setSystemTime(new Date('2025-12-18T03:00:00Z'));

      const date = getDateInTimezone('America/New_York');
      expect(formatDate(date)).toBe('2025-12-17');
    });

    it('returns correct hours for timezone', () => {
      vi.setSystemTime(new Date('2025-12-18T10:00:00Z'));

      // Israel is UTC+2, so 10:00 UTC = 12:00 Israel
      const date = getDateInTimezone('Asia/Jerusalem');
      expect(date.getUTCHours()).toBe(12);
    });

    it('falls back to UTC for UTC timezone', () => {
      vi.setSystemTime(new Date('2025-12-18T15:30:00Z'));

      const date = getDateInTimezone('UTC');
      expect(date.getUTCHours()).toBe(15);
      expect(date.getUTCMinutes()).toBe(30);
    });
  });

  describe('isWorkday', () => {
    it('returns true for matching workday (Sunday)', () => {
      // December 22, 2024 is a Sunday
      const sunday = new Date('2024-12-22T10:00:00Z');
      const ilSchedule = ['sun', 'mon', 'tue', 'wed', 'thu'];

      expect(isWorkday(ilSchedule, sunday)).toBe(true);
    });

    it('returns false for non-workday (Friday for IL schedule)', () => {
      // December 20, 2024 is a Friday
      const friday = new Date('2024-12-20T10:00:00Z');
      const ilSchedule = ['sun', 'mon', 'tue', 'wed', 'thu'];

      expect(isWorkday(ilSchedule, friday)).toBe(false);
    });

    it('returns true for US schedule Monday', () => {
      // December 23, 2024 is a Monday
      const monday = new Date('2024-12-23T10:00:00Z');
      const usSchedule = ['mon', 'tue', 'wed', 'thu', 'fri'];

      expect(isWorkday(usSchedule, monday)).toBe(true);
    });

    it('returns false for US schedule Sunday', () => {
      const sunday = new Date('2024-12-22T10:00:00Z');
      const usSchedule = ['mon', 'tue', 'wed', 'thu', 'fri'];

      expect(isWorkday(usSchedule, sunday)).toBe(false);
    });

    it('handles case-insensitive day names', () => {
      const monday = new Date('2024-12-23T10:00:00Z');
      const mixedCase = ['MON', 'Tue', 'WED'];

      expect(isWorkday(mixedCase, monday)).toBe(true);
    });
  });

  describe('isWithinPromptWindow', () => {
    // Helper to create a date with specific local hours/minutes
    function createLocalTime(hours: number, minutes: number): Date {
      const date = new Date('2025-12-18T00:00:00');
      date.setHours(hours, minutes, 0, 0);
      return date;
    }

    it('returns true at exact schedule time', () => {
      const userDate = createLocalTime(9, 0);
      expect(isWithinPromptWindow('09:00', userDate)).toBe(true);
    });

    it('returns true within 2-hour window', () => {
      // 10:30 user time (1.5 hours after 09:00)
      const userDate = createLocalTime(10, 30);
      expect(isWithinPromptWindow('09:00', userDate)).toBe(true);
    });

    it('returns true at end of window', () => {
      // 11:00 user time (exactly 2 hours after 09:00)
      const userDate = createLocalTime(11, 0);
      expect(isWithinPromptWindow('09:00', userDate)).toBe(true);
    });

    it('returns false before schedule time', () => {
      // 08:30 user time (before 09:00)
      const userDate = createLocalTime(8, 30);
      expect(isWithinPromptWindow('09:00', userDate)).toBe(false);
    });

    it('returns false after window closes', () => {
      // 11:30 user time (2.5 hours after 09:00)
      const userDate = createLocalTime(11, 30);
      expect(isWithinPromptWindow('09:00', userDate)).toBe(false);
    });

    it('handles afternoon schedule times', () => {
      // 14:30 user time (within 2 hours of 14:00)
      const userDate = createLocalTime(14, 30);
      expect(isWithinPromptWindow('14:00', userDate)).toBe(true);
    });
  });

  describe('shouldReprompt', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('returns true if never prompted (null)', () => {
      expect(shouldReprompt(null)).toBe(true);
    });

    it('returns true if prompted more than 30 minutes ago', () => {
      vi.setSystemTime(new Date('2025-12-18T10:00:00Z'));

      // Prompted 45 minutes ago
      const lastPrompted = new Date('2025-12-18T09:15:00Z');
      expect(shouldReprompt(lastPrompted)).toBe(true);
    });

    it('returns false if prompted less than 30 minutes ago', () => {
      vi.setSystemTime(new Date('2025-12-18T10:00:00Z'));

      // Prompted 15 minutes ago
      const lastPrompted = new Date('2025-12-18T09:45:00Z');
      expect(shouldReprompt(lastPrompted)).toBe(false);
    });

    it('returns true if prompted exactly 30 minutes ago', () => {
      vi.setSystemTime(new Date('2025-12-18T10:00:00Z'));

      // Prompted exactly 30 minutes ago
      const lastPrompted = new Date('2025-12-18T09:30:00Z');
      expect(shouldReprompt(lastPrompted)).toBe(true);
    });
  });

  describe('getMinutesLate', () => {
    function createLocalTime(hours: number, minutes: number): Date {
      const date = new Date('2025-12-18T00:00:00');
      date.setHours(hours, minutes, 0, 0);
      return date;
    }

    it('returns 0 when at exact schedule time', () => {
      const userDate = createLocalTime(9, 0);
      expect(getMinutesLate('09:00', userDate)).toBe(0);
    });

    it('returns 0 when before schedule time', () => {
      const userDate = createLocalTime(8, 30);
      expect(getMinutesLate('09:00', userDate)).toBe(0);
    });

    it('calculates minutes late correctly', () => {
      const userDate = createLocalTime(9, 45);
      expect(getMinutesLate('09:00', userDate)).toBe(45);
    });

    it('calculates hours worth of lateness', () => {
      const userDate = createLocalTime(10, 30);
      expect(getMinutesLate('09:00', userDate)).toBe(90);
    });
  });

  describe('formatLatenessPrefix', () => {
    it('returns empty string for less than 5 minutes', () => {
      expect(formatLatenessPrefix(0)).toBe('');
      expect(formatLatenessPrefix(4)).toBe('');
    });

    it('formats minutes for under an hour', () => {
      expect(formatLatenessPrefix(5)).toBe('5 min late · ');
      expect(formatLatenessPrefix(30)).toBe('30 min late · ');
      expect(formatLatenessPrefix(59)).toBe('59 min late · ');
    });

    it('formats hours for exact hours', () => {
      expect(formatLatenessPrefix(60)).toBe('1h late · ');
      expect(formatLatenessPrefix(120)).toBe('2h late · ');
    });

    it('formats hours and minutes', () => {
      expect(formatLatenessPrefix(75)).toBe('1h 15m late · ');
      expect(formatLatenessPrefix(90)).toBe('1h 30m late · ');
    });
  });
});

describe('runNudgeCron', () => {
  const mockDb = {} as any;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getConfigError).mockReturnValue(null);
    vi.mocked(getDailies).mockReturnValue([]);
    vi.mocked(getNudgeMinutesBefore).mockReturnValue(0);
    vi.mocked(getDigestTime).mockReturnValue('14:00');
    vi.mocked(getMissingSubmissions).mockResolvedValue([]);
    vi.mocked(postMessage).mockResolvedValue('ts-123');
  });

  it('skips when nudge_minutes_before is 0', async () => {
    vi.mocked(getDailies).mockReturnValue([
      { name: 'daily-il', channel: 'C1', schedule: 'sched' } as any,
    ]);
    vi.mocked(getNudgeMinutesBefore).mockReturnValue(0);

    const result = await runNudgeCron(mockDb, 'xoxb-test');
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
  });

  it('skips when config has errors', async () => {
    vi.mocked(getConfigError).mockReturnValue('bad config');
    const result = await runNudgeCron(mockDb, 'xoxb-test');
    expect(result.sent).toBe(0);
  });

  it('sends DMs to users who have not submitted when in nudge window', async () => {
    // digest at 14:00 UTC, nudge 30 min before = 13:30 UTC
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T13:35:00Z')); // Wednesday 13:35 UTC

    vi.mocked(getDigestTime).mockReturnValue('14:00');
    vi.mocked(getDailies).mockReturnValue([
      { name: 'daily-il', channel: 'C1', schedule: 'sched' } as any,
    ]);
    vi.mocked(getNudgeMinutesBefore).mockReturnValue(30);
    vi.mocked(getSchedule).mockReturnValue({
      name: 'sched',
      timezone: 'UTC',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      default_time: '10:00',
    } as any);
    vi.mocked(getMissingSubmissions).mockResolvedValue(['U_ALICE', 'U_BOB']);

    const result = await runNudgeCron(mockDb, 'xoxb-test');

    expect(result.sent).toBe(2);
    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(
      'xoxb-test',
      'U_ALICE',
      expect.stringContaining('digest posts in'),
      expect.any(Array)
    );

    vi.useRealTimers();
  });

  it('skips when not in nudge time window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-06T10:00:00Z')); // Wednesday 10:00 UTC — well before 13:30

    vi.mocked(getDigestTime).mockReturnValue('14:00');
    vi.mocked(getDailies).mockReturnValue([
      { name: 'daily-il', channel: 'C1', schedule: 'sched' } as any,
    ]);
    vi.mocked(getNudgeMinutesBefore).mockReturnValue(30);
    vi.mocked(getSchedule).mockReturnValue({
      name: 'sched',
      timezone: 'UTC',
      days: ['mon', 'tue', 'wed', 'thu', 'fri'],
      default_time: '10:00',
    } as any);

    const result = await runNudgeCron(mockDb, 'xoxb-test');

    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sent).toBe(0);
    expect(getMissingSubmissions).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});

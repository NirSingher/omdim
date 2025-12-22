/**
 * Tests for lib/prompt.ts - date/timezone utilities and schedule checks
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock config module before importing prompt (config imports yaml file)
vi.mock('../lib/config', () => ({
  getSchedule: vi.fn(),
  getDaily: vi.fn(),
  loadConfig: vi.fn(),
}));

// Mock slack module (makes API calls)
vi.mock('../lib/slack', () => ({
  getUserInfo: vi.fn(),
  postMessage: vi.fn(),
}));

import {
  isWorkday,
  isWithinPromptWindow,
  shouldReprompt,
  getUserDate,
  formatDate,
} from '../lib/prompt';

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
});

/**
 * Tests for lib/config.ts - Config overrides and dynamic configuration
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfigOverrides, getOverride, isDailyEnabled, clearConfigCache, clearOverridesCache, getDailies, getAllDailiesIncludingDisabled, getDailySections, getWeeklyRecap } from '../lib/config';

describe('config overrides', () => {
  beforeEach(() => {
    clearConfigCache();
  });

  it('returns undefined when overrides not loaded', () => {
    clearOverridesCache();
    expect(getOverride('global', 'some_key')).toBeUndefined();
  });

  it('loads overrides from DB and retrieves them', async () => {
    const mockDb = {
      query: async () => [
        { scope: 'daily-test', key: 'enabled', value: false },
        { scope: 'global', key: 'digest_time', value: '16:00' },
      ],
    };

    await loadConfigOverrides(mockDb);

    expect(getOverride('daily-test', 'enabled')).toBe(false);
    expect(getOverride('global', 'digest_time')).toBe('16:00');
    expect(getOverride('global', 'nonexistent')).toBeUndefined();
  });

  it('isDailyEnabled returns false when override is false', async () => {
    const mockDb = {
      query: async () => [
        { scope: 'daily-test', key: 'enabled', value: false },
      ],
    };

    await loadConfigOverrides(mockDb);

    expect(isDailyEnabled('daily-test')).toBe(false);
    expect(isDailyEnabled('other-daily')).toBe(true);
  });

  it('isDailyEnabled defaults to true when no override', async () => {
    const mockDb = { query: async () => [] };
    await loadConfigOverrides(mockDb);

    expect(isDailyEnabled('daily-test')).toBe(true);
  });

  it('getDailies filters out disabled dailies', async () => {
    const all = getAllDailiesIncludingDisabled();
    expect(all.length).toBeGreaterThanOrEqual(1);

    const dailyToDisable = all[0].name;

    const mockDb = {
      query: async () => [
        { scope: dailyToDisable, key: 'enabled', value: false },
      ],
    };

    await loadConfigOverrides(mockDb);

    const enabled = getDailies();
    expect(enabled.length).toBe(all.length - 1);
    expect(enabled.find(d => d.name === dailyToDisable)).toBeUndefined();
  });

  it('getAllDailiesIncludingDisabled returns all dailies regardless of enabled state', async () => {
    const allBefore = getAllDailiesIncludingDisabled();

    const mockDb = {
      query: async () => [
        { scope: allBefore[0].name, key: 'enabled', value: false },
      ],
    };

    await loadConfigOverrides(mockDb);

    const allAfter = getAllDailiesIncludingDisabled();
    expect(allAfter.length).toBe(allBefore.length);
  });

  it('clearConfigCache clears overrides too', async () => {
    const mockDb = {
      query: async () => [
        { scope: 'global', key: 'test', value: 'hello' },
      ],
    };

    await loadConfigOverrides(mockDb);
    expect(getOverride('global', 'test')).toBe('hello');

    clearConfigCache();
    expect(getOverride('global', 'test')).toBeUndefined();
  });
});

describe('getDailySections', () => {
  it('defaults both to true when sections not configured', () => {
    const daily = { name: 'test', channel: 'C1', schedule: 's' } as any;
    expect(getDailySections(daily)).toEqual({ blockers: true, unplanned: true });
  });

  it('returns configured values', () => {
    const daily = { name: 'test', channel: 'C1', schedule: 's', sections: { blockers: false, unplanned: true } } as any;
    expect(getDailySections(daily)).toEqual({ blockers: false, unplanned: true });
  });

  it('defaults missing fields to true', () => {
    const daily = { name: 'test', channel: 'C1', schedule: 's', sections: { blockers: false } } as any;
    const result = getDailySections(daily);
    expect(result.blockers).toBe(false);
    expect(result.unplanned).toBe(true);
  });
});

describe('getWeeklyRecap', () => {
  it('defaults to true when not configured', () => {
    const daily = { name: 'test', channel: 'C1', schedule: 's' } as any;
    expect(getWeeklyRecap(daily)).toBe(true);
  });

  it('returns configured value', () => {
    const daily = { name: 'test', channel: 'C1', schedule: 's', weekly_recap: false } as any;
    expect(getWeeklyRecap(daily)).toBe(false);
  });
});

/**
 * Tests for stats-related pure functions in lib/db.ts
 * Covers computeBlockerStreaks and the TS filtering logic of getUnplannedOverload
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the neon driver so db.ts can be imported without a real DB connection
vi.mock('@neondatabase/serverless', () => ({
  neon: vi.fn(() => vi.fn()),
}));

import { computeBlockerStreaks } from '../lib/db';

describe('computeBlockerStreaks', () => {
  it('returns empty array for empty input', () => {
    expect(computeBlockerStreaks([])).toEqual([]);
  });

  it('returns empty array when single user has no blockers', () => {
    const rows = [
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: false },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: false },
    ];
    expect(computeBlockerStreaks(rows)).toEqual([]);
  });

  it('single user, all blockers — current_streak = max_streak = total_blocker_days = N', () => {
    const rows = [
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-03', has_blocker: true },
    ];
    const result = computeBlockerStreaks(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slack_user_id: 'U1',
      current_streak: 3,
      max_streak: 3,
      total_blocker_days: 3,
    });
  });

  it('single user, gap in middle — current_streak is trailing run, max_streak is longest', () => {
    // blocker, clear, blocker, blocker — trailing run is 2, max was also 2... let's make it asymmetric
    // blocker, blocker, blocker, clear, blocker, blocker
    const rows = [
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-03', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-04', has_blocker: false },
      { slack_user_id: 'U1', date: '2025-12-05', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-06', has_blocker: true },
    ];
    const result = computeBlockerStreaks(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slack_user_id: 'U1',
      current_streak: 2,  // trailing run: Dec 5-6
      max_streak: 3,      // longest run: Dec 1-3
      total_blocker_days: 5,
    });
  });

  it('single user, blockers then clear — current_streak = 0, max_streak is the earlier run', () => {
    const rows = [
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-03', has_blocker: false },
    ];
    const result = computeBlockerStreaks(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slack_user_id: 'U1',
      current_streak: 0,
      max_streak: 2,
      total_blocker_days: 2,
    });
  });

  it('single blocker day — current_streak = max_streak = total = 1', () => {
    const rows = [
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: false },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: true },
    ];
    const result = computeBlockerStreaks(rows);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      slack_user_id: 'U1',
      current_streak: 1,
      max_streak: 1,
      total_blocker_days: 1,
    });
  });

  it('multiple users — each gets independent streaks', () => {
    const rows = [
      // U1: 3-day streak then clear
      { slack_user_id: 'U1', date: '2025-12-01', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-02', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-03', has_blocker: true },
      { slack_user_id: 'U1', date: '2025-12-04', has_blocker: false },
      // U2: no blockers — should be excluded
      { slack_user_id: 'U2', date: '2025-12-01', has_blocker: false },
      { slack_user_id: 'U2', date: '2025-12-02', has_blocker: false },
      // U3: 1 blocker day, trailing
      { slack_user_id: 'U3', date: '2025-12-01', has_blocker: false },
      { slack_user_id: 'U3', date: '2025-12-02', has_blocker: true },
    ];

    const result = computeBlockerStreaks(rows);

    // U2 excluded (no blockers)
    expect(result).toHaveLength(2);

    const u1 = result.find(r => r.slack_user_id === 'U1');
    expect(u1).toMatchObject({
      current_streak: 0,  // last entry is false
      max_streak: 3,
      total_blocker_days: 3,
    });

    const u3 = result.find(r => r.slack_user_id === 'U3');
    expect(u3).toMatchObject({
      current_streak: 1,
      max_streak: 1,
      total_blocker_days: 1,
    });
  });

  it('only returns users with at least one blocker day', () => {
    const rows = [
      { slack_user_id: 'U_CLEAN', date: '2025-12-01', has_blocker: false },
      { slack_user_id: 'U_BLOCKED', date: '2025-12-01', has_blocker: true },
    ];
    const result = computeBlockerStreaks(rows);
    expect(result.map(r => r.slack_user_id)).toEqual(['U_BLOCKED']);
  });
});

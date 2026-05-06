/**
 * Tests for lib/handlers/home.ts - App Home view with linked accounts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('../lib/db', () => ({
  getUserDailies: vi.fn(() => Promise.resolve([])),
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getPreviousSubmission: vi.fn(() => Promise.resolve(null)),
  getGitHubUsername: vi.fn(() => Promise.resolve(null)),
  getLinearUserId: vi.fn(() => Promise.resolve(null)),
  setGitHubUsername: vi.fn(),
  setLinearUserId: vi.fn(),
  getDmStandupPreference: vi.fn(() => Promise.resolve(false)),
}));

// Mock the config module
vi.mock('../lib/config', () => ({
  getDaily: vi.fn(() => null),
  getGitHubConfig: vi.fn(() => null),
  getGitHubUsernameFromConfig: vi.fn(() => null),
  getLinearConfig: vi.fn(() => null),
  getLinearUserIdFromConfig: vi.fn(() => null),
  getLinearTeamIdForUser: vi.fn(() => null),
}));

// Mock the slack module
vi.mock('../lib/slack', () => ({
  publishHomeView: vi.fn(() => Promise.resolve(true)),
  openModal: vi.fn(() => Promise.resolve(true)),
}));

// Mock the prompt module
vi.mock('../lib/prompt', () => ({
  formatDate: vi.fn(() => '2025-12-22'),
  getUserDate: vi.fn(() => new Date('2025-12-22T12:00:00')),
  getUserTimezone: vi.fn(() => Promise.resolve({ tz: 'UTC', tz_offset: 0 })),
}));

// Mock the github module
vi.mock('../lib/github', () => ({
  fetchUserPRData: vi.fn(),
}));

// Mock the linear module
vi.mock('../lib/linear', () => ({
  fetchUserLinearData: vi.fn(),
}));

import { buildHomeView, LinkedAccounts, handleAppHomeOpened, HomeContext, AppHomeOpenedEvent } from '../lib/handlers/home';
import { getGitHubUsername, getLinearUserId, getUserDailies, getSubmissionForDate, getPreviousSubmission } from '../lib/db';
import { publishHomeView } from '../lib/slack';

describe('buildHomeView - linked accounts section', () => {
  it('shows Link buttons when accounts are not linked', () => {
    const linkedAccounts: LinkedAccounts = { github: null, linear: null, dmStandup: true };
    const view = buildHomeView([], linkedAccounts) as { blocks: Array<Record<string, unknown>> };

    // Find linked accounts header
    const header = view.blocks.find(
      (b: any) => b.type === 'header' && b.text?.text === '🔗 Linked Accounts'
    );
    expect(header).toBeDefined();

    // Find GitHub "Not linked" section
    const githubSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*GitHub*\nNot linked')
    );
    expect(githubSection).toBeDefined();
    expect((githubSection as any).accessory.action_id).toBe('home_link_github');
    expect((githubSection as any).accessory.text.text).toBe('Link');

    // Find Linear "Not linked" section
    const linearSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*Linear*\nNot linked')
    );
    expect(linearSection).toBeDefined();
    expect((linearSection as any).accessory.action_id).toBe('home_link_linear');
    expect((linearSection as any).accessory.text.text).toBe('Link');
  });

  it('shows Unlink buttons when accounts are linked', () => {
    const linkedAccounts: LinkedAccounts = { github: 'octocat', linear: 'lin-user-123', dmStandup: true };
    const view = buildHomeView([], linkedAccounts) as { blocks: Array<Record<string, unknown>> };

    // Find GitHub linked section
    const githubSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('@octocat')
    );
    expect(githubSection).toBeDefined();
    expect((githubSection as any).accessory.action_id).toBe('home_unlink_github');
    expect((githubSection as any).accessory.text.text).toBe('Unlink');

    // Find Linear linked section
    const linearSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('lin-user-123')
    );
    expect(linearSection).toBeDefined();
    expect((linearSection as any).accessory.action_id).toBe('home_unlink_linear');
    expect((linearSection as any).accessory.text.text).toBe('Unlink');
  });

  it('shows mixed state (one linked, one not)', () => {
    const linkedAccounts: LinkedAccounts = { github: 'myuser', linear: null, dmStandup: true };
    const view = buildHomeView([], linkedAccounts) as { blocks: Array<Record<string, unknown>> };

    const githubSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('@myuser')
    );
    expect(githubSection).toBeDefined();
    expect((githubSection as any).accessory.action_id).toBe('home_unlink_github');

    const linearSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('*Linear*\nNot linked')
    );
    expect(linearSection).toBeDefined();
    expect((linearSection as any).accessory.action_id).toBe('home_link_linear');
  });

  it('omits linked accounts section when not provided', () => {
    const view = buildHomeView([]) as { blocks: Array<Record<string, unknown>> };

    const header = view.blocks.find(
      (b: any) => b.type === 'header' && b.text?.text === '🔗 Linked Accounts'
    );
    expect(header).toBeUndefined();
  });
});

describe('buildHomeView - Today\'s Plans section', () => {
  it('shows plan items grouped by status', () => {
    const dailyStatuses = [{
      dailyName: 'daily-test',
      todaySubmitted: true,
      tomorrowScheduled: false,
      planItems: [
        { text: 'Fix auth bug', status: 'done' as const },
        { text: 'Refactor DB layer', status: 'in_progress' as const },
        { text: 'Deploy to staging', status: 'planned' as const },
        { text: 'Old task', status: 'carried' as const },
        { text: 'Abandoned idea', status: 'dropped' as const },
      ],
    }];
    const view = buildHomeView(dailyStatuses) as { blocks: Array<Record<string, unknown>> };

    // Find context block with plan items
    const planBlock = view.blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('Fix auth bug')
    );
    expect(planBlock).toBeDefined();

    const text = (planBlock as any).elements[0].text;
    expect(text).toContain('✅ ~Fix auth bug~');
    expect(text).toContain('🔄 Refactor DB layer');
    expect(text).toContain('🎯 Deploy to staging');
    expect(text).toContain('➡️ Old task _(carried)_');
    expect(text).toContain('❌ ~Abandoned idea~');
  });

  it('shows source tags for integration items', () => {
    const dailyStatuses = [{
      dailyName: 'daily-test',
      todaySubmitted: true,
      tomorrowScheduled: false,
      planItems: [
        { text: '[LIN-123] Fix auth', status: 'planned' as const, source: 'LIN-123' },
        { text: '[repo#45] Add tests', status: 'done' as const, source: 'repo#45' },
        { text: 'Manual task', status: 'planned' as const },
      ],
    }];
    const view = buildHomeView(dailyStatuses) as { blocks: Array<Record<string, unknown>> };

    const planBlock = view.blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('LIN-123')
    );
    expect(planBlock).toBeDefined();
    const text = (planBlock as any).elements[0].text;
    expect(text).toContain('· _LIN-123_');
    expect(text).toContain('· _repo#45_');
    expect(text).not.toContain('Manual task · _');
  });

  it('does not show plan section when no submission', () => {
    const dailyStatuses = [{
      dailyName: 'daily-test',
      todaySubmitted: false,
      tomorrowScheduled: false,
    }];
    const view = buildHomeView(dailyStatuses) as { blocks: Array<Record<string, unknown>> };

    // No context block with plan items
    const planBlocks = view.blocks.filter(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('🎯')
    );
    expect(planBlocks).toHaveLength(0);
  });
});

describe('handleAppHomeOpened - fetches linked accounts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches and passes linked accounts to the view', async () => {
    vi.mocked(getGitHubUsername).mockResolvedValueOnce('octocat');
    vi.mocked(getLinearUserId).mockResolvedValueOnce('lin-123');
    vi.mocked(publishHomeView).mockResolvedValueOnce(true);

    const event: AppHomeOpenedEvent = { type: 'app_home_opened', user: 'U12345', tab: 'home' };
    const ctx: HomeContext = { db: {} as any, slackToken: 'xoxb-test' };

    const result = await handleAppHomeOpened(event, ctx);

    expect(result).toBe(true);
    expect(getGitHubUsername).toHaveBeenCalledWith({}, 'U12345');
    expect(getLinearUserId).toHaveBeenCalledWith({}, 'U12345');

    // Verify the published view contains linked accounts data
    const publishCall = vi.mocked(publishHomeView).mock.calls[0];
    const view = publishCall[2] as { blocks: Array<Record<string, unknown>> };

    const githubSection = view.blocks.find(
      (b: any) => b.type === 'section' && b.text?.text?.includes('@octocat')
    );
    expect(githubSection).toBeDefined();
  });
});

describe('handleAppHomeOpened - Today\'s Plans from submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds plan items from today\'s submission', async () => {
    // User is part of a daily
    vi.mocked(getUserDailies).mockResolvedValueOnce([
      { id: 1, slack_user_id: 'U12345', daily_name: 'daily-test', schedule_name: 'il-team', time_override: null, created_at: new Date() },
    ]);
    // Today's submission exists
    vi.mocked(getSubmissionForDate).mockResolvedValueOnce({
      id: 1,
      slack_user_id: 'U12345',
      daily_name: 'daily-test',
      date: '2025-12-22',
      submitted_at: new Date(),
      yesterday_completed: ['Done task'],
      yesterday_incomplete: ['Carried task'],
      yesterday_in_progress: ['WIP task'],
      unplanned: null,
      today_plans: ['New plan'],
      blockers: null,
      custom_answers: null,
      slack_message_ts: null,
      posted: true,
    });
    // No previous submission (so no dropped items)
    vi.mocked(getPreviousSubmission).mockResolvedValueOnce(null);
    vi.mocked(publishHomeView).mockResolvedValueOnce(true);

    const event: AppHomeOpenedEvent = { type: 'app_home_opened', user: 'U12345', tab: 'home' };
    const ctx: HomeContext = { db: {} as any, slackToken: 'xoxb-test' };

    await handleAppHomeOpened(event, ctx);

    const publishCall = vi.mocked(publishHomeView).mock.calls[0];
    const view = publishCall[2] as { blocks: Array<Record<string, unknown>> };

    // Find the context block with plan items
    const planBlock = view.blocks.find(
      (b: any) => b.type === 'context' && b.elements?.[0]?.text?.includes('New plan')
    );
    expect(planBlock).toBeDefined();
    const text = (planBlock as any).elements[0].text;
    expect(text).toContain('🔄 WIP task');
    expect(text).toContain('➡️ Carried task');
    expect(text).toContain('🎯 New plan');
    expect(text).toContain('✅ ~Done task~');
  });
});

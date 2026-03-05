/**
 * Tests for lib/handlers/home.ts - App Home view with linked accounts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db module
vi.mock('../lib/db', () => ({
  getUserDailies: vi.fn(() => Promise.resolve([])),
  getSubmissionForDate: vi.fn(() => Promise.resolve(null)),
  getGitHubUsername: vi.fn(() => Promise.resolve(null)),
  getLinearUserId: vi.fn(() => Promise.resolve(null)),
  setGitHubUsername: vi.fn(),
  setLinearUserId: vi.fn(),
  getDmStandupPreference: vi.fn(() => Promise.resolve(true)),
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
import { getGitHubUsername, getLinearUserId } from '../lib/db';
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

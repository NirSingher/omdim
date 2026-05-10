import { parse } from 'yaml';
import { z } from 'zod';

// Import config.yaml as text (bundled by wrangler/build tool)
// @ts-ignore - imported as raw text via bundler
import configYaml from '../config.yaml';

// ============================================================================
// Zod Schemas
// ============================================================================

const QuestionSchema = z.object({
  text: z.string().min(1, 'Question text cannot be empty'),
  required: z.boolean().default(false),
  order: z.number().optional(),
});

const FieldOrderSchema = z.object({
  unplanned: z.number().optional(),
  review_requests: z.number().optional(),  // PRs I need to review (default 18, near Linear tickets)
  today_plans: z.number().optional(),
  my_prs: z.number().optional(),           // PRs I authored — draft, awaiting review, ready to merge (default 24)
  blockers: z.number().optional(),
});

const validDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type ValidDay = typeof validDays[number];

const DaySchema = z.string().transform(d => d.toLowerCase() as ValidDay).refine(
  d => validDays.includes(d as ValidDay),
  { message: `Must be one of: ${validDays.join(', ')}` }
);

const ScheduleSchema = z.object({
  name: z.string().min(1, 'Schedule name cannot be empty'),
  days: z.array(DaySchema).min(1, 'Schedule must have at least one day'),
  default_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be in HH:MM format'),
  timezone: z.string().optional(), // e.g. "Asia/Jerusalem"
});

// Integration user mapping for GitHub/Linear
const IntegrationUserMappingSchema = z.object({
  slack_user_id: z.string(),
  external_username: z.string(),
  team_id: z.string().optional(), // Per-user Linear team ID override
});

const GitHubIntelligenceSchema = z.object({
  enabled: z.boolean().default(false),
  work_alignment: z.boolean().default(true),
  auto_populate: z.boolean().default(true),
}).optional();

const GitHubIntegrationSchema = z.object({
  enabled: z.boolean().default(false),
  org: z.string().optional(),
  token: z.string().optional(), // Optional: env var name for token (defaults to GITHUB_TOKEN)
  user_mapping: z.array(IntegrationUserMappingSchema).optional(),
  intelligence: GitHubIntelligenceSchema,
});

const LinearIntelligenceSchema = z.object({
  enabled: z.boolean().default(false),
  cross_reference: z.boolean().default(true),
  auto_update: z.boolean().default(true),
  priority_alignment: z.boolean().default(true),
}).optional();

const LinearIntegrationSchema = z.object({
  enabled: z.boolean().default(false),
  team_id: z.string().optional(),
  token: z.string().optional(), // Optional: env var name for token (defaults to LINEAR_API_KEY)
  user_mapping: z.array(IntegrationUserMappingSchema).optional(),
  intelligence: LinearIntelligenceSchema,
});

const IntegrationsSchema = z.object({
  github: GitHubIntegrationSchema.optional(),
  linear: LinearIntegrationSchema.optional(),
});

const DailySchema = z.object({
  name: z.string().min(1, 'Daily name cannot be empty'),
  channel: z.string().min(1, 'Channel cannot be empty'),
  schedule: z.string().min(1, 'Schedule name cannot be empty'),
  // Manager(s) who receive automatic digests
  manager: z.string().optional(), // Legacy: single manager
  managers: z.array(z.string()).optional(), // New: multiple managers
  // Digest settings
  weekly_digest_day: z.enum(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']).optional(),
  bottleneck_threshold: z.number().min(1).optional(),
  // Modal fields
  field_order: FieldOrderSchema.optional(),
  questions: z.array(QuestionSchema).optional(),
  // Integrations (placeholder for GitHub/Linear)
  integrations: IntegrationsSchema.optional(),
  // Reminder: how many minutes before daily to send channel reminder (0 = disabled, default 90)
  reminder_minutes_before: z.number().min(0).optional(),
  // Nudge: DM participants who haven't submitted N minutes before digest (0 = disabled, default 0)
  nudge_minutes_before: z.number().min(0).optional(),
  // Per-daily plan-size warning threshold (overrides global max_plan_items)
  max_plan_items: z.number().int().min(0).optional(),
  // Post a consolidated team summary to the daily channel at digest time
  team_summary: z.boolean().optional(),
  // Which built-in sections to show in the standup modal (all default to true)
  sections: z.object({
    blockers: z.boolean().default(true),
    unplanned: z.boolean().default(true),
  }).optional(),
  // Send personal weekly recap DM to each participant on weekly digest day (default true)
  weekly_recap: z.boolean().optional(),
});

const ConfigSchema = z.object({
  dailies: z.array(DailySchema).min(1, 'Must have at least one daily'),
  schedules: z.array(ScheduleSchema).min(1, 'Must have at least one schedule'),
  admins: z.array(z.string()).min(1, 'Must have at least one admin'),
  // Global digest time (UTC) - defaults to 14:00
  digest_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be in HH:MM format').optional(),
  // Plan-size soft warning threshold. 0 disables the warning. Defaults to 5.
  max_plan_items: z.number().int().min(0).optional(),
});

// ============================================================================
// Types (inferred from Zod schemas)
// ============================================================================

export type Question = z.infer<typeof QuestionSchema>;
export type FieldOrder = z.infer<typeof FieldOrderSchema>;
export type Schedule = z.infer<typeof ScheduleSchema>;
export type Daily = z.infer<typeof DailySchema>;
export type Config = z.infer<typeof ConfigSchema>;

let cachedConfig: Config | null = null;
let configError: string | null = null;

/** Empty config used when config.yaml is invalid */
const EMPTY_CONFIG: Config = {
  dailies: [],
  schedules: [],
  admins: [],
};

// ============================================================================
// Config Overrides (DB-backed, takes precedence over YAML)
// ============================================================================

let overridesCache: Map<string, unknown> | null = null;

function overrideKey(scope: string, key: string): string {
  return `${scope}::${key}`;
}

export async function loadConfigOverrides(db: { query: <T>(sql: string, params?: unknown[]) => Promise<T[]> }): Promise<void> {
  const rows = await db.query<{ scope: string; key: string; value: unknown }>(
    `SELECT scope, key, value FROM config_overrides`
  );
  overridesCache = new Map();
  for (const row of rows) {
    overridesCache.set(overrideKey(row.scope, row.key), row.value);
  }
}

export function getOverride<T = unknown>(scope: string, key: string): T | undefined {
  if (!overridesCache) return undefined;
  return overridesCache.get(overrideKey(scope, key)) as T | undefined;
}

export function isDailyEnabled(dailyName: string): boolean {
  const override = getOverride<boolean>(dailyName, 'enabled');
  if (override !== undefined) return override;
  return true;
}

export function clearOverridesCache(): void {
  overridesCache = null;
}

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Format Zod errors into a readable string
 */
function formatZodError(error: z.ZodError): string {
  // Zod v4 uses 'issues', older versions use 'errors'
  const issues = (error as { issues?: z.ZodIssue[] }).issues || [];
  return issues.map((e: z.ZodIssue) => {
    const path = e.path.length > 0 ? `${e.path.join('.')}: ` : '';
    return `${path}${e.message}`;
  }).join('; ');
}

/**
 * Validate that all dailies reference existing schedules
 */
function validateScheduleReferences(config: Config): void {
  const scheduleNames = new Set(config.schedules.map(s => s.name));
  for (const daily of config.dailies) {
    if (!scheduleNames.has(daily.schedule)) {
      throw new Error(`Daily "${daily.name}" references unknown schedule "${daily.schedule}"`);
    }
  }
}

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  // If we already tried and failed, return empty config
  if (configError) {
    return EMPTY_CONFIG;
  }

  try {
    const rawConfig = parse(configYaml);
    const result = ConfigSchema.safeParse(rawConfig);

    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }

    // Additional validation: check schedule references
    validateScheduleReferences(result.data);

    cachedConfig = result.data;
    configError = null;
    return cachedConfig;
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    configError = errorMsg;
    console.error('❌ CONFIG ERROR:', errorMsg);
    console.error('The bot will not function correctly until config.yaml is fixed.');
    return EMPTY_CONFIG;
  }
}

/**
 * Get the config error message, or null if config loaded successfully
 */
export function getConfigError(): string | null {
  loadConfig(); // Ensure we've attempted to load
  return configError;
}

export function getDaily(name: string): Daily | undefined {
  const config = loadConfig();
  return config.dailies.find((d) => d.name === name);
}

export function getSchedule(name: string): Schedule | undefined {
  const config = loadConfig();
  return config.schedules.find((s) => s.name === name);
}

export function isSuperAdmin(userId: string): boolean {
  const config = loadConfig();
  return config.admins.includes(userId);
}

export function isAdmin(userId: string): boolean {
  if (isSuperAdmin(userId)) return true;
  const dbAdmins = getOverride<string[]>('global', 'admins');
  return dbAdmins?.includes(userId) ?? false;
}

export function getAdmins(): { superAdmins: string[]; dbAdmins: string[] } {
  const config = loadConfig();
  const dbAdmins = getOverride<string[]>('global', 'admins') ?? [];
  return { superAdmins: config.admins, dbAdmins };
}

export function getDailies(): Daily[] {
  return loadConfig().dailies.filter(d => isDailyEnabled(d.name));
}

export function getAllDailiesIncludingDisabled(): Daily[] {
  return loadConfig().dailies;
}

export function getSchedules(): Schedule[] {
  return loadConfig().schedules;
}

/** Get all managers for a daily (YAML + DB, deduplicated) */
export function getDailyManagers(daily: Daily): string[] {
  const yamlManagers: string[] = [];
  if (daily.managers && daily.managers.length > 0) {
    yamlManagers.push(...daily.managers);
  } else if (daily.manager) {
    yamlManagers.push(daily.manager);
  }
  const dbManagers = getOverride<string[]>(daily.name, 'managers') ?? [];
  return [...new Set([...yamlManagers, ...dbManagers])];
}

/** Get all dailies that have at least one manager configured */
export function getDailiesWithManagers(): Daily[] {
  return loadConfig().dailies.filter((d) => getDailyManagers(d).length > 0);
}

/** Get the weekly digest day for a daily (defaults to friday) */
export function getWeeklyDigestDay(daily: Daily): string {
  return daily.weekly_digest_day || 'fri';
}

/** Get the bottleneck threshold for a daily (defaults to 3) */
export function getBottleneckThreshold(daily: Daily): number {
  return daily.bottleneck_threshold || 3;
}

/** Check if a daily has any integrations enabled */
export function hasIntegrationsEnabled(daily: Daily): boolean {
  if (!daily.integrations) return false;
  return (daily.integrations.github?.enabled === true) ||
         (daily.integrations.linear?.enabled === true);
}

/** Get integration status summary for a daily */
export function getIntegrationStatus(daily: Daily): { github: boolean; linear: boolean } {
  return {
    github: daily.integrations?.github?.enabled === true,
    linear: daily.integrations?.linear?.enabled === true,
  };
}

/** Get the reminder minutes before daily (defaults to 90, 0 = disabled) */
export function getReminderMinutesBefore(daily: Daily): number {
  return daily.reminder_minutes_before ?? 90;
}

/** Get nudge minutes before digest (defaults to 0 = disabled) */
export function getNudgeMinutesBefore(daily: Daily): number {
  return daily.nudge_minutes_before ?? 0;
}

/** Get which sections are enabled for a daily (defaults both to true) */
export function getDailySections(daily: Daily): { blockers: boolean; unplanned: boolean } {
  return {
    blockers: daily.sections?.blockers ?? true,
    unplanned: daily.sections?.unplanned ?? true,
  };
}

/** Whether to send weekly recap DMs to participants (default true) */
export function getWeeklyRecap(daily: Daily): boolean {
  return daily.weekly_recap ?? true;
}

/** Get the digest time (UTC, HH:MM format, defaults to 14:00) */
export function getDigestTime(): string {
  return loadConfig().digest_time || '14:00';
}

/** Plan-size soft-warning threshold (0 = disabled, default 5). Per-daily overrides global. */
export function getMaxPlanItems(dailyName?: string): number {
  const config = loadConfig();
  if (dailyName) {
    const daily = config.dailies.find(d => d.name === dailyName);
    if (daily?.max_plan_items !== undefined) return daily.max_plan_items;
  }
  return config.max_plan_items ?? 5;
}

// Clear all caches (useful for testing or hot reload)
export function clearConfigCache(): void {
  cachedConfig = null;
  configError = null;
  overridesCache = null;
}

// ============================================================================
// GitHub Integration Helpers
// ============================================================================

export interface GitHubConfig {
  enabled: boolean;
  org: string;
  tokenEnvVar: string;
}

/** Get GitHub integration config for a daily, returns null if not enabled */
export function getGitHubConfig(daily: Daily): GitHubConfig | null {
  if (!daily.integrations?.github?.enabled) {
    return null;
  }

  const github = daily.integrations.github;

  // Org is required when enabled
  if (!github.org) {
    console.warn(`GitHub integration enabled for ${daily.name} but no org specified`);
    return null;
  }

  return {
    enabled: true,
    org: github.org,
    tokenEnvVar: github.token || 'GITHUB_TOKEN',
  };
}

/** Look up GitHub username from config mapping for a daily */
export function getGitHubUsernameFromConfig(daily: Daily, slackUserId: string): string | null {
  const mapping = daily.integrations?.github?.user_mapping;
  if (!mapping) return null;

  const match = mapping.find((m) => m.slack_user_id === slackUserId);
  return match?.external_username || null;
}

/** Get all GitHub user mappings for a daily */
export function getGitHubUserMappings(daily: Daily): Array<{ slackUserId: string; githubUsername: string }> {
  const mapping = daily.integrations?.github?.user_mapping;
  if (!mapping) return [];

  return mapping.map((m) => ({
    slackUserId: m.slack_user_id,
    githubUsername: m.external_username,
  }));
}

// ============================================================================
// Linear Integration Helpers
// ============================================================================

export interface LinearConfig {
  enabled: boolean;
  defaultTeamId?: string; // Optional global default — per-user team_id in user_mapping takes precedence
  tokenEnvVar: string;
}

/** Get Linear integration config for a daily, returns null if not enabled */
export function getLinearConfig(daily: Daily): LinearConfig | null {
  if (!daily.integrations?.linear?.enabled) {
    return null;
  }

  const linear = daily.integrations.linear;

  return {
    enabled: true,
    defaultTeamId: linear.team_id,
    tokenEnvVar: linear.token || 'LINEAR_API_KEY',
  };
}

/** Get Linear team ID for a specific user (per-user mapping overrides daily default) */
export function getLinearTeamIdForUser(daily: Daily, slackUserId: string): string | null {
  const mapping = daily.integrations?.linear?.user_mapping;
  if (mapping) {
    const match = mapping.find((m) => m.slack_user_id === slackUserId);
    if (match?.team_id) return match.team_id;
  }
  return daily.integrations?.linear?.team_id || null;
}

/** Look up Linear user ID from config mapping for a daily */
export function getLinearUserIdFromConfig(daily: Daily, slackUserId: string): string | null {
  const mapping = daily.integrations?.linear?.user_mapping;
  if (!mapping) return null;

  const match = mapping.find((m) => m.slack_user_id === slackUserId);
  return match?.external_username || null;
}

export interface LinearIntelligenceConfig {
  enabled: boolean;
  cross_reference: boolean;
  auto_update: boolean;
  priority_alignment: boolean;
}

/** Get Linear intelligence config for a daily, returns null if not enabled */
export function getLinearIntelligenceConfig(daily: Daily): LinearIntelligenceConfig | null {
  const intel = daily.integrations?.linear?.intelligence;
  if (!intel?.enabled) return null;
  return {
    enabled: true,
    cross_reference: intel.cross_reference ?? true,
    auto_update: intel.auto_update ?? true,
    priority_alignment: intel.priority_alignment ?? true,
  };
}

export interface GitHubIntelligenceConfig {
  enabled: boolean;
  work_alignment: boolean;
  auto_populate: boolean;
}

/** Get GitHub intelligence config for a daily, returns null if not enabled */
export function getGitHubIntelligenceConfig(daily: Daily): GitHubIntelligenceConfig | null {
  const intel = daily.integrations?.github?.intelligence;
  if (!intel?.enabled) return null;
  return {
    enabled: true,
    work_alignment: intel.work_alignment ?? true,
    auto_populate: intel.auto_populate ?? true,
  };
}

/** Get all Linear user mappings for a daily */
export function getLinearUserMappings(daily: Daily): Array<{ slackUserId: string; linearUserId: string; teamId?: string }> {
  const mapping = daily.integrations?.linear?.user_mapping;
  if (!mapping) return [];

  return mapping.map((m) => ({
    slackUserId: m.slack_user_id,
    linearUserId: m.external_username,
    teamId: m.team_id,
  }));
}

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
  today_plans: z.number().optional(),
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
});

// Integration user mapping for GitHub/Linear
const IntegrationUserMappingSchema = z.object({
  slack_user_id: z.string(),
  external_username: z.string(),
});

const GitHubIntegrationSchema = z.object({
  enabled: z.boolean().default(false),
  org: z.string().optional(),
  user_mapping: z.array(IntegrationUserMappingSchema).optional(),
});

const LinearIntegrationSchema = z.object({
  enabled: z.boolean().default(false),
  team_id: z.string().optional(),
  user_mapping: z.array(IntegrationUserMappingSchema).optional(),
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
});

const ConfigSchema = z.object({
  dailies: z.array(DailySchema).min(1, 'Must have at least one daily'),
  schedules: z.array(ScheduleSchema).min(1, 'Must have at least one schedule'),
  admins: z.array(z.string()).min(1, 'Must have at least one admin'),
  // Global digest time (UTC) - defaults to 14:00
  digest_time: z.string().regex(/^\d{2}:\d{2}$/, 'Must be in HH:MM format').optional(),
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

export function isAdmin(userId: string): boolean {
  const config = loadConfig();
  return config.admins.includes(userId);
}

export function getDailies(): Daily[] {
  return loadConfig().dailies;
}

export function getSchedules(): Schedule[] {
  return loadConfig().schedules;
}

/** Get all managers for a daily (supports both legacy single manager and new managers array) */
export function getDailyManagers(daily: Daily): string[] {
  // New format takes precedence
  if (daily.managers && daily.managers.length > 0) {
    return daily.managers;
  }
  // Fallback to legacy single manager
  if (daily.manager) {
    return [daily.manager];
  }
  return [];
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

/** Get the digest time (UTC, HH:MM format, defaults to 14:00) */
export function getDigestTime(): string {
  return loadConfig().digest_time || '14:00';
}

// Clear cache (useful for testing or hot reload)
export function clearConfigCache(): void {
  cachedConfig = null;
  configError = null;
}

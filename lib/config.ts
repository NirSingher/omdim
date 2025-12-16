import { parse } from 'yaml';

// Import config.yaml as text (bundled by wrangler/build tool)
// @ts-ignore - imported as raw text via bundler
import configYaml from '../config.yaml';

export interface Question {
  text: string;
  required: boolean;
}

export interface Daily {
  name: string;
  channel: string;
  schedule: string;
  questions?: Question[];
}

export interface Schedule {
  name: string;
  days: string[];
  default_time: string;
}

export interface Config {
  dailies: Daily[];
  schedules: Schedule[];
  admins: string[];
}

let cachedConfig: Config | null = null;

export function loadConfig(): Config {
  if (cachedConfig) {
    return cachedConfig;
  }

  try {
    const config = parse(configYaml) as Config;
    validateConfig(config);
    cachedConfig = config;
    return config;
  } catch (error) {
    console.error('Failed to load config:', error);
    throw new Error('Failed to load configuration');
  }
}

function validateConfig(config: Config): void {
  if (!config.dailies || !Array.isArray(config.dailies)) {
    throw new Error('Config must have a "dailies" array');
  }

  if (!config.schedules || !Array.isArray(config.schedules)) {
    throw new Error('Config must have a "schedules" array');
  }

  if (!config.admins || !Array.isArray(config.admins)) {
    throw new Error('Config must have an "admins" array');
  }

  const scheduleNames = new Set(config.schedules.map((s) => s.name));

  for (const daily of config.dailies) {
    if (!daily.name) {
      throw new Error('Each daily must have a "name"');
    }
    if (!daily.channel) {
      throw new Error(`Daily "${daily.name}" must have a "channel"`);
    }
    if (!daily.schedule) {
      throw new Error(`Daily "${daily.name}" must have a "schedule"`);
    }
    if (!scheduleNames.has(daily.schedule)) {
      throw new Error(
        `Daily "${daily.name}" references unknown schedule "${daily.schedule}"`
      );
    }
  }

  const validDays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  for (const schedule of config.schedules) {
    if (!schedule.name) {
      throw new Error('Each schedule must have a "name"');
    }
    if (!schedule.days || !Array.isArray(schedule.days)) {
      throw new Error(`Schedule "${schedule.name}" must have a "days" array`);
    }
    for (const day of schedule.days) {
      if (!validDays.includes(day.toLowerCase())) {
        throw new Error(
          `Schedule "${schedule.name}" has invalid day "${day}". Valid: ${validDays.join(', ')}`
        );
      }
    }
    if (!schedule.default_time) {
      throw new Error(`Schedule "${schedule.name}" must have a "default_time"`);
    }
    if (!/^\d{2}:\d{2}$/.test(schedule.default_time)) {
      throw new Error(
        `Schedule "${schedule.name}" default_time must be in HH:MM format`
      );
    }
  }
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

// Clear cache (useful for testing or hot reload)
export function clearConfigCache(): void {
  cachedConfig = null;
}

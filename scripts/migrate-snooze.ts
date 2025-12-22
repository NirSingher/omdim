/**
 * Migration script: Add snoozed_until column to work_items
 * Run with: npx tsx scripts/migrate-snooze.ts
 */

import { getDb } from '../lib/db';
import * as fs from 'fs';

async function migrate() {
  const devVars = fs.readFileSync('.dev.vars', 'utf-8');
  const dbUrlMatch = devVars.match(/DATABASE_URL=(.+)/);
  if (!dbUrlMatch) {
    console.error('DATABASE_URL not found in .dev.vars');
    process.exit(1);
  }

  const db = getDb(dbUrlMatch[1]);

  console.log('Adding snoozed_until column to work_items...');

  try {
    await db.query(`
      ALTER TABLE work_items
      ADD COLUMN IF NOT EXISTS snoozed_until DATE
    `);
    console.log('✓ Migration complete');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();

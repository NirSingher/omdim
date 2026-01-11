/**
 * Migration script: Add posted column to submissions table
 * For user-initiated daily feature (tomorrow mode)
 * Run with: npx tsx scripts/migrate-posted.ts
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

  console.log('Adding posted column to submissions table...');

  try {
    await db.query(`
      ALTER TABLE submissions
      ADD COLUMN IF NOT EXISTS posted BOOLEAN DEFAULT TRUE
    `);
    console.log('✓ Column added (existing submissions default to posted=TRUE)');

    console.log('✓ Migration complete');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();

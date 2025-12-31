/**
 * Migration script: Add ooo table for Out of Office tracking
 * Run with: npx tsx scripts/migrate-ooo.ts
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

  console.log('Creating ooo table...');

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS ooo (
        id SERIAL PRIMARY KEY,
        slack_user_id TEXT NOT NULL,
        daily_name TEXT NOT NULL,
        start_date DATE NOT NULL,
        end_date DATE NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(slack_user_id, daily_name, start_date, end_date)
      )
    `);
    console.log('✓ Table created');

    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_ooo_lookup
      ON ooo(slack_user_id, daily_name, start_date, end_date)
    `);
    console.log('✓ Index created');

    console.log('✓ Migration complete');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

migrate();

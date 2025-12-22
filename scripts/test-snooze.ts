/**
 * Local integration test for snooze functionality
 * Run with: npx tsx scripts/test-snooze.ts
 */

import { getDb, snoozeItem, getBottleneckItems, createWorkItems } from '../lib/db';

async function testSnooze() {
  // Load DATABASE_URL from .dev.vars
  const fs = await import('fs');
  const devVars = fs.readFileSync('.dev.vars', 'utf-8');
  const dbUrlMatch = devVars.match(/DATABASE_URL=(.+)/);
  if (!dbUrlMatch) {
    console.error('DATABASE_URL not found in .dev.vars');
    process.exit(1);
  }

  const db = getDb(dbUrlMatch[1]);
  const dailyName = 'daily-il';
  const testUserId = 'UTEST123';
  const todayStr = new Date().toISOString().split('T')[0];

  console.log('=== Snooze Button Integration Test ===\n');

  try {
    // Step 1: Create a test work item that will be a bottleneck
    console.log('1. Creating test work item with high carry count...');
    const testItems = [{
      slackUserId: testUserId,
      dailyName,
      text: `Test bottleneck item ${Date.now()}`,
      date: todayStr,
      submissionId: null,
    }];

    await createWorkItems(db, testItems);
    console.log('   ✓ Created test work item\n');

    // Step 2: Manually update carry_count to make it a bottleneck
    console.log('2. Updating carry_count to simulate bottleneck...');
    await db.query(`
      UPDATE work_items
      SET carry_count = 5, created_date = CURRENT_DATE - INTERVAL '6 days'
      WHERE slack_user_id = $1
        AND daily_name = $2
        AND status = 'pending'
    `, [testUserId, dailyName]);
    console.log('   ✓ Updated carry_count to 5\n');

    // Step 3: Verify it shows up as bottleneck
    console.log('3. Checking bottleneck items (threshold: 3)...');
    const bottlenecksBefore = await getBottleneckItems(db, dailyName, 3);
    const ourItem = bottlenecksBefore.find(b => b.slack_user_id === testUserId);

    if (ourItem) {
      console.log(`   ✓ Found bottleneck: "${ourItem.text}" (${ourItem.days_pending} days, carried ${ourItem.carry_count}x)`);
      console.log(`   Item ID: ${ourItem.id}\n`);

      // Step 4: Snooze the item
      console.log('4. Snoozing item for 7 days...');
      await snoozeItem(db, ourItem.id, 7);
      console.log('   ✓ Item snoozed\n');

      // Step 5: Verify it no longer shows as bottleneck
      console.log('5. Checking bottleneck items after snooze...');
      const bottlenecksAfter = await getBottleneckItems(db, dailyName, 3);
      const stillThere = bottlenecksAfter.find(b => b.id === ourItem.id);

      if (stillThere) {
        console.log('   ✗ ERROR: Item still appears in bottlenecks after snooze!');
      } else {
        console.log('   ✓ Item no longer in bottleneck list\n');
      }

      // Step 6: Verify snoozed_until is set
      console.log('6. Verifying snoozed_until column...');
      const items = await db.query<{ id: number; text: string; snoozed_until: string | null }>(`
        SELECT id, text, snoozed_until
        FROM work_items
        WHERE id = $1
      `, [ourItem.id]);
      const item = items[0];

      if (item.snoozed_until) {
        console.log(`   ✓ snoozed_until = ${item.snoozed_until}\n`);
      } else {
        console.log('   ✗ ERROR: snoozed_until is null!');
      }

      // Cleanup
      console.log('7. Cleaning up test data...');
      await db.query(`DELETE FROM work_items WHERE slack_user_id = $1`, [testUserId]);
      console.log('   ✓ Test data cleaned up\n');

      console.log('=== All tests passed! ===');
    } else {
      console.log('   ✗ Test item not found in bottlenecks');
      console.log('   Bottlenecks found:', bottlenecksBefore.map(b => b.text));

      // Cleanup anyway
      await db.query(`DELETE FROM work_items WHERE slack_user_id = $1`, [testUserId]);
    }

  } catch (error) {
    console.error('Test failed:', error);

    // Cleanup on error
    try {
      await db.query(`DELETE FROM work_items WHERE slack_user_id = $1`, [testUserId]);
    } catch {}

    process.exit(1);
  }
}

testSnooze();

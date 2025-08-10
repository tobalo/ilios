#!/usr/bin/env bun

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';

const migrate = async () => {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  const client = createClient({ url, authToken });
  const db = drizzle(client);

  console.log('Running migration to add workers table...');

  try {
    // Add worker_id column to job_queue if it doesn't exist
    try {
      await db.run(sql`ALTER TABLE job_queue ADD COLUMN worker_id TEXT`);
      console.log('✓ Added worker_id column to job_queue');
    } catch (error: any) {
      if (error.message.includes('duplicate column name')) {
        console.log('- worker_id column already exists in job_queue');
      } else {
        throw error;
      }
    }

    // Create worker_idx if it doesn't exist
    await db.run(sql`CREATE INDEX IF NOT EXISTS worker_idx ON job_queue(worker_id)`);
    console.log('✓ Created worker_idx index');

    // Create workers table
    await db.run(sql`
      CREATE TABLE IF NOT EXISTS workers (
        id TEXT PRIMARY KEY,
        pid INTEGER NOT NULL,
        hostname TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stopping', 'dead'))
      )
    `);
    console.log('✓ Created workers table');

    // Create indexes for workers table
    await db.run(sql`CREATE INDEX IF NOT EXISTS worker_status_idx ON workers(status)`);
    await db.run(sql`CREATE INDEX IF NOT EXISTS heartbeat_idx ON workers(last_heartbeat)`);
    console.log('✓ Created workers table indexes');

    // Clean up any existing processing jobs (reset to pending)
    const result = await db.run(sql`
      UPDATE job_queue 
      SET status = 'pending', worker_id = NULL, started_at = NULL
      WHERE status = 'processing'
    `);
    console.log(`✓ Reset ${result.rowsAffected} processing jobs to pending status`);

    // Clean up any old worker records
    await db.run(sql`DELETE FROM workers`);
    console.log('✓ Cleaned up old worker records');

    console.log('\nMigration completed successfully!');
    console.log('You can now restart your application to use the new worker tracking system.');
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  }
};

migrate().catch(console.error);
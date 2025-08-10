import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { sql } from 'drizzle-orm';

const setup = async () => {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    console.error('Missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN');
    process.exit(1);
  }

  const client = createClient({ url, authToken });
  const db = drizzle(client);

  console.log('Creating tables...');

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      s3_key TEXT NOT NULL,
      content TEXT,
      metadata TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'archived')),
      error TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      processed_at INTEGER,
      archived_at INTEGER,
      retention_days INTEGER NOT NULL DEFAULT 365,
      user_id TEXT,
      api_key TEXT
    )
  `);

  await db.run(sql`CREATE INDEX IF NOT EXISTS status_idx ON documents(status)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS created_at_idx ON documents(created_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS user_id_idx ON documents(user_id)`);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS usage (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      user_id TEXT,
      api_key TEXT,
      operation TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      base_cost_cents INTEGER NOT NULL,
      margin_rate INTEGER NOT NULL DEFAULT 30,
      total_cost_cents INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  await db.run(sql`CREATE INDEX IF NOT EXISTS document_id_idx ON usage(document_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS usage_user_id_idx ON usage(user_id)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS usage_created_at_idx ON usage(created_at)`);

  await db.run(sql`
    CREATE TABLE IF NOT EXISTS job_queue (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL REFERENCES documents(id),
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'retrying')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 3,
      payload TEXT,
      result TEXT,
      error TEXT,
      worker_id TEXT,
      scheduled_at INTEGER NOT NULL DEFAULT (unixepoch()),
      started_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  await db.run(sql`CREATE INDEX IF NOT EXISTS job_status_idx ON job_queue(status)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS scheduled_at_idx ON job_queue(scheduled_at)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS priority_idx ON job_queue(priority)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS worker_idx ON job_queue(worker_id)`);

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

  await db.run(sql`CREATE INDEX IF NOT EXISTS worker_status_idx ON workers(status)`);
  await db.run(sql`CREATE INDEX IF NOT EXISTS heartbeat_idx ON workers(last_heartbeat)`);

  console.log('Database setup complete!');
};

setup().catch(console.error);
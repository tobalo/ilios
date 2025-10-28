import type { Config } from 'drizzle-kit';

const useEmbeddedReplica = process.env.USE_EMBEDDED_REPLICA !== 'false';
const localDbPath = process.env.LOCAL_DB_PATH || './data/ilios.db';

// Hybrid configuration:
// - Turso mode: Uses libSQL driver for remote sync
// - Local mode: Direct file:// connection (Bun's native SQLite in runtime, basic driver in drizzle-kit)
export default {
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  ...(useEmbeddedReplica ? {
    driver: 'turso',
    dbCredentials: {
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN!,
    },
  } : {
    // Local-only mode: Runtime uses bun:sqlite (4x faster), drizzle-kit uses basic SQLite
    dbCredentials: {
      url: `file:${localDbPath}`,
    },
  }),
} satisfies Config;
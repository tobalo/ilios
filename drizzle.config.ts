import type { Config } from 'drizzle-kit';

const useEmbeddedReplica = process.env.USE_EMBEDDED_REPLICA !== 'false';
const localDbPath = process.env.LOCAL_DB_PATH || './data/ilios.db';

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
    dbCredentials: {
      url: `file:${localDbPath}`,
    },
  }),
} satisfies Config;
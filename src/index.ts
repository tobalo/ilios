import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { swaggerUI } from '@hono/swagger-ui';
import { DatabaseService } from './services/database';
import { S3Service } from './services/s3';
import { MistralService } from './services/mistral';
import { JobProcessorSpawn } from './services/job-processor-spawn';
import { createDocumentRoutes } from './routes/documents';
import { createUsageRoutes } from './routes/usage';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { openAPISpec } from './openapi';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());
app.use('*', errorHandler);

app.use('/api/*', authMiddleware);

app.get('/', (c) => {
  return c.json({
    name: 'Convert Docs API',
    version: '2.0.0',
    endpoints: {
      uploadUrl: 'POST /api/documents/upload-url',
      uploadComplete: 'POST /api/documents/upload-complete/:id',
      submit: 'POST /api/documents/submit',
      status: 'GET /api/documents/status/:id',
      download: 'GET /api/documents/:id',
      original: 'GET /api/documents/:id/original',
      usageSummary: 'GET /api/usage/summary',
      usageBreakdown: 'GET /api/usage/breakdown',
    },
  });
});

app.get('/openapi.json', (c) => {
  return c.json(openAPISpec);
});

app.get('/docs', swaggerUI({ url: '/openapi.json' }));

app.get('/health', async (c) => {
  const env = process.env as any;
  
  try {
    const db = new DatabaseService(
      env.TURSO_DATABASE_URL,
      env.TURSO_AUTH_TOKEN
    );
    
    await db.getDocument('health-check');
    
    return c.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        database: 'connected',
        s3: 'configured',
      },
    });
  } catch (error) {
    return c.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 503);
  }
});

const initializeServices = (env: any) => {
  const useEmbeddedReplica = env.USE_EMBEDDED_REPLICA !== 'false';
  
  const db = new DatabaseService(
    useEmbeddedReplica ? env.TURSO_DATABASE_URL : undefined,
    useEmbeddedReplica ? env.TURSO_AUTH_TOKEN : undefined,
    {
      localDbPath: env.LOCAL_DB_PATH || './data/ilios.db',
      syncIntervalSeconds: parseInt(env.TURSO_SYNC_INTERVAL || '60'),
      encryptionKey: env.DB_ENCRYPTION_KEY,
      useEmbeddedReplica,
    }
  );

  const s3 = new S3Service({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
    bucket: env.S3_BUCKET || 'convert-docs',
  });

  const mistral = new MistralService(env.MISTRAL_API_KEY);

  return { db, s3, mistral };
};

// Initialize services once
const env = process.env as any;
const { db, s3, mistral } = initializeServices(env);

// Test S3 connection on startup
s3.testConnection().then(connected => {
  if (!connected) {
    console.error('[Main] WARNING: S3 connection test failed during startup');
  }
}).catch(err => {
  console.error('[Main] ERROR: S3 connection test failed:', err);
});

// Mount document routes
const documentRoutes = createDocumentRoutes(db, s3);
app.route('/api/documents', documentRoutes);

// Mount usage routes
const usageRoutes = createUsageRoutes(db);
app.route('/api/usage', usageRoutes);

// Start job processor
let jobProcessor: JobProcessorSpawn | null = null;
let isJobProcessorStarted = false;

const startJobProcessor = async () => {
  if (!jobProcessor && !isJobProcessorStarted) {
    isJobProcessorStarted = true;
    
    await db.cleanupOrphanedJobs();
    
    jobProcessor = new JobProcessorSpawn(db, 2);
    await jobProcessor.start();
    console.log('Job processor started with 2 workers');
  }
};

startJobProcessor();

// Graceful shutdown handler
let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`${signal} received, shutting down gracefully`);
  
  if (jobProcessor) {
    await jobProcessor.stop();
    jobProcessor = null;
  }
  
  await db.close();
  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default {
  port: process.env.PORT ? parseInt(process.env.PORT) : 1337,
  fetch: app.fetch,
};
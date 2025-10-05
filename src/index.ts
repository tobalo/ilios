import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { swaggerUI } from '@hono/swagger-ui';
import { initializeServices, startJobProcessor } from './services';
import { createDocumentRoutes } from './routes/v1/documents';
import { createUsageRoutes } from './routes/v1/usage';
import { createConvertRoutes } from './routes/v1/convert';
import { createBatchRoutes } from './routes/v1/batch';
import { authMiddleware } from './middleware/auth';
import { errorHandler } from './middleware/error';
import { openAPISpec } from './openapi';

const app = new Hono();

app.use('*', cors());
app.use('*', logger());
app.use('*', errorHandler);

app.use('/api/*', authMiddleware);
app.use('/v1/*', authMiddleware);

app.get('/', (c) => {
  return c.json({
    name: 'Ilios API',
    version: '2.1.0',
    endpoints: {
      convert: 'POST /v1/convert',
      batchSubmit: 'POST /v1/batch/submit',
      batchStatus: 'GET /v1/batch/status/:batchId',
      batchDownload: 'GET /v1/batch/download/:batchId',
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
  try {
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

const env = process.env as any;
const { db, s3, mistral } = initializeServices(env);

s3.testConnection().then(connected => {
  if (!connected) {
    console.error('[Main] WARNING: S3 connection test failed during startup');
  }
}).catch(err => {
  console.error('[Main] ERROR: S3 connection test failed:', err);
});

const documentRoutes = createDocumentRoutes(db, s3);
app.route('/api/documents', documentRoutes);

const usageRoutes = createUsageRoutes(db);
app.route('/api/usage', usageRoutes);

const convertRoutes = createConvertRoutes(db, mistral);
app.route('/v1/convert', convertRoutes);

const batchRoutes = createBatchRoutes(db, s3);
app.route('/v1/batch', batchRoutes);

let jobProcessor = await startJobProcessor(db, 2);

let isShuttingDown = false;

const gracefulShutdown = async (signal: string) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`${signal} received, shutting down gracefully`);
  
  if (jobProcessor) {
    await jobProcessor.stop();
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
import { DatabaseService } from './database';
import { S3Service } from './s3';
import { MistralService } from './mistral';
import { JobProcessorSpawn } from './job-processor-spawn';

export interface Services {
  db: DatabaseService;
  s3: S3Service;
  mistral: MistralService;
  jobProcessor: JobProcessorSpawn | null;
}

export async function initializeServices(env: any): Promise<Services> {
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
  
  await db.initialize();

  const s3 = new S3Service({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
    bucket: env.S3_BUCKET || 'convert-docs',
  });

  const mistral = new MistralService(env.MISTRAL_API_KEY);

  return { db, s3, mistral, jobProcessor: null };
}

export async function startJobProcessor(db: DatabaseService, workerCount: number = 2): Promise<JobProcessorSpawn> {
  await db.cleanupOrphanedJobs();
  
  const jobProcessor = new JobProcessorSpawn(db, workerCount);
  await jobProcessor.start();
  console.log(`Job processor started with ${workerCount} workers`);
  
  return jobProcessor;
}

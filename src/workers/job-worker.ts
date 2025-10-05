#!/usr/bin/env bun

import { DatabaseService } from '../services/database';
import { S3Service } from '../services/s3';
import { MistralService } from '../services/mistral';
import { Bun } from 'bun';

interface WorkerMessage {
  type: 'process' | 'shutdown';
}

interface WorkerResponse {
  type: 'completed' | 'failed' | 'ready' | 'heartbeat';
  jobId?: string;
  error?: string;
}

class JobWorker {
  private db: DatabaseService;
  private s3: S3Service;
  private mistral: MistralService;
  private tempDir: string;
  private workerId: string;
  private heartbeatInterval?: Timer;
  private isShuttingDown = false;
  private activeJobId: string | null = null;

  constructor() {
    const env = process.env as any;
    this.workerId = env.WORKER_ID || `worker-${process.pid}`;
    
    try {
      const useEmbeddedReplica = env.USE_EMBEDDED_REPLICA !== 'false';
      
      this.db = new DatabaseService(
        useEmbeddedReplica ? env.TURSO_DATABASE_URL : undefined,
        useEmbeddedReplica ? env.TURSO_AUTH_TOKEN : undefined,
        {
          localDbPath: env.LOCAL_DB_PATH || './data/ilios.db',
          syncIntervalSeconds: parseInt(env.TURSO_SYNC_INTERVAL || '60'),
          encryptionKey: env.DB_ENCRYPTION_KEY,
          useEmbeddedReplica,
        }
      );

      this.s3 = new S3Service({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
        bucket: env.S3_BUCKET || 'convert-docs',
      });

      this.mistral = new MistralService(env.MISTRAL_API_KEY!);
      
      this.tempDir = './data/tmp';
      try {
        const fs = require('fs');
        if (!fs.existsSync(this.tempDir)) {
          fs.mkdirSync(this.tempDir, { recursive: true });
        }
      } catch (error) {
        console.error(`Error creating temp directory: ${error}`);
      }
    } catch (error) {
      console.error('Worker initialization error:', error);
      throw error;
    }
  }

  async processNextJob() {
    if (this.isShuttingDown) {
      return false;
    }

    // Atomically claim next available job
    const job = await this.db.claimNextJob(this.workerId);
    
    if (!job) {
      return false; // No jobs available
    }

    this.activeJobId = job.id;
    
    try {
      console.log(`Worker ${this.workerId} processing job ${job.id} (type: ${job.type}, attempt ${job.attempts}/${job.maxAttempts})`);

      switch (job.type) {
        case 'convert':
          await this.processConvertJob(job);
          break;
        case 'archive':
          await this.processArchiveJob(job);
          break;
        case 'upload':
          console.log(`Skipping upload job ${job.id} - handled by main process`);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }

      await this.db.completeJob(job.id);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Job ${job.id} failed:`, errorMessage);
      await this.db.failJob(job.id, errorMessage);
      return true;
    } finally {
      this.activeJobId = null;
    }
  }

  private async processConvertJob(job: any) {
    let tempFilePath: string | undefined;
    
    try {
      const document = await this.db.getDocument(job.documentId);
      if (!document) {
        throw new Error(`Document ${job.documentId} not found`);
      }

      await this.db.updateDocumentStatus(document.id, 'processing');

      const startTime = Date.now();
      
      const fileMetadata = await this.s3.getFileMetadata(document.s3Key);
      const isLargeFile = fileMetadata.size > 10 * 1024 * 1024;
      
      let fileData: ArrayBuffer;
      
      if (isLargeFile) {
        const fs = await import('fs/promises');
        tempFilePath = `./data/tmp/${document.id}-${Date.now()}.tmp`;
        
        console.log(`[Worker] Streaming large file to temp: ${tempFilePath}, s3Key: ${document.s3Key}`);
        
        await this.s3.streamToFile(document.s3Key, tempFilePath);
        
        console.log(`[Worker] File downloaded to temp, reading into memory`);
        
        fileData = await fs.readFile(tempFilePath);
      } else {
        fileData = await this.s3.downloadAsBuffer(document.s3Key);
      }
      
      console.log(`Processing document ${document.id} with mimeType: ${document.mimeType}, fileName: ${document.fileName}`);
      
      const result = await this.mistral.convertToMarkdown(
        fileData,
        document.mimeType,
        document.fileName
      );
      
      const processingTime = Date.now() - startTime;

      await this.db.updateDocumentStatus(document.id, 'completed', {
        content: result.content,
        metadata: {
          ...result.metadata,
          processingTimeMs: processingTime,
          fileSize: fileMetadata.size,
          largeFileProcessing: isLargeFile,
        },
      });

      const costData = this.mistral.calculateCost(result.usage);
      await this.db.trackUsage({
        documentId: document.id,
        userId: document.userId,
        apiKey: document.apiKey,
        operation: 'convert',
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        baseCostCents: costData.baseCostCents,
      });

      if (document.batchId) {
        await this.db.updateBatchProgress(document.batchId);
      }

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.db.updateDocumentStatus(job.documentId, 'failed', {
        error: errorMessage,
      });
      
      const document = await this.db.getDocument(job.documentId);
      if (document?.batchId) {
        await this.db.updateBatchProgress(document.batchId);
      }
      
      await this.db.failJob(job.id, errorMessage);
      throw error;
    } finally {
      if (tempFilePath) {
        try {
          const fs = await import('fs/promises');
          await fs.unlink(tempFilePath);
        } catch {}
      }
    }
  }

  private async processArchiveJob(job: any) {
    try {
      const document = await this.db.getDocument(job.documentId);
      if (!document || document.status !== 'completed') {
        throw new Error(`Document ${job.documentId} not ready for archival`);
      }

      const archiveKey = document.s3Key.replace('documents/', 'archive/');
      await this.s3.archiveDocument(document.s3Key, archiveKey);

      await this.db.updateDocumentStatus(document.id, 'archived', {
        metadata: {
          ...document.metadata,
          originalS3Key: document.s3Key,
          archiveS3Key: archiveKey,
        },
      });

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.db.failJob(job.id, errorMessage);
      throw error;
    }
  }

  async start() {
    console.log(`Worker ${this.workerId} started and ready to process jobs`);
    
    await this.db.registerWorker(this.workerId, process.pid, require('os').hostname());
    
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.db.updateWorkerHeartbeat(this.workerId);
        const response: WorkerResponse = { type: 'heartbeat' };
        console.log(JSON.stringify(response));
      } catch (error) {
        console.error(`[Worker ${this.workerId}] Heartbeat failed:`, error instanceof Error ? error.message : error);
      }
    }, 30000);
    
    const response: WorkerResponse = { type: 'ready' };
    console.log(JSON.stringify(response));

    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    
    const decoder = new TextDecoder();
    let buffer = '';

    process.stdin.on('data', async (chunk: Buffer | string) => {
      if (this.isShuttingDown) return;
      
      const data = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
      buffer += data;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        
        try {
          const message: WorkerMessage = JSON.parse(line);
          
          if (message.type === 'shutdown') {
            console.log('Shutdown signal received');
            await this.shutdown();
            process.exit(0);
          }
          
          if (message.type === 'process') {
            // Process jobs until queue is empty
            let processedAny = false;
            while (await this.processNextJob()) {
              processedAny = true;
            }
            
            if (processedAny) {
              const response: WorkerResponse = { type: 'completed' };
              console.log(JSON.stringify(response));
            }
          }
        } catch (error) {
          console.error('Worker message parse error:', error);
        }
      }
    });

    process.stdin.on('end', async () => {
      console.log('stdin ended, shutting down worker');
      await this.shutdown();
      process.exit(0);
    });
  }
  
  async shutdown() {
    console.log(`Worker ${this.workerId} starting graceful shutdown...`);
    this.isShuttingDown = true;
    
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    await this.db.updateWorkerStatus(this.workerId, 'stopping');
    
    if (this.activeJobId) {
      console.log(`Waiting for active job ${this.activeJobId} to complete...`);
      let attempts = 0;
      while (this.activeJobId && attempts < 50) {
        await Bun.sleep(100);
        attempts++;
      }
    }
    
    await this.db.close();
    console.log(`Worker ${this.workerId} shutdown complete`);
  }
}

// Start the worker
const worker = new JobWorker();

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received');
  await worker.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received');
  await worker.shutdown();
  process.exit(0);
});

worker.start().catch(console.error);
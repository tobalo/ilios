#!/usr/bin/env bun

import { DatabaseService } from '../services/database';
import { S3Service } from '../services/s3';
import { MistralService } from '../services/mistral';

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
      
      // Send completion via IPC
      if (process.send) {
        process.send({ type: 'completed', jobId: job.id });
      }
      
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`Job ${job.id} failed:`, errorMessage);
      await this.db.failJob(job.id, errorMessage);
      
      // Send failure via IPC
      if (process.send) {
        process.send({ type: 'failed', jobId: job.id, error: errorMessage });
      }
      
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
        throw new Error(`Document ${job.documentId} not found - job may reference invalid document ID`);
      }

      // Additional validation
      if (!document.s3Key) {
        throw new Error(`Document ${job.documentId} has no S3 key - upload may have failed`);
      }

      await this.db.updateDocumentStatus(document.id, 'processing');

      const startTime = Date.now();
      
      const fileMetadata = await this.s3.getFileMetadata(document.s3Key);
      const isLargeFile = fileMetadata.size > 10 * 1024 * 1024;
      
      let fileData: ArrayBuffer;
      
      if (isLargeFile) {
        tempFilePath = `./data/tmp/${document.id}-${Date.now()}.tmp`;
        
        console.log(`[Worker] Streaming large file to temp: ${tempFilePath}, s3Key: ${document.s3Key}`);
        
        await this.s3.streamToFile(document.s3Key, tempFilePath);
        
        console.log(`[Worker] File downloaded to temp, reading into memory`);
        
        fileData = await Bun.file(tempFilePath).arrayBuffer();
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
          await Bun.file(tempFilePath).delete();
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
    
    // Retry worker registration with exponential backoff for SQLITE_BUSY
    let registered = false;
    let attempts = 0;
    while (!registered && attempts < 5) {
      try {
        await this.db.registerWorker(this.workerId, process.pid, require('os').hostname());
        registered = true;
      } catch (error: any) {
        if (error.code === 'SQLITE_BUSY' && attempts < 4) {
          attempts++;
          const delay = Math.pow(2, attempts) * 100; // 200ms, 400ms, 800ms, 1600ms
          console.log(`[Worker ${this.workerId}] Registration locked, retrying in ${delay}ms (attempt ${attempts}/5)`);
          await Bun.sleep(delay);
        } else {
          throw error;
        }
      }
    }
    
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.db.updateWorkerHeartbeat(this.workerId);
        if (process.send) {
          process.send({ type: 'heartbeat' });
        }
      } catch (error) {
        console.error(`[Worker ${this.workerId}] Heartbeat failed:`, error instanceof Error ? error.message : error);
      }
    }, 30000);
    
    // Send ready message via IPC
    if (process.send) {
      process.send({ type: 'ready' });
    }

    // Listen for IPC messages from parent
    process.on('message', async (message: any) => {
      if (this.isShuttingDown) return;
      
      if (!message || typeof message !== 'object') {
        console.error('Invalid message received:', message);
        return;
      }

      const msg = message as WorkerMessage;
      
      if (msg.type === 'shutdown') {
        console.log('Shutdown signal received');
        await this.shutdown();
        process.exit(0);
      }
      
      if (msg.type === 'process') {
        // Process jobs until queue is empty
        while (await this.processNextJob()) {
          // Keep processing
        }
      }
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
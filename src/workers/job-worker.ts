#!/usr/bin/env bun

import { DatabaseService } from '../services/database';
import { S3Service } from '../services/s3';
import { MistralService } from '../services/mistral';
import { Bun } from 'bun';

interface WorkerMessage {
  type: 'process' | 'shutdown';
  jobId?: string;
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

  constructor() {
    const env = process.env as any;
    this.workerId = env.WORKER_ID || `worker-${process.pid}`;
    
    try {
      this.db = new DatabaseService(
        env.TURSO_DATABASE_URL!,
        env.TURSO_AUTH_TOKEN!,
        {
          localDbPath: env.LOCAL_DB_PATH || './src/db/convert-docs.db',
          syncIntervalSeconds: parseInt(env.TURSO_SYNC_INTERVAL || '60'),
          encryptionKey: env.DB_ENCRYPTION_KEY
        }
      );

      this.s3 = new S3Service({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
        bucket: env.S3_BUCKET || 'convert-docs',
      });

      this.mistral = new MistralService(env.MISTRAL_API_KEY!);
      
      // Create temp directory for large file processing
      this.tempDir = '/tmp/convert-api-worker';
      try {
        Bun.spawnSync(['mkdir', '-p', this.tempDir]);
      } catch {}
    } catch (error) {
      console.error('Worker initialization error:', error);
      throw error;
    }
  }

  async processJob(jobId: string) {
    const job = await this.db.getJob(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    console.log(`Worker processing job ${job.id} of type ${job.type}`);

    switch (job.type) {
      case 'convert':
        await this.processConvertJob(job);
        break;
      case 'archive':
        await this.processArchiveJob(job);
        break;
      case 'upload':
        // Upload jobs are handled by the main process, not workers
        console.log(`Skipping upload job ${job.id} - handled by main process`);
        break;
      default:
        throw new Error(`Unknown job type: ${job.type}`);
    }

    await this.db.completeJob(job.id);
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
      
      // For large files, download to temp file instead of memory
      const fileMetadata = await this.s3.getFileMetadata(document.s3Key);
      const isLargeFile = fileMetadata.size > 10 * 1024 * 1024; // 10MB threshold
      
      let fileData: ArrayBuffer;
      
      if (isLargeFile) {
        // Stream large files directly to disk using Bun's optimized I/O
        tempFilePath = `${this.tempDir}/${document.id}-${Date.now()}.tmp`;
        
        // Use Bun's streaming capabilities to download directly to file
        await this.s3.streamToFile(document.s3Key, tempFilePath);
        
        // Read file for Mistral processing using Bun.file
        const file = Bun.file(tempFilePath);
        fileData = await file.arrayBuffer();
      } else {
        // Small files can be handled in memory
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

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      await this.db.updateDocumentStatus(job.documentId, 'failed', {
        error: errorMessage,
      });
      await this.db.failJob(job.id, errorMessage);
      throw error;
    } finally {
      // Cleanup temp file
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
    
    // Register worker with database
    await this.db.registerWorker(this.workerId, process.pid, require('os').hostname());
    
    // Start heartbeat
    this.heartbeatInterval = setInterval(async () => {
      await this.db.updateWorkerHeartbeat(this.workerId);
      const response: WorkerResponse = { type: 'heartbeat' };
      console.log(JSON.stringify(response));
    }, 30000); // Every 30 seconds
    
    // Send ready message to parent
    const response: WorkerResponse = { type: 'ready' };
    console.log(JSON.stringify(response));

    // Listen for messages from parent process
    for await (const line of console) {
      try {
        const message: WorkerMessage = JSON.parse(line);
        
        if (message.type === 'shutdown') {
          console.log('Worker shutting down');
          await this.shutdown();
          process.exit(0);
        }
        
        if (message.type === 'process' && message.jobId) {
          try {
            await this.processJob(message.jobId);
            const response: WorkerResponse = { 
              type: 'completed', 
              jobId: message.jobId 
            };
            console.log(JSON.stringify(response));
          } catch (error) {
            const response: WorkerResponse = { 
              type: 'failed', 
              jobId: message.jobId,
              error: error instanceof Error ? error.message : 'Unknown error'
            };
            console.log(JSON.stringify(response));
          }
        }
      } catch (error) {
        console.error('Worker error:', error);
      }
    }
  }
  
  async shutdown() {
    // Stop heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    // Mark worker as stopping
    await this.db.updateWorkerStatus(this.workerId, 'stopping');
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
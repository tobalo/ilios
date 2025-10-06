/// <reference lib="webworker" />
declare const self: Worker;

import type { DatabaseService } from '../services/database';
import type { S3Service } from '../services/s3';
import type { MistralService } from '../services/mistral';

interface WorkerInitMessage {
  type: 'init';
  env: Record<string, string>;
  workerId: string;
}

interface WorkerProcessMessage {
  type: 'process';
}

interface WorkerShutdownMessage {
  type: 'shutdown';
}

type WorkerMessage = WorkerInitMessage | WorkerProcessMessage | WorkerShutdownMessage;

interface WorkerReadyResponse {
  type: 'ready';
  workerId: string;
}

interface WorkerCompletedResponse {
  type: 'completed';
  jobId: string;
}

interface WorkerFailedResponse {
  type: 'failed';
  jobId: string;
  error: string;
}

interface WorkerErrorResponse {
  type: 'error';
  error: string;
}

type WorkerResponse = WorkerReadyResponse | WorkerCompletedResponse | WorkerFailedResponse | WorkerErrorResponse;

class JobWorkerThread {
  private db!: DatabaseService;
  private s3!: S3Service;
  private mistral!: MistralService;
  private workerId!: string;
  private isShuttingDown = false;
  private activeJobId: string | null = null;

  async initialize(env: Record<string, string>, workerId: string) {
    this.workerId = workerId;
    
    const { DatabaseService } = await import('../services/database');
    const { S3Service } = await import('../services/s3');
    const { MistralService } = await import('../services/mistral');
    
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
      accessKeyId: env.AWS_ACCESS_KEY_ID!,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      endpoint: env.AWS_ENDPOINT_URL_S3 || 'https://fly.storage.tigris.dev',
      bucket: env.S3_BUCKET || 'convert-docs',
    });

    this.mistral = new MistralService(env.MISTRAL_API_KEY!);
    
    console.log(`[Worker ${this.workerId}] Initialized and ready`);
  }

  async processNextJob(): Promise<boolean> {
    if (this.isShuttingDown) {
      return false;
    }

    const job = await this.db.claimNextJob(this.workerId);
    
    if (!job) {
      return false;
    }

    this.activeJobId = job.id;
    
    try {
      console.log(`[Worker ${this.workerId}] Processing job ${job.id} (type: ${job.type}, attempt ${job.attempts}/${job.maxAttempts})`);

      switch (job.type) {
        case 'convert':
          await this.processConvertJob(job);
          break;
        case 'archive':
          await this.processArchiveJob(job);
          break;
        default:
          throw new Error(`Unknown job type: ${job.type}`);
      }
      
      postMessage({ type: 'completed', jobId: job.id } as WorkerCompletedResponse);
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Worker ${this.workerId}] Job ${job.id} failed:`, errorMessage);
      await this.db.failJob(job.id, errorMessage);
      
      postMessage({ type: 'failed', jobId: job.id, error: errorMessage } as WorkerFailedResponse);
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

      if (!document.s3Key) {
        throw new Error(`Document ${job.documentId} has no S3 key`);
      }

      const startTime = Date.now();
      
      const fileMetadata = await this.s3.getFileMetadata(document.s3Key);
      const isLargeFile = fileMetadata.size > 10 * 1024 * 1024;
      
      let fileData: ArrayBuffer;
      
      if (isLargeFile) {
        tempFilePath = `./data/tmp/${document.id}-${Date.now()}.tmp`;
        await this.s3.streamToFile(document.s3Key, tempFilePath);
        
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(tempFilePath);
        fileData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } else {
        fileData = await this.s3.downloadAsBuffer(document.s3Key);
      }
      
      const result = await this.mistral.convertToMarkdown(
        fileData,
        document.mimeType,
        document.fileName
      );
      
      const processingTime = Date.now() - startTime;

      await this.db.updateJobAndDocumentStatus(
        job.id,
        document.id,
        'completed',
        'completed',
        {
          content: result.content,
          metadata: {
            ...result.metadata,
            processingTimeMs: processingTime,
            fileSize: fileMetadata.size,
            largeFileProcessing: isLargeFile,
          },
        }
      );

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
      
      try {
        await this.db.updateDocumentStatus(job.documentId, 'failed', {
          error: errorMessage,
        });
      } catch (statusError) {
        console.error(`[Worker ${this.workerId}] Failed to update document status (non-fatal):`, statusError);
      }
      
      const document = await this.db.getDocument(job.documentId);
      if (document?.batchId) {
        try {
          await this.db.updateBatchProgress(document.batchId);
        } catch (batchError) {
          console.error(`[Worker ${this.workerId}] Failed to update batch progress (non-fatal):`, batchError);
        }
      }
      
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

  async shutdown() {
    console.log(`[Worker ${this.workerId}] Starting graceful shutdown...`);
    this.isShuttingDown = true;
    
    if (this.activeJobId) {
      console.log(`[Worker ${this.workerId}] Waiting for active job ${this.activeJobId} to complete...`);
      let attempts = 0;
      while (this.activeJobId && attempts < 50) {
        await Bun.sleep(100);
        attempts++;
      }
    }
    
    console.log(`[Worker ${this.workerId}] Shutdown complete`);
  }
}

const worker = new JobWorkerThread();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;
  
  try {
    switch (message.type) {
      case 'init':
        await worker.initialize(message.env, message.workerId);
        postMessage({ type: 'ready', workerId: message.workerId } as WorkerReadyResponse);
        break;
        
      case 'process':
        while (await worker.processNextJob()) {
          // Keep processing
        }
        break;
        
      case 'shutdown':
        await worker.shutdown();
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Worker error:', errorMessage);
    postMessage({ type: 'error', error: errorMessage } as WorkerErrorResponse);
  }
};

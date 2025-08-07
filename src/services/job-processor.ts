import { DatabaseService } from './database';
import { S3Service } from './s3';
import { MistralService } from './mistral';

export class JobProcessor {
  private db: DatabaseService;
  private s3: S3Service;
  private mistral: MistralService;
  private isRunning = false;
  private interval?: Timer;

  constructor(
    db: DatabaseService,
    s3: S3Service,
    mistral: MistralService
  ) {
    this.db = db;
    this.s3 = s3;
    this.mistral = mistral;
  }

  start(intervalMs = 5000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this.interval = setInterval(async () => {
      await this.processNextJob();
    }, intervalMs);
    
    this.processNextJob();
  }

  stop() {
    this.isRunning = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  private async processNextJob() {
    if (!this.isRunning) return;

    try {
      const job = await this.db.getNextJob();
      if (!job) return;

      console.log(`Processing job ${job.id} of type ${job.type}`);

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

      await this.db.completeJob(job.id);
    } catch (error) {
      console.error('Job processing error:', error);
    }
  }

  private async processConvertJob(job: any) {
    try {
      const document = await this.db.getDocument(job.documentId);
      if (!document) {
        throw new Error(`Document ${job.documentId} not found`);
      }

      await this.db.updateDocumentStatus(document.id, 'processing');

      const fileData = await this.s3.downloadAsBuffer(document.s3Key);
      
      const startTime = Date.now();
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
    }
  }

  async processArchivalBatch() {
    const archivedCount = await this.db.archiveOldDocuments();
    console.log(`Archived ${archivedCount} documents`);
    
    for (let i = 0; i < archivedCount; i++) {
      await this.db.createJob({
        documentId: '',
        type: 'archive',
        priority: -1,
      });
    }
  }
}
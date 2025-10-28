import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { documents, usage, jobQueue, batches } from '../db/schema';
import { eq, and, sql, desc } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as path from 'path';

export class DatabaseService {
  public db;
  private client;
  private syncInterval: NodeJS.Timeout | null = null;

  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    const maxAttempts = 5;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        return await operation();
      } catch (error: any) {
        attempts++;
        if (error.code === 'SQLITE_BUSY' && attempts < maxAttempts) {
          const delay = Math.pow(2, attempts) * 50; // 100ms, 200ms, 400ms, 800ms, 1600ms
          console.log(`[Database] ${operationName} SQLITE_BUSY, retrying in ${delay}ms (attempt ${attempts}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }

    throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
  }

  constructor(syncUrl?: string, authToken?: string, options?: {
    localDbPath?: string;
    syncIntervalSeconds?: number;
    encryptionKey?: string;
    useEmbeddedReplica?: boolean;
  }) {
    const localDbPath = options?.localDbPath || path.join(process.cwd(), 'data/ilios.db');
    const useEmbeddedReplica = options?.useEmbeddedReplica ?? true;
    
    if (useEmbeddedReplica && syncUrl && authToken) {
      console.log(`Initializing embedded replica with local db: ${localDbPath}`);
      
      this.client = createClient({
        url: `file:${localDbPath}`,
        syncUrl: syncUrl,
        authToken: authToken,
        syncInterval: options?.syncIntervalSeconds || 60,
        encryptionKey: options?.encryptionKey,
      });
      
      this.db = drizzle(this.client);
      
      if (options?.syncIntervalSeconds) {
        this.syncInterval = setInterval(() => {
          this.syncDatabase().catch(err => {
            console.error('Periodic sync failed:', err);
          });
        }, options.syncIntervalSeconds * 1000);
      }
    } else {
      console.log(`Initializing local database: ${localDbPath}`);
      
      this.client = createClient({
        url: `file:${localDbPath}`,
        encryptionKey: options?.encryptionKey,
      });
      
      this.db = drizzle(this.client);
    }
  }
  
  async initialize() {
    await this.initializeDatabase();
  }
  
  private async initializeDatabase() {
    try {
      // Use drizzle's sql template for better compatibility
      await this.db.run(sql`PRAGMA journal_mode = WAL`);
      await this.db.run(sql`PRAGMA busy_timeout = 5000`);
      await this.db.run(sql`PRAGMA synchronous = NORMAL`);
      
      // Verify settings
      const timeout = await this.db.get(sql`PRAGMA busy_timeout`);
      console.log(`Database initialized: WAL mode, busy_timeout=${(timeout as any).timeout}ms`);
      
      // Auto-migrate if tables don't exist
      await this.autoMigrate();
    } catch (error) {
      console.warn('Failed to set database PRAGMAs:', error);
    }
  }
  
  private async autoMigrate() {
    try {
      const result = await this.client.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
      );
      
      if (result.rows.length === 0) {
        console.log('[Migration] Database is empty, running migrations...');
        
        const fs = await import('fs/promises');
        const path = await import('path');
        
        const migrationsDir = path.join(process.cwd(), 'src/db/migrations');
        const files = await fs.readdir(migrationsDir);
        const sqlFiles = files
          .filter(f => f.endsWith('.sql'))
          .sort()
          .reverse();
        
        const latestMigration = sqlFiles[0];
        
        if (latestMigration) {
          console.log(`[Migration] Running latest schema: ${latestMigration}`);
          const filePath = path.join(migrationsDir, latestMigration);
          const migration = await fs.readFile(filePath, 'utf-8');
          
          const statements = migration
            .split(/-->.*?breakpoint/g)
            .join('')
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0 && !s.startsWith('--'));
          
          for (const statement of statements) {
            try {
              await this.client.execute(statement);
            } catch (error: any) {
              if (error.message?.includes('already exists')) {
                console.log(`[Migration] Skipping (already exists): ${statement.substring(0, 50)}...`);
              } else {
                console.error(`[Migration] Failed: ${statement.substring(0, 100)}...`);
                throw error;
              }
            }
          }
          
          console.log('[Migration] Schema initialized successfully');
        }
      } else {
        console.log('[Migration] Database already initialized, skipping migrations');
      }
    } catch (error) {
      console.error('[Migration] Failed to auto-migrate:', error);
      throw error;
    }
  }
  
  async syncDatabase() {
    if (!this.client.sync) {
      return;
    }
    
    try {
      console.log('Syncing embedded replica with remote database...');
      await this.client.sync();
      console.log('Sync completed successfully');
    } catch (error) {
      console.error('Sync error:', error);
      throw error;
    }
  }
  
  async close() {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    await this.client.close();
  }

  async createDocument(data: {
    fileName: string;
    mimeType: string;
    fileSize: number;
    s3Key: string;
    userId?: string;
    apiKey?: string;
    retentionDays?: number;
    batchId?: string;
  }) {
    const id = createId();
    
    await this.withRetry(
      () => this.db.insert(documents).values({
        id,
        ...data,
        status: 'pending',
      }),
      'createDocument'
    );
    
    return id;
  }

  async updateDocumentStatus(id: string, status: 'processing' | 'completed' | 'failed', data?: {
    content?: string;
    metadata?: any;
    error?: string;
  }) {
    await this.withRetry(
      () => this.db.update(documents)
        .set({
          status,
          ...(status === 'completed' && { processedAt: new Date() }),
          ...(data || {}),
        })
        .where(eq(documents.id, id)),
      'updateDocumentStatus'
    );
  }

  async getDocument(id: string) {
    const [doc] = await this.db.select().from(documents).where(eq(documents.id, id));
    return doc;
  }

  async trackUsage(data: {
    documentId: string;
    userId?: string;
    apiKey?: string;
    operation: string;
    inputTokens?: number;
    outputTokens?: number;
    baseCostCents: number;
    marginRate?: number;
  }) {
    const id = createId();
    const totalCostCents = Math.ceil(data.baseCostCents * (1 + (data.marginRate || 30) / 100));
    
    await this.withRetry(
      () => this.db.insert(usage).values({
        id,
        ...data,
        totalCostCents,
      }),
      'trackUsage'
    );
  }

  async getUsageSummary(filters?: { userId?: string; apiKey?: string; startDate?: Date; endDate?: Date }) {
    let query = this.db.select({
      totalDocuments: sql<number>`count(distinct ${usage.documentId})`,
      totalOperations: sql<number>`count(*)`,
      totalInputTokens: sql<number>`sum(${usage.inputTokens})`,
      totalOutputTokens: sql<number>`sum(${usage.outputTokens})`,
      totalCostCents: sql<number>`sum(${usage.totalCostCents})`,
    }).from(usage);

    const conditions = [];
    if (filters?.userId) conditions.push(eq(usage.userId, filters.userId));
    if (filters?.apiKey) conditions.push(eq(usage.apiKey, filters.apiKey));
    if (filters?.startDate) conditions.push(sql`${usage.createdAt} >= ${filters.startDate.getTime() / 1000}`);
    if (filters?.endDate) conditions.push(sql`${usage.createdAt} <= ${filters.endDate.getTime() / 1000}`);

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const [result] = await query;
    return result;
  }

  async createJob(data: {
    documentId: string;
    type: string;
    priority?: number;
    payload?: any;
    scheduledAt?: Date;
  }) {
    const id = createId();
    
    await this.withRetry(
      () => this.db.insert(jobQueue).values({
        id,
        ...data,
        status: 'pending',
      }),
      'createJob'
    );
    
    return id;
  }

  // Atomically claim a job for a specific worker
  async claimNextJob(workerId: string) {
    return await this.withRetry(
      async () => {
        // Use a transaction to ensure atomicity
        return await this.db.transaction(async (tx) => {
          // Find next available job
          const [availableJob] = await tx.select()
            .from(jobQueue)
            .where(
              and(
                eq(jobQueue.status, 'pending'),
                sql`${jobQueue.scheduledAt} <= unixepoch()`
              )
            )
            .orderBy(desc(jobQueue.priority), jobQueue.scheduledAt)
            .limit(1);
          
          if (!availableJob) return null;
          
          // Try to claim it atomically
          const [claimedJob] = await tx.update(jobQueue)
            .set({
              status: 'processing',
              workerId: workerId,
              startedAt: new Date(),
              attempts: availableJob.attempts + 1,
            })
            .where(
              and(
                eq(jobQueue.id, availableJob.id),
                eq(jobQueue.status, 'pending'), // Double-check it's still pending
              )
            )
            .returning();
          
          return claimedJob;
        });
      },
      'claimNextJob'
    );
  }

  async cleanupOrphanedJobs() {
    // Find jobs that have been processing for more than 5 minutes (likely stuck/orphaned)
    const timeoutThreshold = Math.floor(Date.now() / 1000) - 300; // 5 minutes ago
    
    const orphanedJobs = await this.db.select()
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.status, 'processing'),
          sql`unixepoch(${jobQueue.startedAt}) < ${timeoutThreshold}`
        )
      );
    
    let resetCount = 0;
    let failedCount = 0;
    
    for (const job of orphanedJobs) {
      console.log(`[Cleanup] Job ${job.id} timed out (attempts: ${job.attempts}/${job.maxAttempts}, worker: ${job.workerId}, started: ${job.startedAt})`);
      
      if (job.attempts >= job.maxAttempts) {
        await this.db.update(jobQueue)
          .set({
            status: 'failed',
            completedAt: new Date(),
            error: `Max retry attempts exceeded (job timeout >5 minutes)`,
            workerId: null,
          })
          .where(eq(jobQueue.id, job.id));
        
        if (job.documentId) {
          try {
            await this.updateDocumentStatus(job.documentId, 'failed', {
              error: `Max retry attempts exceeded (job timeout >5 minutes)`,
            });
            
            const doc = await this.getDocument(job.documentId);
            if (doc?.batchId) {
              await this.updateBatchProgress(doc.batchId);
            }
          } catch (error) {
            console.error(`Failed to update document ${job.documentId} status:`, error);
          }
        }
        
        failedCount++;
      } else {
        await this.db.update(jobQueue)
          .set({
            status: 'pending',
            workerId: null,
            startedAt: null,
            scheduledAt: new Date(Date.now() + Math.pow(2, job.attempts) * 5000),
          })
          .where(eq(jobQueue.id, job.id));
        resetCount++;
      }
    }
    
    if (resetCount > 0 || failedCount > 0) {
      console.log(`Cleaned up ${orphanedJobs.length} orphaned jobs: ${resetCount} reset, ${failedCount} failed`);
    }
    
    return orphanedJobs.length;
  }



  async getJob(jobId: string) {
    const [job] = await this.db.select()
      .from(jobQueue)
      .where(eq(jobQueue.id, jobId));
    return job;
  }

  async completeJob(id: string, result?: any) {
    await this.db.update(jobQueue)
      .set({
        status: 'completed',
        completedAt: new Date(),
        result,
      })
      .where(eq(jobQueue.id, id));
  }

  async updateJobAndDocumentStatus(
    jobId: string,
    documentId: string,
    jobStatus: 'completed' | 'failed',
    documentStatus: 'completed' | 'failed',
    data?: {
      content?: string;
      metadata?: any;
      error?: string;
      result?: any;
    }
  ) {
    await this.withRetry(
      async () => {
        await this.db.transaction(async (tx) => {
          await tx.update(jobQueue)
            .set({
              status: jobStatus,
              completedAt: new Date(),
              result: data?.result,
              error: data?.error,
            })
            .where(eq(jobQueue.id, jobId));

          await tx.update(documents)
            .set({
              status: documentStatus,
              ...(documentStatus === 'completed' && { processedAt: new Date() }),
              content: data?.content,
              metadata: data?.metadata,
              error: data?.error,
            })
            .where(eq(documents.id, documentId));
        });
      },
      'updateJobAndDocumentStatus'
    );
  }

  async failJob(id: string, error: string) {
    const [job] = await this.db.select().from(jobQueue).where(eq(jobQueue.id, id));
    
    if (job && job.attempts < job.maxAttempts) {
      await this.db.update(jobQueue)
        .set({
          status: 'pending',
          error,
          scheduledAt: new Date(Date.now() + Math.pow(2, job.attempts) * 60000),
        })
        .where(eq(jobQueue.id, id));
    } else {
      await this.db.update(jobQueue)
        .set({
          status: 'failed',
          completedAt: new Date(),
          error,
        })
        .where(eq(jobQueue.id, id));
    }
  }

  async archiveOldDocuments() {
    const cutoffDate = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    const docsToArchive = await this.db.select()
      .from(documents)
      .where(
        and(
          eq(documents.status, 'completed'),
          sql`${documents.createdAt} + (${documents.retentionDays} * 86400) <= unixepoch()`,
          sql`${documents.archivedAt} IS NULL`
        )
      );
    
    for (const doc of docsToArchive) {
      await this.db.update(documents)
        .set({
          status: 'archived',
          archivedAt: new Date(),
        })
        .where(eq(documents.id, doc.id));
    }
    
    return docsToArchive.length;
  }

  async createBatch(data: {
    userId?: string;
    apiKey?: string;
    totalDocuments: number;
    priority?: number;
    metadata?: any;
  }) {
    const id = createId();
    
    await this.withRetry(
      () => this.db.insert(batches).values({
        id,
        ...data,
        status: 'pending',
      }),
      'createBatch'
    );
    
    return id;
  }

  async getBatch(id: string) {
    const [batch] = await this.db.select().from(batches).where(eq(batches.id, id));
    return batch;
  }

  async updateBatchMistralJob(batchId: string, mistralJobId: string, mistralInputFileId: string) {
    await this.withRetry(
      () => this.db.update(batches)
        .set({
          batchType: 'mistral',
          mistralBatchJobId: mistralJobId,
          mistralInputFileId: mistralInputFileId,
          status: 'processing',
        })
        .where(eq(batches.id, batchId)),
      'updateBatchMistralJob'
    );
  }

  async updateBatchMistralOutput(batchId: string, mistralOutputFileId: string) {
    await this.withRetry(
      () => this.db.update(batches)
        .set({
          mistralOutputFileId: mistralOutputFileId,
        })
        .where(eq(batches.id, batchId)),
      'updateBatchMistralOutput'
    );
  }

  async updateBatchProgress(batchId: string) {
    const batchDocs = await this.db.select()
      .from(documents)
      .where(eq(documents.batchId, batchId));

    const completed = batchDocs.filter(d => d.status === 'completed').length;
    const failed = batchDocs.filter(d => d.status === 'failed').length;
    const total = batchDocs.length;

    const allDone = completed + failed === total;
    const batchStatus = allDone 
      ? (failed === total ? 'failed' : 'completed')
      : (completed > 0 || failed > 0 ? 'processing' : 'pending');

    await this.db.update(batches)
      .set({
        completedDocuments: completed,
        failedDocuments: failed,
        status: batchStatus,
        ...(allDone && { completedAt: new Date() }),
      })
      .where(eq(batches.id, batchId));

    return { completed, failed, total, status: batchStatus };
  }

  async getBatchDocuments(batchId: string) {
    return await this.db.select()
      .from(documents)
      .where(eq(documents.batchId, batchId))
      .orderBy(documents.createdAt);
  }

  async listBatches(filters?: { userId?: string; apiKey?: string; status?: string }) {
    let query = this.db.select().from(batches);

    const conditions = [];
    if (filters?.userId) conditions.push(eq(batches.userId, filters.userId));
    if (filters?.apiKey) conditions.push(eq(batches.apiKey, filters.apiKey));
    if (filters?.status) conditions.push(eq(batches.status, filters.status));

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    return await query.orderBy(desc(batches.createdAt));
  }
}
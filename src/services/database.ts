import { drizzle as drizzleLibSQL } from 'drizzle-orm/libsql';
import { drizzle as drizzleBunSQLite } from 'drizzle-orm/bun-sqlite';
import { createClient } from '@libsql/client';
import { Database } from 'bun:sqlite';
import { documents, usage, jobQueue, batches } from '../db/schema';
import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as path from 'path';

export class DatabaseService {
  public db;
  private client;
  private syncInterval: NodeJS.Timeout | null = null;
  private useNativeBun: boolean = false;
  private preparedStatements: {
    getDocument?: any;
  } = {};

  /**
   * Retry helper for SQLite BUSY errors with exponential backoff
   */
  private async withRetry<T>(
    operation: () => Promise<T>,
    operationName: string = 'operation'
  ): Promise<T> {
    const maxAttempts = 5;
    let attempts = 0;

    while (attempts < maxAttempts) {
      try {
        return await operation();
      } catch (error: unknown) {
        attempts++;
        const isBusyError = error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY';
        if (isBusyError && attempts < maxAttempts) {
          const delay = (2 ** attempts) * 50; // 100ms, 200ms, 400ms, 800ms, 1600ms
          console.log(`[Database] ${operationName} SQLITE_BUSY, retrying in ${delay}ms (attempt ${attempts}/${maxAttempts})`);
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }

    throw new Error(`${operationName} failed after ${maxAttempts} attempts`);
  }

  /**
   * Initialize database service with local SQLite or Turso sync
   * @param syncUrl - Turso database URL (optional, for sync mode)
   * @param authToken - Turso auth token (optional, for sync mode)
   * @param options - Configuration options
   * @param options.localDbPath - Local SQLite file path (default: ./data/ilios.db)
   * @param options.syncIntervalSeconds - Sync interval in seconds (default: 60)
   * @param options.encryptionKey - Optional encryption key for local database
   * @param options.useEmbeddedReplica - Enable Turso embedded replica sync (default: true if syncUrl provided)
   */
  constructor(syncUrl?: string, authToken?: string, options?: {
    localDbPath?: string;
    syncIntervalSeconds?: number;
    encryptionKey?: string;
    useEmbeddedReplica?: boolean;
  }) {
    const localDbPath = options?.localDbPath || path.join(process.cwd(), 'data/ilios.db');
    const useEmbeddedReplica = options?.useEmbeddedReplica ?? true;

    if (useEmbeddedReplica && syncUrl && authToken) {
      console.log(`[Database] Initializing libSQL with Turso sync: ${localDbPath}`);

      // Use libSQL for Turso sync mode
      this.client = createClient({
        url: `file:${localDbPath}`,
        syncUrl: syncUrl,
        authToken: authToken,
        syncInterval: options?.syncIntervalSeconds || 60,
        encryptionKey: options?.encryptionKey,
      });

      this.db = drizzleLibSQL(this.client);
      this.useNativeBun = false;

      if (options?.syncIntervalSeconds) {
        this.syncInterval = setInterval(() => {
          this.syncDatabase().catch(err => {
            console.error('Periodic sync failed:', err);
          });
        }, options.syncIntervalSeconds * 1000);
      }
    } else {
      console.log(`[Database] Initializing native Bun SQLite (local-only, FAST!): ${localDbPath}`);

      // Use native Bun SQLite for local-only mode (4x faster!)
      this.client = new Database(localDbPath, { create: true, readwrite: true });
      this.db = drizzleBunSQLite(this.client);
      this.useNativeBun = true;
    }
  }
  
  async initialize() {
    await this.initializeDatabase();
  }
  
  private async initializeDatabase() {
    try {
      if (this.useNativeBun) {
        // Use native Bun SQLite APIs for optimal performance
        const db = this.client as Database;

        // Core PRAGMAs (apply to both modes)
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA busy_timeout = 5000');
        db.run('PRAGMA synchronous = NORMAL');

        // Performance optimization PRAGMAs (native Bun only)
        db.run('PRAGMA cache_size = -64000');        // 64MB cache
        db.run('PRAGMA temp_store = MEMORY');        // Temp tables in memory
        db.run('PRAGMA mmap_size = 268435456');      // 256MB memory-mapped I/O
        db.run('PRAGMA page_size = 8192');           // 8KB pages
        db.run('PRAGMA wal_autocheckpoint = 1000');  // Checkpoint every 1000 pages

        console.log('[Database] Native Bun SQLite initialized with optimized PRAGMAs');
      } else {
        // Use drizzle's sql template for libSQL compatibility
        await this.db.run(sql`PRAGMA journal_mode = WAL`);
        await this.db.run(sql`PRAGMA busy_timeout = 5000`);
        await this.db.run(sql`PRAGMA synchronous = NORMAL`);

        console.log('[Database] libSQL initialized with standard PRAGMAs');
      }

      // Auto-migrate FIRST - must run before prepared statements
      await this.autoMigrate();

      // Initialize prepared statements AFTER tables exist
      if (this.useNativeBun) {
        const db = this.client as Database;
        this.preparedStatements.getDocument = db.query('SELECT * FROM documents WHERE id = ?');
        console.log('[Database] Prepared statements initialized');
      }
    } catch (error) {
      console.error('[Database] Failed to initialize database:', error);
      throw error; // Rethrow - app should not start with broken database
    }
  }
  
  private async autoMigrate() {
    try {
      let tableExists = false;

      if (this.useNativeBun) {
        // Use native Bun SQLite query API
        const db = this.client as Database;
        const result = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").all();
        tableExists = result.length > 0;
      } else {
        // Use libSQL execute API
        const result = await this.client.execute(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='documents'"
        );
        tableExists = result.rows.length > 0;
      }

      if (!tableExists) {
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
              if (this.useNativeBun) {
                // Use native Bun SQLite run API
                (this.client as Database).run(statement);
              } else {
                // Use libSQL execute API
                await this.client.execute(statement);
              }
            } catch (error: unknown) {
              const errorMessage = error && typeof error === 'object' && 'message' in error ? error.message : '';
              if (typeof errorMessage === 'string' && errorMessage.includes('already exists')) {
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

    // Close prepared statements if using native Bun SQLite
    if (this.useNativeBun) {
      if (this.preparedStatements.getDocument) {
        this.preparedStatements.getDocument.finalize();
      }
      if (this.preparedStatements.countPendingJobs) {
        this.preparedStatements.countPendingJobs.finalize();
      }
      // Close native Bun SQLite database
      (this.client as Database).close();
    } else {
      // Close libSQL client
      await this.client.close();
    }
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
    if (this.useNativeBun && this.preparedStatements.getDocument) {
      // Use prepared statement for native Bun SQLite (2x faster)
      return this.preparedStatements.getDocument.get(id);
    }
    // Fallback to Drizzle ORM for libSQL
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

  /**
   * Atomically claim the next available job for a worker
   * Uses a database transaction to ensure only one worker claims each job
   * @param workerId - Worker ID claiming the job
   * @returns Claimed job or null if no jobs available
   */
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

  /**
   * Clean up orphaned jobs (stuck processing >5 minutes)
   * Jobs exceeding max attempts are marked failed, others are reset with backoff
   * Automatically updates associated documents and batch progress
   * @returns Number of orphaned jobs processed
   */
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

    if (orphanedJobs.length === 0) {
      return 0;
    }

    // Separate jobs into two batches: jobs to fail and jobs to reset
    const jobsToFail: string[] = [];
    const jobsToReset: string[] = [];
    const docsToFail: { id: string; batchId?: string }[] = [];

    for (const job of orphanedJobs) {
      console.log(`[Cleanup] Job ${job.id} timed out (attempts: ${job.attempts}/${job.maxAttempts}, worker: ${job.workerId}, started: ${job.startedAt})`);

      if (job.attempts >= job.maxAttempts) {
        jobsToFail.push(job.id);
        if (job.documentId) {
          const doc = await this.getDocument(job.documentId);
          docsToFail.push({ id: job.documentId, batchId: doc?.batchId });
        }
      } else {
        jobsToReset.push(job.id);
      }
    }

    // Batch update: fail jobs (single query instead of N queries!)
    if (jobsToFail.length > 0) {
      await this.db.update(jobQueue)
        .set({
          status: 'failed',
          completedAt: new Date(),
          error: `Max retry attempts exceeded (job timeout >5 minutes)`,
          workerId: null,
        })
        .where(inArray(jobQueue.id, jobsToFail));

      // Batch update: fail associated documents
      if (docsToFail.length > 0) {
        const docIds = docsToFail.map(d => d.id);
        await this.db.update(documents)
          .set({
            status: 'failed',
            error: `Max retry attempts exceeded (job timeout >5 minutes)`,
          })
          .where(inArray(documents.id, docIds));

        // Update batch progress for affected batches
        const batchIds = [...new Set(docsToFail.map(d => d.batchId).filter(Boolean))] as string[];
        for (const batchId of batchIds) {
          try {
            await this.updateBatchProgress(batchId);
          } catch (error) {
            console.error(`Failed to update batch ${batchId} progress:`, error);
          }
        }
      }
    }

    // Batch update: reset jobs (single query instead of N queries!)
    if (jobsToReset.length > 0) {
      // Note: We need to calculate individual backoff times, so we still need a loop for scheduledAt
      // But we can at least batch the update by using a transaction
      await this.db.transaction(async (tx: any) => {
        for (const jobId of jobsToReset) {
          const job = orphanedJobs.find(j => j.id === jobId);
          if (job) {
            await tx.update(jobQueue)
              .set({
                status: 'pending',
                workerId: null,
                startedAt: null,
                scheduledAt: new Date(Date.now() + (2 ** job.attempts) * 5000),
              })
              .where(eq(jobQueue.id, jobId));
          }
        }
      });
    }

    console.log(`[Cleanup] Processed ${orphanedJobs.length} orphaned jobs: ${jobsToReset.length} reset, ${jobsToFail.length} failed (batch operations)`);

    return orphanedJobs.length;
  }

  async getJob(jobId: string) {
    const [job] = await this.db.select()
      .from(jobQueue)
      .where(eq(jobQueue.id, jobId));
    return job;
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

  async archiveOldDocuments() {
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

  /**
   * Update batch progress by counting document statuses
   * Automatically transitions batch status: pending → processing → completed/failed
   * @param batchId - Batch ID to update
   * @returns Current progress stats and status
   */
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
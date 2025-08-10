import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { documents, usage, jobQueue, workers } from '../db/schema';
import { eq, and, lt, sql, desc, notInArray, isNotNull } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as path from 'path';
import * as os from 'os';

export class DatabaseService {
  public db;
  private client;
  private syncInterval: NodeJS.Timeout | null = null;

  constructor(syncUrl: string, authToken: string, options?: {
    localDbPath?: string;
    syncIntervalSeconds?: number;
    encryptionKey?: string;
  }) {
    // Default to local file in src/db directory
    const localDbPath = options?.localDbPath || path.join(process.cwd(), 'src/db/convert-docs.db');
    
    console.log(`Initializing embedded replica with local db: ${localDbPath}`);
    
    // Create client with embedded replica configuration
    this.client = createClient({
      url: `file:${localDbPath}`,
      syncUrl: syncUrl,
      authToken: authToken,
      syncInterval: options?.syncIntervalSeconds || 60, // Default 60 seconds
      encryptionKey: options?.encryptionKey,
    });
    
    this.db = drizzle(this.client);
    
    // Initial sync
    this.syncDatabase().catch(err => {
      console.error('Initial sync failed:', err);
    });
    
    // Set up periodic manual sync as backup (in case automatic sync has issues)
    if (options?.syncIntervalSeconds) {
      this.syncInterval = setInterval(() => {
        this.syncDatabase().catch(err => {
          console.error('Periodic sync failed:', err);
        });
      }, options.syncIntervalSeconds * 1000);
    }
  }
  
  async syncDatabase() {
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
  }) {
    const id = createId();
    await this.db.insert(documents).values({
      id,
      ...data,
      status: 'pending',
    });
    return id;
  }

  async updateDocumentStatus(id: string, status: 'processing' | 'completed' | 'failed', data?: {
    content?: string;
    metadata?: any;
    error?: string;
  }) {
    await this.db.update(documents)
      .set({
        status,
        ...(status === 'completed' && { processedAt: new Date() }),
        ...data,
      })
      .where(eq(documents.id, id));
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
    
    await this.db.insert(usage).values({
      id,
      ...data,
      totalCostCents,
    });
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
    await this.db.insert(jobQueue).values({
      id,
      ...data,
      status: 'pending',
    });
    return id;
  }

  // Atomically claim a job for a specific worker
  async claimNextJob(workerId: string) {
    // Use a transaction to ensure atomicity
    const job = await this.db.transaction(async (tx) => {
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
    
    return job;
  }

  // Clean up jobs from workers that no longer exist
  async cleanupOrphanedJobs() {
    // Get all active worker IDs
    const activeWorkers = await this.db.select({ id: workers.id })
      .from(workers)
      .where(eq(workers.status, 'active'));
    
    const activeWorkerIds = activeWorkers.map(w => w.id);
    
    // Reset jobs assigned to non-existent workers
    const result = await this.db.update(jobQueue)
      .set({
        status: 'pending',
        workerId: null,
        startedAt: null,
      })
      .where(
        and(
          eq(jobQueue.status, 'processing'),
          activeWorkerIds.length > 0 
            ? notInArray(jobQueue.workerId, activeWorkerIds)
            : isNotNull(jobQueue.workerId)
        )
      )
      .returning();
    
    if (result.length > 0) {
      console.log(`Reset ${result.length} orphaned jobs back to pending status`);
    }
    
    return result.length;
  }

  // Register a worker
  async registerWorker(workerId: string, pid: number, hostname: string) {
    await this.db.insert(workers)
      .values({
        id: workerId,
        pid,
        hostname,
        status: 'active',
      })
      .onConflictDoUpdate({
        target: workers.id,
        set: {
          pid,
          hostname,
          status: 'active',
          lastHeartbeat: new Date(),
        },
      });
  }

  // Update worker heartbeat
  async updateWorkerHeartbeat(workerId: string) {
    await this.db.update(workers)
      .set({ lastHeartbeat: new Date() })
      .where(eq(workers.id, workerId));
  }

  // Mark worker as stopping/dead
  async updateWorkerStatus(workerId: string, status: 'stopping' | 'dead') {
    await this.db.update(workers)
      .set({ status })
      .where(eq(workers.id, workerId));
    
    // Release any jobs this worker was processing
    await this.db.update(jobQueue)
      .set({
        status: 'pending',
        workerId: null,
        startedAt: null,
      })
      .where(
        and(
          eq(jobQueue.workerId, workerId),
          eq(jobQueue.status, 'processing')
        )
      );
  }

  async getNextJobs(limit: number) {
    const jobs = await this.db.select()
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.status, 'pending'),
          sql`${jobQueue.scheduledAt} <= unixepoch()`
        )
      )
      .orderBy(desc(jobQueue.priority), jobQueue.scheduledAt)
      .limit(limit);
    
    // Mark jobs as processing
    for (const job of jobs) {
      await this.db.update(jobQueue)
        .set({
          status: 'processing',
          startedAt: new Date(),
          attempts: job.attempts + 1,
        })
        .where(eq(jobQueue.id, job.id));
    }
    
    return jobs;
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
}
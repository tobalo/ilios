import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import { documents, usage, jobQueue } from '../db/schema';
import { eq, and, lt, sql, desc } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import * as path from 'path';

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

  async getNextJob() {
    const [job] = await this.db.select()
      .from(jobQueue)
      .where(
        and(
          eq(jobQueue.status, 'pending'),
          sql`${jobQueue.scheduledAt} <= unixepoch()`
        )
      )
      .orderBy(desc(jobQueue.priority), jobQueue.scheduledAt)
      .limit(1);
    
    if (job) {
      await this.db.update(jobQueue)
        .set({
          status: 'processing',
          startedAt: new Date(),
          attempts: job.attempts + 1,
        })
        .where(eq(jobQueue.id, job.id));
    }
    
    return job;
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
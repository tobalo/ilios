import { sql } from 'drizzle-orm';
import { text, integer, sqliteTable, index } from 'drizzle-orm/sqlite-core';

export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  fileName: text('file_name').notNull(),
  mimeType: text('mime_type').notNull(),
  fileSize: integer('file_size').notNull(),
  s3Key: text('s3_key').notNull(),
  content: text('content'),
  metadata: text('metadata', { mode: 'json' }),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'failed', 'archived'] }).notNull().default('pending'),
  error: text('error'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  processedAt: integer('processed_at', { mode: 'timestamp' }),
  archivedAt: integer('archived_at', { mode: 'timestamp' }),
  retentionDays: integer('retention_days').notNull().default(365),
  userId: text('user_id'),
  apiKey: text('api_key'),
  batchId: text('batch_id'),
}, (table) => ({
  statusIdx: index('status_idx').on(table.status),
  createdAtIdx: index('created_at_idx').on(table.createdAt),
  userIdIdx: index('user_id_idx').on(table.userId),
  batchIdIdx: index('batch_id_idx').on(table.batchId),
  // Composite indexes for hot query paths
  docBatchStatusIdx: index('doc_batch_status_idx').on(table.batchId, table.status),
  docApiKeyCreatedIdx: index('doc_api_key_created_idx').on(table.apiKey, table.createdAt),
}));

export const usage = sqliteTable('usage', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  userId: text('user_id'),
  apiKey: text('api_key'),
  operation: text('operation').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  baseCostCents: integer('base_cost_cents').notNull(),
  marginRate: integer('margin_rate').notNull().default(30),
  totalCostCents: integer('total_cost_cents').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  documentIdIdx: index('document_id_idx').on(table.documentId),
  userIdIdx: index('usage_user_id_idx').on(table.userId),
  createdAtIdx: index('usage_created_at_idx').on(table.createdAt),
  // Composite indexes for usage summary queries
  apiKeyTimeIdx: index('api_key_time_idx').on(table.apiKey, table.createdAt),
  userIdTimeIdx: index('user_id_time_idx').on(table.userId, table.createdAt),
}));

export const jobQueue = sqliteTable('job_queue', {
  id: text('id').primaryKey(),
  documentId: text('document_id').notNull().references(() => documents.id),
  type: text('type').notNull(),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'failed', 'retrying'] }).notNull().default('pending'),
  priority: integer('priority').notNull().default(0),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  payload: text('payload', { mode: 'json' }),
  result: text('result', { mode: 'json' }),
  error: text('error'),
  workerId: text('worker_id'), // Track which worker is processing this job
  scheduledAt: integer('scheduled_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  statusIdx: index('job_status_idx').on(table.status),
  scheduledAtIdx: index('scheduled_at_idx').on(table.scheduledAt),
  priorityIdx: index('priority_idx').on(table.priority),
  workerIdx: index('worker_idx').on(table.workerId),
  // Composite indexes for hot query paths (10-100x faster)
  claimJobIdx: index('claim_job_idx').on(table.status, table.scheduledAt, table.priority),
  cleanupJobIdx: index('cleanup_job_idx').on(table.status, table.startedAt),
}));



export const batches = sqliteTable('batches', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  apiKey: text('api_key'),
  totalDocuments: integer('total_documents').notNull(),
  completedDocuments: integer('completed_documents').notNull().default(0),
  failedDocuments: integer('failed_documents').notNull().default(0),
  status: text('status', { enum: ['pending', 'processing', 'completed', 'failed'] }).notNull().default('pending'),
  priority: integer('priority').notNull().default(5),
  batchType: text('batch_type', { enum: ['local', 'mistral'] }).notNull().default('local'),
  mistralBatchJobId: text('mistral_batch_job_id'),
  mistralInputFileId: text('mistral_input_file_id'),
  mistralOutputFileId: text('mistral_output_file_id'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' }),
  metadata: text('metadata', { mode: 'json' }),
}, (table) => ({
  statusIdx: index('batch_status_idx').on(table.status),
  createdAtIdx: index('batch_created_at_idx').on(table.createdAt),
  userIdIdx: index('batch_user_id_idx').on(table.userId),
  mistralBatchJobIdx: index('mistral_batch_job_idx').on(table.mistralBatchJobId),
}));
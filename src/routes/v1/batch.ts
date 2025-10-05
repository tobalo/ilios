import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../../services/database';
import { S3Service } from '../../services/s3';

const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;

const batchSubmitSchema = z.object({
  retentionDays: z.number().min(1).max(3650).optional(),
  priority: z.number().min(1).max(10).optional().default(5),
});

export function createBatchRoutes(db: DatabaseService, s3: S3Service) {
  const app = new Hono();

  app.post('/submit', async (c) => {
    try {
      const formData = await c.req.formData();
      const files: File[] = [];
      
      for (const [key, value] of formData.entries()) {
        if (key === 'files' || key === 'files[]') {
          if (value instanceof File) {
            files.push(value);
          }
        }
      }

      if (files.length === 0) {
        return c.json({ error: 'No files provided' }, 400);
      }

      if (files.length > MAX_FILES_PER_BATCH) {
        return c.json({
          error: `Maximum ${MAX_FILES_PER_BATCH} files per batch`,
          provided: files.length
        }, 400);
      }

      for (const file of files) {
        if (file.size > MAX_FILE_SIZE) {
          return c.json({
            error: `File "${file.name}" exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`,
            fileSize: file.size,
          }, 400);
        }
      }

      const retentionDays = formData.get('retentionDays');
      const priority = formData.get('priority');
      
      const params = batchSubmitSchema.parse({
        retentionDays: retentionDays ? parseInt(retentionDays as string) : undefined,
        priority: priority ? parseInt(priority as string) : 5,
      });

      const batchId = await db.createBatch({
        totalDocuments: files.length,
        priority: params.priority,
        userId: undefined,
        apiKey: undefined,
      });

      console.log(`[Batch] Created batch ${batchId} with ${files.length} files`);

      const documentIds: string[] = [];
      const documentDetails: any[] = [];

      for (const file of files) {
        let mimeType = file.type;
        if (!mimeType || mimeType === 'application/octet-stream') {
          const ext = file.name.split('.').pop()?.toLowerCase();
          const mimeMap: Record<string, string> = {
            'pdf': 'application/pdf',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'png': 'image/png',
            'gif': 'image/gif',
            'webp': 'image/webp',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          };
          if (ext && mimeMap[ext]) {
            mimeType = mimeMap[ext];
          }
        }

        const s3Key = s3.generateKey(file.name);

        const documentId = await db.createDocument({
          fileName: file.name,
          mimeType: mimeType,
          fileSize: file.size,
          s3Key,
          userId: undefined,
          apiKey: undefined,
          retentionDays: params.retentionDays,
          batchId,
        });

        documentIds.push(documentId);
        documentDetails.push({
          id: documentId,
          fileName: file.name,
          fileSize: file.size,
          status: 'pending',
        });

        // Immediately capture loop variables to avoid closure issues
        ((capturedDocId, capturedS3Key, capturedFile, capturedMimeType) => {
          (async () => {
            try {
              const uploadStrategy = capturedFile.size > MULTIPART_THRESHOLD ? 'multipart' :
                                   capturedFile.size > LARGE_FILE_THRESHOLD ? 'streaming' : 'standard';

              console.log(`[Batch] Uploading ${capturedFile.name} (${(capturedFile.size / 1024 / 1024).toFixed(2)}MB) - ${uploadStrategy}`);

              if (uploadStrategy === 'multipart' || uploadStrategy === 'streaming') {
                await s3.uploadLarge(capturedS3Key, capturedFile, { type: capturedMimeType, fileSize: capturedFile.size });
              } else {
                await s3.upload(capturedS3Key, capturedFile, { type: capturedMimeType });
              }

              const exists = await s3.exists(capturedS3Key);
              if (!exists) {
                throw new Error('Upload verification failed');
              }

              await db.createJob({
                documentId: capturedDocId,
                type: 'convert',
                priority: params.priority,
              });

              console.log(`[Batch] Successfully queued ${capturedFile.name} for processing`);

            } catch (error: any) {
              console.error(`[Batch] Failed to upload ${capturedFile.name}:`, error);
              await db.updateDocumentStatus(capturedDocId, 'failed', {
                error: `Upload failed: ${error.message}`
              });
              await db.updateBatchProgress(batchId);
            }
          })().catch(err => {
            console.error(`[Batch] Uncaught error processing ${capturedFile.name}:`, err);
          });
        })(documentId, s3Key, file, mimeType);
      }

      return c.json({
        batchId,
        status: 'queued',
        totalDocuments: files.length,
        documents: documentDetails,
        statusUrl: `/v1/batch/status/${batchId}`,
      }, 202);

    } catch (error) {
      console.error('[Batch] Submit error:', error);
      return c.json({
        error: 'Failed to submit batch',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  app.get('/status/:batchId', async (c) => {
    const batchId = c.req.param('batchId');

    try {
      const batch = await db.getBatch(batchId);

      if (!batch) {
        return c.json({ error: 'Batch not found' }, 404);
      }

      const documents = await db.getBatchDocuments(batchId);

      const progress = {
        total: batch.totalDocuments,
        pending: documents.filter(d => d.status === 'pending').length,
        processing: documents.filter(d => d.status === 'processing').length,
        completed: batch.completedDocuments,
        failed: batch.failedDocuments,
      };

      const includeDetails = c.req.query('details') === 'true';

      const response: any = {
        batchId: batch.id,
        status: batch.status,
        progress,
        createdAt: batch.createdAt,
        completedAt: batch.completedAt,
      };

      if (batch.status === 'completed' || batch.status === 'failed') {
        response.downloadUrl = `/v1/batch/download/${batchId}`;
      }

      if (includeDetails) {
        response.documents = documents.map(d => ({
          id: d.id,
          fileName: d.fileName,
          status: d.status,
          error: d.error,
          processedAt: d.processedAt,
        }));
      }

      return c.json(response);

    } catch (error) {
      console.error('[Batch] Status error:', error);
      return c.json({
        error: 'Failed to get batch status',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  app.get('/download/:batchId', async (c) => {
    const batchId = c.req.param('batchId');
    const format = c.req.query('format') || 'jsonl';

    try {
      const batch = await db.getBatch(batchId);

      if (!batch) {
        return c.json({ error: 'Batch not found' }, 404);
      }

      if (batch.status !== 'completed' && batch.status !== 'failed') {
        return c.json({
          error: 'Batch not ready for download',
          status: batch.status,
          progress: {
            completed: batch.completedDocuments,
            failed: batch.failedDocuments,
            total: batch.totalDocuments,
          }
        }, 400);
      }

      const documents = await db.getBatchDocuments(batchId);

      if (format === 'jsonl') {
        const lines = documents.map(doc => JSON.stringify({
          id: doc.id,
          fileName: doc.fileName,
          status: doc.status,
          content: doc.content,
          metadata: doc.metadata,
          error: doc.error,
          processedAt: doc.processedAt,
        }));

        const jsonl = lines.join('\n');

        c.header('Content-Type', 'application/x-ndjson; charset=utf-8');
        c.header('Content-Disposition', `attachment; filename="batch-${batchId}.jsonl"`);
        
        return c.text(jsonl);
      }

      return c.json({
        error: 'Unsupported format',
        supportedFormats: ['jsonl']
      }, 400);

    } catch (error) {
      console.error('[Batch] Download error:', error);
      return c.json({
        error: 'Failed to download batch results',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  return app;
}

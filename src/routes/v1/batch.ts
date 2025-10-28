import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../../services/database';
import { S3Service } from '../../services/s3';
import { MistralService } from '../../services/mistral';

const MAX_FILES_PER_BATCH = 100;
const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;
const MULTIPART_THRESHOLD = 50 * 1024 * 1024;

const batchSubmitSchema = z.object({
  retentionDays: z.number().min(1).max(3650).optional(),
  priority: z.number().min(1).max(10).optional().default(5),
  useMistralBatch: z.boolean().optional().default(false),
  model: z.string().optional().default('mistral-small-latest'),
});

async function handleMistralBatch(
  c: any,
  files: File[],
  params: z.infer<typeof batchSubmitSchema>,
  db: DatabaseService,
  mistral: MistralService
) {
  const batchId = await db.createBatch({
    totalDocuments: files.length,
    priority: params.priority || 5,
    userId: c.get('userId'),
    apiKey: c.get('apiKey'),
  });

  console.log(`[Batch Mistral] Created batch ${batchId} with ${files.length} files`);

  const batchRequests: Array<{ custom_id: string; body: Record<string, unknown> }> = [];

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
      };
      if (ext && mimeMap[ext]) {
        mimeType = mimeMap[ext];
      }
    }

    const documentId = await db.createDocument({
      fileName: file.name,
      mimeType: mimeType,
      fileSize: file.size,
      s3Key: `batch-mistral/${batchId}/${file.name}`,
      userId: c.get('userId'),
      apiKey: c.get('apiKey'),
      retentionDays: params.retentionDays,
      batchId,
    });

    const fileBuffer = await file.arrayBuffer();
    const uint8Array = new Uint8Array(fileBuffer);
    const base64Data = Buffer.from(uint8Array).toString('base64');

    const isImage = mimeType.startsWith('image/');
    const documentType = isImage ? 'image_url' : 'document_url';
    const urlKey = isImage ? 'imageUrl' : 'documentUrl';

    batchRequests.push({
      custom_id: documentId,
      body: {
        model: 'mistral-ocr-latest',
        document: {
          type: documentType,
          [urlKey]: `data:${mimeType};base64,${base64Data}`,
        },
        includeImageBase64: true,
      },
    });
  }

  console.log(`[Batch Mistral] Uploading ${batchRequests.length} requests to Mistral`);

  const mistralInputFileId = await mistral.uploadBatchFile(batchRequests);
  const mistralJob = await mistral.createBatchJob(
    mistralInputFileId,
    params.model || 'mistral-small-latest',
    { batchId, userId: c.get('userId') || 'anonymous' }
  );

  console.log(`[Batch Mistral] Created job ${mistralJob.id} with status ${mistralJob.status}`);

  await db.updateBatchMistralJob(batchId, mistralJob.id, mistralInputFileId);

  return c.json({
    batchId,
    mistralBatchJobId: mistralJob.id,
    status: 'queued',
    totalDocuments: files.length,
    statusUrl: `/v1/batch/status/${batchId}`,
  }, 202);
}

export function createBatchRoutes(db: DatabaseService, s3: S3Service, mistral: MistralService) {
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
      const useMistralBatch = formData.get('useMistralBatch') === 'true';
      const model = formData.get('model');

      const params = batchSubmitSchema.parse({
        retentionDays: retentionDays ? parseInt(retentionDays as string, 10) : undefined,
        priority: priority ? parseInt(priority as string, 10) : 5,
        useMistralBatch,
        model: model || 'mistral-small-latest',
      });

      // If useMistralBatch is true, use Mistral's batch API
      if (params.useMistralBatch) {
        return handleMistralBatch(c, files, params, db, mistral);
      }

      const batchId = await db.createBatch({
        totalDocuments: files.length,
        priority: params.priority,
        userId: c.get('userId'),
        apiKey: c.get('apiKey'),
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
          userId: c.get('userId'),
          apiKey: c.get('apiKey'),
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

      // If this is a Mistral batch, sync status from Mistral API
      if (batch.batchType === 'mistral' && batch.mistralBatchJobId) {
        try {
          const mistralStatus = await mistral.getBatchJobStatus(batch.mistralBatchJobId);

          // Map Mistral status to our status
          let newStatus = batch.status;
          if (mistralStatus.status === 'SUCCESS') {
            newStatus = 'completed';
            if (mistralStatus.outputFile) {
              await db.updateBatchMistralOutput(batchId, mistralStatus.outputFile);
            }
          } else if (mistralStatus.status === 'FAILED' || mistralStatus.status === 'CANCELLED') {
            newStatus = 'failed';
          } else if (mistralStatus.status === 'RUNNING') {
            newStatus = 'processing';
          }

          // Update batch status if changed
          if (newStatus !== batch.status) {
            await db.updateBatchProgress(batchId);
          }

          const response: any = {
            batchId: batch.id,
            status: newStatus,
            mistralBatchJobId: batch.mistralBatchJobId,
            mistralStatus: {
              status: mistralStatus.status,
              totalRequests: mistralStatus.totalRequests,
              completedRequests: mistralStatus.completedRequests,
              failedRequests: mistralStatus.failedRequests,
            },
            createdAt: batch.createdAt,
            completedAt: batch.completedAt,
          };

          if (newStatus === 'completed' && mistralStatus.outputFile) {
            response.downloadUrl = `/v1/batch/download/${batchId}`;
          }

          return c.json(response);
        } catch (mistralError) {
          console.error('[Batch] Mistral status sync error:', mistralError);
          // Fall through to regular status check
        }
      }

      // Regular batch status (local processing)
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

      // If this is a Mistral batch, download and process results from Mistral
      if (batch.batchType === 'mistral' && batch.mistralOutputFileId) {
        try {
          console.log(`[Batch] Downloading Mistral batch results for ${batchId}`);

          const resultStream = await mistral.downloadBatchResults(batch.mistralOutputFileId);
          const reader = resultStream.getReader();
          const chunks: Uint8Array[] = [];

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }

          const resultText = new TextDecoder().decode(
            new Uint8Array(chunks.reduce((acc, chunk) => acc + chunk.length, 0))
              .map((_, i) => {
                let offset = 0;
                for (const chunk of chunks) {
                  if (i < offset + chunk.length) {
                    return chunk[i - offset];
                  }
                  offset += chunk.length;
                }
                return 0;
              })
          );

          const lines = resultText.trim().split('\n');
          const results: Array<{ custom_id: string; response: any; error?: any }> = [];

          for (const line of lines) {
            if (line.trim()) {
              results.push(JSON.parse(line));
            }
          }

          // Update documents with results
          for (const result of results) {
            const documentId = result.custom_id;

            if (result.error) {
              await db.updateDocumentStatus(documentId, 'failed', {
                error: result.error.message || 'Mistral processing failed',
              });
            } else if (result.response?.pages) {
              const content = result.response.pages
                .map((page: any) => page.markdown)
                .join('\n\n---\n\n');

              await db.updateDocumentStatus(documentId, 'completed', {
                content,
                metadata: {
                  model: 'mistral-ocr-latest',
                  extractedPages: result.response.pages.length,
                  mistralBatchProcessed: true,
                },
              });
            }
          }

          // Get updated documents
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
        } catch (mistralError) {
          console.error('[Batch] Mistral download error:', mistralError);
          return c.json({
            error: 'Failed to download Mistral batch results',
            details: mistralError instanceof Error ? mistralError.message : 'Unknown error'
          }, 500);
        }
      }

      // Regular batch download (local processing)
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

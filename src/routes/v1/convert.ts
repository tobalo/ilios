import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../../services/database';
import { MistralService } from '../../services/mistral';
import { mkdir } from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 1024 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024;

const convertSchema = z.object({
  format: z.enum(['markdown', 'json']).optional().default('markdown'),
  retentionDays: z.number().min(1).max(3650).optional(),
});

export function createConvertRoutes(db: DatabaseService, mistral: MistralService) {
  const app = new Hono();

  app.post('/', async (c) => {
    const startTime = Date.now();
    let tempFilePath: string | null = null;
    let documentId: string | null = null;

    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      const format = formData.get('format') as string || 'markdown';
      const retentionDays = formData.get('retentionDays');

      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }

      if (file.size > MAX_FILE_SIZE) {
        return c.json({
          error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`,
          details: {
            fileSize: file.size,
            maxSize: MAX_FILE_SIZE,
          }
        }, 400);
      }

      const params = convertSchema.parse({ 
        format,
        retentionDays: retentionDays ? parseInt(retentionDays as string) : undefined,
      });

      console.log(`[Convert] Processing file: ${file.name}, size: ${(file.size / 1024 / 1024).toFixed(2)}MB`);

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

      documentId = await db.createDocument({
        fileName: file.name,
        mimeType: mimeType,
        fileSize: file.size,
        s3Key: `convert/${Date.now()}-${file.name}`,
        userId: undefined,
        apiKey: undefined,
        retentionDays: params.retentionDays,
      });

      await db.updateDocumentStatus(documentId, 'processing');

      console.log(`[Convert] Created document ${documentId} for immediate processing`);

      let fileData: ArrayBuffer;

      const VERY_LARGE_THRESHOLD = 100 * 1024 * 1024;

      if (file.size > VERY_LARGE_THRESHOLD) {
        const tmpDir = path.join(process.cwd(), 'data', 'tmp');
        await mkdir(tmpDir, { recursive: true });
        
        tempFilePath = path.join(tmpDir, `${Date.now()}-${file.name}`);
        
        console.log(`[Convert] Very large file (>100MB) detected, using temp: ${tempFilePath}`);
        await Bun.write(tempFilePath, file);
        fileData = await Bun.file(tempFilePath).arrayBuffer();
      } else {
        fileData = await file.arrayBuffer();
      }

      console.log(`[Convert] Sending to Mistral OCR...`);
      const result = await mistral.convertToMarkdown(
        fileData,
        mimeType,
        file.name
      );

      const processingTimeMs = Date.now() - startTime;
      console.log(`[Convert] Completed in ${processingTimeMs}ms, ${result.metadata.extractedPages} pages`);

      await db.updateDocumentStatus(documentId, 'completed', {
        content: result.content,
        metadata: {
          ...result.metadata,
          processingTimeMs,
          immediateConversion: true,
        },
      });

      const costData = mistral.calculateCost(result.usage);
      await db.trackUsage({
        documentId,
        userId: undefined,
        apiKey: undefined,
        operation: 'convert-immediate',
        inputTokens: result.usage.prompt_tokens,
        outputTokens: result.usage.completion_tokens,
        baseCostCents: costData.baseCostCents,
      });

      console.log(`[Convert] Document ${documentId} completed and saved`);

      if (params.format === 'json') {
        return c.json({
          id: documentId,
          content: result.content,
          metadata: {
            ...result.metadata,
            processingTimeMs,
            fileName: file.name,
            fileSize: file.size,
            mimeType,
          },
          usage: result.usage,
          downloadUrl: `/api/documents/${documentId}`,
        });
      }

      c.header('Content-Type', 'text/markdown; charset=utf-8');
      c.header('Content-Disposition', `inline; filename="${file.name}.md"`);
      c.header('X-Processing-Time-Ms', processingTimeMs.toString());
      c.header('X-Extracted-Pages', result.metadata.extractedPages?.toString() || '0');
      c.header('X-Document-Id', documentId);
      
      return c.text(result.content);

    } catch (error) {
      console.error('[Convert] Error:', error);
      
      if (documentId) {
        await db.updateDocumentStatus(documentId, 'failed', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
      
      return c.json({
        error: 'Failed to convert document',
        details: error instanceof Error ? error.message : 'Unknown error',
        ...(documentId && { id: documentId }),
      }, 500);
    } finally {
      if (tempFilePath) {
        try {
          await Bun.file(tempFilePath).delete();
          console.log(`[Convert] Cleaned up temp file: ${tempFilePath}`);
        } catch (err) {
          console.error(`[Convert] Failed to cleanup temp file:`, err);
        }
      }
    }
  });

  return app;
}

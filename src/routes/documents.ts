import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../services/database';
import { S3Service } from '../services/s3';

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB

const uploadSchema = z.object({
  retentionDays: z.number().min(1).max(3650).optional(),
});

export function createDocumentRoutes(db: DatabaseService, s3: S3Service) {
  const app = new Hono();

  app.post('/submit', async (c) => {
    try {
      const formData = await c.req.formData();
      const file = formData.get('file') as File;
      
      if (!file) {
        return c.json({ error: 'No file provided' }, 400);
      }
      
      // Log raw file info
      console.log(`Raw file info: name=${file.name}, type=${file.type || 'undefined'}, size=${file.size}`);
      
      // If mimetype is missing or incorrect, try to detect from filename
      let mimeType = file.type;
      if (!mimeType || mimeType === 'application/octet-stream' || mimeType === 'text/plain') {
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
          'epub': 'application/epub+zip',
          'rtf': 'application/rtf',
          'odt': 'application/vnd.oasis.opendocument.text'
        };
        
        if (ext && mimeMap[ext]) {
          mimeType = mimeMap[ext];
          console.log(`Detected mimetype from extension: ${ext} -> ${mimeType}`);
        }
      }

      if (file.size > MAX_FILE_SIZE) {
        return c.json({ error: 'File size exceeds 50MB limit' }, 400);
      }

      const body = Object.fromEntries(formData);
      delete body.file;
      
      const params = uploadSchema.parse({
        retentionDays: body.retentionDays ? parseInt(body.retentionDays as string) : undefined,
      });

      const s3Key = s3.generateKey(file.name);
      
      // Create database record first to get documentId
      console.log(`Creating document record: fileName=${file.name}, mimeType=${mimeType}, size=${file.size}`);
      
      const documentId = await db.createDocument({
        fileName: file.name,
        mimeType: mimeType,
        fileSize: file.size,
        s3Key,
        userId: c.get('userId') as string | undefined,
        apiKey: c.get('apiKey') as string | undefined,
        retentionDays: params.retentionDays,
      });

      // No need for upload job - we handle it inline

      // Return immediately with upload confirmation
      const uploadUrl = s3.presignUrl(s3Key, {
        expiresIn: 3600,
        method: 'GET',
      });

      // Start async upload in background
      (async () => {
        try {
          console.log(`Starting async upload for document ${documentId}`);
          
          // Bun's S3 client handles multipart uploads automatically
          // We just need to provide the file data
          if (file.size > 10 * 1024 * 1024) { // 10MB threshold
            console.log(`Using streaming upload for large file: ${file.size} bytes`);
            
            // For large files, we need to use Bun's file writer API
            const s3File = s3.client.file(`${s3.bucket}/${s3Key}`);
            const writer = s3File.writer({
              retry: 3,
              queueSize: 10,
              partSize: 5 * 1024 * 1024, // 5MB chunks
              type: mimeType,
            });
            
            try {
              const stream = file.stream();
              const reader = stream.getReader();
              let totalBytes = 0;
              
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                
                await writer.write(value);
                totalBytes += value.byteLength;
                console.log(`Upload progress for ${documentId}: ${totalBytes}/${file.size} bytes`);
                await writer.flush();
              }
              
              await writer.end();
              console.log(`Large file upload completed for ${documentId}`);
            } catch (error) {
              console.error(`Writer error for ${documentId}:`, error);
              throw error;
            }
          } else {
            const arrayBuffer = await file.arrayBuffer();
            await s3.upload(s3Key, arrayBuffer, {
              type: mimeType,
            });
          }
          
          console.log(`Upload completed for document ${documentId}`);
          
          // Update document status and create conversion job
          await db.updateDocumentStatus(documentId, 'processing');
          
          // Create conversion job
          await db.createJob({
            documentId,
            type: 'convert',
            priority: 1,
          });
          
        } catch (error) {
          console.error(`Async upload failed for document ${documentId}:`, error);
          
          // Update document status to failed
          await db.updateDocumentStatus(documentId, 'failed', {
            error: error instanceof Error ? error.message : 'Upload failed'
          });
        }
      })().catch(err => {
        console.error('Background upload error:', err);
      });

      return c.json({
        id: documentId,
        status: 'uploading',
        fileName: file.name,
        fileSize: file.size,
        uploadUrl,
        message: 'Document upload initiated. Processing will begin once upload completes.',
      });

    } catch (error) {
      console.error('Upload error:', error);
      return c.json({ 
        error: 'Failed to upload document',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  app.get('/status/:id', async (c) => {
    const id = c.req.param('id');
    
    try {
      const doc = await db.getDocument(id);
      
      if (!doc) {
        return c.json({ error: 'Document not found' }, 404);
      }

      const response: any = {
        id: doc.id,
        status: doc.status,
        fileName: doc.fileName,
        fileSize: doc.fileSize,
        createdAt: doc.createdAt,
      };

      if (doc.status === 'completed') {
        response.processedAt = doc.processedAt;
        response.downloadUrl = `/api/documents/${doc.id}`;
      } else if (doc.status === 'failed') {
        response.error = doc.error;
      }

      return c.json(response);

    } catch (error) {
      console.error('Status check error:', error);
      return c.json({ error: 'Failed to check status' }, 500);
    }
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const format = c.req.query('format') || 'markdown';
    
    try {
      const doc = await db.getDocument(id);
      
      if (!doc) {
        return c.json({ error: 'Document not found' }, 404);
      }

      if (doc.status !== 'completed' && doc.status !== 'archived') {
        return c.json({ 
          error: 'Document not ready',
          status: doc.status 
        }, 400);
      }

      if (format === 'json') {
        return c.json({
          id: doc.id,
          fileName: doc.fileName,
          content: doc.content,
          metadata: doc.metadata,
          createdAt: doc.createdAt,
          processedAt: doc.processedAt,
        });
      }

      c.header('Content-Type', 'text/markdown; charset=utf-8');
      c.header('Content-Disposition', `inline; filename="${doc.fileName}.md"`);
      
      return c.text(doc.content || '');

    } catch (error) {
      console.error('Download error:', error);
      return c.json({ error: 'Failed to retrieve document' }, 500);
    }
  });

  app.get('/:id/original', async (c) => {
    const id = c.req.param('id');
    
    try {
      const doc = await db.getDocument(id);
      
      if (!doc) {
        return c.json({ error: 'Document not found' }, 404);
      }

      const presignedUrl = s3.presignUrl(doc.s3Key, {
        expiresIn: 300,
        method: 'GET',
      });

      return c.redirect(presignedUrl, 302);

    } catch (error) {
      console.error('Original file error:', error);
      return c.json({ error: 'Failed to retrieve original file' }, 500);
    }
  });

  return app;
}
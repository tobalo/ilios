import { Hono } from 'hono';
import { z } from 'zod';
import { DatabaseService } from '../services/database';
import { S3Service } from '../services/s3';

const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10MB - Use streaming for files larger than this
const MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50MB - Use multipart upload for files larger than this

const uploadSchema = z.object({
  retentionDays: z.number().min(1).max(3650).optional(),
});

// CUID2 format validation
const cuid2Schema = z.string().regex(/^[a-z0-9]{20,30}$/, 'Invalid document ID format');

export function createDocumentRoutes(db: DatabaseService, s3: S3Service) {
  const app = new Hono();

  // Generate presigned upload URL for direct client uploads
  app.post('/upload-url', async (c) => {
    try {
      const body = await c.req.json();
      const { fileName, fileSize, mimeType } = body;
      
      if (!fileName || !fileSize) {
        return c.json({ error: 'fileName and fileSize are required' }, 400);
      }
      
      if (fileSize > MAX_FILE_SIZE) {
        return c.json({ error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit` }, 400);
      }
      
      const s3Key = s3.generateKey(fileName);
      
      // Create document record
      const documentId = await db.createDocument({
        fileName,
        mimeType: mimeType || 'application/octet-stream',
        fileSize,
        s3Key,
        userId: undefined, // Would be set by auth middleware
        apiKey: undefined, // Would be set by auth middleware
        retentionDays: body.retentionDays,
      });
      
      // Generate presigned URL for direct upload
      const uploadUrl = s3.presignUrl(s3Key, {
        method: 'PUT',
        expiresIn: 3600, // 1 hour
        contentType: mimeType,
      });
      
      console.log(`[Upload] Generated presigned URL for document ${documentId}, file: ${fileName}, size: ${fileSize}`);
      
      return c.json({
        id: documentId,
        uploadUrl,
        s3Key,
        expiresIn: 3600,
      });
      
    } catch (error) {
      console.error('[Upload] Error generating upload URL:', error);
      return c.json({ 
        error: 'Failed to generate upload URL',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });
  
  // Confirm upload completion
  app.post('/upload-complete/:id', async (c) => {
    const id = c.req.param('id');
    
    // Validate CUID2 format
    const validation = cuid2Schema.safeParse(id);
    if (!validation.success) {
      return c.json({ 
        error: 'Invalid document ID format',
        details: validation.error.errors[0].message 
      }, 400);
    }
    
    try {
      const doc = await db.getDocument(id);
      
      if (!doc) {
        return c.json({ error: 'Document not found' }, 404);
      }
      
      // Verify file exists in S3
      const exists = await s3.exists(doc.s3Key);
      if (!exists) {
        console.error(`[Upload] File not found in S3 for document ${id}: ${doc.s3Key}`);
        await db.updateDocumentStatus(id, 'failed', {
          error: 'File upload to S3 failed'
        });
        return c.json({ error: 'File upload failed' }, 400);
      }
      
      // Get actual file metadata from S3
      const metadata = await s3.getFileMetadata(doc.s3Key);
      console.log(`[Upload] File verified in S3 for document ${id}, size: ${metadata.size}, type: ${metadata.type}`);
      
      // Update status and create conversion job
      await db.updateDocumentStatus(id, 'processing');
      
      await db.createJob({
        documentId: id,
        type: 'convert',
        priority: 1,
      });
      
      return c.json({
        id,
        status: 'processing',
        message: 'Upload confirmed, processing started',
      });
      
    } catch (error) {
      console.error('[Upload] Error confirming upload:', error);
      return c.json({ 
        error: 'Failed to confirm upload',
        details: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

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
        return c.json({ 
          error: `File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`,
          details: {
            fileSize: file.size,
            maxSize: MAX_FILE_SIZE,
            fileSizeMB: (file.size / 1024 / 1024).toFixed(2),
            maxSizeMB: MAX_FILE_SIZE / 1024 / 1024
          }
        }, 400);
      }

      // Manually extract form data values
      const body: Record<string, any> = {};
      formData.forEach((value, key) => {
        if (key !== 'file') {
          body[key] = value;
        }
      });
      
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
        userId: undefined, // Would be set by auth middleware
        apiKey: undefined, // Would be set by auth middleware
        retentionDays: params.retentionDays,
      });

      // No need for upload job - we handle it inline

      // Return immediately with upload confirmation
      const uploadUrl = s3.presignUrl(s3Key, {
        expiresIn: 3600,
        method: 'GET',
      });

      // Decide upload strategy based on file size
      const uploadStrategy = file.size > MULTIPART_THRESHOLD ? 'multipart' : 
                           file.size > LARGE_FILE_THRESHOLD ? 'streaming' : 'standard';
      
      console.log(`[Upload] Document ${documentId} - Size: ${(file.size / 1024 / 1024).toFixed(2)}MB, Strategy: ${uploadStrategy}`);
      
      // Start async upload in background with optimized approach
      (async () => {
        const uploadStartTime = Date.now();
        
        try {
          console.log(`[AsyncUpload] Starting for document ${documentId}`);
          console.log(`[AsyncUpload] File: ${file.name}, Size: ${file.size} bytes (${(file.size / 1024 / 1024).toFixed(2)} MB)`);
          console.log(`[AsyncUpload] MimeType: ${mimeType}, S3Key: ${s3Key}, Strategy: ${uploadStrategy}`);
          
          if (uploadStrategy === 'multipart' || uploadStrategy === 'streaming') {
            console.log(`[AsyncUpload] Using ${uploadStrategy} upload for large file`);
            
            // Use Bun's efficient large file handling
            await s3.uploadLarge(s3Key, file, {
              type: mimeType,
              fileSize: file.size,
              onProgress: (bytesWritten) => {
                const progress = (bytesWritten / file.size * 100).toFixed(2);
                const elapsed = (Date.now() - uploadStartTime) / 1000;
                const rate = (bytesWritten / 1024 / 1024) / elapsed;
                
                // Log progress every 10%
                if (Math.floor(bytesWritten / file.size * 10) > Math.floor((bytesWritten - 1) / file.size * 10)) {
                  console.log(`[AsyncUpload] Progress: ${progress}% - ${rate.toFixed(2)} MB/s`);
                }
              }
            });
            
          } else {
            console.log(`[AsyncUpload] Using standard upload for small file`);
            
            // For small files, Bun can handle File objects directly
            await s3.upload(s3Key, file, {
              type: mimeType,
            });
          }
          
          const uploadDuration = Date.now() - uploadStartTime;
          const throughput = (file.size / 1024 / 1024) / (uploadDuration / 1000);
          
          console.log(`[AsyncUpload] Upload completed for document ${documentId}`);
          console.log(`[AsyncUpload] Duration: ${uploadDuration}ms, Throughput: ${throughput.toFixed(2)} MB/s`);
          
          // Verify upload
          const exists = await s3.exists(s3Key);
          if (!exists) {
            throw new Error('Upload verification failed - file not found in S3');
          }
          
          const metadata = await s3.getFileMetadata(s3Key);
          console.log(`[AsyncUpload] Verified: size=${metadata.size}, etag=${metadata.etag}`);
          
          // Update document status and create conversion job
          await db.updateDocumentStatus(documentId, 'processing');
          
          // Create conversion job
          await db.createJob({
            documentId,
            type: 'convert',
            priority: 1,
          });
          
        } catch (error: any) {
          const uploadDuration = Date.now() - uploadStartTime;
          
          console.error(`[AsyncUpload] Failed for document ${documentId} after ${uploadDuration}ms:`, {
            error: error.message,
            code: error.code,
            strategy: uploadStrategy,
            fileSize: file.size,
            stack: error.stack
          });
          
          // Update document status to failed with detailed error
          await db.updateDocumentStatus(documentId, 'failed', {
            error: `${error instanceof Error ? error.message : 'Upload failed'} [${error.code || 'UNKNOWN'}] - Strategy: ${uploadStrategy}, Duration: ${uploadDuration}ms, Size: ${file.size} bytes`
          });
        }
      })().catch(err => {
        console.error('[AsyncUpload] Uncaught background upload error:', err);
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
    
    // Validate CUID2 format
    const validation = cuid2Schema.safeParse(id);
    if (!validation.success) {
      return c.json({ 
        error: 'Invalid document ID format',
        details: validation.error.errors[0].message 
      }, 400);
    }
    
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
    
    // Validate CUID2 format
    const validation = cuid2Schema.safeParse(id);
    if (!validation.success) {
      return c.json({ 
        error: 'Invalid document ID format',
        details: validation.error.errors[0].message 
      }, 400);
    }
    
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
    
    // Validate CUID2 format
    const validation = cuid2Schema.safeParse(id);
    if (!validation.success) {
      return c.json({ 
        error: 'Invalid document ID format',
        details: validation.error.errors[0].message 
      }, 400);
    }
    
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
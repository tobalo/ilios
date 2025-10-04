import { S3Client, write } from 'bun';
import { createId } from '@paralleldrive/cuid2';

interface S3ServiceConfig {
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  bucket: string;
}

export class S3Service {
  public client: S3Client;
  public bucket: string;

  constructor(config: S3ServiceConfig) {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 credentials are required (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)');
    }
    
    console.log(`[S3] Initializing S3 client with endpoint: ${config.endpoint}, bucket: ${config.bucket}`);
    
    this.client = new S3Client({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      endpoint: config.endpoint,
      bucket: config.bucket,
    });
    
    this.bucket = config.bucket;
  }

  generateKey(fileName: string, prefix = 'documents'): string {
    const ext = fileName.split('.').pop() || '';
    const id = createId();
    const timestamp = Date.now();
    return `${prefix}/${timestamp}-${id}.${ext}`;
  }

  async upload(key: string, data: Blob | ArrayBuffer | string | File | Response, options?: {
    type?: string;
    acl?: 'private' | 'public-read' | 'public-read-write' | 'aws-exec-read' | 'authenticated-read' | 'bucket-owner-read' | 'bucket-owner-full-control' | 'log-delivery-write';
  }): Promise<void> {
    const file = this.client.file(key);
    await file.write(data, options);
  }

  async uploadLarge(key: string, data: ReadableStream | File, options?: {
    type?: string;
    acl?: 'private' | 'public-read' | 'public-read-write' | 'aws-exec-read' | 'authenticated-read' | 'bucket-owner-read' | 'bucket-owner-full-control' | 'log-delivery-write';
    fileSize?: number;
    onProgress?: (bytesWritten: number) => void;
  }): Promise<void> {
    const file = this.client.file(key);
    
    // For large files, use writer for optimal streaming
    const writer = file.writer({
      retry: 3,
      queueSize: 4, // Parallel parts for multipart upload
      partSize: 10 * 1024 * 1024, // 10MB parts
      type: options?.type,
      acl: options?.acl,
    });
    
    if (data instanceof File) {
      // For File objects, stream them efficiently
      const stream = data.stream();
      const reader = stream.getReader();
      let totalBytes = 0;
      
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          writer.write(value);
          totalBytes += value.byteLength;
          
          if (options?.onProgress) {
            options.onProgress(totalBytes);
          }
        }
      } finally {
        reader.releaseLock();
      }
      
      await writer.end();
    } else {
      // For ReadableStream - convert to proper format
      const reader = data.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          writer.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      await writer.end();
    }
  }

  async downloadAsBuffer(key: string): Promise<ArrayBuffer> {
    const file = this.client.file(key);
    return await file.arrayBuffer();
  }

  async streamToFile(key: string, destinationPath: string): Promise<void> {
    const file = this.client.file(key);
    const arrayBuffer = await file.arrayBuffer();
    
    const fs = await import('fs/promises');
    await fs.writeFile(destinationPath, Buffer.from(arrayBuffer));
  }

  async exists(key: string): Promise<boolean> {
    const file = this.client.file(key);
    return await file.exists();
  }

  async getFileMetadata(key: string) {
    const file = this.client.file(key);
    const stat = await file.stat();
    return {
      size: stat.size,
      lastModified: stat.lastModified,
      etag: stat.etag,
      type: stat.type,
    };
  }

  presignUrl(key: string, options?: {
    expiresIn?: number;
    method?: 'GET' | 'PUT' | 'DELETE';
    acl?: 'private' | 'public-read' | 'public-read-write' | 'aws-exec-read' | 'authenticated-read' | 'bucket-owner-read' | 'bucket-owner-full-control' | 'log-delivery-write';
    contentType?: string;
  }): string {
    const file = this.client.file(key);
    return file.presign({
      expiresIn: options?.expiresIn || 3600,
      method: options?.method || 'GET',
      acl: options?.acl,
      type: options?.contentType,
    });
  }

  async archiveDocument(sourceKey: string, archiveKey: string): Promise<void> {
    const sourceFile = this.client.file(sourceKey);
    const archiveFile = this.client.file(archiveKey);
    
    // Copy and delete
    await archiveFile.write(sourceFile, { acl: 'private' });
    await sourceFile.delete();
  }

  async testConnection(): Promise<boolean> {
    try {
      console.log(`[S3] Testing connection to S3 bucket: ${this.bucket}`);
      const testKey = `test-connection-${Date.now()}.txt`;
      const file = this.client.file(testKey);
      
      await file.write('test');
      await file.delete();
      
      console.log('[S3] Connection test successful');
      return true;
    } catch (error: any) {
      console.error('[S3] Connection test failed:', {
        message: error.message,
        code: error.code,
        name: error.name,
        stack: error.stack,
        bucket: this.bucket
      });
      return false;
    }
  }
}
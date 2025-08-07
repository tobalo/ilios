import { S3Client } from 'bun';
import { createId } from '@paralleldrive/cuid2';

export class S3Service {
  public client: S3Client;
  public bucket: string;

  constructor(config: {
    accessKeyId: string;
    secretAccessKey: string;
    endpoint: string;
    bucket: string;
  }) {
    if (!config.accessKeyId || !config.secretAccessKey) {
      throw new Error('S3 credentials are required (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)');
    }
    
    try {
      console.log(`Initializing S3 client with endpoint: ${config.endpoint}, bucket: ${config.bucket}`);
      this.client = new S3Client({
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        endpoint: config.endpoint,
      });
      this.bucket = config.bucket;
    } catch (error) {
      console.error('S3Client initialization error:', error);
      throw new Error(`Failed to initialize S3 client: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  generateKey(fileName: string, prefix = 'documents'): string {
    const ext = fileName.split('.').pop() || '';
    const id = createId();
    const timestamp = Date.now();
    return `${prefix}/${timestamp}-${id}.${ext}`;
  }

  async upload(key: string, data: Blob | ArrayBuffer | string, options?: {
    type?: string;
    acl?: 'private' | 'public-read' | 'public-read-write' | 'aws-exec-read' | 'authenticated-read' | 'bucket-owner-read' | 'bucket-owner-full-control' | 'log-delivery-write';
  }): Promise<void> {
    const file = this.client.file(`${this.bucket}/${key}`);
    await file.write(data, options);
  }

  async uploadLarge(key: string, stream: ReadableStream, options?: {
    type?: string;
    acl?: 'private' | 'public-read' | 'public-read-write' | 'aws-exec-read' | 'authenticated-read' | 'bucket-owner-read' | 'bucket-owner-full-control' | 'log-delivery-write';
    onProgress?: (bytesWritten: number) => void;
  }): Promise<void> {
    console.log(`Starting large upload for key: ${key} to bucket: ${this.bucket}`);
    const file = this.client.file(`${this.bucket}/${key}`);
    
    const writer = file.writer({
      retry: 3,
      queueSize: 10,
      partSize: 5 * 1024 * 1024,
      type: options?.type,
      acl: options?.acl
    });

    try {
      const reader = stream.getReader();
      let totalBytes = 0;
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        await writer.write(value);
        totalBytes += value.byteLength;
        
        if (options?.onProgress) {
          options.onProgress(totalBytes);
        }
        
        await writer.flush();
      }
      
      await writer.end();
    } catch (error) {
      console.error('Large upload error:', error);
      throw new Error(`Failed to upload large file: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async download(key: string): Promise<Blob> {
    const file = this.client.file(`${this.bucket}/${key}`);
    const exists = await file.exists();
    if (!exists) {
      throw new Error(`File not found: ${key}`);
    }
    return file;
  }

  async downloadAsText(key: string): Promise<string> {
    const file = this.client.file(`${this.bucket}/${key}`);
    return await file.text();
  }

  async downloadAsBuffer(key: string): Promise<ArrayBuffer> {
    const file = this.client.file(`${this.bucket}/${key}`);
    return await file.arrayBuffer();
  }

  async downloadAsStream(key: string): Promise<ReadableStream> {
    const file = this.client.file(`${this.bucket}/${key}`);
    return file.stream();
  }

  async streamToFile(key: string, destinationPath: string): Promise<void> {
    const file = this.client.file(`${this.bucket}/${key}`);
    const stream = file.stream();
    await Bun.write(destinationPath, stream);
  }

  async delete(key: string): Promise<void> {
    const file = this.client.file(`${this.bucket}/${key}`);
    await file.delete();
  }

  async exists(key: string): Promise<boolean> {
    const file = this.client.file(`${this.bucket}/${key}`);
    return await file.exists();
  }

  presignUrl(key: string, options?: {
    expiresIn?: number;
    method?: 'GET' | 'PUT' | 'DELETE';
    acl?: string;
  }): string {
    const file = this.client.file(`${this.bucket}/${key}`);
    return file.presign({
      expiresIn: options?.expiresIn || 3600,
      method: options?.method || 'GET',
      acl: options?.acl,
    });
  }

  async archiveDocument(sourceKey: string, archiveKey: string): Promise<void> {
    const data = await this.download(sourceKey);
    await this.upload(archiveKey, data, { acl: 'private' });
    await this.delete(sourceKey);
  }

  async getFileMetadata(key: string) {
    const file = this.client.file(`${this.bucket}/${key}`);
    const stat = await file.stat();
    return {
      size: stat.size,
      lastModified: stat.lastModified,
      etag: stat.etag,
      type: stat.type,
    };
  }
}
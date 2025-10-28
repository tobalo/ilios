import { Mistral } from '@mistralai/mistralai';
import type { BatchJobStatus } from '@mistralai/mistralai/models/components';

export interface MistralUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ConversionResult {
  content: string;
  metadata: {
    model: string;
    temperature: number;
    extractedPages?: number;
  };
  usage: MistralUsage;
}

export class MistralService {
  private client: Mistral;

  constructor(apiKey: string) {
    this.client = new Mistral({ apiKey });
  }

  async convertToMarkdown(
    fileData: ArrayBuffer,
    mimeType: string,
    fileName: string
  ): Promise<ConversionResult> {
    let uploadedFileId: string | undefined;

    try {
      // Create Uint8Array view for the ArrayBuffer (Bun native)
      const uint8Array = new Uint8Array(fileData);

      console.log(`Uploading file to Mistral: ${fileName} with mimeType: ${mimeType}, size: ${uint8Array.length} bytes`);
      
      // Upload file to Mistral (SDK expects raw buffer, not Blob)
      const uploadedFile = await this.client.files.upload({
        file: {
          fileName: fileName,
          content: uint8Array,
        },
        purpose: 'ocr',
      });

      uploadedFileId = uploadedFile.id;

      // Get signed URL
      const signedUrl = await this.client.files.getSignedUrl({
        fileId: uploadedFile.id,
      });

      // Process OCR with the signed URL
      const ocrResponse = await this.client.ocr.process({
        model: 'mistral-ocr-latest',
        document: {
          type: 'document_url',
          documentUrl: signedUrl.url,
        },
        includeImageBase64: true,
      });

      // Combine all pages into a single markdown document
      const content = ocrResponse.pages
        .map(page => page.markdown)
        .join('\n\n---\n\n');

      // Calculate usage based on OCR response
      // Since OCR doesn't return usage directly, we'll estimate based on content
      const estimatedTokens = Math.ceil(content.length / 4);
      const usage: MistralUsage = {
        prompt_tokens: estimatedTokens,
        completion_tokens: 0,
        total_tokens: estimatedTokens,
      };

      return {
        content,
        metadata: {
          model: 'mistral-ocr-latest',
          temperature: 0.1,
          extractedPages: ocrResponse.pages.length,
        },
        usage,
      };

    } finally {
      // Clean up uploaded file
      if (uploadedFileId) {
        try {
          await this.client.files.delete({ fileId: uploadedFileId });
        } catch (error: any) {
          if (error.statusCode === 404) {
            console.log(`[Mistral] File ${uploadedFileId} already deleted (404)`);
          } else {
            console.error('Failed to cleanup file:', error);
          }
        }
      }
    }
  }

  async convertToMarkdownFromBase64(
    base64Data: string,
    mimeType: string
  ): Promise<ConversionResult> {
    try {
      // Determine document type based on mime type
      const isImage = mimeType.startsWith('image/');
      const documentType = isImage ? 'image_url' : 'document_url';
      const urlKey = isImage ? 'imageUrl' : 'documentUrl';
      
      // Process OCR with base64 data
      const ocrResponse = await this.client.ocr.process({
        model: 'mistral-ocr-latest',
        document: {
          type: documentType,
          [urlKey]: `data:${mimeType};base64,${base64Data}`,
        },
        includeImageBase64: true,
      });

      // Combine all pages into a single markdown document
      const content = ocrResponse.pages
        .map(page => page.markdown)
        .join('\n\n---\n\n');

      // Calculate usage based on OCR response
      const estimatedTokens = Math.ceil(content.length / 4);
      const usage: MistralUsage = {
        prompt_tokens: estimatedTokens,
        completion_tokens: 0,
        total_tokens: estimatedTokens,
      };

      return {
        content,
        metadata: {
          model: 'mistral-ocr-latest',
          temperature: 0.1,
          extractedPages: ocrResponse.pages.length,
        },
        usage,
      };
    } catch (error) {
      throw new Error(`OCR processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async convertToMarkdownFromUrl(url: string): Promise<ConversionResult> {
    try {
      const ocrResponse = await this.client.ocr.process({
        model: 'mistral-ocr-latest',
        document: {
          type: 'document_url',
          documentUrl: url,
        },
        includeImageBase64: true,
      });

      // Combine all pages into a single markdown document
      const content = ocrResponse.pages
        .map(page => page.markdown)
        .join('\n\n---\n\n');

      // Calculate usage based on OCR response
      const estimatedTokens = Math.ceil(content.length / 4);
      const usage: MistralUsage = {
        prompt_tokens: estimatedTokens,
        completion_tokens: 0,
        total_tokens: estimatedTokens,
      };

      return {
        content,
        metadata: {
          model: 'mistral-ocr-latest',
          temperature: 0.1,
          extractedPages: ocrResponse.pages.length,
        },
        usage,
      };
    } catch (error) {
      throw new Error(`OCR processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  calculateCost(usage: MistralUsage): { baseCostCents: number } {
    // OCR pricing: $0.01 per page (estimated as 1000 tokens per page)
    const ocrCostPerPage = 0.01;
    const tokensPerPage = 1000;

    const estimatedPages = Math.ceil(usage.total_tokens / tokensPerPage);
    const totalCost = estimatedPages * ocrCostPerPage;

    return {
      baseCostCents: Math.ceil(totalCost * 100),
    };
  }

  // Batch Inference Methods
  async uploadBatchFile(batchRequests: Array<{ custom_id: string; body: Record<string, unknown> }>): Promise<string> {
    // Create JSONL content
    const jsonlContent = batchRequests
      .map(req => JSON.stringify(req))
      .join('\n');

    const encoder = new TextEncoder();
    const uint8Array = encoder.encode(jsonlContent);

    console.log(`[Mistral] Uploading batch file with ${batchRequests.length} requests`);

    const uploadedFile = await this.client.files.upload({
      file: {
        fileName: `batch_${Date.now()}.jsonl`,
        content: uint8Array,
      },
      purpose: 'batch',
    });

    return uploadedFile.id;
  }

  async createBatchJob(
    inputFileId: string,
    model: string = 'mistral-small-latest',
    metadata?: Record<string, string>
  ): Promise<{ id: string; status: string }> {
    console.log(`[Mistral] Creating batch job for file ${inputFileId}`);

    const createdJob = await this.client.batch.jobs.create({
      inputFiles: [inputFileId],
      model,
      endpoint: '/v1/ocr',
      metadata,
    });

    return {
      id: createdJob.id,
      status: createdJob.status,
    };
  }

  async getBatchJobStatus(jobId: string): Promise<{
    id: string;
    status: string;
    outputFile?: string | null;
    totalRequests?: number;
    completedRequests?: number;
    failedRequests?: number;
  }> {
    const job = await this.client.batch.jobs.get({ jobId });

    return {
      id: job.id,
      status: job.status,
      outputFile: job.outputFile,
      totalRequests: job.totalRequests,
      completedRequests: job.completedRequests,
      failedRequests: job.failedRequests,
    };
  }

  async listBatchJobs(filters?: {
    status?: Array<BatchJobStatus>;
    metadata?: Record<string, string>;
  }) {
    return await this.client.batch.jobs.list({
      status: filters?.status,
      metadata: filters?.metadata,
    });
  }

  async downloadBatchResults(outputFileId: string): Promise<ReadableStream> {
    console.log(`[Mistral] Downloading batch results from file ${outputFileId}`);
    return await this.client.files.download({ fileId: outputFileId });
  }

  async cancelBatchJob(jobId: string): Promise<void> {
    console.log(`[Mistral] Cancelling batch job ${jobId}`);
    await this.client.batch.jobs.cancel({ jobId });
  }
}
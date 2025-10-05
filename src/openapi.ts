export const openAPISpec = {
  openapi: '0.0.3',
  info: {
    title: 'Ilios API',
    version: '0.0.3',
    description: `High-performance document-to-markdown conversion API with immediate OCR and batch processing using Mistral AI. Built with Bun native APIs for 2-10x faster file operations.

## Authentication

API key authentication is optional but recommended for production deployments. When the \`API_KEY\` environment variable is set, all endpoints except public paths require authentication.

**Public Paths (No Auth Required):**
- \`/health\` - Health check
- \`/docs\` - API documentation
- \`/openapi.json\` - OpenAPI specification
- \`/\` - Landing page
- \`/images/*\` - Static assets
- \`/benchmarks/*\` - Benchmark results

**Authentication Header:**
\`\`\`
Authorization: Bearer YOUR_API_KEY
\`\`\`

**Multi-Key ACL Support:**
Set multiple API keys for different teams/clients:
\`\`\`
API_KEY=team-alpha-key,team-beta-key,admin-key
\`\`\`

**Usage Tracking:**
All API operations are automatically tracked per API key for billing and auditing. Usage endpoints automatically filter results to the authenticated key.`,
  },
  servers: [
    {
      url: 'http://localhost:1337',
      description: 'Development server',
    },
    {
      url: 'https://ilios.sh',
      description: 'Production server',
    },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'API_KEY',
        description: 'API key authentication using Bearer token. Set API_KEY environment variable to enable. Supports multiple comma-separated keys for ACL.',
      },
    },
    schemas: {
      Document: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9]{20,30}$', description: 'CUID2 identifier' },
          fileName: { type: 'string' },
          mimeType: { type: 'string' },
          fileSize: { type: 'integer' },
          content: { type: 'string', nullable: true },
          metadata: { type: 'object', nullable: true },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'completed', 'failed', 'archived'],
          },
          error: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: 'string', format: 'date-time', nullable: true },
          archivedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      SubmitResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9]{20,30}$', description: 'CUID2 identifier' },
          status: { type: 'string' },
          fileName: { type: 'string' },
          fileSize: { type: 'integer' },
          uploadUrl: { type: 'string' },
          message: { type: 'string' },
        },
      },
      UploadUrlResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9]{20,30}$', description: 'CUID2 identifier' },
          uploadUrl: { type: 'string' },
          s3Key: { type: 'string' },
          expiresIn: { type: 'integer' },
        },
      },
      UploadCompleteResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9]{20,30}$', description: 'CUID2 identifier' },
          status: { type: 'string' },
          message: { type: 'string' },
        },
      },
      StatusResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9]{20,30}$', description: 'CUID2 identifier' },
          status: {
            type: 'string',
            enum: ['pending', 'processing', 'completed', 'failed'],
          },
          progress: { type: 'number', minimum: 0, maximum: 100 },
          error: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          processedAt: { type: 'string', format: 'date-time', nullable: true },
        },
      },
      UsageSummary: {
        type: 'object',
        properties: {
          summary: {
            type: 'object',
            properties: {
              totalDocuments: { type: 'integer' },
              totalOperations: { type: 'integer' },
              totalInputTokens: { type: 'integer' },
              totalOutputTokens: { type: 'integer' },
              totalCostCents: { type: 'integer' },
              totalCostUSD: { type: 'string' },
            },
          },
          filters: {
            type: 'object',
            properties: {
              startDate: { type: 'string', format: 'date-time', nullable: true },
              endDate: { type: 'string', format: 'date-time', nullable: true },
            },
          },
        },
      },
      UsageBreakdown: {
        type: 'object',
        properties: {
          breakdown: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                operation: { type: 'string' },
                count: { type: 'integer' },
                totalInputTokens: { type: 'integer' },
                totalOutputTokens: { type: 'integer' },
                totalCostCents: { type: 'integer' },
                totalCostUSD: { type: 'string' },
              },
            },
          },
        },
      },
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          message: { type: 'string' },
          details: { type: 'object', nullable: true },
        },
      },
      ConvertResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Document ID for retrieval' },
          content: { type: 'string', description: 'Extracted markdown content' },
          metadata: {
            type: 'object',
            properties: {
              model: { type: 'string' },
              extractedPages: { type: 'integer' },
              processingTimeMs: { type: 'integer' },
              fileName: { type: 'string' },
              fileSize: { type: 'integer' },
              mimeType: { type: 'string' },
            },
          },
          usage: {
            type: 'object',
            properties: {
              prompt_tokens: { type: 'integer' },
              completion_tokens: { type: 'integer' },
              total_tokens: { type: 'integer' },
            },
          },
          downloadUrl: { type: 'string', description: 'URL to download document later' },
        },
      },
      BatchSubmitResponse: {
        type: 'object',
        properties: {
          batchId: { type: 'string' },
          status: { type: 'string', enum: ['queued'] },
          totalDocuments: { type: 'integer' },
          documents: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                fileName: { type: 'string' },
                fileSize: { type: 'integer' },
                status: { type: 'string' },
              },
            },
          },
          statusUrl: { type: 'string' },
        },
      },
      BatchStatusResponse: {
        type: 'object',
        properties: {
          batchId: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'processing', 'completed', 'failed'] },
          progress: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              pending: { type: 'integer' },
              processing: { type: 'integer' },
              completed: { type: 'integer' },
              failed: { type: 'integer' },
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          downloadUrl: { type: 'string', nullable: true },
        },
      },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/': {
      get: {
        summary: 'API Information',
        description: 'Get basic API information and available endpoints',
        security: [],
        responses: {
          '200': {
            description: 'API information',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    version: { type: 'string' },
                    endpoints: { type: 'object' },
                  },
                },
              },
            },
          },
        },
      },
    },
    '/health': {
      get: {
        summary: 'Health Check',
        description: 'Check the health status of the API and its services',
        security: [],
        responses: {
          '200': {
            description: 'Service is healthy',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['healthy', 'unhealthy'] },
                    timestamp: { type: 'string', format: 'date-time' },
                    services: {
                      type: 'object',
                      properties: {
                        database: { type: 'string' },
                        s3: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
          '503': {
            description: 'Service is unhealthy',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/upload-url': {
      post: {
        summary: 'Generate Upload URL',
        description: 'Generate a presigned URL for direct client uploads',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['fileName', 'fileSize'],
                properties: {
                  fileName: { type: 'string' },
                  fileSize: { type: 'integer' },
                  mimeType: { type: 'string' },
                  retentionDays: { type: 'integer', minimum: 1, maximum: 3650 },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Presigned URL generated',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadUrlResponse' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/upload-complete/{id}': {
      post: {
        summary: 'Confirm Upload Completion',
        description: 'Confirm that a direct upload has completed and start processing',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Document ID (CUID2 format)',
            schema: { type: 'string', pattern: '^[a-z0-9]{20,30}$' },
          },
        ],
        responses: {
          '200': {
            description: 'Upload confirmed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UploadCompleteResponse' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/submit': {
      post: {
        summary: 'Submit Document',
        description: 'Upload a document for OCR processing',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Document file to process (max 1GB)',
                  },
                  retentionDays: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 3650,
                    description: 'Days to retain document (optional)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Document accepted for processing',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SubmitResponse' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '401': {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '413': {
            description: 'File too large',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/status/{id}': {
      get: {
        summary: 'Check Document Status',
        description: 'Get the processing status of a document',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Document ID (CUID2 format)',
            schema: { type: 'string', pattern: '^[a-z0-9]{20,30}$' },
          },
        ],
        responses: {
          '200': {
            description: 'Document status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/StatusResponse' },
              },
            },
          },
          '404': {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/{id}': {
      get: {
        summary: 'Retrieve Document',
        description: 'Get the processed document content',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Document ID (CUID2 format)',
            schema: { type: 'string', pattern: '^[a-z0-9]{20,30}$' },
          },
          {
            name: 'format',
            in: 'query',
            description: 'Response format (json or markdown)',
            schema: { type: 'string', enum: ['json', 'markdown'], default: 'markdown' },
          },
        ],
        responses: {
          '200': {
            description: 'Document content',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Document' },
              },
              'text/markdown': {
                schema: { type: 'string' },
              },
            },
          },
          '400': {
            description: 'Document not ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/documents/{id}/original': {
      get: {
        summary: 'Get Original Document',
        description: 'Redirect to the original uploaded document in S3',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            description: 'Document ID (CUID2 format)',
            schema: { type: 'string', pattern: '^[a-z0-9]{20,30}$' },
          },
        ],
        responses: {
          '302': {
            description: 'Redirect to presigned S3 URL',
          },
          '404': {
            description: 'Document not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/api/usage/summary': {
      get: {
        summary: 'Usage Summary',
        description: 'Get usage statistics and cost summary. When authenticated, results are automatically filtered to the API key used in the request.',
        parameters: [
          {
            name: 'startDate',
            in: 'query',
            description: 'Start date for filtering (ISO 8601)',
            schema: { type: 'string', format: 'date-time' },
          },
          {
            name: 'endDate',
            in: 'query',
            description: 'End date for filtering (ISO 8601)',
            schema: { type: 'string', format: 'date-time' },
          },
        ],
        responses: {
          '200': {
            description: 'Usage summary',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageSummary' },
              },
            },
          },
        },
      },
    },
    '/api/usage/breakdown': {
      get: {
        summary: 'Usage Breakdown',
        description: 'Get detailed usage breakdown by operation type. When authenticated, results are automatically filtered to the API key used in the request.',
        responses: {
          '200': {
            description: 'Usage breakdown',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/UsageBreakdown' },
              },
            },
          },
        },
      },
    },
    '/v1/convert': {
      post: {
        summary: 'Convert Document (Immediate)',
        description: 'Convert a document to markdown immediately with synchronous OCR processing. Creates database record for retrieval but no S3 upload or job queue. Optimized for files <100MB with direct in-memory processing.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['file'],
                properties: {
                  file: {
                    type: 'string',
                    format: 'binary',
                    description: 'Document file to convert (max 1GB)',
                  },
                  format: {
                    type: 'string',
                    enum: ['markdown', 'json'],
                    default: 'markdown',
                    description: 'Response format',
                  },
                  retentionDays: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 3650,
                    description: 'Days to retain document record',
                  },
                },
              },
            },
          },
        },
        responses: {
          '200': {
            description: 'Document converted successfully',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ConvertResponse' },
              },
              'text/markdown': {
                schema: { type: 'string' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '500': {
            description: 'Conversion failed',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/v1/batch/submit': {
      post: {
        summary: 'Submit Batch for Processing',
        description: 'Submit multiple documents for batch processing. Documents are uploaded to S3 and queued for asynchronous worker processing. Uses Bun native streaming for optimal upload performance.',
        requestBody: {
          required: true,
          content: {
            'multipart/form-data': {
              schema: {
                type: 'object',
                required: ['files'],
                properties: {
                  files: {
                    type: 'array',
                    items: {
                      type: 'string',
                      format: 'binary',
                    },
                    description: 'Document files (max 100 files, 1GB each)',
                  },
                  retentionDays: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 3650,
                    description: 'Days to retain documents',
                  },
                  priority: {
                    type: 'integer',
                    minimum: 1,
                    maximum: 10,
                    default: 5,
                    description: 'Processing priority (higher = faster)',
                  },
                },
              },
            },
          },
        },
        responses: {
          '202': {
            description: 'Batch accepted for processing',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchSubmitResponse' },
              },
            },
          },
          '400': {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/v1/batch/status/{batchId}': {
      get: {
        summary: 'Get Batch Status',
        description: 'Check the processing status of a batch',
        parameters: [
          {
            name: 'batchId',
            in: 'path',
            required: true,
            description: 'Batch ID',
            schema: { type: 'string' },
          },
          {
            name: 'details',
            in: 'query',
            description: 'Include detailed document list',
            schema: { type: 'boolean', default: false },
          },
        ],
        responses: {
          '200': {
            description: 'Batch status',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BatchStatusResponse' },
              },
            },
          },
          '404': {
            description: 'Batch not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
    '/v1/batch/download/{batchId}': {
      get: {
        summary: 'Download Batch Results',
        description: 'Download all completed batch results in JSONL format',
        parameters: [
          {
            name: 'batchId',
            in: 'path',
            required: true,
            description: 'Batch ID',
            schema: { type: 'string' },
          },
          {
            name: 'format',
            in: 'query',
            description: 'Download format',
            schema: { type: 'string', enum: ['jsonl'], default: 'jsonl' },
          },
        ],
        responses: {
          '200': {
            description: 'Batch results',
            content: {
              'application/x-ndjson': {
                schema: { type: 'string' },
              },
            },
          },
          '400': {
            description: 'Batch not ready',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
          '404': {
            description: 'Batch not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
    },
  },
};
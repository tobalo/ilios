export const openAPISpec = {
  openapi: '3.0.0',
  info: {
    title: 'Convert Docs API',
    version: '2.0.0',
    description: 'API for converting documents to markdown using Mistral OCR',
  },
  servers: [
    {
      url: 'http://localhost:1337',
      description: 'Development server',
    },
    {
      url: 'https://api.convert-docs.com',
      description: 'Production server',
    },
  ],
  components: {
    securitySchemes: {
      apiKey: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
        description: 'API key for authentication',
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
    },
  },
  security: [{ apiKey: [] }],
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
                    description: 'Document file to process (max 50MB)',
                  },
                  metadata: {
                    type: 'string',
                    description: 'Optional JSON metadata',
                  },
                },
              },
            },
          },
        },
        responses: {
          '202': {
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
        description: 'Get usage statistics and cost summary',
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
        description: 'Get detailed usage breakdown by operation type',
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
  },
};
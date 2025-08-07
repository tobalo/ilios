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
          id: { type: 'string', format: 'uuid' },
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
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string' },
          message: { type: 'string' },
        },
      },
      StatusResponse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
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
          totalDocuments: { type: 'integer' },
          totalCostCents: { type: 'integer' },
          documentsProcessed: { type: 'integer' },
          averageProcessingTime: { type: 'number' },
          byStatus: {
            type: 'object',
            additionalProperties: { type: 'integer' },
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
            description: 'Document ID',
            schema: { type: 'string', format: 'uuid' },
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
            description: 'Document ID',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Document content',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Document' },
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
  },
};
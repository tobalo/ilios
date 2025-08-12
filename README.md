# Convert Docs API v2

A streamlined document-to-markdown conversion API using Turso (edge SQLite), Tigris S3, and Mistral OCR.

## Features

- 📄 Document to Markdown conversion using Mistral OCR ($1 per 1000 pages)
- 💾 Document retention and archival (configurable retention period)
- 📊 Usage tracking with margin-based billing
- 🚀 Edge-optimized with Turso database using embedded replicas
- 💨 Local SQLite (libsql) for fast reads with automatic sync to Turso
- 🗄️ S3-compatible storage with Tigris (using Bun's native S3 helpers)
- ⚡ Async job processing with database-backed queue
- 📦 Support for large files up to 1GB
- 🔒 Optional API key authentication

## Architecture

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Hono API
    participant DB as Turso DB<br/>(Embedded Replica)
    participant Q as Job Queue
    participant W as Job Worker
    participant S3 as Tigris S3
    participant M as Mistral OCR

    C->>API: POST /api/documents/submit<br/>(multipart form data)
    API->>S3: Upload original document
    API->>DB: Create document record<br/>(status: pending)
    API->>Q: Create job entry
    API-->>C: Return document ID

    Note over Q,W: Async Processing
    
    W->>Q: Poll for jobs
    Q-->>W: Return pending job
    W->>DB: Update status: processing
    W->>S3: Retrieve document
    W->>M: Send for OCR/conversion
    M-->>W: Return markdown content
    W->>DB: Store converted content<br/>Update usage records
    W->>DB: Update status: completed

    Note over C,API: Later...
    
    C->>API: GET /api/documents/status/{id}
    API->>DB: Query document status
    API-->>C: Return status

    C->>API: GET /api/documents/{id}
    API->>DB: Retrieve converted content
    API-->>C: Return markdown
```

## Setup

1. Install dependencies:
```bash
bun install
```

2. Configure environment variables:
```bash
cp .env.example .env
# Edit .env with your credentials
```

3. Setup database:
```bash
# Generate database types
bun run db:generate
# Push schema changes
bun run db:push
```
Or `bun run scripts/setup-db.ts`

4. Start the server:
```bash
bun run dev
```

## API Endpoints

### Submit Document
```bash
POST /api/documents/submit
Content-Type: multipart/form-data

file: <file>
retentionDays: 365 (optional, 1-3650)
```

### Check Status
```bash
GET /api/documents/status/:id
```

### Download Converted Document
```bash
GET /api/documents/:id
GET /api/documents/:id?format=json
```

### Get Original File
```bash
GET /api/documents/:id/original
```

### Usage Summary
```bash
GET /api/usage/summary?startDate=2024-01-01T00:00:00Z&endDate=2024-12-31T23:59:59Z
```

### Usage Breakdown
```bash
GET /api/usage/breakdown
```

## Environment Variables

- `TURSO_DATABASE_URL`: Turso database URL (remote sync target)
- `TURSO_AUTH_TOKEN`: Turso authentication token
- `TURSO_SYNC_INTERVAL`: Sync interval in seconds (default: 60)
- `LOCAL_DB_PATH`: Local SQLite file path (default: ./src/db/convert-docs.db)
- `DB_ENCRYPTION_KEY`: Optional encryption key for local database
- `AWS_ACCESS_KEY_ID`: S3 access key (works with Tigris)
- `AWS_SECRET_ACCESS_KEY`: S3 secret key
- `AWS_ENDPOINT_URL_S3`: S3 endpoint (default: https://fly.storage.tigris.dev)
- `S3_BUCKET`: S3 bucket name
- `MISTRAL_API_KEY`: Mistral API key for OCR
- `API_KEY`: Optional API key for authentication

## Embedded Replicas

This API uses Turso's embedded replicas for optimal performance:

- **Local First**: All reads are served from the local SQLite file (microsecond latency)
- **Auto Sync**: Writes go to remote Turso and sync back automatically
- **Resilient**: Works offline, syncs when connection restored
- **Encrypted**: Optional encryption at rest for local database

The local database file is stored at `./src/db/convert-docs.db` by default.

## Database Schema

```mermaid
erDiagram
    documents {
        text id PK
        text file_name
        text mime_type
        integer file_size
        text s3_key
        text content
        json metadata
        text status "pending|processing|completed|failed|archived"
        text error
        timestamp created_at
        timestamp processed_at
        timestamp archived_at
        integer retention_days
        text user_id
        text api_key
    }
    
    usage {
        text id PK
        text document_id FK
        text user_id
        text api_key
        text operation
        integer input_tokens
        integer output_tokens
        integer base_cost_cents
        integer margin_rate
        integer total_cost_cents
        timestamp created_at
    }
    
    jobQueue {
        text id PK
        text document_id FK
        text type
        text status "pending|processing|completed|failed|retrying"
        integer priority
        integer attempts
        integer max_attempts
        json payload
        json result
        text error
        text worker_id FK
        timestamp scheduled_at
        timestamp started_at
        timestamp completed_at
        timestamp created_at
    }
    
    workers {
        text id PK
        integer pid
        text hostname
        timestamp started_at
        timestamp last_heartbeat
        text status "active|stopping|dead"
    }
    
    documents ||--o{ usage : "has"
    documents ||--o{ jobQueue : "has"
    workers ||--o{ jobQueue : "processes"
```

### Documents Table
- Stores document metadata and converted content
- Supports archival with configurable retention periods
- Tracks processing status and errors

### Usage Table
- Records all operations with token counts
- Calculates costs with configurable margin rates
- Supports filtering by user/API key

### Job Queue Table
- Database-backed job queue for async processing
- Supports retries with exponential backoff
- Priority-based processing

### Workers Table
- Tracks active worker processes
- Manages worker lifecycle with heartbeat monitoring
- Enables distributed job processing

## Cost Calculation

Base cost: **Mistral OCR** - $0.001 per page ($1 per 1000 pages)

Total cost = Base cost × (1 + margin rate)
Default margin rate: 30%

Example: Processing 1000 pages costs $1.30 with default 30% margin

## Development

```bash
# Generate database types
bun run db:generate

# Push schema changes
bun run db:push

# View database
bun run db:studio
```

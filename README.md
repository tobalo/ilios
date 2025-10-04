# Ilios API

A production-ready document-to-markdown conversion API built with Bun, featuring local-first architecture, atomic job processing, and automatic retry logic.

### TODO: 
- Add batch submit and req/reply markdown convert endpoints
-- Evaluation and processing benchmarks

## Features

- 📄 **Document Conversion** - PDF/images to Markdown using Mistral OCR ($1 per 1000 pages)
- 💾 **Document Retention** - Configurable archival (1-3650 days)
- 📊 **Usage Tracking** - Token-based billing with configurable margins
- 🚀 **Local-First Database** - SQLite with optional Turso sync via embedded replicas
- 🗄️ **S3-Compatible Storage** - Tigris/Cloudflare R2 support with multipart upload
- ⚡ **Atomic Job Queue** - Transaction-based job claiming prevents race conditions
- 🔄 **Automatic Retries** - Exponential backoff (5s, 10s, 20s) with max 3 attempts
- 📦 **Large File Support** - Up to 1GB with streaming and temp file handling
- 🔒 **Optional Auth** - API key authentication via header or env variable
- 🛡️ **Graceful Shutdown** - Waits for active jobs before process termination

## Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                       Ilios API Server                       │
├─────────────────────────────────────────────────────────────┤
│  Main Process                                               │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │  Hono API    │  │ Job Processor│  │  S3 Service  │      │
│  │  (Routes)    │  │  (Spawn Mgr) │  │  (Tigris)    │      │
│  └──────┬───────┘  └──────┬───────┘  └──────────────┘      │
│         │                  │                                 │
│         └──────────┬───────┘                                │
│                    │                                         │
│         ┌──────────▼──────────┐                             │
│         │  SQLite Database    │                             │
│         │  (./data/ilios.db)  │                             │
│         │  WAL Mode Enabled   │                             │
│         └─────────────────────┘                             │
├─────────────────────────────────────────────────────────────┤
│  Worker Processes (spawned via Bun)                        │
│  ┌──────────────┐  ┌──────────────┐                        │
│  │  Worker 0    │  │  Worker 1    │                        │
│  │  - Claims    │  │  - Claims    │                        │
│  │  - Processes │  │  - Processes │                        │
│  │  - Retries   │  │  - Retries   │                        │
│  └──────────────┘  └──────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### Request Flow (Detailed Sequence)

```mermaid
sequenceDiagram
    participant C as Client
    participant API as Hono API
    participant DB as SQLite DB<br/>(WAL Mode)
    participant JP as Job Processor
    participant W as Worker Process
    participant S3 as S3 Storage
    participant M as Mistral OCR

    Note over C,API: Document Submission
    C->>API: POST /api/documents/submit<br/>(file, retentionDays)
    API->>API: Detect MIME type
    API->>S3: Upload file (multipart if >50MB)
    API->>DB: INSERT document (status=pending)
    API->>DB: INSERT job (type=convert, status=pending)
    API-->>C: 200 OK {id, status: pending}

    Note over JP,W: Async Job Processing
    JP->>DB: Check for pending jobs
    JP->>W: Signal "process" (no job ID)
    
    W->>DB: BEGIN TRANSACTION
    W->>DB: SELECT pending job (LIMIT 1)
    W->>DB: UPDATE job SET status=processing,<br/>worker_id=W, attempts=attempts+1
    W->>DB: COMMIT (atomic claim)
    
    alt Job Claimed Successfully
        W->>DB: UPDATE document SET status=processing
        W->>S3: Download file (stream if >10MB)
        W->>W: Save to ./data/tmp/ if large
        W->>M: POST /v1/chat/completions<br/>(vision model + file)
        M-->>W: Response with markdown content
        W->>DB: UPDATE document SET<br/>content=markdown, status=completed
        W->>DB: INSERT usage record<br/>(tokens, cost)
        W->>DB: UPDATE job SET<br/>status=completed, completedAt=now
        W->>W: Clean up temp file
        W-->>JP: completed
    else Job Processing Failed
        W->>DB: failJob(id, error)
        alt attempts < maxAttempts
            W->>DB: UPDATE job SET status=pending,<br/>scheduledAt=now+backoff
            Note over W,DB: Retry with exponential backoff<br/>(5s, 10s, 20s)
        else attempts >= maxAttempts
            W->>DB: UPDATE job SET status=failed,<br/>completedAt=now
            W->>DB: UPDATE document SET status=failed
        end
        W-->>JP: failed
    end

    Note over C,API: Status Check & Download
    C->>API: GET /api/documents/status/{id}
    API->>DB: SELECT document WHERE id={id}
    API-->>C: {status, error?, metadata?}

    C->>API: GET /api/documents/{id}
    API->>DB: SELECT content WHERE id={id}
    alt status=completed
        API-->>C: 200 OK (markdown text)
    else status=processing
        API-->>C: 202 Accepted {status: processing}
    else status=failed
        API-->>C: 500 Error {error}
    end
```

### Worker Lifecycle & Job States

```mermaid
stateDiagram-v2
    [*] --> pending: Job Created
    pending --> processing: Worker Claims (atomic)
    
    processing --> completed: Success
    processing --> pending: Worker Died<br/>(attempts < max)
    processing --> failed: Worker Died<br/>(attempts >= max)
    processing --> pending: Error + Retry<br/>(attempts < max)
    processing --> failed: Error + No Retry<br/>(attempts >= max)
    
    completed --> [*]
    failed --> [*]
    
    note right of processing
        Worker tracks active job
        Heartbeat every 30s
        Cleanup runs every 30s
    end note
```

## Directory Structure

```
ilios/api/
├── src/
│   ├── db/
│   │   ├── schema.ts              # Drizzle ORM schema definitions
│   │   └── migrations/            # Database migrations
│   ├── middleware/
│   │   ├── auth.ts                # API key authentication
│   │   └── error.ts               # Global error handler
│   ├── routes/
│   │   ├── documents.ts           # Document endpoints
│   │   └── usage.ts               # Usage tracking endpoints
│   ├── services/
│   │   ├── database.ts            # SQLite/Turso database service
│   │   ├── job-processor-spawn.ts # Worker process manager
│   │   ├── mistral.ts             # Mistral OCR integration
│   │   └── s3.ts                  # S3-compatible storage
│   ├── workers/
│   │   └── job-worker.ts          # Worker process (claims & processes jobs)
│   ├── index.ts                   # Main server entry point
│   └── openapi.ts                 # OpenAPI/Swagger spec
├── data/                          # gitignored, auto-created
│   ├── ilios.db                   # Local SQLite database (shared)
│   ├── ilios.db-shm               # WAL shared memory
│   ├── ilios.db-wal               # WAL write-ahead log
│   └── tmp/                       # Temp files for large uploads
├── drizzle.config.ts              # Drizzle Kit configuration
├── package.json
├── tsconfig.json
├── CLAUDE.md                      # AI assistant context
└── README.md
```

## Quick Setup

### Prerequisites
- [Bun](https://bun.sh) v1.0+ (runtime & package manager)
- [Mistral API Key](https://console.mistral.ai/) (for OCR)
- [Tigris/S3 credentials](https://www.tigrisdata.com/) (for storage)
- Optional: [Turso account](https://turso.tech/) (for edge sync)

### Installation

1. **Clone and install dependencies:**
```bash
git clone <repo-url>
cd ilios/api
bun install
```

2. **Configure environment:**
```bash
cp .env.example .env
```

Edit `.env` with your credentials:
```bash
# Required - Mistral OCR
MISTRAL_API_KEY=your_mistral_api_key_here

# Required - S3 Storage (Tigris example)
AWS_ACCESS_KEY_ID=tid_xxx
AWS_SECRET_ACCESS_KEY=tsec_xxx
AWS_ENDPOINT_URL_S3=https://fly.storage.tigris.dev
S3_BUCKET=your-bucket-name

# Optional - API Key Authentication
API_KEY=your_secure_api_key_here

# Optional - Turso Sync (omit for local-only mode)
USE_EMBEDDED_REPLICA=false  # true to enable Turso sync
# TURSO_DATABASE_URL=libsql://your-db.turso.io
# TURSO_AUTH_TOKEN=your-token
# TURSO_SYNC_INTERVAL=60

# Optional - Database
LOCAL_DB_PATH=./data/ilios.db
```

3. **Initialize database:**
```bash
bun run db:push
```

4. **Start server:**
```bash
bun run dev
```

Server starts at `http://localhost:1337`
- API docs: `http://localhost:1337/docs` (Swagger UI)
- Health check: `http://localhost:1337/health`

### API Key Setup

If you set `API_KEY` in your `.env`, all requests to `/api/*` must include:

```bash
# Header-based auth
curl -H "Authorization: Bearer your_api_key_here" \
  -F "file=@document.pdf" \
  http://localhost:1337/api/documents/submit

# Or query param
curl -F "file=@document.pdf" \
  "http://localhost:1337/api/documents/submit?apiKey=your_api_key_here"
```

To disable authentication, remove or comment out `API_KEY` in `.env`.

## API Usage

### Submit Document for Conversion

```bash
curl -X POST http://localhost:1337/api/documents/submit \
  -H "Authorization: Bearer your_api_key" \
  -F "file=@path/to/document.pdf" \
  -F "retentionDays=365"
```

**Response:**
```json
{
  "id": "cm5xabc123...",
  "status": "pending",
  "fileName": "document.pdf",
  "fileSize": 1234567,
  "retentionDays": 365,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

### Check Document Status

```bash
curl http://localhost:1337/api/documents/status/cm5xabc123 \
  -H "Authorization: Bearer your_api_key"
```

**Response (Processing):**
```json
{
  "id": "cm5xabc123...",
  "status": "processing",
  "fileName": "document.pdf"
}
```

**Response (Completed):**
```json
{
  "id": "cm5xabc123...",
  "status": "completed",
  "fileName": "document.pdf",
  "metadata": {
    "pages": 10,
    "processingTimeMs": 5432,
    "model": "pixtral-12b-2409"
  }
}
```

### Download Converted Markdown

```bash
# Get raw markdown
curl http://localhost:1337/api/documents/cm5xabc123 \
  -H "Authorization: Bearer your_api_key"

# Get JSON response
curl http://localhost:1337/api/documents/cm5xabc123?format=json \
  -H "Authorization: Bearer your_api_key"
```

**Response (markdown):**
```markdown
# Document Title

Document content in markdown format...
```

**Response (JSON):**
```json
{
  "id": "cm5xabc123...",
  "content": "# Document Title\n\nDocument content...",
  "metadata": {...}
}
```

### Get Original Document

```bash
curl http://localhost:1337/api/documents/cm5xabc123/original \
  -H "Authorization: Bearer your_api_key" \
  -o original_document.pdf
```

### Usage Tracking

```bash
# Summary for date range
curl "http://localhost:1337/api/usage/summary?startDate=2024-01-01T00:00:00Z&endDate=2024-12-31T23:59:59Z" \
  -H "Authorization: Bearer your_api_key"

# Detailed breakdown
curl http://localhost:1337/api/usage/breakdown \
  -H "Authorization: Bearer your_api_key"
```

**Response (Summary):**
```json
{
  "totalDocuments": 150,
  "totalOperations": 150,
  "totalInputTokens": 50000,
  "totalOutputTokens": 25000,
  "totalCostCents": 13000
}
```

## Environment Variables

- `USE_EMBEDDED_REPLICA`: Set to 'true' for Turso sync, 'false' for local-only (default: false)
- `LOCAL_DB_PATH`: Local SQLite file path (default: ./data/ilios.db)
- `TURSO_DATABASE_URL`: Turso database URL (only if USE_EMBEDDED_REPLICA=true)
- `TURSO_AUTH_TOKEN`: Turso authentication token (only if USE_EMBEDDED_REPLICA=true)
- `TURSO_SYNC_INTERVAL`: Sync interval in seconds (default: 60)
- `DB_ENCRYPTION_KEY`: Optional encryption key for local database
- `AWS_ACCESS_KEY_ID`: S3 access key
- `AWS_SECRET_ACCESS_KEY`: S3 secret key
- `AWS_ENDPOINT_URL_S3`: S3 endpoint URL
- `S3_BUCKET`: S3 bucket name
- `MISTRAL_API_KEY`: Mistral API key for OCR
- `API_KEY`: Optional API key for authentication

## Database Modes

### Local-Only (Default)
Uses local SQLite database only - no remote sync required:
```bash
USE_EMBEDDED_REPLICA=false
LOCAL_DB_PATH=./data/ilios.db
```

### Turso Embedded Replica (Optional)
Enable Turso sync for edge-optimized performance:
```bash
USE_EMBEDDED_REPLICA=true
LOCAL_DB_PATH=./data/ilios.db
TURSO_DATABASE_URL=libsql://your-database.turso.io
TURSO_AUTH_TOKEN=your-token
```

Benefits of embedded replicas:
- **Local First**: All reads from local SQLite (microsecond latency)
- **Auto Sync**: Writes sync to Turso automatically
- **Resilient**: Works offline, syncs when reconnected
- **Encrypted**: Optional encryption at rest

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

### Database Management

```bash
# Push schema changes (first-time setup or schema updates)
bun run db:push

# Generate migrations from schema
bun run db:generate

# Run migrations
bun run db:migrate

# View database in Drizzle Studio
bun run db:studio
```

### Project Scripts

```bash
bun run dev          # Start dev server with hot reload
bun run db:push      # Sync schema to database
bun run db:generate  # Generate migration files
bun run db:studio    # Open Drizzle Studio
```

### Worker Architecture

The API uses a multi-worker architecture for async job processing:

- **Main Process**: Handles HTTP requests, manages worker lifecycle
- **Worker Processes**: Spawned via Bun, atomically claim and process jobs
- **Shared Database**: All processes use `./data/ilios.db` with WAL mode
- **Atomic Job Claiming**: Transaction-based claiming prevents race conditions
- **Automatic Retries**: Failed jobs retry with exponential backoff (5s, 10s, 20s)
- **Graceful Shutdown**: Workers wait for active jobs before exiting

**Job Processing Flow:**
1. Main process signals workers when jobs are available
2. Workers atomically claim jobs using `claimNextJob()` transaction
3. Worker processes job (download → OCR → store result)
4. On error: Job retries if `attempts < maxAttempts`, else marked `failed`
5. On worker crash: Orphaned jobs cleaned up and retried/failed based on attempts

### Monitoring & Debugging

**Check worker status:**
```bash
sqlite3 ./data/ilios.db "SELECT * FROM workers;"
```

**Check job queue:**
```bash
sqlite3 ./data/ilios.db "SELECT id, status, type, attempts, error FROM job_queue;"
```

**View logs:**
```bash
# Workers log to stderr with prefix "Worker {id} error:"
# Main process logs job distribution and worker lifecycle
```

**Cleanup stuck jobs manually:**
```bash
bun -e "
import { DatabaseService } from './src/services/database.ts';
const db = new DatabaseService();
await db.cleanupOrphanedJobs();
await db.close();
"
```

## Production Deployment

### Environment Considerations

1. **Enable Turso Sync** for multi-region edge performance:
```bash
USE_EMBEDDED_REPLICA=true
TURSO_DATABASE_URL=libsql://your-db.turso.io
TURSO_AUTH_TOKEN=your-token
```

2. **Configure Worker Count** based on CPU cores:
```typescript
// src/index.ts
jobProcessor = new JobProcessorSpawn(db, 4); // 4 workers
```

3. **Set Reasonable Timeouts**:
- Mistral OCR can take 30s+ for large documents
- Configure reverse proxy timeouts accordingly

4. **Monitor Disk Space**:
- `./data/tmp/` stores large files during processing
- Ensure adequate disk space (10GB+ recommended)

5. **Secure API Keys**:
- Use strong, randomly generated API keys
- Rotate keys periodically
- Consider per-user API keys for tracking

## Troubleshooting

**Workers exit immediately:**
- Check for syntax errors in worker code
- Ensure `./data/tmp/` directory exists and is writable
- Verify database file permissions

**SQLITE_BUSY errors:**
- WAL mode should handle concurrent access
- Check that `PRAGMA journal_mode=WAL` is set
- Reduce worker count if excessive contention

**Jobs stuck in processing:**
- Run cleanup: `await db.cleanupOrphanedJobs()`
- Check worker heartbeat timestamps
- Verify workers are running: `ps aux | grep job-worker`

**Large files failing:**
- Files >10MB stream to `./data/tmp/`
- Ensure sufficient disk space
- Check temp directory permissions

## License

MIT

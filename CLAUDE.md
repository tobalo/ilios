# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Ilios API v2.1 - A production-ready document-to-markdown conversion API with immediate OCR and batch processing, using local-first SQLite, Tigris S3, and Mistral AI OCR.

## Essential Commands

### Development
```bash
# Start development server with hot reload
bun run dev

# Setup database (run this before first use)
bun run db:push

# Database management
bun run db:generate    # Generate Drizzle types from schema
bun run db:push       # Push schema changes to database
bun run db:studio     # Open Drizzle Studio for visual DB management
```

### New v2.1 Endpoints
- **POST /v1/convert** - Immediate OCR conversion (synchronous, no S3, no queue, saves to DB)
- **POST /v1/batch/submit** - Submit batch for processing
- **GET /v1/batch/status/:batchId** - Check batch progress
- **GET /v1/batch/download/:batchId** - Download completed batch results

### Environment Setup
Required environment variables:
- `USE_EMBEDDED_REPLICA` - Set to 'true' for Turso sync, 'false' for local-only (default: false)
- `LOCAL_DB_PATH` - Local SQLite file path (default: ./data/ilios.db)
- `TURSO_DATABASE_URL` - Turso database URL (only if USE_EMBEDDED_REPLICA=true)
- `TURSO_AUTH_TOKEN` - Turso authentication token (only if USE_EMBEDDED_REPLICA=true)
- `TURSO_SYNC_INTERVAL` - Sync interval in seconds (default: 60)
- `DB_ENCRYPTION_KEY` - Optional encryption key for local database
- `MISTRAL_API_KEY` - Mistral API key for OCR processing
- `AWS_ACCESS_KEY_ID` - S3 access key
- `AWS_SECRET_ACCESS_KEY` - S3 secret key
- `S3_BUCKET` - S3 bucket name for document storage
- `AWS_ENDPOINT_URL_S3` - S3 endpoint URL
- `API_KEY` - API key(s) for authentication (comma-separated for ACL support)
  - If set, ALL endpoints require valid Bearer token except: `/health`, `/docs`, `/openapi.json`
  - Supports multiple keys: `API_KEY=key1,key2,key3`
  - Each key is tracked independently in usage and document records

## Architecture

### Core Components
1. **API Layer** (`src/index.ts`) - Hono framework with OpenAPI/Swagger UI
2. **Database** (`src/services/database.ts`) - Local SQLite or Turso with optional embedded replica
3. **Job Processing** (`src/services/job-processor-spawn.ts`) - Multi-worker spawn-based job processing
4. **Storage** (`src/services/s3.ts`) - S3-compatible storage with multipart upload support

### Key Design Patterns
- **Local-First**: Uses local SQLite database stored in `./data/ilios.db`
- **Optional Sync**: Toggle embedded replicas with `USE_EMBEDDED_REPLICA=true` for Turso sync
- **Job Queue**: Database-backed async processing with atomic job claiming
- **Automatic Retries**: Failed jobs retry with exponential backoff (5s, 10s, 20s), max 3 attempts
- **Multipart Upload**: Automatic chunking for files > 50MB
- **Usage Tracking**: Page-based billing with configurable margins
- **Worker Spawn**: Uses Bun's spawn API for process-based workers

### Database Schema (`src/db/schema.ts`)
- `documents` - Document metadata, content, processing status, and optional `batchId`
- `batches` - Batch metadata, progress tracking, and status
- `usage` - API usage tracking with token counts
- `jobQueue` - Async job management (processes both single and batch documents)
- `workers` - Active worker process tracking
- Migrations stored in `src/db/migrations/`

### API Routes
**v1 Routes** (New in v2.1):
- `/v1/convert` - Immediate OCR (no S3 upload, no job queue, synchronous processing, saves to DB)
- `/v1/batch/submit` - Batch document submission
- `/v1/batch/status/:batchId` - Batch progress tracking
- `/v1/batch/download/:batchId` - Download batch results

**Legacy Routes**:
- `/api/documents/*` - Document submission, status, and retrieval
- `/api/usage/*` - Usage tracking and billing endpoints
- All routes defined in `src/routes/v1/`

### Worker Architecture
- Main process spawns Bun Worker threads (`src/services/job-processor-worker.ts`)
- **True Thread Parallelism**: Uses Bun's native Worker API (actual OS threads, not Node.js worker_threads)
- **Shared Database Connection**: All workers share the same database instance (no process isolation)
- **Fast IPC**: Bun's optimized `postMessage` API (2-241x faster than Node.js)
- **Shared Temp Directory**: All workers use `./data/tmp/` for temporary files
- Workers atomically claim jobs using database transactions (`claimNextJob()`)
- **Job State Flow**: `pending` → `processing` → `completed`|`failed`
  - Failed jobs auto-retry with exponential backoff if attempts < maxAttempts
  - Orphaned jobs (timed out >5 minutes) are reset to `pending` or marked `failed` based on attempt count
- **Worker-Agnostic Processing**: Workers process jobs from queue without distinction between single/batch documents
  - Batch progress automatically updated after each document completion
  - Batch status transitions: `pending` → `processing` → `completed`|`failed`
- Configurable worker count (default: 2)
- **No Worker Registration Table**: Workers communicate via IPC messages only
- **No Heartbeats**: Cleanup relies solely on job timeout (>5 minutes)
- Orphaned job cleanup every 60 seconds based on job start time
- Graceful shutdown with 5-second timeout, waits for active jobs to complete
- **Zero Database Contention**: No SQLITE_BUSY errors since workers share connection

## Important Notes

1. **No Test Framework**: Currently no test files or testing commands configured
2. **No Linting**: No ESLint or code formatting tools configured
3. **Bun Runtime**: Uses Bun-specific features (hot reload, native S3 helpers, spawn API)
4. **Local-First Database**: Default mode uses local SQLite (`./data/ilios.db`), no remote required
5. **WAL Mode**: Database uses WAL journaling with 5-second busy timeout for concurrent access
6. **Optional Turso Sync**: Enable with `USE_EMBEDDED_REPLICA=true` for edge replica sync
7. **Security**: 
   - API key authentication via `API_KEY` environment variable (supports ACL with comma-separated keys)
   - When `API_KEY` is set, all endpoints require `Authorization: Bearer <key>` except public paths
   - Public paths (no auth required): `/health`, `/docs`, `/openapi.json`
   - All API keys are tracked in `documents.apiKey` and `usage.apiKey` for usage isolation
8. **File Limits**: Supports files up to 1GB, configurable retention (1-3650 days)
9. **Data Directory**: `./data/` is gitignored, contains:
   - `ilios.db` - Main SQLite database (shared by all processes)
   - `tmp/` - Temporary file storage for large file processing
10. **Performance Optimizations**: Uses Bun native APIs for file I/O (see PERFORMANCE_OPTIMIZATIONS.md)
    - `Bun.write()` for zero-copy file streaming
    - `Bun.file()` for lazy file loading and operations
    - Direct buffer processing for files <100MB (no temp files)

## Common Tasks

### Adding New Routes
1. Create route file in `src/routes/v1/`
2. Define route handler function (e.g., `createMyRoutes(dependencies)`)
3. Register route in `src/index.ts` using `app.route('/v1/myroute', createMyRoutes(...))`
4. Update `src/openapi.ts` with new endpoint schemas

### Modifying Database Schema
1. Edit `src/db/schema.ts`
2. Run `bun run db:push` to apply changes directly
   OR
   Run `bun run db:generate` to create migration in `src/db/migrations/` then `bun run db:migrate`

### Debugging Job Processing
- Check `jobQueue` table for job status
- Monitor `workers` table for active workers
- Worker logs include job IDs for tracing

### Working with Large Files
- Files > 10MB automatically stream to `./data/tmp/` directory
- Files > 50MB use multipart S3 upload
- Temp files cleaned up after processing
- Workers use Node.js fs/promises instead of Bun APIs for file operations

### Worker Process Gotchas
- Workers are spawned as separate Bun processes but don't have access to all Bun globals
- Use Node.js APIs (`fs/promises`) instead of Bun APIs (`Bun.file`, `Bun.spawnSync`)
- Workers communicate via stdin/stdout using JSON messages
- Database SQLITE_BUSY errors are automatically retried with exponential backoff
## Document & Job Status Flow

### Correct Status Progression

**Document Status:**
```
pending → processing → completed|failed → archived
```

**Job Status:**
```
pending → processing → completed|failed
         ↓ (retry)
    pending (with backoff)
```

### Timeline

1. **Upload Phase**
   - Document created: `status = 'pending'` (default)
   - File uploaded to S3 (async)
   - Job created: `status = 'pending'`
   - Client receives: `{status: 'pending'}`

2. **Worker Claims Job (Atomic)**
   - Worker calls `claimNextJob(workerId)`
   - Transaction: `UPDATE job SET status='processing', worker_id=X, attempts++`
   - Worker updates: `UPDATE document SET status='processing'`

3. **Processing**
   - Download from S3
   - Send to Mistral OCR
   - Store result

4. **Completion**
   - Success: `document.status = 'completed'`, `job.status = 'completed'`
   - Failure: Retry if `attempts < maxAttempts`, else `failed`

### Important Rules

- ✅ **ONLY workers** set `document.status = 'processing'` (after claiming job)
- ✅ API endpoints create jobs but leave document in `pending`
- ✅ Job claiming is atomic (transaction-based)
- ✅ Status updates follow the progression above
- ❌ **NEVER** set `processing` before worker claims job
- ❌ **NEVER** skip statuses in the flow


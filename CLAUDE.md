# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Convert Docs API v2 - A document-to-markdown conversion API using Turso (edge SQLite), Tigris S3, and Mistral OCR.

## Essential Commands

### Development
```bash
# Start development server with hot reload
bun run dev

# Setup database (run this before first use)
bun run scripts/setup-db.ts

# Database management
bun run db:generate    # Generate Drizzle types from schema
bun run db:push       # Push schema changes to database
bun run db:studio     # Open Drizzle Studio for visual DB management
```

### Environment Setup
Required environment variables:
- `TURSO_DATABASE_URL` - Turso database URL (remote sync target)
- `TURSO_AUTH_TOKEN` - Turso authentication token
- `MISTRAL_API_KEY` - Mistral API key for OCR processing
- `TIGRIS_ACCESS_KEY_ID` - Tigris S3 access key (or AWS_ACCESS_KEY_ID)
- `TIGRIS_SECRET_ACCESS_KEY` - Tigris S3 secret key (or AWS_SECRET_ACCESS_KEY)
- `TIGRIS_BUCKET_NAME` - S3 bucket name for document storage (or S3_BUCKET)
- `TIGRIS_ENDPOINT` - Tigris S3 endpoint URL (or AWS_ENDPOINT_URL_S3)
- `API_KEY` - Optional API key for authentication
- `LOCAL_DB_PATH` - Local SQLite file path (default: ./src/db/convert-docs.db)
- `TURSO_SYNC_INTERVAL` - Sync interval in seconds (default: 60)
- `DB_ENCRYPTION_KEY` - Optional encryption key for local database

## Architecture

### Core Components
1. **API Layer** (`src/index.ts`) - Hono framework with OpenAPI/Swagger UI
2. **Database** (`src/services/database.ts`) - Turso with embedded replica for edge performance
3. **Job Processing** (`src/services/job-processor-spawn.ts`) - Multi-worker spawn-based job processing
4. **Storage** (`src/services/s3.ts`) - S3-compatible storage with multipart upload support

### Key Design Patterns
- **Edge-First**: Uses embedded SQLite replicas for microsecond read latency
- **Job Queue**: Database-backed async processing with worker spawn management
- **Multipart Upload**: Automatic chunking for files > 50MB
- **Usage Tracking**: Page-based billing with configurable margins
- **Worker Spawn**: Uses Bun's spawn API for process-based workers

### Database Schema (`src/db/schema.ts`)
- `documents` - Document metadata, content, and processing status
- `usage` - API usage tracking with token counts
- `jobQueue` - Async job management
- `workers` - Active worker process tracking

### API Routes
- `/api/documents/*` - Document submission, status, and retrieval
- `/api/usage/*` - Usage tracking and billing endpoints
- All routes defined in `src/routes/`

### Worker Architecture
- Main process spawns worker processes (`src/services/job-processor-spawn.ts`)
- Workers process jobs from database queue (`src/workers/job-worker.ts`)
- Automatic worker lifecycle management with health checks
- Configurable worker count (default: 2)
- Heartbeat monitoring every 30 seconds
- Auto-restart on failure with 5-second delay

## Important Notes

1. **No Test Framework**: Currently no test files or testing commands configured
2. **No Linting**: No ESLint or code formatting tools configured
3. **Bun Runtime**: Uses Bun-specific features (hot reload, native S3 helpers, spawn API)
4. **Active Development**: Recent features include embedded replicas and multipart uploads
5. **Security**: Optional API key authentication via `API_KEY` environment variable
6. **File Limits**: Supports files up to 1GB, configurable retention (1-3650 days)
7. **Database Files**: SQLite database files are tracked in git (unusual but intentional)

## Common Tasks

### Adding New Routes
1. Create route file in `src/routes/`
2. Define OpenAPI schema using Hono's zod-openapi
3. Register route in `src/index.ts`

### Modifying Database Schema
1. Edit `src/db/schema.ts`
2. Run `bun run db:generate` to create migration
3. Run `bun run db:push` to apply changes

### Debugging Job Processing
- Check `jobQueue` table for job status
- Monitor `workers` table for active workers
- Worker logs include job IDs for tracing

### Working with Large Files
- Files > 10MB automatically stream to temp directory
- Files > 50MB use multipart S3 upload
- Temp files cleaned up after processing
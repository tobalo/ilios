# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Convert Docs API v2 - A document-to-markdown conversion API using Turso (edge SQLite), Tigris S3, and Mistral Pixtral OCR.

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
- `MISTRAL_API_KEY` - Mistral API key for Pixtral OCR
- `TIGRIS_ACCESS_KEY_ID` - Tigris S3 access key
- `TIGRIS_SECRET_ACCESS_KEY` - Tigris S3 secret key
- `TIGRIS_BUCKET_NAME` - S3 bucket name for document storage
- `TIGRIS_ENDPOINT` - Tigris S3 endpoint URL

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
- **Usage Tracking**: Token-based billing with configurable margins

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

## Important Notes

1. **No Test Framework**: Currently no test files or testing commands configured
2. **Bun Runtime**: Uses Bun-specific features (hot reload, native S3 helpers)
3. **Active Development**: Recent features include embedded replicas and multipart uploads
4. **Security**: Optional API key authentication via `API_KEY` environment variable
5. **File Limits**: Supports files up to 1GB, configurable retention (1-3650 days)

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
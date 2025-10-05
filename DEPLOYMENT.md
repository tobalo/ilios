# Ilios API Deployment Guide

## Docker Deployment

### Build & Run Locally

```bash
# Build image
docker build -t ilios-api .

# Run with volume mount
docker run -d \
  -p 1337:1337 \
  -v ilios-data:/data \
  -e AWS_ACCESS_KEY_ID=your-key \
  -e AWS_SECRET_ACCESS_KEY=your-secret \
  -e S3_BUCKET=your-bucket \
  -e MISTRAL_API_KEY=your-key \
  ilios-api
```

### Environment Variables

Required:
- `AWS_ACCESS_KEY_ID` - S3 access key
- `AWS_SECRET_ACCESS_KEY` - S3 secret key
- `S3_BUCKET` - S3 bucket name
- `MISTRAL_API_KEY` - Mistral API key for OCR

Optional:
- `LOCAL_DB_PATH` - Database file path (default: `/data/ilios.db`)
- `PORT` - Server port (default: `1337`)
- `AWS_ENDPOINT_URL_S3` - S3 endpoint (default: `https://fly.storage.tigris.dev`)
- `USE_EMBEDDED_REPLICA` - Enable Turso sync (default: `false`)
- `TURSO_DATABASE_URL` - Turso database URL (if embedded replica enabled)
- `TURSO_AUTH_TOKEN` - Turso auth token (if embedded replica enabled)
- `API_KEY` - Optional API authentication key

## Railway Deployment

Railway deployment is pre-configured with:
- **Volume Mount**: `/data` (configured in `railway.json`)
- **Auto-Migration**: Database schema automatically created on first start
- **Start Command**: `bun run start` (configured in `railway.json`)

### Setup Steps

1. **Create Railway Project**
   ```bash
   railway init
   ```

2. **Add Volume**
   - Volume is already configured in `railway.json` as `ilios-embedded-data`
   - Mounted at `/data` for persistent SQLite database

3. **Set Environment Variables**
   ```bash
   railway variables set AWS_ACCESS_KEY_ID=your-key
   railway variables set AWS_SECRET_ACCESS_KEY=your-secret
   railway variables set S3_BUCKET=your-bucket
   railway variables set MISTRAL_API_KEY=your-key
   ```

4. **Deploy**
   ```bash
   railway up
   ```

### How It Works

1. **Dockerfile** builds optimized Bun image with:
   - Lightweight multi-stage build
   - Migrations included (`src/db/migrations/`)
   - Proper permissions for `bun` user
   - Health check endpoint

2. **Startup Script** (`start.sh`):
   - Ensures `/data/tmp` directory exists
   - Starts Bun server

3. **Auto-Migration** (`src/services/database.ts`):
   - Checks if `documents` table exists
   - If empty, runs latest migration (0002_*.sql)
   - Handles "already exists" errors gracefully
   - No manual migration needed!

### Database Persistence

- **Local Mode** (default): Uses `/data/ilios.db` with Railway volume
- **Turso Mode** (optional): Set `USE_EMBEDDED_REPLICA=true` for edge sync

### Health Check

```bash
curl https://your-app.railway.app/health
```

Response:
```json
{
  "status": "healthy",
  "timestamp": "2025-10-05T22:36:16.435Z",
  "services": {
    "database": "connected",
    "s3": "configured"
  }
}
```

## Troubleshooting

### Database Permission Errors

If you see `error: ConnectionFailed("Unable to open connection to local database")`:
- Ensure `/data` volume is mounted
- Check `LOCAL_DB_PATH` environment variable is set to `/data/ilios.db`
- Verify volume has write permissions

### Migration Failures

Auto-migration runs on startup. If it fails:
- Check logs for specific SQL errors
- Verify migrations exist in `/app/src/db/migrations/`
- Manually run: `bun run db:push` (for Turso) or `bun run db:migrate`

### S3 Connection Issues

If S3 tests fail:
- Verify credentials are correct
- Check endpoint URL is reachable
- Test bucket permissions

## Architecture

```
┌─────────────────────────────────────────┐
│         Railway Container               │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │   Bun Runtime (Port 1337)       │   │
│  │                                 │   │
│  │  • API Server (Hono)            │   │
│  │  • Job Processor (2 workers)    │   │
│  │  • Auto-Migration               │   │
│  └─────────────────────────────────┘   │
│              │                          │
│              ▼                          │
│  ┌─────────────────────────────────┐   │
│  │   Volume: /data                 │   │
│  │                                 │   │
│  │  • ilios.db (SQLite)            │   │
│  │  • ilios.db-wal                 │   │
│  │  • tmp/ (temp files)            │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
         │                    │
         ▼                    ▼
    ┌──────────┐        ┌──────────┐
    │ Tigris   │        │ Mistral  │
    │ S3       │        │ OCR API  │
    └──────────┘        └──────────┘
```

## Performance Optimizations

The deployment includes all optimizations from v2.1.1:
- ✅ Bun native APIs (2-10x faster file I/O)
- ✅ IPC-based worker communication
- ✅ SQLITE_BUSY retry logic with exponential backoff
- ✅ Orphaned job cleanup with proper timestamp handling
- ✅ Direct in-memory processing for files <100MB
- ✅ Zero-copy streaming for large files

## Monitoring

- **Logs**: `railway logs`
- **Health**: `/health` endpoint
- **OpenAPI Docs**: `/docs`
- **Metrics**: Coming soon (Prometheus/Grafana)

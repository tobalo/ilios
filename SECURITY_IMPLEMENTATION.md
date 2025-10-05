# Security Hardening Implementation

## Overview
Implemented API key-based authentication with ACL (Access Control List) support that enforces strict security while allowing public access to essential endpoints.

## Changes Made

### 1. Auth Middleware (`src/middleware/auth.ts`)
**Features:**
- ✅ Multi-key ACL support via comma-separated `API_KEY` environment variable
- ✅ Whitelist of public paths that bypass authentication
- ✅ Global enforcement - applied to ALL routes via `app.use('*', authMiddleware)`
- ✅ Tracks API key in Hono context for usage attribution

**Public Paths (No Auth Required):**
- `/` - Landing page
- `/health` - Health check endpoint
- `/docs` - Swagger UI documentation
- `/openapi.json` - OpenAPI specification
- `/images/*` - Static image assets
- `/benchmarks/*` - Benchmark results

**Protected Paths (Auth Required when API_KEY is set):**
- `/api/documents/*` - All document operations
- `/api/usage/*` - Usage tracking endpoints
- `/v1/convert` - Immediate OCR conversion
- `/v1/batch/*` - Batch processing endpoints

### 2. Route Updates
Updated all route handlers to use authenticated API key from context:

**Files Modified:**
- `src/routes/v1/documents.ts` - Document upload/submission endpoints
- `src/routes/v1/batch.ts` - Batch submission endpoint
- `src/routes/v1/convert.ts` - Immediate conversion endpoint
- `src/routes/v1/usage.ts` - Already using `c.get('apiKey')` correctly

**Changes:**
- Changed `userId: undefined, apiKey: undefined` → `userId: c.get('userId'), apiKey: c.get('apiKey')`
- Ensures all documents, batches, and usage records are properly attributed to API keys
- Enables per-key usage tracking and isolation

### 3. Main App (`src/index.ts`)
- Moved auth from route-specific (`/api/*`, `/v1/*`) to global (`*`)
- Ensures no endpoint bypasses security check
- Auth middleware handles public path whitelisting internally

### 4. Documentation Updates

**`.env.example`:**
```bash
# API Authentication (ACL)
# If set, all endpoints require valid Bearer token except /health, /docs, /openapi.json
# Supports multiple keys (comma-separated): API_KEY=key1,key2,key3
API_KEY=your-api-key
```

**`CLAUDE.md`:**
- Updated environment variable documentation
- Added security architecture notes
- Documented public vs protected paths
- Explained ACL usage tracking

## Usage Examples

### Single API Key
```bash
export API_KEY="secret-production-key"
```

### Multiple API Keys (ACL)
```bash
export API_KEY="team-alpha-key,team-beta-key,admin-master-key"
```

### Making Authenticated Requests
```bash
# Without API_KEY set - all endpoints are public
curl http://localhost:1337/v1/convert -F "file=@document.pdf"

# With API_KEY set - must provide Authorization header
curl http://localhost:1337/v1/convert \
  -H "Authorization: Bearer team-alpha-key" \
  -F "file=@document.pdf"

# Public endpoints work without auth even when API_KEY is set
curl http://localhost:1337/health
curl http://localhost:1337/docs
```

### Usage Tracking Per Key
Each API key's usage is tracked independently in the database:
- `documents.apiKey` - Which key uploaded the document
- `usage.apiKey` - Which key incurred the processing costs
- `/api/usage/summary` - Filtered by authenticated key
- `/api/usage/breakdown` - Per-key usage breakdown

## Security Benefits

1. **Zero Trust by Default**: When `API_KEY` is set, all non-public endpoints require authentication
2. **Multi-Tenant Support**: Different teams/clients can have separate keys with isolated usage tracking
3. **Public Documentation**: `/docs` and `/health` remain accessible for monitoring and API discovery
4. **Usage Attribution**: Every operation is tracked to a specific API key for billing/auditing
5. **Easy Key Rotation**: Add new keys to ACL, migrate clients, remove old keys
6. **No Middleware Bypass**: Global middleware ensures consistent enforcement

## Migration Notes

**Before (Insecure):**
- Auth only on specific routes (`/api/*`, `/v1/*`)
- Documents/batches created with `undefined` apiKey
- No usage attribution
- Public by default

**After (Secure):**
- Auth on ALL routes (with public path whitelist)
- Documents/batches properly attributed to API keys
- Full usage tracking per key
- Private by default when `API_KEY` is set

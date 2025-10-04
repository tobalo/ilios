# Migration: Single-threaded to Multi-worker Architecture

## What Changed

### Removed (Legacy)
- ❌ `src/services/job-processor.ts` - Single-threaded job processor

### Active Architecture
- ✅ `src/services/job-processor-spawn.ts` - Worker process manager
- ✅ `src/workers/job-worker.ts` - Worker process (spawned)

## Key Differences

| Aspect | Old (job-processor.ts) | New (job-worker.ts) |
|--------|------------------------|---------------------|
| **Execution** | Main process (blocking) | Separate processes |
| **Concurrency** | Single-threaded | Multi-worker (default: 2) |
| **Job Claiming** | Non-atomic `getNextJob()` | Atomic `claimNextJob()` |
| **Isolation** | Crash affects API | Workers crash independently |
| **Retries** | Manual | Automatic with backoff |
| **Shutdown** | Immediate | Graceful (waits for jobs) |

## Database Method Changes

### Removed
```typescript
async getNextJob() // Non-atomic, race conditions
async getNextJobs(limit: number) // Non-atomic batch
```

### Current
```typescript
async claimNextJob(workerId: string) // Atomic with transaction
async cleanupOrphanedJobs() // Handles worker crashes
```

## Migration Complete ✓

No action required - the legacy code has been removed and the system is now running on the multi-worker architecture.

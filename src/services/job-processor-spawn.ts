import { DatabaseService } from './database';
import { jobQueue } from '../db/schema';
import { Subprocess } from 'bun';
import { eq, and, sql } from 'drizzle-orm';
import * as os from 'os';

interface WorkerMessage {
  type: 'process' | 'shutdown';
}

interface WorkerResponse {
  type: 'completed' | 'failed' | 'ready' | 'heartbeat';
  jobId?: string;
  error?: string;
}

export class JobProcessorSpawn {
  private db: DatabaseService;
  private workers: Map<string, Subprocess> = new Map();
  private workerCount: number;
  private isRunning = false;
  private interval?: Timer;
  private cleanupInterval?: Timer;
  private workerPath: string;

  constructor(
    db: DatabaseService,
    workerCount: number = 2
  ) {
    this.db = db;
    this.workerCount = workerCount;
    this.workerPath = new URL('../workers/job-worker.ts', import.meta.url).pathname;
  }

  async start(intervalMs = 5000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    await this.spawnWorkers();
    
    this.interval = setInterval(async () => {
      await this.distributeJobs();
    }, intervalMs);
    
    // Periodic cleanup of orphaned jobs every 30 seconds
    this.cleanupInterval = setInterval(async () => {
      await this.db.cleanupOrphanedJobs();
    }, 30000);
    
    await this.distributeJobs();
  }

  async stop() {
    console.log('Stopping job processor...');
    this.isRunning = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
    
    const shutdownPromises = Array.from(this.workers.entries()).map(
      ([id, worker]) => this.shutdownWorker(id, worker)
    );
    
    await Promise.all(shutdownPromises);
    
    this.workers.clear();
    console.log('All workers stopped');
  }

  private async spawnWorkers() {
    for (let i = 0; i < this.workerCount; i++) {
      await this.spawnWorker(`worker-${i}`);
      // Small delay to reduce database contention during worker registration
      if (i < this.workerCount - 1) {
        await Bun.sleep(200);
      }
    }
  }

  private async spawnWorker(workerId: string) {
    const worker = Bun.spawn({
      cmd: ['bun', 'run', this.workerPath],
      env: {
        ...process.env,
        WORKER_ID: workerId,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
      ipc: (message) => {
        this.handleWorkerMessage(workerId, message);
      },
    });

    this.workers.set(workerId, worker);

    await this.db.registerWorker(workerId, worker.pid!, os.hostname());

    this.handleWorkerErrors(workerId, worker);

    worker.exited.then(async (exitCode) => {
      console.log(`Worker ${workerId} exited with code ${exitCode}`);
      this.workers.delete(workerId);
      
      await this.db.updateWorkerStatus(workerId, 'dead');
      
      // Clean up any jobs that were being processed by this worker
      await this.db.cleanupOrphanedJobs();
      
      if (this.isRunning) {
        console.log(`Respawning worker ${workerId} in 5 seconds...`);
        setTimeout(() => this.spawnWorker(workerId), 5000);
      }
    });
  }

  private handleWorkerMessage(workerId: string, message: any) {
    if (!message || typeof message !== 'object') {
      console.log(`Worker ${workerId} sent invalid message:`, message);
      return;
    }

    const response = message as WorkerResponse;
    
    switch (response.type) {
      case 'ready':
        console.log(`Worker ${workerId} is ready`);
        break;
      case 'completed':
        console.log(`Worker ${workerId} completed job ${response.jobId}`);
        break;
      case 'failed':
        console.error(`Worker ${workerId} failed job ${response.jobId}: ${response.error}`);
        break;
      case 'heartbeat':
        // Silent heartbeat
        break;
      default:
        console.log(`Worker ${workerId} message:`, response);
    }
  }

  private async handleWorkerErrors(workerId: string, worker: Subprocess) {
    const reader = worker.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          console.error(`Worker ${workerId} error:`, line);
        }
      }
    } catch (error) {
      console.error(`Error reading worker ${workerId} stderr:`, error);
    }
  }

  private async shutdownWorker(workerId: string, worker: Subprocess) {
    console.log(`Shutting down worker ${workerId}...`);
    
    try {
      // Send shutdown signal via IPC
      const message: WorkerMessage = { type: 'shutdown' };
      worker.send(message);
      
      // Wait for graceful shutdown (5 seconds max)
      const timeout = new Promise((resolve) => setTimeout(resolve, 5000));
      await Promise.race([worker.exited, timeout]);
      
      // Force kill if still running
      if (!worker.killed) {
        console.log(`Force killing worker ${workerId}`);
        worker.kill('SIGKILL');
      }
      
      // Update worker status in database
      await this.db.updateWorkerStatus(workerId, 'dead');
    } catch (error) {
      console.error(`Error shutting down worker ${workerId}:`, error);
      try {
        worker.kill('SIGKILL');
      } catch {}
    }
  }

  private async distributeJobs() {
    if (!this.isRunning) return;

    try {
      const availableWorkers = Array.from(this.workers.entries())
        .filter(([_, worker]) => !worker.killed);

      if (availableWorkers.length === 0) {
        return;
      }

      // Check if there are pending jobs
      const pendingJobsCount = await this.db.db.select({ count: sql<number>`count(*)` })
        .from(jobQueue)
        .where(
          and(
            eq(jobQueue.status, 'pending'),
            sql`${jobQueue.scheduledAt} <= unixepoch()`
          )
        );
      
      if (!pendingJobsCount[0] || pendingJobsCount[0].count === 0) {
        return;
      }

      // Signal workers to check for jobs (they'll claim atomically)
      for (const [workerId, worker] of availableWorkers) {
        const message: WorkerMessage = { type: 'process' };
        
        try {
          worker.send(message);
        } catch (error) {
          console.error(`Failed to signal worker ${workerId}:`, error);
        }
      }
    } catch (error) {
      console.error('Job distribution error:', error);
    }
  }

  async processArchivalBatch() {
    const archivedCount = await this.db.archiveOldDocuments();
    console.log(`Archived ${archivedCount} documents`);
    
    for (let i = 0; i < archivedCount; i++) {
      await this.db.createJob({
        documentId: '',
        type: 'archive',
        priority: -1,
      });
    }
  }
}
import { DatabaseService } from './database';
import { sql } from 'drizzle-orm';

interface WorkerInitMessage {
  type: 'init';
  env: Record<string, string>;
  workerId: string;
}

interface WorkerProcessMessage {
  type: 'process';
}

interface WorkerShutdownMessage {
  type: 'shutdown';
}

type WorkerMessage = WorkerInitMessage | WorkerProcessMessage | WorkerShutdownMessage;

interface WorkerReadyResponse {
  type: 'ready';
  workerId: string;
}

interface WorkerCompletedResponse {
  type: 'completed';
  jobId: string;
}

interface WorkerFailedResponse {
  type: 'failed';
  jobId: string;
  error: string;
}

interface WorkerErrorResponse {
  type: 'error';
  error: string;
}

type WorkerResponse = WorkerReadyResponse | WorkerCompletedResponse | WorkerFailedResponse | WorkerErrorResponse;

export class JobProcessorWorker {
  private db: DatabaseService;
  private workers: Map<string, Worker> = new Map();
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
    this.workerPath = new URL('../workers/job-worker-thread.ts', import.meta.url).pathname;
  }

  async start(intervalMs = 5000) {
    if (this.isRunning) return;
    
    this.isRunning = true;
    
    await this.spawnWorkers();
    
    this.interval = setInterval(async () => {
      await this.distributeJobs();
    }, intervalMs);
    
    this.cleanupInterval = setInterval(async () => {
      await this.db.cleanupOrphanedJobs();
    }, 60000);
    
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
      await Bun.sleep(100);
    }
  }

  private async spawnWorker(workerId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(this.workerPath);
      
      const handleMessage = (event: MessageEvent<WorkerResponse>) => {
        this.handleWorkerMessage(workerId, event.data);
        
        if (event.data.type === 'ready') {
          resolve();
        }
      };
      
      const handleError = (error: ErrorEvent) => {
        console.error(`Worker ${workerId} error:`, error.message);
        reject(error);
      };
      
      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      
      this.workers.set(workerId, worker);
      
      const initMessage: WorkerInitMessage = {
        type: 'init',
        env: process.env as Record<string, string>,
        workerId,
      };
      
      worker.postMessage(initMessage);
    });
  }

  private handleWorkerMessage(workerId: string, message: WorkerResponse) {
    switch (message.type) {
      case 'ready':
        console.log(`Worker ${workerId} is ready`);
        break;
      case 'completed':
        console.log(`Worker ${workerId} completed job ${message.jobId}`);
        break;
      case 'failed':
        console.error(`Worker ${workerId} failed job ${message.jobId}: ${message.error}`);
        break;
      case 'error':
        console.error(`Worker ${workerId} error: ${message.error}`);
        break;
    }
  }

  private async shutdownWorker(workerId: string, worker: Worker) {
    console.log(`Shutting down worker ${workerId}...`);
    
    try {
      const message: WorkerShutdownMessage = { type: 'shutdown' };
      worker.postMessage(message);
      
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 5000);
        
        worker.addEventListener('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
      
      worker.terminate();
    } catch (error) {
      console.error(`Error shutting down worker ${workerId}:`, error);
      worker.terminate();
    }
  }

  private async distributeJobs() {
    if (!this.isRunning) return;

    try {
      const availableWorkers = Array.from(this.workers.entries());

      if (availableWorkers.length === 0) {
        return;
      }

      const pendingJobsCount = await this.db.db.get<{ count: number }>(
        sql`SELECT COUNT(*) as count FROM job_queue 
            WHERE status = 'pending' 
            AND scheduled_at <= unixepoch()`
      );
      
      if (!pendingJobsCount || pendingJobsCount.count === 0) {
        return;
      }

      for (const [workerId, worker] of availableWorkers) {
        const message: WorkerProcessMessage = { type: 'process' };
        
        try {
          worker.postMessage(message);
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

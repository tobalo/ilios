import { DatabaseService } from './database';
import { Subprocess } from 'bun';
import * as os from 'os';

interface WorkerMessage {
  type: 'process' | 'shutdown';
  jobId?: string;
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
    
    // Spawn worker processes
    await this.spawnWorkers();
    
    // Start job distribution
    this.interval = setInterval(async () => {
      await this.distributeJobs();
    }, intervalMs);
    
    // Initial job distribution
    await this.distributeJobs();
  }

  async stop() {
    this.isRunning = false;
    
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    
    // Shutdown all workers
    for (const [id, worker] of this.workers) {
      await this.shutdownWorker(id, worker);
    }
    
    this.workers.clear();
  }

  private async spawnWorkers() {
    for (let i = 0; i < this.workerCount; i++) {
      await this.spawnWorker(`worker-${i}`);
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
      stdin: 'pipe',
    });

    this.workers.set(workerId, worker);

    // Register worker in database
    await this.db.registerWorker(workerId, worker.pid!, os.hostname());

    // Handle worker output
    this.handleWorkerOutput(workerId, worker);

    // Handle worker errors
    worker.exited.then(async (exitCode) => {
      console.error(`Worker ${workerId} exited with code ${exitCode}`);
      this.workers.delete(workerId);
      
      // Mark worker as dead in database
      await this.db.updateWorkerStatus(workerId, 'dead');
      
      // Respawn worker if still running
      if (this.isRunning) {
        setTimeout(() => this.spawnWorker(workerId), 5000);
      }
    });
  }

  private async handleWorkerOutput(workerId: string, worker: Subprocess) {
    const reader = worker.stdout.getReader();
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
          
          try {
            const response: WorkerResponse = JSON.parse(line);
            
            if (response.type === 'ready') {
              console.log(`Worker ${workerId} is ready`);
            } else if (response.type === 'completed') {
              console.log(`Worker ${workerId} completed job ${response.jobId}`);
            } else if (response.type === 'failed') {
              console.error(`Worker ${workerId} failed job ${response.jobId}: ${response.error}`);
            }
          } catch (error) {
            console.log(`Worker ${workerId} output:`, line);
          }
        }
      }
    } catch (error) {
      console.error(`Error reading worker ${workerId} output:`, error);
    }
  }

  private async shutdownWorker(workerId: string, worker: Subprocess) {
    const message: WorkerMessage = { type: 'shutdown' };
    worker.stdin.write(JSON.stringify(message) + '\n');
    worker.stdin.end();
    
    // Give worker time to shutdown gracefully
    await Bun.sleep(1000);
    
    if (!worker.killed) {
      worker.kill();
    }
  }

  private async distributeJobs() {
    if (!this.isRunning) return;

    try {
      // Get available workers
      const availableWorkers = Array.from(this.workers.entries())
        .filter(([_, worker]) => !worker.killed);

      if (availableWorkers.length === 0) {
        console.warn('No available workers');
        return;
      }

      // Get pending jobs up to the number of available workers
      const jobs = await this.db.getNextJobs(availableWorkers.length);
      
      for (let i = 0; i < jobs.length && i < availableWorkers.length; i++) {
        const job = jobs[i];
        const [workerId, worker] = availableWorkers[i];
        
        console.log(`Assigning job ${job.id} to worker ${workerId}`);
        
        const message: WorkerMessage = { 
          type: 'process', 
          jobId: job.id 
        };
        
        worker.stdin.write(JSON.stringify(message) + '\n');
        worker.stdin.flush();
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
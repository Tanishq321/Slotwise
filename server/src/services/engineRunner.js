import { Worker } from 'node:worker_threads';

/** Runs the engine in a separate thread and resolves with its result. */
export function runEngine(problem, options, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./engineThread.js', import.meta.url), { workerData: { problem, options } });
    let done = false;
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress?.(msg.progress);
      if (msg.type === 'result') {
        done = true;
        resolve(msg.result);
      }
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      if (!done) reject(new Error(`Engine thread stopped unexpectedly (exit code ${code})`));
    });
  });
}

/** Turn engine progress into a single 0–100 number for the progress bar. */
export function toPercent(p) {
  if (p.phase === 'construct') return Math.round((p.placed / Math.max(1, p.total)) * 30);
  if (p.phase === 'optimise') return 30 + Math.round(p.progress * 68);
  if (p.phase === 'done') return 99;
  return 0;
}

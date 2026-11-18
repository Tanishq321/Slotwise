// Runs inside a worker thread. The solver is CPU-heavy and synchronous; running it
// here keeps the main event loop free, so the API keeps answering requests while a
// timetable is being generated.
import { parentPort, workerData } from 'node:worker_threads';
import { generate } from '@slotwise/engine';

const { problem, options } = workerData;
const result = generate(problem, {
  ...options,
  onProgress: (p) => parentPort.postMessage({ type: 'progress', progress: p }),
});
parentPort.postMessage({ type: 'result', result });

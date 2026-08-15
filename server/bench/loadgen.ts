/**
 * Load generator child process.
 *
 * Runs as its own process so the parent can pin it to an arbitrary set of
 * logical CPUs before any work starts. Windows affinity is a per-process
 * property, so the mask set by the parent constrains every worker thread
 * spawned here — that is what makes "test only these cores" work.
 *
 * Protocol: the parent writes a line to stdin to start. Waiting for that
 * handshake guarantees affinity is already applied when the load begins,
 * rather than racing the first few hundred milliseconds of the run.
 */

const threads = Number(process.argv[2] ?? 1);
const durationMs = Number(process.argv[3] ?? 10_000);

const workers: Worker[] = [];
for (let i = 0; i < threads; i++) {
  workers.push(new Worker(new URL('./worker.ts', import.meta.url).href));
}

let finished = 0;
for (const w of workers) {
  w.onmessage = () => {
    if (++finished === workers.length) {
      for (const x of workers) x.terminate();
      console.log(JSON.stringify({ done: true, threads, durationMs }));
      process.exit(0);
    }
  };
}

// Wait for the go-ahead from the parent.
for await (const _line of console) {
  break;
}

console.log(JSON.stringify({ started: true, threads }));
for (const w of workers) w.postMessage({ cmd: 'start', durationMs });

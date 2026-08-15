/// <reference lib="webworker" />
/**
 * One load-generator thread. Runs a mixed integer/floating-point loop that is
 * heavy enough to pull the core to its power limit, unlike a bare spin loop
 * which leaves the vector units idle and understates real-world draw.
 *
 * The result is accumulated and reported so the JIT cannot eliminate the work
 * as dead code.
 */

// Reach the worker scope through globalThis rather than declaring `self`,
// which collides with the DOM lib's own declaration.
const ctx = globalThis as unknown as {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage: (message: unknown) => void;
};

let running = false;

function burn(until: number): number {
  let acc = 0;
  // Chunked so we can check the clock without checking it every iteration.
  while (performance.now() < until) {
    for (let i = 0; i < 200_000; i++) {
      acc += Math.sqrt(i * 1.0000001) * Math.sin(i) + (i ^ (acc | 0));
    }
  }
  return acc;
}

ctx.onmessage = (ev: MessageEvent) => {
  const msg = ev.data as { cmd: string; durationMs?: number };
  if (msg.cmd === 'start' && !running) {
    running = true;
    const until = performance.now() + (msg.durationMs ?? 10_000);
    const acc = burn(until);
    running = false;
    ctx.postMessage({ done: true, acc });
  }
};

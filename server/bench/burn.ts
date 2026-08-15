/**
 * One load-generator thread, as its own process.
 *
 * Runs a mixed integer/floating-point loop that is heavy enough to pull the
 * core to its power limit, unlike a bare spin loop which leaves the vector
 * units idle and understates real-world draw. The result is accumulated and
 * printed so the JIT cannot eliminate the work as dead code.
 *
 * A process rather than a Worker because the compiled single-file build cannot
 * spawn Workers: `new Worker(new URL('./worker.ts', import.meta.url))` resolves
 * against a bundle path that has no module behind it, and the executable
 * cannot be handed a .ts file to run either. Processes work identically in
 * both builds, and Windows hands each child the parent's affinity mask, so
 * pinning the load generator still pins every thread of load it creates.
 */

export function burn(durationMs: number): number {
  const until = performance.now() + durationMs;
  let acc = 0;
  // Chunked so we can check the clock without checking it every iteration.
  while (performance.now() < until) {
    for (let i = 0; i < 200_000; i++) {
      acc += Math.sqrt(i * 1.0000001) * Math.sin(i) + (i ^ (acc | 0));
    }
  }
  return acc;
}

export function burnMain(args: string[]): void {
  const durationMs = Number(args[0] ?? 10_000);
  const acc = burn(durationMs);
  console.log(JSON.stringify({ done: true, acc }));
}

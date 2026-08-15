/**
 * Load generator, run as its own process.
 *
 * The process boundary is the point: Windows affinity is a per-process
 * property, so the parent pins this process before any work starts and every
 * burn child spawned from here inherits that mask. That is what makes "test
 * only these cores" mean it.
 *
 * Protocol: the server writes a line to stdin to start. Waiting for that
 * handshake guarantees affinity is already applied before the load begins,
 * rather than racing the first few hundred milliseconds of the run.
 */
import { selfCommand } from '../assets.ts';

export async function loadgenMain(args: string[]): Promise<void> {
  const threads = Number(args[0] ?? 1);
  const durationMs = Number(args[1] ?? 10_000);

  // Wait for the go-ahead from the server.
  for await (const _line of console) {
    break;
  }

  const children = Array.from({ length: threads }, () =>
    Bun.spawn(selfCommand(['--burn', String(durationMs)]), {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    }),
  );

  console.log(JSON.stringify({ started: true, threads }));

  // If we are killed, take the load with us rather than leaving the machine
  // pinned at 100% by orphans.
  const killAll = () => {
    for (const c of children) {
      try {
        c.kill();
      } catch {
        /* already gone */
      }
    }
  };
  process.on('SIGTERM', killAll);
  process.on('SIGINT', killAll);
  process.on('exit', killAll);

  await Promise.all(children.map((c) => c.exited));
  console.log(JSON.stringify({ done: true, threads, durationMs }));
}

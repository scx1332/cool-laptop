/**
 * Starts a pinned load-generator process.
 *
 * Shared by the benchmark runner and the clock calibration, which both need
 * exactly the same dance: spawn, pin, release the handshake. Pinning before
 * the handshake is what guarantees no work happens off-mask.
 */
import { selfCommand } from '../assets.ts';
import { affinityMask } from '../topology.ts';
import { setProcessAffinity } from './affinity.ts';

export async function spawnLoadgen(
  cpus: number[],
  threads: number,
  durationMs: number,
): Promise<Bun.Subprocess<'pipe', 'pipe', 'pipe'>> {
  const proc = Bun.spawn(selfCommand(['--loadgen', String(threads), String(durationMs)]), {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

  await setProcessAffinity(proc.pid, affinityMask(cpus));
  proc.stdin.write('go\n');
  proc.stdin.flush();
  return proc;
}

import { resolve } from 'node:path';
import { config } from '../config.ts';
import { readSettings } from '../control/powercfg.ts';
import { saveRun } from '../db.ts';
import { telemetry } from '../telemetry/poller.ts';
import { affinityMask, getTopology } from '../topology.ts';
import type { BenchRequest, BenchResult } from '../types.ts';
import { setProcessAffinity } from './affinity.ts';

/** Power and clocks take a moment to settle after a workload starts; ignoring
 *  the ramp keeps the averages representative of the steady state. */
const RAMP_MS = 3000;

export interface RunProgress {
  phase: 'starting' | 'running' | 'finishing' | 'done' | 'error';
  message: string;
  runId?: number;
  result?: BenchResult;
}

let active: { proc: Bun.Subprocess; kind: string } | null = null;

export function isRunning(): boolean {
  return active !== null;
}

export function cancelRun(): boolean {
  if (!active) return false;
  active.proc.kill();
  return true;
}

/** Parses the total rating out of `7z b` output.
 *  The trailing "Tot:" line ends with the overall rating in MIPS. */
export function parseSevenZipScore(output: string): number | null {
  const line = output
    .split(/\r?\n/)
    .reverse()
    .find((l) => /^\s*Tot:/.test(l));
  if (!line) return null;
  const nums = line.match(/\d+/g);
  if (!nums || nums.length === 0) return null;
  return Number(nums[nums.length - 1]);
}

export async function runBenchmark(
  req: BenchRequest,
  onProgress: (p: RunProgress) => void,
  schemeGuid: string,
): Promise<BenchResult> {
  if (active) throw new Error('a benchmark is already running');

  const topo = await getTopology();
  const cpus = req.cpus?.length ? [...req.cpus].sort((a, b) => a - b) : topo.cores.map((c) => c.id);
  const invalid = cpus.filter((c) => c < 0 || c >= topo.logicalCount);
  if (invalid.length) throw new Error(`invalid cpu ids: ${invalid.join(', ')}`);

  const mask = affinityMask(cpus);
  const threads = req.threads && req.threads > 0 ? req.threads : cpus.length;
  const settings = await readSettings(schemeGuid);

  onProgress({ phase: 'starting', message: `preparing ${req.kind} on CPUs ${cpus.join(',')}` });

  // Snapshot how busy the machine already is. A benchmark run on a laptop that
  // is also indexing, scanning, or rendering a browser tab is not comparable
  // with one taken on an idle machine, and the difference is large enough to
  // invert conclusions.
  const pre = telemetry.history.slice(-5);
  const baselineUtil = round(mean(pre.map((s) => s.avgUtil)), 1);
  const baselineW = round(mean(pre.map((s) => s.power.pkg)), 2);
  if (baselineUtil > 15) {
    onProgress({
      phase: 'starting',
      message: `warning: machine is already ${baselineUtil}% busy (${baselineW} W) — results will be noisy`,
    });
  }

  const startedAt = Date.now();
  let output = '';
  let score: number | null = null;
  let scoreUnit = '';

  try {
    if (req.kind === '7zip') {
      const dict = req.dictLog2 ?? 22;
      const proc = Bun.spawn(
        [config.sevenZip, 'b', `-mmt=${threads}`, `-md=${dict}`],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
      );
      active = { proc, kind: req.kind };
      await setProcessAffinity(proc.pid, mask);
      onProgress({ phase: 'running', message: `7-Zip benchmark, ${threads} threads, dict 2^${dict}` });

      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output = out + (err ? `\n[stderr]\n${err}` : '');
      score = parseSevenZipScore(output);
      scoreUnit = 'MIPS';
    } else {
      const durationMs = (req.durationSec ?? 20) * 1000;
      const script = resolve(config.root, 'server', 'bench', 'loadgen.ts');
      // process.execPath, not "bun": on Windows `bun` on PATH is a .cmd shim
      // that launches the real binary as a child. Affinity set on the shim
      // does not reach that child, so the load silently escapes the mask.
      const proc = Bun.spawn(
        [process.execPath, script, String(threads), String(durationMs)],
        { stdout: 'pipe', stderr: 'pipe', stdin: 'pipe' },
      );
      active = { proc, kind: req.kind };

      // Pin first, then release the handshake, so no work happens off-mask.
      await setProcessAffinity(proc.pid, mask);
      proc.stdin.write('go\n');
      proc.stdin.flush();

      onProgress({
        phase: 'running',
        message: `load generator, ${threads} threads for ${durationMs / 1000}s`,
      });

      const [out, err] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      output = out + (err ? `\n[stderr]\n${err}` : '');
      scoreUnit = 'n/a';
    }
  } finally {
    active = null;
  }

  const finishedAt = Date.now();
  onProgress({ phase: 'finishing', message: 'aggregating telemetry' });

  const window = telemetry.window(startedAt + RAMP_MS, finishedAt);
  const usable = window.length ? window : telemetry.window(startedAt, finishedAt);

  const pkgSeries = usable.map((s) => s.power.pkg);
  const avgPkgW = mean(pkgSeries);
  const maxPkgW = pkgSeries.length ? Math.max(...pkgSeries) : 0;

  // Average clock across only the cores under test — averaging idle cores in
  // would drag the number down and make comparisons meaningless.
  const selected = new Set(cpus);
  const avgMhz = mean(
    usable.flatMap((s) => s.cpus.filter((c) => selected.has(c.id)).map((c) => c.mhz)),
  );

  const result: Omit<BenchResult, 'id'> = {
    kind: req.kind,
    startedAt,
    finishedAt,
    cpus,
    threads,
    affinityMask: mask,
    score,
    scoreUnit,
    avgPkgW: round(avgPkgW, 2),
    maxPkgW: round(maxPkgW, 2),
    avgMhz: Math.round(avgMhz),
    efficiency: score && avgPkgW > 0 ? round(score / avgPkgW, 1) : null,
    baselineUtil,
    baselineW,
    settings,
    output,
  };

  const id = saveRun(result);
  const full: BenchResult = { ...result, id };
  onProgress({ phase: 'done', message: 'benchmark complete', runId: id, result: full });
  return full;
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

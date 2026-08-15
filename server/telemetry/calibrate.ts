import { resolve } from 'node:path';
import { setProcessAffinity } from '../bench/affinity.ts';
import { config } from '../config.ts';
import { keeper } from '../control/keeper.ts';
import { applySettings, readSettings, setClassValue } from '../control/powercfg.ts';
import { kvSet } from '../db.ts';
import { affinityMask, getTopology } from '../topology.ts';
import type { EffClass } from '../types.ts';
import { setCalibration, telemetry, type Calibration } from './poller.ts';

/**
 * Derives the reference base clock for each efficiency class.
 *
 * The "% Processor Performance" counter reports a percentage of each core's
 * nominal frequency, and that nominal differs between P and E cores. Windows
 * does not expose the per-class value anywhere readable — Win32_Processor and
 * the registry both report a single flat number for all cores, and the
 * "Processor Frequency" counter is stuck at nominal.
 *
 * So we measure it: clamp a class to a known frequency, saturate it, and read
 * back the percentage. Since the cap is enforced in hardware, the cores sit at
 * the cap, and base = knownCapMhz / (measuredPercent / 100).
 */

const CAL_CAP_MHZ = 1500;
const SETTLE_MS = 5000;
const MEASURE_MS = 4000;

async function loadCores(cpus: number[], durationMs: number): Promise<Bun.Subprocess> {
  const script = resolve(config.root, 'server', 'bench', 'loadgen.ts');
  // See runner.ts: must be the real binary, not the PATH shim, or affinity
  // is applied to a wrapper process and the load escapes onto every core.
  const proc = Bun.spawn([process.execPath, script, String(cpus.length), String(durationMs)], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  });
  await setProcessAffinity(proc.pid, affinityMask(cpus));
  proc.stdin.write('go\n');
  proc.stdin.flush();
  return proc;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function measureClass(
  scheme: string,
  cls: EffClass,
  cpus: number[],
): Promise<number> {
  const { activate } = await import('../control/powercfg.ts');

  // The platform wipes the cap within about ten seconds, so a single write
  // before a nine-second measurement is a coin flip — that is what produced a
  // nonsense 693 MHz base on an earlier run. Re-assert throughout.
  const assert = async () => {
    await setClassValue(scheme, cls, 'freqMax', CAL_CAP_MHZ);
    await setClassValue(scheme, cls, 'stateMax', 100);
    await activate(scheme);
  };
  await assert();

  const proc = await loadCores(cpus, SETTLE_MS + MEASURE_MS + 2000);
  const reassert = setInterval(() => void assert(), 2000);

  await sleep(SETTLE_MS);
  const from = Date.now();
  await sleep(MEASURE_MS);
  const samples = telemetry.window(from, Date.now());

  clearInterval(reassert);
  proc.kill();

  const wanted = new Set(cpus);
  const perfs = samples.flatMap((s) =>
    s.cpus.filter((c) => wanted.has(c.id) && c.util > 50).map((c) => c.perf),
  );
  if (perfs.length < 3) {
    throw new Error(`calibration for class ${cls} collected too few samples (${perfs.length})`);
  }

  const meanPerf = perfs.reduce((a, b) => a + b, 0) / perfs.length;
  if (meanPerf <= 1) throw new Error(`calibration for class ${cls} read implausible perf ${meanPerf}`);

  const base = Math.round(CAL_CAP_MHZ / (meanPerf / 100));
  console.log(
    `[calibrate] class ${cls}: ${perfs.length} readings across ${samples.length} samples, ` +
      `mean perf ${meanPerf.toFixed(1)}% at a ${CAL_CAP_MHZ} MHz cap -> base ${base} MHz`,
  );
  return base;
}

export async function calibrate(scheme: string): Promise<Calibration> {
  const topo = await getTopology();
  const before = await readSettings(scheme);
  // The keeper would re-assert the user's caps on top of the calibration cap.
  keeper.suspend();

  try {
    const pBaseMhz = await measureClass(scheme, 1, topo.pCpus);
    const eBaseMhz = topo.eCpus.length ? await measureClass(scheme, 0, topo.eCpus) : pBaseMhz;

    const cal: Calibration = { pBaseMhz, eBaseMhz, calibratedAt: Date.now() };
    setCalibration(cal);
    kvSet('calibration', cal);
    return cal;
  } finally {
    // Always put the machine back the way we found it, even if a measurement
    // threw partway through.
    await applySettings(scheme, before);
    keeper.resume();
  }
}

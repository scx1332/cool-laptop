import { killTree } from '../bench/affinity.ts';
import { spawnLoadgen } from '../bench/spawn.ts';
import { keeper } from '../control/keeper.ts';
import { applySettings, readSettings, setClassValue } from '../control/powercfg.ts';
import { kvSet } from '../db.ts';
import { getTopology } from '../topology.ts';
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
 * So we measure it. The obvious method — clamp a class to a known frequency,
 * saturate it, and take base = capMhz / (percent / 100) — is wrong, because
 * the cores do not actually sit at the cap. Measured on a 12800H:
 *
 *   P class:  cap 1200 -> 61.1%   cap 1500 -> 77.8%   cap 1800 -> 94.4%
 *   E class:  cap 1200 -> 64.3%   cap 1500 -> 85.7%   cap 1800 -> 100.0%
 *
 * P-cores land one 100 MHz bin below the request, and the E cap is scaled by
 * the platform so E-cores land ~25% low. Both offsets are baked straight into
 * a single-point ratio, which is what produced a 1928/1750 pair (and E-core
 * clocks reading above P-core clocks, and above the part's E turbo ceiling).
 *
 * The offsets are constant, so measuring two caps and taking the *slope*
 * cancels them exactly:
 *
 *   base = 100 * (capHi - capLo) / (percentHi - percentLo)
 *
 * On the numbers above that yields 1796 and 1402 — 1800 and 1400 once snapped
 * to the 100 MHz bus multiple that every reading quantises to.
 */

/** Two caps low enough to bind on both classes, far enough apart for the
 *  difference to survive a tenth-of-a-percent counter resolution. */
const CAL_CAPS_MHZ = [1200, 1500] as const;
const SETTLE_MS = 5000;
const MEASURE_MS = 4000;
/** Bases are bus-clock multiples; readings land on exact 100 MHz bins. */
const BIN_MHZ = 100;
/** Anything outside this is a failed measurement, not a real reference clock. */
const MIN_BASE_MHZ = 800;
const MAX_BASE_MHZ = 4000;

async function loadCores(cpus: number[], durationMs: number): Promise<Bun.Subprocess> {
  return spawnLoadgen(cpus, cpus.length, durationMs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Median rather than mean: a couple of ramp-up or thermally-limited readings
 *  drag a mean down, and a low percentage inflates the derived base. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Saturates a class at one known cap and returns the median reported
 *  percentage. The absolute value is not trusted — only the difference
 *  between two of these is. */
async function measureAtCap(
  scheme: string,
  cls: EffClass,
  cpus: number[],
  capMhz: number,
): Promise<number> {
  const { activate } = await import('../control/powercfg.ts');

  // The platform wipes the cap within about ten seconds, so a single write
  // before a nine-second measurement is a coin flip — that is what produced a
  // nonsense 693 MHz base on an earlier run. Re-assert throughout.
  const assert = async () => {
    await setClassValue(scheme, cls, 'freqMax', capMhz);
    await setClassValue(scheme, cls, 'stateMax', 100);
    await activate(scheme);
  };
  await assert();

  const proc = await loadCores(cpus, SETTLE_MS + MEASURE_MS + 2000);
  const pid = proc.pid;
  const reassert = setInterval(() => void assert(), 2000);

  await sleep(SETTLE_MS);
  const from = Date.now();
  await sleep(MEASURE_MS);
  const samples = telemetry.window(from, Date.now());

  clearInterval(reassert);
  await killTree(pid);

  const wanted = new Set(cpus);
  // The threshold only has to separate "running the burner" from "idle".
  // "% Processor Utility" is work-normalised, so a saturated core capped well
  // below nominal reports far less than 100 — a core held at 1200 MHz against
  // a 2400 MHz nominal reads 50, and the old threshold of 50 discarded exactly
  // the readings the calibration exists to take.
  const perfs = samples.flatMap((s) =>
    s.cpus.filter((c) => wanted.has(c.id) && c.util > 20).map((c) => c.perf),
  );
  if (perfs.length < 3) {
    throw new Error(
      `calibration for class ${cls} at ${capMhz} MHz collected too few samples (${perfs.length})`,
    );
  }

  const perf = median(perfs);
  if (perf <= 1) {
    throw new Error(`calibration for class ${cls} read implausible perf ${perf} at ${capMhz} MHz`);
  }

  console.log(
    `[calibrate] class ${cls} at ${capMhz} MHz cap: ${perfs.length} readings across ` +
      `${samples.length} samples, median perf ${perf.toFixed(1)}%`,
  );
  return perf;
}

async function measureClass(scheme: string, cls: EffClass, cpus: number[]): Promise<number> {
  const [capLo, capHi] = CAL_CAPS_MHZ;
  const perfLo = await measureAtCap(scheme, cls, cpus, capLo);
  const perfHi = await measureAtCap(scheme, cls, cpus, capHi);

  const dPerf = perfHi - perfLo;
  // A cap that never bound, or one the platform wiped, shows up as two nearly
  // identical readings — and dividing by that noise yields any number at all.
  if (dPerf < 1) {
    throw new Error(
      `calibration for class ${cls} saw no response to the cap ` +
        `(${perfLo.toFixed(1)}% at ${capLo} MHz vs ${perfHi.toFixed(1)}% at ${capHi} MHz)`,
    );
  }

  const raw = (100 * (capHi - capLo)) / dPerf;
  const base = Math.round(raw / BIN_MHZ) * BIN_MHZ;
  if (base < MIN_BASE_MHZ || base > MAX_BASE_MHZ) {
    throw new Error(`calibration for class ${cls} derived an implausible base of ${base} MHz`);
  }

  console.log(
    `[calibrate] class ${cls}: slope over ${capLo}->${capHi} MHz is ` +
      `${dPerf.toFixed(1)} points -> base ${raw.toFixed(0)} MHz, snapped to ${base}`,
  );
  return base;
}

export async function calibrate(scheme: string): Promise<Calibration> {
  const topo = await getTopology();
  const before = await readSettings(scheme);
  // The keeper would re-assert the user's caps on top of the calibration cap.
  keeper.suspend();
  // Each class is measured over a four-second window, so the idle one-minute
  // cadence would collect nothing at all to average.
  const release = telemetry.hold('calibration');
  await telemetry.settled();

  try {
    const pBaseMhz = await measureClass(scheme, 1, topo.pCpus);
    const eBaseMhz = topo.eCpus.length ? await measureClass(scheme, 0, topo.eCpus) : pBaseMhz;

    // No Intel hybrid part clocks its E cores off a higher reference than its
    // P cores. If the measurement says otherwise it is wrong, and shipping it
    // means the UI draws E-core clocks above P-core clocks — the exact symptom
    // the slope method exists to prevent.
    if (eBaseMhz > pBaseMhz) {
      throw new Error(
        `calibration derived an E base (${eBaseMhz} MHz) above the P base (${pBaseMhz} MHz)`,
      );
    }

    const cal: Calibration = { pBaseMhz, eBaseMhz, calibratedAt: Date.now() };
    setCalibration(cal);
    kvSet('calibration', cal);
    return cal;
  } finally {
    // Always put the machine back the way we found it, even if a measurement
    // threw partway through.
    await applySettings(scheme, before);
    keeper.resume();
    release();
  }
}

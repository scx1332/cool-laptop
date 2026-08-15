import { resolve } from 'node:path';
import { config } from '../config.ts';
import { kvGet } from '../db.ts';
import { getTopology } from '../topology.ts';
import type { CpuSample, Sample } from '../types.ts';

/** Per-class reference clock used to turn "% Processor Performance" into MHz.
 *  The counter is a percentage of each core's nominal base, and that base
 *  differs between P and E cores — which is why a naive single multiplier
 *  reports impossible E-core clocks. Calibration overwrites these. */
export interface Calibration {
  pBaseMhz: number;
  eBaseMhz: number;
  calibratedAt: number | null;
}

export const DEFAULT_CALIBRATION: Calibration = {
  pBaseMhz: 2400,
  eBaseMhz: 1400,
  calibratedAt: null,
};

let calibration: Calibration = { ...DEFAULT_CALIBRATION };

export function getCalibration(): Calibration {
  return calibration;
}

export function setCalibration(c: Calibration): void {
  calibration = c;
}

export function loadCalibration(): void {
  const stored = kvGet<Calibration>('calibration');
  if (stored) calibration = stored;
}

type Listener = (s: Sample) => void;

export class Telemetry {
  private proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
  private listeners = new Set<Listener>();
  private pCpuSet = new Set<number>();
  latest: Sample | null = null;
  /** Rolling window for the governor and benchmark aggregation. */
  history: Sample[] = [];
  private maxHistory = 900;

  async start(): Promise<void> {
    if (this.proc) return;
    const topo = await getTopology();
    this.pCpuSet = new Set(topo.pCpus);

    const script = resolve(config.root, 'server', 'telemetry', 'sidecar.ps1');
    this.proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-IntervalMs',
        String(config.sampleIntervalMs),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    ) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>;

    void this.pump();
    void this.drainErrors();
  }

  private async drainErrors(): Promise<void> {
    if (!this.proc?.stderr) return;
    const text = await new Response(this.proc.stderr).text();
    if (text.trim()) console.error('[telemetry sidecar]', text.trim());
  }

  private async pump(): Promise<void> {
    if (!this.proc?.stdout) return;
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          this.handleLine(JSON.parse(line));
        } catch (e) {
          console.error('[telemetry] bad line:', line.slice(0, 200), e);
        }
      }
    }
  }

  private handleLine(raw: Record<string, unknown>): void {
    if (raw.ready) return;

    const flat = raw.cpus as number[];
    const cpus: CpuSample[] = [];
    let mhzSum = 0;
    let mhzMax = 0;
    let utilSum = 0;

    // Packed 6 values per core: id, perf, util, parked, limit, flags
    for (let i = 0; i + 5 < flat.length; i += 6) {
      const id = flat[i];
      const perf = flat[i + 1];
      const base = this.pCpuSet.has(id) ? calibration.pBaseMhz : calibration.eBaseMhz;
      const mhz = Math.round((perf / 100) * base);
      const util = flat[i + 2];
      cpus.push({
        id,
        perf,
        mhz,
        util,
        parked: flat[i + 3] !== 0,
        limit: flat[i + 4],
        flags: flat[i + 5],
      });
      mhzSum += mhz;
      utilSum += util;
      if (mhz > mhzMax) mhzMax = mhz;
    }

    const sample: Sample = {
      ts: raw.t as number,
      power: {
        pkg: raw.pkg as number,
        cores: raw.pp0 as number,
        gpu: raw.pp1 as number,
        dram: raw.dram as number,
      },
      cpus,
      onAc: raw.ac === 1,
      avgMhz: cpus.length ? Math.round(mhzSum / cpus.length) : 0,
      maxMhz: mhzMax,
      avgUtil: cpus.length ? Math.round((utilSum / cpus.length) * 10) / 10 : 0,
    };

    this.latest = sample;
    this.history.push(sample);
    if (this.history.length > this.maxHistory) this.history.shift();
    for (const l of this.listeners) l(sample);
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Samples captured between two timestamps, used to attribute power draw to
   *  a benchmark run. */
  window(fromTs: number, toTs: number): Sample[] {
    return this.history.filter((s) => s.ts >= fromTs && s.ts <= toTs);
  }

  stop(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

export const telemetry = new Telemetry();

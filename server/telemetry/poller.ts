import { scriptPath } from '../assets.ts';
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

/** Placeholders until the first calibration run. The P value is the nominal
 *  Windows itself reports (Win32_Processor.MaxClockSpeed), which is the
 *  divisor the counter actually uses — not the P-core base clock from the
 *  spec sheet, which is what the 2400 here used to be and which read every
 *  P-core a third too fast. */
export const DEFAULT_CALIBRATION: Calibration = {
  pBaseMhz: 1800,
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

export interface RateState {
  /** Cadence the sidecar is actually running at, in milliseconds. */
  intervalMs: number;
  /** True while sampling every second, whether the user asked for it or
   *  something on the server did. */
  realtime: boolean;
  /** Set when realtime is forced by work in progress rather than chosen. */
  holds: string[];
  idleIntervalMs: number;
  realtimeIntervalMs: number;
}

export class Telemetry {
  private proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
  private listeners = new Set<Listener>();
  private pCpuSet = new Set<number>();
  latest: Sample | null = null;
  /** Rolling window for the governor and benchmark aggregation. */
  history: Sample[] = [];
  private maxHistory = 900;

  /** Cadence the user asked for; holds can force something faster. */
  private requestedMs = config.idleIntervalMs;
  /** Reasons the server currently needs realtime data regardless of the mode
   *  the user picked — a running benchmark, an active governor. */
  private holds = new Map<string, number>();
  /** Cadence the running sidecar was started with. */
  private activeMs = 0;
  /** Rate changes are serialised: two of them overlapping would race to spawn
   *  sidecars and leave an orphan reading counters forever. */
  private queue: Promise<void> = Promise.resolve();
  onRateChange: ((r: RateState) => void) | null = null;

  get intervalMs(): number {
    return this.holds.size > 0
      ? Math.min(this.requestedMs, config.realtimeIntervalMs)
      : this.requestedMs;
  }

  get rate(): RateState {
    return {
      intervalMs: this.activeMs || this.intervalMs,
      realtime: (this.activeMs || this.intervalMs) <= config.realtimeIntervalMs,
      holds: [...this.holds.keys()],
      idleIntervalMs: config.idleIntervalMs,
      realtimeIntervalMs: config.realtimeIntervalMs,
    };
  }

  /** Switches the cadence the user sees. Returns once the sidecar is running
   *  at the new rate. */
  async setRealtime(on: boolean): Promise<RateState> {
    this.requestedMs = on ? config.realtimeIntervalMs : config.idleIntervalMs;
    await this.applyRate();
    return this.rate;
  }

  /** Forces realtime for as long as the returned function is uncalled.
   *  Refcounted, so two overlapping holders cannot cut each other short. */
  hold(reason: string): () => void {
    this.holds.set(reason, (this.holds.get(reason) ?? 0) + 1);
    void this.applyRate();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const n = (this.holds.get(reason) ?? 1) - 1;
      if (n > 0) this.holds.set(reason, n);
      else this.holds.delete(reason);
      void this.applyRate();
    };
  }

  /** Resolves once any pending rate change has finished, so a caller that just
   *  took a hold can wait for the faster data before relying on it. */
  async settled(): Promise<void> {
    await this.queue;
  }

  /** Restarts the sidecar when the wanted cadence no longer matches the
   *  running one. The interval is a launch parameter of the PowerShell
   *  process, so changing it means replacing the process — which costs a
   *  couple of seconds of counter priming and leaves a short gap in the data.
   *  Cheaper than the alternative of polling at 1 Hz forever and throwing
   *  most of it away, which is the overhead we are trying to avoid. */
  private applyRate(): Promise<void> {
    this.queue = this.queue.then(async () => {
      const wanted = this.intervalMs;
      if (!this.proc || wanted === this.activeMs) return;
      console.log(`[telemetry] switching to ${wanted} ms sampling`);
      this.stop();
      await this.start();
      this.onRateChange?.(this.rate);
    });
    return this.queue;
  }

  async start(): Promise<void> {
    if (this.proc) return;
    const topo = await getTopology();
    this.pCpuSet = new Set(topo.pCpus);

    const interval = this.intervalMs;
    const script = await scriptPath('sidecar.ps1');
    this.proc = Bun.spawn(
      [
        'powershell.exe',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        script,
        '-IntervalMs',
        String(interval),
      ],
      { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' },
    ) as Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
    this.activeMs = interval;

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
    this.activeMs = 0;
  }
}

export const telemetry = new Telemetry();

/** Windows processor power efficiency classes as exposed by powercfg.
 *  Verified empirically on the i7-12800H: capping class 1 dropped CPU 0-11
 *  (the hyperthreaded P-cores) while CPU 12-19 kept boosting. */
export type EffClass = 0 | 1;

export const CLASS_E: EffClass = 0;
export const CLASS_P: EffClass = 1;

export interface CpuSample {
  id: number;
  /** % Processor Performance: percentage of that core's nominal base clock. */
  perf: number;
  /** Derived actual clock, using the per-class calibrated base. */
  mhz: number;
  util: number;
  parked: boolean;
  /** % Performance Limit: how much of max frequency is currently permitted. */
  limit: number;
  /** Performance Limit Flags bitmask: why the core is being held back. */
  flags: number;
}

export interface PowerSample {
  /** Whole CPU package, watts. */
  pkg: number;
  /** Cores domain (RAPL pp0), watts. */
  cores: number;
  /** Integrated GPU domain (RAPL pp1), watts. */
  gpu: number;
  dram: number;
}

export interface Sample {
  ts: number;
  power: PowerSample;
  cpus: CpuSample[];
  onAc: boolean;
  /** Package-wide aggregates, precomputed for the UI. */
  avgMhz: number;
  maxMhz: number;
  avgUtil: number;
}

export interface ClassSettings {
  /** Max frequency in MHz; 0 means unrestricted. */
  freqMax: number;
  /** Max processor state, percent. */
  stateMax: number;
  /** Min processor state, percent. */
  stateMin: number;
  /** Energy Performance Preference, 0 = performance ... 100 = efficiency. */
  epp: number;
  /** Core parking ceiling, percent of cores allowed unparked. */
  maxCores: number;
}

export interface Settings {
  p: ClassSettings;
  e: ClassSettings;
  /** Processor performance boost mode, 0 = disabled ... 6. */
  boostMode: number;
  /** System cooling policy: 0 = passive (throttle first), 1 = active (fan first). */
  coolingPolicy: number;
}

export interface GovernorState {
  enabled: boolean;
  /** Package power target in watts. */
  targetWatts: number;
  /** Frequency floor the governor will not go below, MHz. */
  floorMhz: number;
  /** Frequency ceiling, MHz. 0 = hardware max. */
  ceilingMhz: number;
  /** Last cap the governor applied, MHz. */
  currentCapMhz: number;
}

export interface BenchRequest {
  kind: '7zip' | 'loadgen';
  /** Logical CPU ids the workload may run on. */
  cpus: number[];
  /** Worker thread count; defaults to cpus.length. */
  threads?: number;
  /** Duration in seconds; loadgen only. 7-Zip runs a fixed pass count. */
  durationSec?: number;
  /** 7-Zip dictionary size exponent, e.g. 22 = 4 MB. */
  dictLog2?: number;
}

export interface BenchResult {
  id: number;
  kind: string;
  startedAt: number;
  finishedAt: number;
  cpus: number[];
  threads: number;
  affinityMask: number;
  score: number | null;
  scoreUnit: string;
  avgPkgW: number;
  maxPkgW: number;
  avgMhz: number;
  /** score / avgPkgW — the number that actually answers "cool or performant". */
  efficiency: number | null;
  /** Mean CPU utilisation in the seconds before the run started. Anything
   *  much above idle means other software was competing and the result is not
   *  comparable with a quiet-machine run. */
  baselineUtil: number;
  /** Package watts before the run started. */
  baselineW: number;
  settings: Settings;
  output: string;
}

/** Bit meanings for Performance Limit Flags, per the Windows kernel PPM. */
export const LIMIT_FLAGS: Array<[number, string]> = [
  [0x01, 'Thermal'],
  [0x02, 'Package power'],
  [0x04, 'Platform power'],
  [0x08, 'Reliability'],
  [0x10, 'Turbo unavailable'],
  [0x20, 'Turbo limited'],
  [0x40, 'Firmware'],
  [0x80, 'Domain limit'],
];

export function describeFlags(flags: number): string[] {
  return LIMIT_FLAGS.filter(([bit]) => (flags & bit) !== 0).map(([, name]) => name);
}

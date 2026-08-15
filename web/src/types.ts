export interface CoreInfo {
  id: number;
  core: number;
  effClass: number;
  parked: boolean;
  allocated: boolean;
}

export interface Topology {
  cores: CoreInfo[];
  pCpus: number[];
  eCpus: number[];
  smtGroups: Record<number, number[]>;
  logicalCount: number;
  physicalCount: number;
}

export interface CpuSample {
  id: number;
  perf: number;
  mhz: number;
  util: number;
  parked: boolean;
  limit: number;
  flags: number;
}

export interface Sample {
  ts: number;
  power: { pkg: number; cores: number; gpu: number; dram: number };
  cpus: CpuSample[];
  onAc: boolean;
  avgMhz: number;
  maxMhz: number;
  avgUtil: number;
}

export interface ClassSettings {
  freqMax: number;
  stateMax: number;
  stateMin: number;
  epp: number;
  maxCores: number;
}

export interface Settings {
  p: ClassSettings;
  e: ClassSettings;
  boostMode: number;
  coolingPolicy: number;
}

export interface GovernorState {
  enabled: boolean;
  targetWatts: number;
  floorMhz: number;
  ceilingMhz: number;
  currentCapMhz: number;
}

export interface Profile {
  id: string;
  name: string;
  description: string;
  settings: Settings;
}

export interface Calibration {
  pBaseMhz: number;
  eBaseMhz: number;
  calibratedAt: number | null;
}

export interface AppState {
  topology: Topology;
  settings: Settings;
  calibration: Calibration;
  governor: GovernorState;
  profiles: Profile[];
  latest: Sample | null;
  benchRunning: boolean;
  sampleIntervalMs: number;
  scheme: { lab: string; original: string };
}

export interface RunRow {
  id: number;
  kind: string;
  started_at: number;
  finished_at: number;
  cpus: string;
  threads: number;
  score: number | null;
  score_unit: string;
  avg_pkg_w: number;
  max_pkg_w: number;
  avg_mhz: number;
  efficiency: number | null;
  baseline_util: number;
  baseline_w: number;
  settings: string;
}

export const FLAG_NAMES: Array<[number, string]> = [
  [0x01, 'Thermal'],
  [0x02, 'Package power'],
  [0x04, 'Platform power'],
  [0x08, 'Reliability'],
  [0x10, 'Turbo unavailable'],
  [0x20, 'Turbo limited'],
  [0x40, 'Firmware'],
  [0x80, 'Domain limit'],
];

export function flagNames(flags: number): string[] {
  return FLAG_NAMES.filter(([b]) => (flags & b) !== 0).map(([, n]) => n);
}

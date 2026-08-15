import { scriptPath } from './assets.ts';

export interface CoreInfo {
  id: number;
  core: number;
  cache: number;
  effClass: number;
  group: number;
  /** Snapshot only — live parking state comes from the telemetry counter. */
  parked: boolean;
  allocated: boolean;
}

export interface Topology {
  cores: CoreInfo[];
  /** Logical CPU ids belonging to the performance cores. */
  pCpus: number[];
  /** Logical CPU ids belonging to the efficiency cores. */
  eCpus: number[];
  /** Physical core index -> logical cpu ids, for SMT-aware selection. */
  smtGroups: Record<number, number[]>;
  logicalCount: number;
  physicalCount: number;
}

let cached: Topology | null = null;

export async function getTopology(): Promise<Topology> {
  if (cached) return cached;

  const script = await scriptPath('topology.ps1');
  const proc = Bun.spawn(
    ['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`topology detection failed: ${err || out}`);

  const parsed = JSON.parse(out.trim()) as CoreInfo[];
  const cores = parsed.sort((a, b) => a.id - b.id);

  // The highest efficiency class is the performance class. Deriving it rather
  // than hardcoding keeps this correct on non-hybrid and future chips.
  const maxClass = Math.max(...cores.map((c) => c.effClass));
  const isHybrid = cores.some((c) => c.effClass !== maxClass);

  const smtGroups: Record<number, number[]> = {};
  for (const c of cores) (smtGroups[c.core] ??= []).push(c.id);

  cached = {
    cores,
    pCpus: cores.filter((c) => c.effClass === maxClass).map((c) => c.id),
    eCpus: isHybrid ? cores.filter((c) => c.effClass !== maxClass).map((c) => c.id) : [],
    smtGroups,
    logicalCount: cores.length,
    physicalCount: Object.keys(smtGroups).length,
  };
  return cached;
}

/** Builds a Windows processor affinity mask from a list of logical CPU ids. */
export function affinityMask(cpus: number[]): number {
  let mask = 0;
  for (const c of cpus) mask |= 1 << c;
  return mask >>> 0;
}

export function maskToCpus(mask: number, logicalCount: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < logicalCount; i++) if (mask & (1 << i)) out.push(i);
  return out;
}

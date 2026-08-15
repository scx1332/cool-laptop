import { config } from '../config.ts';
import type { ClassSettings, EffClass, Settings } from '../types.ts';

/** powercfg setting aliases, indexed by efficiency class.
 *  Class 0 = E-cores, class 1 = P-cores (verified via GetSystemCpuSetInformation). */
const ALIAS = {
  freqMax: ['PROCFREQMAX', 'PROCFREQMAX1'],
  stateMax: ['PROCTHROTTLEMAX', 'PROCTHROTTLEMAX1'],
  stateMin: ['PROCTHROTTLEMIN', 'PROCTHROTTLEMIN1'],
  epp: ['PERFEPP', 'PERFEPP1'],
  maxCores: ['CPMAXCORES', 'CPMAXCORES1'],
} as const;

type ClassKey = keyof typeof ALIAS;

export class PowercfgError extends Error {}

async function powercfg(...args: string[]): Promise<string> {
  const proc = Bun.spawn(['powercfg.exe', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new PowercfgError(`powercfg ${args.join(' ')} failed (${code}): ${err || out}`);
  }
  return out;
}

const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface Scheme {
  guid: string;
  name: string;
  active: boolean;
}

export async function listSchemes(): Promise<Scheme[]> {
  const out = await powercfg('/list');
  return out
    .split(/\r?\n/)
    .filter((l) => GUID_RE.test(l))
    .map((line) => {
      const guid = line.match(GUID_RE)![0];
      const name = line.match(/\(([^)]*)\)/)?.[1] ?? guid;
      return { guid, name, active: line.includes('*') };
    });
}

export async function activeScheme(): Promise<string> {
  const out = await powercfg('/getactivescheme');
  const guid = out.match(GUID_RE);
  if (!guid) throw new PowercfgError(`could not parse active scheme from: ${out}`);
  return guid[0];
}

/** Ensures a dedicated scheme exists that we own and are free to mutate, so
 *  the user's own Balanced/High Performance schemes stay pristine.
 *
 *  `rememberOriginal` is persisted by the caller. It matters on restart: by
 *  then the lab scheme is usually still active, so reading the active scheme
 *  would record the lab scheme as the thing to restore and the user's real
 *  plan would never come back. */
export async function ensureLabScheme(
  rememberedOriginal?: string | null,
): Promise<{ lab: string; original: string }> {
  const schemes = await listSchemes();
  const existing = schemes.find((s) => s.name === config.schemeName);
  const active = await activeScheme();

  // Prefer the remembered value; otherwise the active scheme, unless that is
  // already our own lab scheme, in which case fall back to Balanced.
  const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';
  let original = rememberedOriginal ?? null;
  if (!original || original === existing?.guid) {
    original = active !== existing?.guid ? active : BALANCED;
  }

  if (existing) return { lab: existing.guid, original };

  const out = await powercfg('-duplicatescheme', original);
  const guid = out.match(GUID_RE);
  if (!guid) throw new PowercfgError(`duplicatescheme returned no GUID: ${out}`);
  await powercfg('-changename', guid[0], config.schemeName, 'Managed by PowerManagement');
  return { lab: guid[0], original };
}

export async function activate(guid: string): Promise<void> {
  await powercfg('/setactive', guid);
}

/** Applies a value to both AC and DC so behaviour does not silently change
 *  when the charger is unplugged mid-experiment. */
async function setValue(scheme: string, alias: string, value: number): Promise<void> {
  await powercfg('/setacvalueindex', scheme, 'SUB_PROCESSOR', alias, String(value));
  await powercfg('/setdcvalueindex', scheme, 'SUB_PROCESSOR', alias, String(value));
}

export async function setClassValue(
  scheme: string,
  cls: EffClass,
  key: ClassKey,
  value: number,
): Promise<void> {
  await setValue(scheme, ALIAS[key][cls], value);
}

export async function setBoostMode(scheme: string, mode: number): Promise<void> {
  await setValue(scheme, 'PERFBOOSTMODE', mode);
}

/** Reads back what is actually in effect, so the UI reflects reality rather
 *  than what we last tried to write. */
export async function readSettings(scheme: string): Promise<Settings> {
  // /qh, not /query: every setting we care about (frequency caps, EPP, boost
  // mode, core parking) is marked hidden, and plain /query silently omits
  // them — which reads back as "unset" no matter what is actually applied.
  const out = await powercfg('/qh', scheme, 'SUB_PROCESSOR');
  const onAc = process.env.PM_READ_DC ? false : true;
  const wanted = onAc ? /Current AC Power Setting Index:\s*(0x[0-9a-f]+)/i
                      : /Current DC Power Setting Index:\s*(0x[0-9a-f]+)/i;

  // Walk the query output, tracking the most recent GUID alias so each
  // "Current ... Setting Index" line can be attributed to a setting.
  const values = new Map<string, number>();
  let alias: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const a = line.match(/GUID Alias:\s*(\S+)/);
    if (a) {
      alias = a[1];
      continue;
    }
    const v = line.match(wanted);
    if (v && alias) values.set(alias, parseInt(v[1], 16));
  }

  const read = (cls: EffClass): ClassSettings => ({
    freqMax: values.get(ALIAS.freqMax[cls]) ?? 0,
    stateMax: values.get(ALIAS.stateMax[cls]) ?? 100,
    stateMin: values.get(ALIAS.stateMin[cls]) ?? 5,
    epp: values.get(ALIAS.epp[cls]) ?? 50,
    maxCores: values.get(ALIAS.maxCores[cls]) ?? 100,
  });

  return {
    p: read(1),
    e: read(0),
    boostMode: values.get('PERFBOOSTMODE') ?? 2,
  };
}

/**
 * Values that are written but never varied.
 *
 * stateMax is a percentage of a moving target with a cliff at the top: 100 is
 * the only setting that permits turbo, so the first step below it costs about
 * two thirds of the clock (measured on the 12800H: 100% -> 3427 MHz, 75% ->
 * 1132 MHz), and below 20% it is dead travel against the 400 MHz floor. It is
 * a worse version of the frequency cap, which is absolute and predictable, so
 * the cap is the only ceiling the app exposes.
 *
 * stateMin stays at the stock floor. Raising it just burns power at idle.
 *
 * maxCores is core parking, which does nothing on this class of chip — held at
 * 25% with the CPU at 4% load, no core ever reported parked. Windows leaves
 * parking off on modern hybrid parts and steers work with the scheduler.
 */
const FIXED = { stateMax: 100, stateMin: 5, maxCores: 100 } as const;

/** Forces the fields the UI no longer exposes, whatever the caller passed.
 *  Applied here rather than in the client so profiles, PM_RESTORE_LAST and
 *  the API all get the same treatment. */
export function normalise(s: Settings): Settings {
  return {
    ...s,
    p: { ...s.p, ...FIXED },
    e: { ...s.e, ...FIXED },
  };
}

export async function applySettings(scheme: string, raw: Settings): Promise<void> {
  const s = normalise(raw);
  const classes: Array<[EffClass, ClassSettings]> = [
    [1, s.p],
    [0, s.e],
  ];
  for (const [cls, cs] of classes) {
    await setClassValue(scheme, cls, 'freqMax', cs.freqMax);
    await setClassValue(scheme, cls, 'stateMax', cs.stateMax);
    await setClassValue(scheme, cls, 'stateMin', cs.stateMin);
    await setClassValue(scheme, cls, 'epp', cs.epp);
    await setClassValue(scheme, cls, 'maxCores', cs.maxCores);
  }
  await setBoostMode(scheme, s.boostMode);
  await activate(scheme);
}

/** The known-safe stock configuration: everything unrestricted. */
export const STOCK: Settings = {
  p: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
  e: { freqMax: 0, stateMax: 100, stateMin: 5, epp: 50, maxCores: 100 },
  boostMode: 2,
};

/** Fast path used by the governor: only the frequency caps change, and we skip
 *  the /setactive round-trip cost where possible by batching both classes. */
export async function setFreqCaps(scheme: string, pMhz: number, eMhz: number): Promise<void> {
  await setClassValue(scheme, 1, 'freqMax', pMhz);
  await setClassValue(scheme, 0, 'freqMax', eMhz);
  await activate(scheme);
}

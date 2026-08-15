import { basename, dirname, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

/** True when running from a `bun build --compile` single-file executable.
 *  In that build there is no source tree on disk: the PowerShell sidecars are
 *  embedded and unpacked to a temp directory, the frontend is served from an
 *  embedded map, and child processes are this same binary re-invoked with a
 *  subcommand rather than `bun some/script.ts`. */
export const compiled = !/^bun(\.exe)?$/i.test(basename(process.execPath));

/** Where anything we write goes. In the compiled build `root` points inside
 *  the embedded bundle, which is not a real directory, so files live next to
 *  the executable instead. */
const dataRoot = compiled ? dirname(process.execPath) : root;

export const config = {
  root,
  dataRoot,
  compiled,
  port: Number(process.env.PM_PORT ?? 4317),

  /** Loopback only by default. The API can cap and uncap the CPU with no
   *  authentication of any kind, which is tolerable for something you start in
   *  a terminal and close again, and not tolerable for something that listens
   *  from boot. Set PM_HOST=0.0.0.0 to expose it deliberately. */
  host: process.env.PM_HOST ?? '127.0.0.1',

  /** Re-apply the settings last chosen in the UI on startup rather than waiting
   *  for a browser. This is what makes a cap survive a reboot, and it is the
   *  reason to run as a service at all — but it also means the machine comes up
   *  limited with nothing on screen saying so, so it is off unless asked for. */
  restoreLast: process.env.PM_RESTORE_LAST === '1',

  /** Telemetry cadence when nothing needs a close look. One sample a minute is
   *  enough to see where the machine is sitting and costs almost nothing: the
   *  sidecar sleeps between reads and each counter read is an average over the
   *  whole interval, so no information is lost, only resolution. */
  idleIntervalMs: Number(process.env.PM_INTERVAL_MS ?? 60_000),

  /** Cadence in realtime mode — what the UI switches to on demand, and what
   *  the governor and benchmarks force while they run because both need
   *  second-by-second data to work at all. */
  realtimeIntervalMs: Number(process.env.PM_REALTIME_MS ?? 1000),

  /** SQLite lives in RAM by default: the sample table is a rolling window that
   *  nothing outside a session reads, and writing it to disk buys nothing but
   *  wear. Set PM_DB=file (or a path) to keep a real database instead. The few
   *  values that must outlive a restart — which power scheme to restore, the
   *  clock calibration — are mirrored to a small JSON file either way. */
  dbPath: (() => {
    const v = process.env.PM_DB;
    if (!v || v === 'memory') return ':memory:';
    if (v === 'file') return resolve(dataRoot, 'data', 'power.db');
    return resolve(v);
  })(),

  /** Where kv rows are mirrored so an in-memory database still remembers the
   *  user's original power scheme across restarts. */
  statePath: process.env.PM_STATE ?? resolve(dataRoot, 'data', 'state.json'),

  /** Rows older than this are pruned on a timer. */
  retentionHours: Number(process.env.PM_RETENTION_HOURS ?? 24),

  /** Name of the dedicated powercfg scheme we mutate, so the user's own
   *  Balanced scheme is never touched. */
  schemeName: 'PowerManagement Lab',

  sevenZip: process.env.PM_7Z ?? 'C:\\Program Files\\7-Zip\\7z.exe',

  /** Safety net: if the browser disconnects and no client returns within this
   *  window while non-default limits are applied, revert to stock. Set to 0 to
   *  disable it, which a service wants — there, running unattended with limits
   *  applied is the intended state rather than a sign something was forgotten. */
  watchdogMs: Number(process.env.PM_WATCHDOG_MS ?? 5 * 60_000),
};

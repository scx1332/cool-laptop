import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');

export const config = {
  root,
  port: Number(process.env.PM_PORT ?? 4317),

  /** Telemetry cadence. 1000 ms during the test phase; raise for production
   *  use — the RAPL counters are cheap but the SQLite writes are not. */
  sampleIntervalMs: Number(process.env.PM_INTERVAL_MS ?? 1000),

  /** Set PM_DB=memory to run entirely in RAM and stop hammering the disk. */
  dbPath:
    process.env.PM_DB === 'memory'
      ? ':memory:'
      : resolve(root, 'data', 'power.db'),

  /** Rows older than this are pruned on a timer. */
  retentionHours: Number(process.env.PM_RETENTION_HOURS ?? 24),

  /** Name of the dedicated powercfg scheme we mutate, so the user's own
   *  Balanced scheme is never touched. */
  schemeName: 'PowerManagement Lab',

  sevenZip: process.env.PM_7Z ?? 'C:\\Program Files\\7-Zip\\7z.exe',

  /** Safety net: if the browser disconnects and no client returns within this
   *  window while non-default limits are applied, revert to stock. */
  watchdogMs: Number(process.env.PM_WATCHDOG_MS ?? 5 * 60_000),
};

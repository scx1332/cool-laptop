import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.ts';
import type { BenchResult, Sample, Settings } from './types.ts';

if (config.dbPath !== ':memory:') {
  mkdirSync(dirname(config.dbPath), { recursive: true });
}

export const db = new Database(config.dbPath, { create: true });

// WAL keeps sample writes from blocking readers, which matters in realtime
// mode. Irrelevant for the default in-memory database.
if (config.dbPath !== ':memory:') {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS samples (
    ts       INTEGER PRIMARY KEY,
    pkg_w    REAL NOT NULL,
    core_w   REAL NOT NULL,
    gpu_w    REAL NOT NULL,
    dram_w   REAL NOT NULL,
    avg_mhz  REAL NOT NULL,
    max_mhz  REAL NOT NULL,
    avg_util REAL NOT NULL,
    on_ac    INTEGER NOT NULL,
    cpus     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bench_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    kind          TEXT NOT NULL,
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER NOT NULL,
    cpus          TEXT NOT NULL,
    threads       INTEGER NOT NULL,
    affinity_mask INTEGER NOT NULL,
    score         REAL,
    score_unit    TEXT NOT NULL,
    avg_pkg_w     REAL NOT NULL,
    max_pkg_w     REAL NOT NULL,
    avg_mhz       REAL NOT NULL,
    efficiency    REAL,
    baseline_util REAL NOT NULL DEFAULT 0,
    baseline_w    REAL NOT NULL DEFAULT 0,
    settings      TEXT NOT NULL,
    output        TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS kv (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL
  );
`);

const insertSample = db.prepare(`
  INSERT OR REPLACE INTO samples
    (ts, pkg_w, core_w, gpu_w, dram_w, avg_mhz, max_mhz, avg_util, on_ac, cpus)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveSample(s: Sample): void {
  insertSample.run(
    s.ts,
    s.power.pkg,
    s.power.cores,
    s.power.gpu,
    s.power.dram,
    s.avgMhz,
    s.maxMhz,
    s.avgUtil,
    s.onAc ? 1 : 0,
    JSON.stringify(s.cpus.map((c) => [c.id, c.perf, c.mhz, c.util, c.parked ? 1 : 0, c.flags])),
  );
}

export function recentSamples(sinceMs: number): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC')
    .all(Date.now() - sinceMs) as Array<Record<string, unknown>>;
}

export function pruneSamples(): number {
  const cutoff = Date.now() - config.retentionHours * 3_600_000;
  return db.prepare('DELETE FROM samples WHERE ts < ?').run(cutoff).changes;
}

/** Adds columns introduced after a database was first created.
 *  CREATE TABLE IF NOT EXISTS silently keeps an older schema, so new columns
 *  have to be added explicitly or every insert fails against an existing file. */
function migrate(): void {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(bench_runs)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    ),
  );
  const added: string[] = [];
  if (!columns.has('baseline_util')) {
    db.exec('ALTER TABLE bench_runs ADD COLUMN baseline_util REAL NOT NULL DEFAULT 0');
    added.push('baseline_util');
  }
  if (!columns.has('baseline_w')) {
    db.exec('ALTER TABLE bench_runs ADD COLUMN baseline_w REAL NOT NULL DEFAULT 0');
    added.push('baseline_w');
  }
  if (added.length) console.log(`[db] migrated bench_runs: added ${added.join(', ')}`);
}
migrate();

const insertRun = db.prepare(`
  INSERT INTO bench_runs
    (kind, started_at, finished_at, cpus, threads, affinity_mask,
     score, score_unit, avg_pkg_w, max_pkg_w, avg_mhz, efficiency,
     baseline_util, baseline_w, settings, output)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

export function saveRun(r: Omit<BenchResult, 'id'>): number {
  const res = insertRun.run(
    r.kind,
    r.startedAt,
    r.finishedAt,
    JSON.stringify(r.cpus),
    r.threads,
    r.affinityMask,
    r.score,
    r.scoreUnit,
    r.avgPkgW,
    r.maxPkgW,
    r.avgMhz,
    r.efficiency,
    r.baselineUtil,
    r.baselineW,
    JSON.stringify(r.settings),
    r.output,
  );
  return Number(res.lastInsertRowid);
}

export function listRuns(limit = 50): unknown[] {
  return db
    .prepare(
      `SELECT id, kind, started_at, finished_at, cpus, threads, score, score_unit,
              avg_pkg_w, max_pkg_w, avg_mhz, efficiency, baseline_util, baseline_w, settings
       FROM bench_runs ORDER BY id DESC LIMIT ?`,
    )
    .all(limit);
}

export function getRun(id: number): unknown {
  return db.prepare('SELECT * FROM bench_runs WHERE id = ?').get(id);
}

export function deleteRun(id: number): number {
  return db.prepare('DELETE FROM bench_runs WHERE id = ?').run(id).changes;
}

/**
 * The kv table holds the handful of values that must outlive the process: which
 * power scheme to hand back to the user, and the measured clock calibration
 * that costs twenty seconds of benchmarking to rediscover. With the database in
 * memory those would be lost on every restart, so kv — and only kv, not the
 * sample stream — is mirrored to a small JSON file.
 */
function readMirror(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(config.statePath, 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMirror(rows: Record<string, string>): void {
  try {
    mkdirSync(dirname(config.statePath), { recursive: true });
    writeFileSync(config.statePath, JSON.stringify(rows, null, 2));
  } catch (e) {
    console.error('[db] could not persist state file:', e);
  }
}

// Seed the table from the mirror so an in-memory database still starts with
// whatever the last run learned.
for (const [k, v] of Object.entries(readMirror())) {
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(k, v);
}

export function kvGet<T>(key: string): T | null {
  const row = db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | null;
  return row ? (JSON.parse(row.v) as T) : null;
}

export function kvSet(key: string, value: unknown): void {
  const json = JSON.stringify(value);
  db.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(key, json);
  writeMirror({ ...readMirror(), [key]: json });
}

export type StoredSettings = { settings: Settings; savedAt: number };

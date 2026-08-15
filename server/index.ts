import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runBenchmark, cancelRun, isRunning } from './bench/runner.ts';
import { config } from './config.ts';
import { governor } from './control/governor.ts';
import {
  activate,
  applySettings,
  ensureLabScheme,
  readSettings,
  STOCK,
} from './control/powercfg.ts';
import { keeper } from './control/keeper.ts';
import { findProfile, PROFILES } from './control/profiles.ts';
import {
  deleteRun,
  getRun,
  kvGet,
  kvSet,
  listRuns,
  pruneSamples,
  recentSamples,
  saveSample,
} from './db.ts';
import { calibrate } from './telemetry/calibrate.ts';
import { getCalibration, loadCalibration, telemetry } from './telemetry/poller.ts';
import { getTopology } from './topology.ts';
import type { Settings } from './types.ts';

const WEB_DIST = resolve(config.root, 'web', 'dist');

let labScheme = '';
let originalScheme = '';
let currentSettings: Settings = STOCK;
let dirty = false; // true when anything non-stock is applied

// ---------------------------------------------------------------- bootstrap

loadCalibration();

const schemes = await ensureLabScheme(kvGet<string>('originalScheme'));
labScheme = schemes.lab;
originalScheme = schemes.original;
kvSet('originalScheme', originalScheme);
await activate(labScheme);
currentSettings = await readSettings(labScheme);
governor.attach(labScheme);
keeper.setDesired(currentSettings);
keeper.start(labScheme);

await telemetry.start();
const topology = await getTopology();

console.log(
  `[pm] ${topology.physicalCount} physical / ${topology.logicalCount} logical cores — ` +
    `P: ${topology.pCpus.join(',')} | E: ${topology.eCpus.join(',') || 'none'}`,
);
console.log(`[pm] lab scheme ${labScheme} (restoring ${originalScheme} on exit)`);

// -------------------------------------------------------------- ws plumbing

type Client = { send: (data: string) => void };
const clients = new Set<Client>();
let lastClientSeenAt = Date.now();

function broadcast(type: string, payload: unknown): void {
  if (clients.size === 0) return;
  const msg = JSON.stringify({ type, payload });
  for (const c of clients) {
    try {
      c.send(msg);
    } catch {
      /* client went away mid-send; the close handler will clean it up */
    }
  }
}

telemetry.subscribe((sample) => {
  saveSample(sample);
  broadcast('sample', sample);
});

governor.onChange = (s) => broadcast('governor', s);

// Prune on a slow timer so the table cannot grow without bound.
setInterval(() => {
  const removed = pruneSamples();
  if (removed) console.log(`[pm] pruned ${removed} old samples`);
}, 10 * 60_000);

/** If every browser tab is gone and we left the CPU restricted, put it back.
 *  A forgotten 1 GHz cap is a genuinely annoying way to lose an afternoon. */
setInterval(() => {
  if (clients.size > 0) {
    lastClientSeenAt = Date.now();
    return;
  }
  if (!dirty) return;
  if (Date.now() - lastClientSeenAt < config.watchdogMs) return;
  console.warn('[pm] watchdog: no clients connected, reverting to stock settings');
  void restoreStock();
}, 30_000);

async function restoreStock(): Promise<void> {
  await governor.disable();
  await applySettings(labScheme, STOCK);
  currentSettings = STOCK;
  keeper.setDesired(STOCK);
  dirty = false;
  broadcast('settings', currentSettings);
}

function isStock(s: Settings): boolean {
  return JSON.stringify(s) === JSON.stringify(STOCK);
}

// --------------------------------------------------------------- http layer

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

function fail(err: unknown, status = 400): Response {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[pm] request failed:', message);
  return json({ error: message }, status);
}

async function fullState() {
  return {
    topology,
    settings: currentSettings,
    calibration: getCalibration(),
    governor: governor.state,
    profiles: PROFILES,
    latest: telemetry.latest,
    benchRunning: isRunning(),
    sampleIntervalMs: config.sampleIntervalMs,
    scheme: { lab: labScheme, original: originalScheme },
  };
}

const server = Bun.serve({
  port: config.port,
  idleTimeout: 120,

  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/ws') {
      if (srv.upgrade(req)) return undefined as unknown as Response;
      return new Response('websocket upgrade failed', { status: 400 });
    }

    if (req.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
          'access-control-allow-headers': 'content-type',
        },
      });
    }

    try {
      if (path === '/api/state') return json(await fullState());

      if (path === '/api/topology') return json(topology);

      if (path === '/api/settings' && req.method === 'GET') {
        currentSettings = await readSettings(labScheme);
        return json(currentSettings);
      }

      if (path === '/api/settings' && req.method === 'POST') {
        const body = (await req.json()) as Settings;
        await applySettings(labScheme, body);
        // Trust the request, not a readback: the platform zeroes frequency
        // caps within seconds, so re-reading would report 0 and the keeper
        // would then stop defending the cap the user just asked for.
        currentSettings = body;
        keeper.setDesired(body);
        dirty = !isStock(currentSettings);
        kvSet('lastSettings', currentSettings);
        broadcast('settings', currentSettings);
        return json(currentSettings);
      }

      if (path.startsWith('/api/profile/') && req.method === 'POST') {
        const id = path.slice('/api/profile/'.length);
        const profile = findProfile(id);
        if (!profile) return fail(`unknown profile: ${id}`, 404);
        await applySettings(labScheme, profile.settings);
        currentSettings = profile.settings;
        keeper.setDesired(currentSettings);
        dirty = !isStock(currentSettings);
        broadcast('settings', currentSettings);
        return json({ applied: profile.id, settings: currentSettings });
      }

      if (path === '/api/restore' && req.method === 'POST') {
        await restoreStock();
        return json({ settings: currentSettings });
      }

      if (path === '/api/calibrate' && req.method === 'POST') {
        broadcast('status', { message: 'calibrating clock references, ~20s' });
        const cal = await calibrate(labScheme);
        keeper.setDesired(currentSettings);
        broadcast('calibration', cal);
        return json(cal);
      }

      if (path === '/api/governor' && req.method === 'POST') {
        const body = (await req.json()) as {
          enabled: boolean;
          targetWatts?: number;
          floorMhz?: number;
          ceilingMhz?: number;
        };
        if (body.enabled) {
          await governor.enable(body.targetWatts ?? 25, body.floorMhz, body.ceilingMhz);
          dirty = true;
        } else {
          await governor.disable();
          // The panel's own caps take over again once the governor lets go.
          keeper.setDesired(currentSettings);
          dirty = !isStock(currentSettings);
        }
        return json(governor.state);
      }

      if (path === '/api/bench' && req.method === 'POST') {
        const body = await req.json();
        // Fire and forget: progress streams over the websocket so a long
        // 7-Zip run does not sit on an open HTTP request.
        void runBenchmark(body, (p) => broadcast('bench', p), labScheme).catch((e) =>
          broadcast('bench', { phase: 'error', message: String(e) }),
        );
        return json({ started: true });
      }

      if (path === '/api/bench/cancel' && req.method === 'POST') {
        return json({ cancelled: cancelRun() });
      }

      if (path === '/api/runs' && req.method === 'GET') {
        return json(listRuns(Number(url.searchParams.get('limit') ?? 50)));
      }

      if (path.startsWith('/api/runs/') && req.method === 'GET') {
        const run = getRun(Number(path.split('/').pop()));
        return run ? json(run) : fail('no such run', 404);
      }

      if (path.startsWith('/api/runs/') && req.method === 'DELETE') {
        return json({ deleted: deleteRun(Number(path.split('/').pop())) });
      }

      if (path === '/api/samples') {
        const minutes = Number(url.searchParams.get('minutes') ?? 5);
        return json(recentSamples(minutes * 60_000));
      }
    } catch (e) {
      return fail(e, 500);
    }

    // Static frontend, when built.
    if (existsSync(WEB_DIST)) {
      const rel = path === '/' ? 'index.html' : path.slice(1);
      const file = Bun.file(resolve(WEB_DIST, rel));
      if (await file.exists()) return new Response(file);
      const index = Bun.file(resolve(WEB_DIST, 'index.html'));
      if (await index.exists()) return new Response(index);
    }

    return new Response(
      'PowerManagement API is running. Start the Vite dev server with `bun run web`.',
      { status: 404 },
    );
  },

  websocket: {
    open(ws) {
      clients.add(ws);
      lastClientSeenAt = Date.now();
      void fullState().then((s) => ws.send(JSON.stringify({ type: 'state', payload: s })));
    },
    close(ws) {
      clients.delete(ws);
      lastClientSeenAt = Date.now();
    },
    message() {
      /* the client has no need to talk back; everything goes over HTTP */
    },
  },
});

console.log(`[pm] listening on http://localhost:${server.port}`);

// ---------------------------------------------------------------- shutdown

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[pm] ${signal}: restoring stock settings before exit`);
  try {
    keeper.stop();
    await governor.disable();
    await applySettings(labScheme, STOCK);
    if (originalScheme) await activate(originalScheme);
  } catch (e) {
    console.error('[pm] restore failed:', e);
  }
  telemetry.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

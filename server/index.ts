import { runBenchmark, cancelRun, isRunning } from './bench/runner.ts';
import { config } from './config.ts';
import { governor } from './control/governor.ts';
import {
  activate,
  applySettings,
  ensureLabScheme,
  normalise,
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
import { serveWeb } from './web.ts';

let labScheme = '';
let originalScheme = '';
let currentSettings: Settings = STOCK;
let dirty = false; // true when anything non-stock is applied
/** Held while the governor is running, so telemetry stays at 1 Hz for it. */
let releaseGovernorRate: (() => void) | null = null;

// ---------------------------------------------------------------- bootstrap

loadCalibration();

const schemes = await ensureLabScheme(kvGet<string>('originalScheme'));
labScheme = schemes.lab;
originalScheme = schemes.original;
kvSet('originalScheme', originalScheme);
await activate(labScheme);
// Normalised on the way in: the platform reports its own adjusted values for
// the pinned fields, and echoing those back would advertise a state the app
// does not actually honour.
currentSettings = normalise(await readSettings(labScheme));
governor.attach(labScheme);
keeper.setDesired(currentSettings);
keeper.start(labScheme);

// Started headless with PM_RESTORE_LAST=1, put back whatever the UI last
// applied. Otherwise start from stock — explicitly, not by assuming the scheme
// is already clean. The lab scheme persists across reboots and holds whatever
// was last written to it, so a boot that skipped this would silently inherit
// the previous session's cap: shut down on Min, come back at 400 MHz with
// nothing on screen saying so.
if (config.restoreLast) {
  const last = kvGet<Settings>('lastSettings');
  if (last) {
    await applySettings(labScheme, last);
    currentSettings = last;
    keeper.setDesired(last);
    dirty = !isStock(last);
    console.log(
      `[pm] restored last settings: P cap ${last.p.freqMax || 'off'} MHz, ` +
        `E cap ${last.e.freqMax || 'off'} MHz, EPP ${last.p.epp}/${last.e.epp}`,
    );
  }
} else if (!isStock(currentSettings)) {
  await applySettings(labScheme, STOCK);
  currentSettings = STOCK;
  keeper.setDesired(STOCK);
  dirty = false;
  console.log('[pm] cleared leftover limits from the lab scheme — starting at stock');
}

await telemetry.start();
const topology = await getTopology();

console.log(
  `[pm] ${topology.physicalCount} physical / ${topology.logicalCount} logical cores — ` +
    `P: ${topology.pCpus.join(',')} | E: ${topology.eCpus.join(',') || 'none'}`,
);
console.log(`[pm] lab scheme ${labScheme} (restoring ${originalScheme} on exit)`);
console.log(
  `[pm] sampling every ${config.idleIntervalMs / 1000}s ` +
    `(realtime mode: ${config.realtimeIntervalMs / 1000}s) — ` +
    `database ${config.dbPath === ':memory:' ? 'in memory' : config.dbPath}`,
);

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
telemetry.onRateChange = (r) => broadcast('rate', r);

// Prune on a slow timer so the table cannot grow without bound.
setInterval(() => {
  const removed = pruneSamples();
  if (removed) console.log(`[pm] pruned ${removed} old samples`);
}, 10 * 60_000);

/** If every browser tab is gone and we left the CPU restricted, put it back.
 *  A forgotten 1 GHz cap is a genuinely annoying way to lose an afternoon. */
setInterval(() => {
  if (config.watchdogMs <= 0) return; // disabled: running unattended on purpose
  if (clients.size > 0) {
    lastClientSeenAt = Date.now();
    return;
  }
  if (Date.now() - lastClientSeenAt < config.watchdogMs) return;

  // Nobody is watching, so there is nothing to watch fast for.
  if (telemetry.rate.realtime && telemetry.rate.holds.length === 0) {
    console.log('[pm] watchdog: no clients connected, dropping back to idle sampling');
    void telemetry.setRealtime(false);
  }

  if (!dirty) return;
  console.warn('[pm] watchdog: no clients connected, reverting to stock settings');
  void restoreStock();
}, 30_000);

async function restoreStock(): Promise<void> {
  await governor.disable();
  releaseGovernorRate?.();
  releaseGovernorRate = null;
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
    rate: telemetry.rate,
    scheme: { lab: labScheme, original: originalScheme },
  };
}

const server = Bun.serve({
  port: config.port,
  hostname: config.host,
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

      if (path === '/api/rate' && req.method === 'POST') {
        const body = (await req.json()) as { realtime: boolean };
        const rate = await telemetry.setRealtime(Boolean(body.realtime));
        broadcast('rate', rate);
        return json(rate);
      }

      if (path === '/api/settings' && req.method === 'GET') {
        // Normalised on the way in: the platform reports its own adjusted values for
// the pinned fields, and echoing those back would advertise a state the app
// does not actually honour.
currentSettings = normalise(await readSettings(labScheme));
        return json(currentSettings);
      }

      if (path === '/api/settings' && req.method === 'POST') {
        const body = normalise((await req.json()) as Settings);
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
        currentSettings = normalise(profile.settings);
        keeper.setDesired(currentSettings);
        dirty = !isStock(currentSettings);
        // Same as the settings panel: a profile is a choice worth remembering,
        // and without this a restart could only ever restore hand-set values.
        kvSet('lastSettings', currentSettings);
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
          // The control loop servos on measured package power; at one sample a
          // minute it would take an hour to converge, so it holds realtime for
          // as long as it is running.
          releaseGovernorRate ??= telemetry.hold('governor');
          await telemetry.settled();
          await governor.enable(body.targetWatts ?? 25, body.floorMhz, body.ceilingMhz);
          dirty = true;
        } else {
          await governor.disable();
          releaseGovernorRate?.();
          releaseGovernorRate = null;
          // The panel's own caps take over again once the governor lets go.
          keeper.setDesired(currentSettings);
          dirty = !isStock(currentSettings);
        }
        return json(governor.state);
      }

      if (path === '/api/bench' && req.method === 'POST') {
        const body = await req.json();
        // A run is aggregated from the samples captured while it lasts, so a
        // twenty-second benchmark needs realtime telemetry or it has nothing
        // to average. Wait for the switch before starting the load.
        const releaseRate = telemetry.hold('benchmark');
        await telemetry.settled();
        // Fire and forget: progress streams over the websocket so a long
        // 7-Zip run does not sit on an open HTTP request.
        void runBenchmark(body, (p) => broadcast('bench', p), labScheme)
          .catch((e) => broadcast('bench', { phase: 'error', message: String(e) }))
          .finally(releaseRate);
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

    // Static frontend: embedded in the compiled build, web/dist otherwise.
    const page = await serveWeb(path);
    if (page) return page;

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

console.log(`[pm] listening on http://${config.host}:${server.port}`);

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

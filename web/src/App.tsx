import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { Bench } from './Bench.tsx';
import { Chart, Legend, type Series } from './Chart.tsx';
import { Controls } from './Controls.tsx';
import { flagNames, type AppState, type RateState, type Sample } from './types.ts';

const WINDOW = 180; // samples kept for the live charts

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [history, setHistory] = useState<Sample[]>([]);
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState('');
  const [benchMessage, setBenchMessage] = useState('');
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let stop = false;
    let retry: ReturnType<typeof setTimeout>;

    function connect() {
      if (stop) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        retry = setTimeout(connect, 1500);
      };
      ws.onmessage = (ev) => {
        const { type, payload } = JSON.parse(ev.data);
        if (type === 'state') {
          setState(payload);
        } else if (type === 'sample') {
          setHistory((h) => [...h, payload as Sample].slice(-WINDOW));
          setState((s) => (s ? { ...s, latest: payload } : s));
        } else if (type === 'settings') {
          setState((s) => (s ? { ...s, settings: payload } : s));
        } else if (type === 'rate') {
          setState((s) => (s ? { ...s, rate: payload } : s));
          // Charts plot samples evenly spaced, so keeping minute-apart points
          // next to second-apart ones would draw a lie.
          setHistory([]);
        } else if (type === 'governor') {
          setState((s) => (s ? { ...s, governor: payload } : s));
        } else if (type === 'calibration') {
          setState((s) => (s ? { ...s, calibration: payload } : s));
        } else if (type === 'status') {
          setStatus(payload.message);
        } else if (type === 'bench') {
          setBenchMessage(payload.message ?? '');
          setState((s) =>
            s ? { ...s, benchRunning: payload.phase === 'running' || payload.phase === 'starting' } : s,
          );
        }
      };
    }

    connect();
    return () => {
      stop = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  // Fall back to a plain fetch if the socket is slow to deliver initial state.
  useEffect(() => {
    if (!state) void api.state().then(setState).catch(() => undefined);
  }, [state]);

  const pSet = useMemo(() => new Set(state?.topology.pCpus ?? []), [state]);

  const { times, powerSeries, clockSeries } = useMemo(() => {
    const times = history.map((s) => s.ts);
    const pAvg = history.map((s) => {
      const c = s.cpus.filter((x) => pSet.has(x.id));
      return c.length ? Math.round(c.reduce((a, b) => a + b.mhz, 0) / c.length) : null;
    });
    const eAvg = history.map((s) => {
      const c = s.cpus.filter((x) => !pSet.has(x.id));
      return c.length ? Math.round(c.reduce((a, b) => a + b.mhz, 0) / c.length) : null;
    });

    const powerSeries: Series[] = [
      { name: 'Package', color: 'var(--series-3)', values: history.map((s) => s.power.pkg) },
      { name: 'Cores', color: 'var(--series-p)', values: history.map((s) => s.power.cores) },
      { name: 'iGPU', color: 'var(--series-e)', values: history.map((s) => s.power.gpu) },
    ];
    const clockSeries: Series[] = [
      { name: 'P-cores', color: 'var(--series-p)', values: pAvg },
      { name: 'E-cores', color: 'var(--series-e)', values: eAvg },
    ];
    return { times, powerSeries, clockSeries };
  }, [history, pSet]);

  if (!state) {
    return (
      <div className="app">
        <header className="top">
          <h1>PowerManagement</h1>
          <span className="pill">
            <span className="dot down" /> connecting to the server…
          </span>
        </header>
        <p className="hint" style={{ color: 'var(--muted)' }}>
          Start it with <code>bun run server</code> if it is not already running.
        </p>
      </div>
    );
  }

  const latest = state.latest;
  const throttles = latest ? [...new Set(latest.cpus.flatMap((c) => flagNames(c.flags)))] : [];

  // Reference lines, so a clock reading means something without knowing the
  // part. An applied cap is only drawn when one is actually set.
  const clockMarkers = [
    { value: state.calibration.pBaseMhz, label: 'P base' },
    { value: state.calibration.eBaseMhz, label: 'E base' },
    ...(state.settings.p.freqMax ? [{ value: state.settings.p.freqMax, label: 'P cap' }] : []),
    ...(state.settings.e.freqMax ? [{ value: state.settings.e.freqMax, label: 'E cap' }] : []),
  ];

  return (
    <div className="app">
      <header className="top">
        <h1>PowerManagement</h1>
        <span className="sub">
          {state.topology.physicalCount} cores / {state.topology.logicalCount} threads ·{' '}
          {state.topology.pCpus.length} P + {state.topology.eCpus.length} E
        </span>
        <span className="spacer" />
        {latest && <span className="pill">{latest.onAc ? 'On AC' : 'On battery'}</span>}
        <span className="pill">
          <span className={`dot ${connected ? 'live' : 'down'}`} />
          {connected ? `live · ${formatInterval(state.rate.intervalMs)}` : 'disconnected'}
        </span>
        <RateToggle rate={state.rate} onStatus={setStatus} />
      </header>
      <p className="status-line" style={{ marginTop: 0 }}>
        {status}
      </p>

      <div className="tiles" style={{ marginBottom: 14 }}>
        <Tile label="Package" value={latest?.power.pkg.toFixed(1) ?? '—'} unit="W" foot="RAPL" />
        <Tile label="Cores" value={latest?.power.cores.toFixed(1) ?? '—'} unit="W" foot="RAPL pp0" />
        <Tile label="iGPU" value={latest?.power.gpu.toFixed(2) ?? '—'} unit="W" foot="RAPL pp1" />
        <Tile
          label="Peak clock"
          value={latest ? formatGhz(latest.maxMhz) : '—'}
          unit="GHz"
          foot={latest ? `avg ${formatGhz(latest.avgMhz)}` : 'avg —'}
        />
        <Tile label="Utilisation" value={latest?.avgUtil.toFixed(0) ?? '—'} unit="%" foot="all cores" />
        <Tile
          label="Governor"
          value={state.governor.enabled ? state.governor.targetWatts : 'off'}
          unit={state.governor.enabled ? 'W' : ''}
          foot={state.governor.enabled ? `cap ${state.governor.currentCapMhz} MHz` : 'not limiting'}
        />
      </div>

      <div className="grid cols-2" style={{ marginBottom: 14 }}>
        <div className="card">
          <div className="chart-head">
            <h2 style={{ margin: 0 }}>Power</h2>
            <Legend series={powerSeries} />
          </div>
          <Chart times={times} series={powerSeries} unit="W" decimals={1} />
        </div>

        <div className="card">
          <div className="chart-head">
            <h2 style={{ margin: 0 }}>Clocks by class</h2>
            <Legend series={clockSeries} />
          </div>
          <Chart
            times={times}
            series={clockSeries}
            unit="GHz"
            zeroBased={false}
            format={formatGhz}
            markers={clockMarkers}
          />
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Per-core</h2>
        <p className="hint">
          Clock and utilisation per logical processor. Blue are the hyperthreaded P-cores, orange the
          E-cores — read from the Windows CPU-set API rather than assumed from numbering.
          {throttles.length > 0 && (
            <>
              {' '}
              Currently limited by: <strong>{throttles.join(', ')}</strong>.
            </>
          )}
        </p>
        <div className="cores">
          {(latest?.cpus ?? []).map((c) => {
            const isP = pSet.has(c.id);
            return (
              <div
                key={c.id}
                className={`core${c.parked ? ' parked' : ''}`}
                style={{ color: isP ? 'var(--series-p)' : 'var(--series-e)' }}
                title={`CPU ${c.id} · ${c.util.toFixed(0)}% utility · limit ${c.limit}%${
                  flagNames(c.flags).length ? ` · ${flagNames(c.flags).join(', ')}` : ''
                }`}
              >
                <div className="id">
                  CPU {c.id} <span className="cls">{isP ? 'P' : 'E'}</span>
                </div>
                <div className="mhz" style={{ color: 'var(--text-primary)' }}>
                  {formatGhz(c.mhz)} <span className="u">GHz</span>
                </div>
                <div className="bar">
                  <i style={{ width: `${Math.min(100, c.util)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="grid">
          <Controls state={state} onStatus={setStatus} />
        </div>
        <div className="grid">
          <Bench state={state} benchMessage={benchMessage} onStatus={setStatus} />
        </div>
      </div>
    </div>
  );
}

function formatInterval(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${ms / 1000}s`;
}

/** Clocks read as GHz to two decimals. Four-digit MHz integers are the same
 *  information, but they need a thousands separator to scan and they make
 *  every axis label a different width. */
export function formatGhz(mhz: number): string {
  return (mhz / 1000).toFixed(2);
}

/** Switches the server between its quiet default and second-by-second
 *  sampling. Realtime restarts the telemetry sidecar, so it takes a moment to
 *  take effect, and the server forces it on regardless while a benchmark or
 *  the governor is running — shown here rather than silently overriding the
 *  button. */
function RateToggle({ rate, onStatus }: { rate: RateState; onStatus: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const forced = rate.holds.length > 0;

  const toggle = async () => {
    setBusy(true);
    onStatus(rate.realtime ? 'dropping back to the idle sample rate…' : 'switching to realtime…');
    try {
      const next = await api.rate(!rate.realtime);
      onStatus(`sampling every ${formatInterval(next.intervalMs)}`);
    } catch (e) {
      onStatus(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className={rate.realtime ? 'active' : ''}
      disabled={busy || forced}
      onClick={() => void toggle()}
      title={
        forced
          ? `realtime is held by: ${rate.holds.join(', ')}`
          : `switch between ${formatInterval(rate.idleIntervalMs)} and ${formatInterval(
              rate.realtimeIntervalMs,
            )} sampling`
      }
    >
      {forced ? `Realtime · ${rate.holds[0]}` : rate.realtime ? 'Realtime on' : 'Realtime'}
    </button>
  );
}

function Tile({
  label,
  value,
  unit,
  foot,
}: {
  label: string;
  value: string | number;
  unit?: string;
  foot?: string;
}) {
  return (
    <div className="tile">
      <div className="label">{label}</div>
      <div className="value">
        {value}
        {unit ? <span className="unit">{unit}</span> : null}
      </div>
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );
}

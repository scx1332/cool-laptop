import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { AppState, RunRow } from './types.ts';

export function Bench({
  state,
  benchMessage,
  onStatus,
}: {
  state: AppState;
  benchMessage: string;
  onStatus: (s: string) => void;
}) {
  const topo = state.topology;
  const [selected, setSelected] = useState<number[]>(topo.cores.map((c) => c.id));
  const [kind, setKind] = useState<'7zip' | 'loadgen'>('7zip');
  const [threads, setThreads] = useState<number | ''>('');
  const [duration, setDuration] = useState(20);
  const [dict, setDict] = useState(22);
  const [runs, setRuns] = useState<RunRow[]>([]);

  async function refresh() {
    try {
      setRuns(await api.runs());
    } catch {
      /* the table is not important enough to surface a failure for */
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  // Reload the table whenever a run finishes.
  useEffect(() => {
    if (benchMessage.startsWith('benchmark complete')) void refresh();
  }, [benchMessage]);

  const toggle = (id: number) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].sort((a, b) => a - b)));

  const presets: Array<[string, number[]]> = [
    ['All 20', topo.cores.map((c) => c.id)],
    ['P-cores', topo.pCpus],
    ['E-cores', topo.eCpus],
    [
      'P, one thread each',
      Object.values(topo.smtGroups)
        .filter((g) => topo.pCpus.includes(g[0]))
        .map((g) => g[0]),
    ],
    ['Single core', [topo.pCpus[0]]],
  ];

  async function run() {
    onStatus('starting benchmark…');
    try {
      await api.bench({
        kind,
        cpus: selected,
        threads: threads === '' ? undefined : Number(threads),
        durationSec: duration,
        dictLog2: dict,
      });
    } catch (e) {
      onStatus(`benchmark failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const effThreads = threads === '' ? selected.length : Number(threads);

  return (
    <>
      <div className="card">
        <h2>Benchmark</h2>
        <p className="hint">
          7-Zip is the scored run (open source, already installed, reports MIPS). The load generator
          just holds the cores busy so you can watch power and the governor settle.
        </p>

        <div className="btn-row" style={{ marginBottom: 10 }}>
          {presets.map(([name, cpus]) => (
            <button
              key={name}
              className={
                JSON.stringify([...cpus].sort((a, b) => a - b)) === JSON.stringify(selected)
                  ? 'active'
                  : ''
              }
              onClick={() => setSelected([...cpus].sort((a, b) => a - b))}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="cores" style={{ marginBottom: 12 }}>
          {topo.cores.map((c) => {
            const isP = c.effClass !== 0;
            const on = selected.includes(c.id);
            return (
              <div
                key={c.id}
                className={`core selectable${on ? ' selected' : ''}`}
                style={{
                  color: isP ? 'var(--series-p)' : 'var(--series-e)',
                  opacity: on ? 1 : 0.4,
                }}
                onClick={() => toggle(c.id)}
                title={`CPU ${c.id} · ${isP ? 'P-core' : 'E-core'} · physical core ${c.core}`}
              >
                <div className="id">CPU {c.id}</div>
                <div className="cls">{isP ? 'P' : 'E'}</div>
              </div>
            );
          })}
        </div>

        <div className="row">
          <label htmlFor="kind">Workload</label>
          <select id="kind" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="7zip">7-Zip benchmark (scored)</option>
            <option value="loadgen">Load generator (sustained)</option>
          </select>

          <label htmlFor="threads" style={{ flex: '0 0 auto', marginLeft: 14 }}>
            Threads
          </label>
          <input
            id="threads"
            type="number"
            min={1}
            max={64}
            placeholder={String(selected.length)}
            value={threads}
            onChange={(e) => setThreads(e.target.value === '' ? '' : Number(e.target.value))}
          />

          {kind === '7zip' ? (
            <>
              <label htmlFor="dict" style={{ flex: '0 0 auto', marginLeft: 14 }}>
                Dictionary
              </label>
              <select id="dict" value={dict} onChange={(e) => setDict(Number(e.target.value))}>
                {[20, 21, 22, 23, 24, 25].map((d) => (
                  <option key={d} value={d}>
                    2^{d} = {2 ** (d - 20)} MB
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label htmlFor="dur" style={{ flex: '0 0 auto', marginLeft: 14 }}>
                Seconds
              </label>
              <input
                id="dur"
                type="number"
                min={5}
                max={600}
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              />
            </>
          )}
        </div>

        <div className="btn-row" style={{ marginTop: 6 }}>
          <button
            className="primary"
            disabled={state.benchRunning || selected.length === 0}
            onClick={run}
          >
            Run on {selected.length} CPU{selected.length === 1 ? '' : 's'} / {effThreads} thread
            {effThreads === 1 ? '' : 's'}
          </button>
          <button
            className="danger"
            disabled={!state.benchRunning}
            onClick={() => void api.cancelBench()}
          >
            Cancel
          </button>
          <span className="status-line">{benchMessage}</span>
        </div>
      </div>

      <div className="card">
        <h2>Results</h2>
        <p className="hint">
          Efficiency is score per watt — the number that actually settles “cool or performant”.
          Runs started on a busy machine are flagged; they are not comparable with quiet ones.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th className="name">Workload</th>
                <th>CPUs</th>
                <th>Score</th>
                <th>MIPS/W</th>
                <th>Avg W</th>
                <th>Peak W</th>
                <th>Avg MHz</th>
                <th className="name">Caps (P / E)</th>
                <th className="name">Noise</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={11} style={{ color: 'var(--muted)' }}>
                    No runs yet.
                  </td>
                </tr>
              )}
              {runs.map((r) => {
                const cpus: number[] = JSON.parse(r.cpus);
                const st = JSON.parse(r.settings);
                const noisy = r.baseline_util > 15;
                return (
                  <tr key={r.id}>
                    <td>{r.id}</td>
                    <td className="name">{r.kind === '7zip' ? '7-Zip' : 'Load gen'}</td>
                    <td>{cpus.length}</td>
                    <td>{r.score ?? '—'}</td>
                    <td>
                      <strong>{r.efficiency ?? '—'}</strong>
                    </td>
                    <td>{r.avg_pkg_w.toFixed(1)}</td>
                    <td>{r.max_pkg_w.toFixed(1)}</td>
                    <td>{r.avg_mhz}</td>
                    <td className="name">
                      {st.p.freqMax || 'off'} / {st.e.freqMax || 'off'}
                    </td>
                    <td className="name" style={{ color: noisy ? 'var(--warning)' : 'var(--muted)' }}>
                      {r.baseline_util.toFixed(0)}%{noisy ? ' busy' : ''}
                    </td>
                    <td>
                      <button
                        onClick={async () => {
                          await api.deleteRun(r.id);
                          void refresh();
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

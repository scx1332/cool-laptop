import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { AppState, ClassSettings, GovernorState, Settings } from './types.ts';

const BOOST_MODES = [
  'Disabled',
  'Enabled',
  'Aggressive',
  'Efficient enabled',
  'Efficient aggressive',
];

/** A frequency cap of 0 means "no cap". Rendered literally that put the thumb
 *  hard left — the position that otherwise means "slowest possible" — so an
 *  unrestricted CPU looked like a maximally throttled one. Off is therefore
 *  given its own stop one step past the top of the range, where "no limit"
 *  belongs, and the raw 0 never reaches the input. */
const CAP_MIN_MHZ = 400;
const CAP_MAX_MHZ = 4000;
const CAP_STEP_MHZ = 100;
const CAP_OFF = CAP_MAX_MHZ + CAP_STEP_MHZ;

const capToSlider = (mhz: number) => (mhz === 0 ? CAP_OFF : mhz);
const sliderToCap = (v: number) => (v >= CAP_OFF ? 0 : v);

interface ClassPanelProps {
  title: string;
  color: string;
  cpus: number[];
  baseMhz: number;
  value: ClassSettings;
  onChange: (v: ClassSettings) => void;
}

function ClassPanel({ title, color, cpus, baseMhz, value, onChange }: ClassPanelProps) {
  const set = <K extends keyof ClassSettings>(k: K, v: number) => onChange({ ...value, [k]: v });

  return (
    <div>
      <div className="class-head" style={{ color }}>
        <span className="swatch" style={{ background: color }} />
        {title}
        <span style={{ color: 'var(--muted)', fontWeight: 400 }}>
          CPU {cpus[0]}–{cpus[cpus.length - 1]} · base {baseMhz} MHz
        </span>
      </div>

      <div className="row">
        <label htmlFor={`${title}-freq`}>Max frequency</label>
        <input
          id={`${title}-freq`}
          type="range"
          min={CAP_MIN_MHZ}
          max={CAP_OFF}
          step={CAP_STEP_MHZ}
          value={capToSlider(value.freqMax)}
          style={{ accentColor: color }}
          aria-valuetext={value.freqMax === 0 ? 'off, no cap' : `${value.freqMax} MHz`}
          onChange={(e) => set('freqMax', sliderToCap(Number(e.target.value)))}
        />
        <span className="num">
          {value.freqMax === 0 ? 'no cap' : `${(value.freqMax / 1000).toFixed(2)} GHz`}
        </span>
      </div>

      <div className="row">
        <label htmlFor={`${title}-epp`}>Energy preference</label>
        <input
          id={`${title}-epp`}
          type="range"
          min={0}
          max={100}
          step={1}
          value={value.epp}
          style={{ accentColor: color }}
          onChange={(e) => set('epp', Number(e.target.value))}
        />
        <span className="num">{value.epp}</span>
      </div>
    </div>
  );
}

export function Controls({
  state,
  onStatus,
}: {
  state: AppState;
  onStatus: (s: string) => void;
}) {
  const [draft, setDraft] = useState<Settings>(state.settings);
  const [busy, setBusy] = useState(false);
  const [gov, setGov] = useState<GovernorState>(state.governor);

  // Server is the source of truth: when it reports new settings (profile
  // applied, watchdog reverted, governor moved a cap) adopt them.
  useEffect(() => setDraft(state.settings), [state.settings]);
  useEffect(() => setGov(state.governor), [state.governor]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(state.settings);

  async function guard(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    onStatus(`${label}…`);
    try {
      await fn();
      onStatus(`${label} — done`);
    } catch (e) {
      onStatus(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  const pBase = state.calibration.pBaseMhz;

  return (
    <>
      <div className="card">
        <h2>Profiles</h2>
        <p className="hint">
          Starting points. Every value stays editable below, and nothing here touches your own
          Windows power plans — the app works on its own duplicated scheme.
        </p>
        <div className="btn-row">
          {state.profiles.map((p) => (
            <button
              key={p.id}
              disabled={busy}
              title={p.description}
              onClick={() => guard(`Applying "${p.name}"`, () => api.applyProfile(p.id))}
            >
              {p.name}
            </button>
          ))}
          <button
            className="danger"
            disabled={busy}
            onClick={() => guard('Restoring stock', () => api.restore())}
          >
            Restore stock
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Per-class control</h2>
        <p className="hint">
          Frequency caps are exact at or below the base clock and ignored above it — above base
          every step is a turbo bin Windows cannot select. Use boost mode up there instead.
        </p>

        <div className="grid cols-2">
          <ClassPanel
            title="P-cores"
            color="var(--series-p)"
            cpus={state.topology.pCpus}
            baseMhz={pBase}
            value={draft.p}
            onChange={(p) => setDraft({ ...draft, p })}
          />
          <ClassPanel
            title="E-cores"
            color="var(--series-e)"
            cpus={state.topology.eCpus}
            baseMhz={state.calibration.eBaseMhz}
            value={draft.e}
            onChange={(e) => setDraft({ ...draft, e })}
          />
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <label htmlFor="boost">Turbo boost</label>
          <select
            id="boost"
            value={draft.boostMode}
            onChange={(e) => setDraft({ ...draft, boostMode: Number(e.target.value) })}
          >
            {BOOST_MODES.map((m, i) => (
              <option key={m} value={i}>
                {m}
              </option>
            ))}
          </select>
        </div>

        <div className="btn-row" style={{ marginTop: 12 }}>
          <button
            className="primary"
            disabled={busy || !dirty}
            onClick={() => guard('Applying settings', () => api.applySettings(draft))}
          >
            {dirty ? 'Apply changes' : 'No changes'}
          </button>
          <button disabled={busy || !dirty} onClick={() => setDraft(state.settings)}>
            Discard
          </button>
        </div>

        <p className="note">
          Processor state percentages, core parking and the cooling policy are not exposed:
          below 100% the state ceiling turns turbo off and collapses the clock — measured here,
          75% cost two thirds of it — core parking never engaged on this chip at all, and the
          cooling policy does nothing on this laptop, where the embedded controller owns the fan.
          All are pinned, so the frequency cap above is the only ceiling.
        </p>
      </div>

      <div className="card">
        <h2>Wattage governor</h2>
        <p className="hint">
          True PL1/PL2 registers need ring 0, so this servos the frequency cap against measured
          RAPL package power instead — same outcome, no kernel driver.
        </p>

        <div className="row">
          <label htmlFor="target">Target package</label>
          <input
            id="target"
            type="range"
            min={8}
            max={65}
            step={1}
            value={gov.targetWatts}
            onChange={(e) => setGov({ ...gov, targetWatts: Number(e.target.value) })}
          />
          <span className="num">{gov.targetWatts} W</span>
        </div>
        <div className="row">
          <label htmlFor="floor">Frequency floor</label>
          <input
            id="floor"
            type="range"
            min={400}
            max={2000}
            step={100}
            value={gov.floorMhz}
            onChange={(e) => setGov({ ...gov, floorMhz: Number(e.target.value) })}
          />
          <span className="num">{(gov.floorMhz / 1000).toFixed(2)} GHz</span>
        </div>

        <div className="btn-row" style={{ marginTop: 10 }}>
          <button
            className={gov.enabled ? 'danger' : 'primary'}
            disabled={busy}
            onClick={() =>
              guard(gov.enabled ? 'Disabling governor' : 'Enabling governor', () =>
                api.governor({
                  enabled: !gov.enabled,
                  targetWatts: gov.targetWatts,
                  floorMhz: gov.floorMhz,
                }),
              )
            }
          >
            {gov.enabled ? 'Stop governor' : 'Start governor'}
          </button>
          {state.governor.enabled && (
            <span className="pill">
              holding cap at <strong className="mono">{state.governor.currentCapMhz} MHz</strong>
            </span>
          )}
        </div>

        <p className="note">
          Effective for holding power below the natural all-core draw. It cannot trim finely inside
          the turbo range, because the cap has no effect above {pBase} MHz on this silicon.
        </p>
      </div>

      <div className="card">
        <h2>Clock calibration</h2>
        <p className="hint">
          Windows reports clocks as a percentage of a per-class base it never exposes, so the app
          measures that base: clamp a class to a known frequency, saturate it, read the percentage
          back. Without this, E-core clocks read impossibly high.
        </p>
        <div className="btn-row">
          <button
            disabled={busy || state.benchRunning}
            onClick={() => guard('Calibrating (~25s, loads the CPU)', () => api.calibrate())}
          >
            Recalibrate
          </button>
          <span className="pill">
            P {state.calibration.pBaseMhz} MHz · E {state.calibration.eBaseMhz} MHz
            {state.calibration.calibratedAt
              ? ` · ${new Date(state.calibration.calibratedAt).toLocaleString()}`
              : ' · never calibrated'}
          </span>
        </div>
      </div>
    </>
  );
}

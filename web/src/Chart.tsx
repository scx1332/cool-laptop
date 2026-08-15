import { useMemo, useRef, useState } from 'react';

export interface Series {
  name: string;
  color: string;
  values: Array<number | null>;
}

interface Props {
  times: number[];
  series: Series[];
  unit: string;
  height?: number;
  /** Force the axis to start at zero; true for power, false for clocks. */
  zeroBased?: boolean;
  decimals?: number;
  /** Overrides the axis and tooltip number format — clocks read as GHz. */
  format?: (v: number) => string;
  /** Drawn as a dashed reference line, e.g. the base clock or an active cap. */
  markers?: Array<{ value: number; label: string }>;
}

const PAD = { top: 10, right: 12, bottom: 22, left: 46 };

/** Picks a step from the 1/2/5 x 10^n ladder so ticks land on round numbers
 *  instead of the raw min..max interpolation, which produced axis labels like
 *  1965 / 2556 / 3147 that changed on every incoming sample. */
function niceStep(span: number, target: number): number {
  const rough = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(rough));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (mag * m >= rough) return mag * m;
  }
  return mag * 10;
}

/**
 * Small SVG time-series chart with a crosshair tooltip.
 *
 * Deliberately single-axis: power and frequency live in separate charts rather
 * than sharing one plot with two scales.
 */
export function Chart({
  times,
  series,
  unit,
  height = 170,
  zeroBased = true,
  decimals = 0,
  format,
  markers = [],
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;

  // Domain and ticks are derived together: the axis is snapped outwards to
  // whole steps so both ends of the plot sit on a labelled gridline.
  const { min, max, ticks } = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
    const marks = markers.map((m) => m.value);
    if (!all.length) return { min: 0, max: 1, ticks: [0, 1] };

    let lo = zeroBased ? 0 : Math.min(...all, ...marks);
    let hi = Math.max(...all, ...marks);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    if (!zeroBased) lo -= pad;
    hi += pad;

    const step = niceStep(hi - lo, 4);
    const snappedLo = zeroBased ? 0 : Math.floor(lo / step) * step;
    const snappedHi = Math.ceil(hi / step) * step;

    const out: number[] = [];
    // Accumulate off the index rather than by repeated addition, so a
    // fractional step cannot drift a tick onto 2.9999999999.
    for (let i = 0; snappedLo + i * step <= snappedHi + step / 1000; i++) {
      out.push(Number((snappedLo + i * step).toPrecision(12)));
    }
    return { min: snappedLo, max: snappedHi, ticks: out };
  }, [series, zeroBased, markers]);

  const n = times.length;
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const y = (v: number) =>
    PAD.top + (1 - (v - min) / (max - min)) * (height - PAD.top - PAD.bottom);

  function path(values: Array<number | null>): string {
    let d = '';
    let pen = false;
    values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  function onMove(ev: React.MouseEvent<SVGSVGElement>) {
    if (n === 0) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * width;
    const t = (px - PAD.left) / Math.max(1, width - PAD.left - PAD.right);
    setHover(Math.max(0, Math.min(n - 1, Math.round(t * (n - 1)))));
  }

  const fmt = (v: number) => format?.(v) ?? v.toFixed(decimals);
  const hoverTime = hover != null && times[hover] ? new Date(times[hover]) : null;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Time series in ${unit}`}
      >
        {ticks.map((t, i) => (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={width - PAD.right}
              y1={y(t)}
              y2={y(t)}
              stroke="var(--grid)"
              strokeWidth={1}
            />
            <text x={PAD.left - 7} y={y(t) + 3.5} textAnchor="end" fontSize={10} fill="var(--muted)">
              {fmt(t)}
            </text>
          </g>
        ))}

        {markers.map((m) =>
          m.value < min || m.value > max ? null : (
            <g key={m.label}>
              <line
                x1={PAD.left}
                x2={width - PAD.right}
                y1={y(m.value)}
                y2={y(m.value)}
                stroke="var(--axis)"
                strokeWidth={1}
                strokeDasharray="4 4"
              />
              <text
                x={width - PAD.right - 4}
                y={y(m.value) - 4}
                textAnchor="end"
                fontSize={9}
                fill="var(--muted)"
              >
                {m.label}
              </text>
            </g>
          ),
        )}

        {series.map((s) => (
          <path
            key={s.name}
            d={path(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {hover != null && (
          <>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={PAD.top}
              y2={height - PAD.bottom}
              stroke="var(--axis)"
              strokeWidth={1}
            />
            {series.map((s) => {
              const v = s.values[hover];
              return v == null ? null : (
                <circle
                  key={s.name}
                  cx={x(hover)}
                  cy={y(v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--surface-1)"
                  strokeWidth={2}
                />
              );
            })}
          </>
        )}

        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={height - PAD.bottom}
          y2={height - PAD.bottom}
          stroke="var(--axis)"
          strokeWidth={1}
        />
      </svg>

      {hover != null && hoverTime && (
        <div
          className="tooltip"
          style={{
            left: `min(calc(100% - 150px), ${(x(hover) / width) * 100}%)`,
            top: 4,
          }}
        >
          <div className="t-time">{hoverTime.toLocaleTimeString()}</div>
          {series.map((s) => (
            <div className="t-row" key={s.name}>
              <span className="t-name">
                <span
                  className="swatch"
                  style={{ width: 9, height: 9, borderRadius: 3, background: s.color }}
                />
                {s.name}
              </span>
              <span className="t-val">
                {s.values[hover] == null ? '—' : `${fmt(s.values[hover] as number)} ${unit}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Legend({ series }: { series: Series[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span className="item" key={s.name}>
          <span className="swatch" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

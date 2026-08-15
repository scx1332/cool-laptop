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
}

const PAD = { top: 10, right: 12, bottom: 22, left: 46 };

/**
 * Small SVG time-series chart with a crosshair tooltip.
 *
 * Deliberately single-axis: power and frequency live in separate charts rather
 * than sharing one plot with two scales.
 */
export function Chart({ times, series, unit, height = 170, zeroBased = true, decimals = 0 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;

  const { min, max } = useMemo(() => {
    const all = series.flatMap((s) => s.values.filter((v): v is number => v != null));
    if (!all.length) return { min: 0, max: 1 };
    let lo = zeroBased ? 0 : Math.min(...all);
    let hi = Math.max(...all);
    if (hi === lo) hi = lo + 1;
    const pad = (hi - lo) * 0.08;
    return { min: zeroBased ? 0 : lo - pad, max: hi + pad };
  }, [series, zeroBased]);

  const n = times.length;
  const x = (i: number) => PAD.left + (n <= 1 ? 0 : (i / (n - 1)) * (width - PAD.left - PAD.right));
  const y = (v: number) =>
    PAD.top + (1 - (v - min) / (max - min)) * (height - PAD.top - PAD.bottom);

  const ticks = useMemo(() => {
    const out: number[] = [];
    for (let i = 0; i <= 4; i++) out.push(min + ((max - min) * i) / 4);
    return out;
  }, [min, max]);

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

  const fmt = (v: number) => v.toFixed(decimals);
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

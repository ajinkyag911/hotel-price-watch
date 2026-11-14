import { useId, useMemo, useState, type ReactNode } from "react";
import { useWidth } from "../lib/hooks";
import { DAY, addDays, fmtDate, fmtMonth, fmtMonthShort, inrCompact, isoDay, localDate } from "../lib/format";

// ---------- scales ----------

export function niceTicks(min: number, max: number, count = 4) {
  if (!isFinite(min) || !isFinite(max)) return [];
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.05);
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(Math.round(v));
  return ticks;
}

function timeTicks(t0: number, t1: number, width: number) {
  const n = Math.max(2, Math.min(6, Math.floor(width / 110)));
  const span = t1 - t0;
  if (span <= 0) return [t0];
  const step = span / n;
  return Array.from({ length: n + 1 }, (_, i) => t0 + i * step);
}

// ---------- line chart (price over time) ----------

export interface LinePoint {
  time: number;
  value: number | null;
  label?: ReactNode;
}

interface LineChartProps {
  points: LinePoint[];
  height?: number;
  alertBelow?: number | null;
  format?: (v: number) => string;
  ariaLabel: string;
  tooltip?: (p: LinePoint) => ReactNode;
}

export function LineChart({ points, height = 240, alertBelow, format = inrCompact, ariaLabel, tooltip }: LineChartProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gid = useId().replace(/:/g, "");
  const priced = points.filter((p) => p.value != null) as (LinePoint & { value: number })[];

  const geom = useMemo(() => {
    if (!width || !priced.length) return null;
    const m = { t: 14, r: 16, b: 28, l: 56 };
    const t0 = points[0].time;
    const t1 = points[points.length - 1].time;
    const vals = priced.map((p) => p.value);
    if (alertBelow != null) vals.push(alertBelow);
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.12, hi * 0.03);
    lo -= pad;
    hi += pad;
    const ticks = niceTicks(lo, hi, 4);
    lo = Math.min(lo, ticks[0] ?? lo);
    hi = Math.max(hi, ticks[ticks.length - 1] ?? hi);
    const sx = (t: number) => (t1 === t0 ? (m.l + width - m.r) / 2 : m.l + ((t - t0) / (t1 - t0)) * (width - m.l - m.r));
    const sy = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (height - m.t - m.b);
    // Break the line where the room was unavailable.
    let d = "";
    let open = false;
    const segs: string[] = [];
    let seg = "";
    for (const p of points) {
      if (p.value == null) {
        if (seg) segs.push(seg);
        seg = "";
        open = false;
        continue;
      }
      const cmd = `${open ? "L" : "M"}${sx(p.time).toFixed(1)},${sy(p.value).toFixed(1)}`;
      d += cmd;
      seg += cmd;
      open = true;
    }
    if (seg) segs.push(seg);
    const base = height - m.b;
    const areas = segs.map((s) => {
      const coords = s.match(/[ML]([\d.]+),([\d.]+)/g)!.map((c) => c.slice(1).split(",").map(Number));
      return `${s}L${coords[coords.length - 1][0]},${base}L${coords[0][0]},${base}Z`;
    });
    return { m, t0, t1, sx, sy, ticks, d, areas, xt: timeTicks(t0, t1, width - m.l - m.r) };
  }, [width, points, priced, alertBelow, height]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geom) return;
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    let best = 0;
    let bd = Infinity;
    points.forEach((p, i) => {
      const dd = Math.abs(geom.sx(p.time) - x);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setHover(best);
  };

  const hp = hover != null ? points[hover] : null;
  const last = priced[priced.length - 1];

  return (
    <div className="chart" ref={ref}>
      {geom && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={`a${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--chart-line)" stopOpacity="0.22" />
              <stop offset="1" stopColor="var(--chart-line)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {geom.ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={geom.m.l} x2={width - geom.m.r} y1={geom.sy(t)} y2={geom.sy(t)} />
              <text className="axis" x={geom.m.l - 10} y={geom.sy(t)} dy="0.32em" textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {geom.xt.map((t, i) => (
            <text
              key={i}
              className="axis"
              x={geom.sx(t)}
              y={height - 8}
              textAnchor={i === 0 ? "start" : i === geom.xt.length - 1 ? "end" : "middle"}
            >
              {fmtDate.format(new Date(t))}
            </text>
          ))}
          {alertBelow != null && (
            <g className="alert-line">
              <line x1={geom.m.l} x2={width - geom.m.r} y1={geom.sy(alertBelow)} y2={geom.sy(alertBelow)} />
              <text x={width - geom.m.r} y={geom.sy(alertBelow) - 6} textAnchor="end">
                Alert below {format(alertBelow)}
              </text>
            </g>
          )}
          {geom.areas.map((a, i) => (
            <path key={i} d={a} fill={`url(#a${gid})`} />
          ))}
          <path className="line" d={geom.d} />
          {last && (
            <circle className="end-dot" cx={geom.sx(last.time)} cy={geom.sy(last.value)} r={4.5} />
          )}
          {hp && (
            <g>
              <line className="crosshair" x1={geom.sx(hp.time)} x2={geom.sx(hp.time)} y1={geom.m.t} y2={height - geom.m.b} />
              {hp.value != null && <circle className="hover-dot" cx={geom.sx(hp.time)} cy={geom.sy(hp.value)} r={5} />}
            </g>
          )}
        </svg>
      )}
      {geom && hp && (
        <div
          className="tooltip"
          style={{
            left: Math.min(Math.max(geom.sx(hp.time), 90), width - 90),
            top: hp.value != null ? geom.sy(hp.value) - 12 : geom.m.t,
          }}
        >
          {tooltip ? tooltip(hp) : hp.value != null ? format(hp.value) : "Unavailable"}
        </div>
      )}
    </div>
  );
}

// ---------- sparkline ----------

export function Sparkline({ values, width = 120, height = 36, className = "" }: { values: (number | null)[]; width?: number; height?: number; className?: string }) {
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v != null) as { v: number; i: number }[];
  if (pts.length < 2) return <svg className={`spark ${className}`} width={width} height={height} aria-hidden="true" />;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const n = values.length - 1 || 1;
  const sx = (i: number) => 3 + (i / n) * (width - 6);
  const sy = (v: number) => (hi === lo ? height / 2 : 4 + (1 - (v - lo) / (hi - lo)) * (height - 8));
  const d = pts.map((p, k) => `${k ? "L" : "M"}${sx(p.i).toFixed(1)},${sy(p.v).toFixed(1)}`).join("");
  const lastP = pts[pts.length - 1];
  const trend = lastP.v < pts[0].v ? "down" : lastP.v > pts[0].v ? "up" : "flat";
  return (
    <svg className={`spark spark-${trend} ${className}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} />
      <circle cx={sx(lastP.i)} cy={sy(lastP.v)} r={2.6} />
    </svg>
  );
}

// ---------- step chart for one check-in date's history ----------

export function StepChart({
  h,
  t0,
  t1,
  height = 120,
  format = inrCompact,
}: {
  h: { time: number; v: number | null }[];
  t0: number;
  t1: number;
  height?: number;
  format?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const m = { t: 12, r: 12, b: 22, l: 52 };
  let i0 = -1;
  h.forEach((x, k) => {
    if (x.time <= t0) i0 = k;
  });
  const pts = i0 >= 0 ? [{ ...h[i0], time: t0 }] : [];
  for (const x of h) if (x.time > t0 && x.time <= t1) pts.push(x);
  const vals = pts.filter((p) => p.v != null).map((p) => p.v as number);
  if (!width || !vals.length) return <div className="chart" ref={ref} style={{ height }} />;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  const span = Math.max(hi - lo, hi * 0.1) || 1;
  const mid = (lo + hi) / 2;
  lo = mid - span / 1.6;
  hi = mid + span / 1.6;
  const sx = (t: number) => m.l + ((t - t0) / Math.max(1, t1 - t0)) * (width - m.l - m.r);
  const sy = (v: number) => m.t + (1 - (v - lo) / (hi - lo)) * (height - m.t - m.b);
  let d = "";
  let prev = false;
  const gaps: [number, number][] = [];
  pts.forEach((p, k) => {
    const xa = sx(p.time);
    const xb = sx(k + 1 < pts.length ? pts[k + 1].time : t1);
    if (p.v == null) {
      gaps.push([xa, xb]);
      prev = false;
      return;
    }
    const y = sy(p.v).toFixed(1);
    d += `${prev ? "L" : "M"}${xa.toFixed(1)},${y}L${xb.toFixed(1)},${y}`;
    prev = true;
  });
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals), 2);
  const lastV = pts[pts.length - 1]?.v;
  return (
    <div className="chart" ref={ref}>
      <svg width={width} height={height} role="img" aria-label="Price history for this check-in date">
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={m.l} x2={width - m.r} y1={sy(t)} y2={sy(t)} />
            <text className="axis" x={m.l - 8} y={sy(t)} dy="0.32em" textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        <text className="axis" x={m.l} y={height - 6}>{fmtDate.format(new Date(t0))}</text>
        <text className="axis" x={width - m.r} y={height - 6} textAnchor="end">Now</text>
        {gaps.map(([a, b], i) => (
          <line key={i} className="soldout-gap" x1={a} x2={b} y1={height - m.b - 1} y2={height - m.b - 1} />
        ))}
        <path className="line" d={d} />
        {lastV != null && <circle className="end-dot" cx={width - m.r} cy={sy(lastV)} r={4} />}
      </svg>
    </div>
  );
}

// ---------- calendar heatmap of check-in dates ----------

export interface HeatCell {
  date: string;
  value: number | null; // null = sold out / unavailable
  missing?: boolean; // not priced yet
}

const RAMP = 6;

/** Cheaper = deeper. One hue, light → dark; sold out is hatched, never coloured. */
export function Heatmap({
  cells,
  from,
  to,
  onPick,
  selected,
  tooltip,
  highlight,
}: {
  cells: HeatCell[];
  from: string;
  to: string;
  onPick?: (date: string) => void;
  selected?: string | null;
  tooltip: (c: HeatCell) => ReactNode;
  highlight?: Set<string>;
}) {
  const [hover, setHover] = useState<{ c: HeatCell; x: number; y: number } | null>(null);
  const byDate = new Map(cells.map((c) => [c.date, c]));
  const priced = cells.filter((c) => c.value != null).map((c) => c.value as number).sort((a, b) => a - b);
  const q = (v: number) => {
    if (priced.length < 2) return RAMP;
    // Quantile buckets so a few outliers don't wash the calendar out.
    let idx = 0;
    while (idx < priced.length && priced[idx] <= v) idx++;
    const f = (idx - 1) / (priced.length - 1);
    return Math.max(1, RAMP - Math.floor(f * RAMP));
  };
  const months: { key: string; first: Date }[] = [];
  const start = localDate(from);
  const end = localDate(to);
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d <= end; d.setMonth(d.getMonth() + 1)) {
    months.push({ key: isoDay(d), first: new Date(d) });
  }
  return (
    <div className="heatmap" onPointerLeave={() => setHover(null)}>
      <div className="heat-months">
        {months.map(({ key, first }) => {
          const lead = (first.getDay() + 6) % 7; // Monday-first
          const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
          const slots: (string | null)[] = [...Array(lead).fill(null)];
          for (let i = 0; i < days; i++) slots.push(addDays(key, i));
          return (
            <div className="heat-month" key={key}>
              <div className="heat-month-name">{fmtMonth.format(first)}</div>
              <div className="heat-grid">
                {["M", "T", "W", "T", "F", "S", "S"].map((w, i) => (
                  <div key={i} className="heat-wd">{w}</div>
                ))}
                {slots.map((iso, i) => {
                  if (!iso) return <div key={i} />;
                  const c = byDate.get(iso);
                  const inWindow = iso >= from && iso <= to;
                  const cls = !inWindow || !c ? "out" : c.missing ? "missing" : c.value == null ? "soldout" : `h${q(c.value)}`;
                  return (
                    <button
                      key={i}
                      type="button"
                      className={`heat-cell ${cls}${selected === iso ? " sel" : ""}${highlight?.has(iso) ? " best" : ""}`}
                      disabled={!inWindow || !c}
                      aria-label={c ? `${iso}` : undefined}
                      onPointerEnter={(e) => {
                        if (!c) return;
                        const r = e.currentTarget.getBoundingClientRect();
                        const host = e.currentTarget.closest(".heatmap")!.getBoundingClientRect();
                        setHover({ c, x: r.left - host.left + r.width / 2, y: r.top - host.top });
                      }}
                      onClick={() => c && onPick?.(iso)}
                    >
                      {localDate(iso).getDate()}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      {hover && (
        <div className="tooltip" style={{ left: hover.x, top: hover.y - 6 }}>
          {tooltip(hover.c)}
        </div>
      )}
      <div className="heat-legend">
        <span>Cheaper</span>
        {Array.from({ length: RAMP }, (_, i) => (
          <i key={i} className={`heat-swatch h${RAMP - i}`} />
        ))}
        <span>Pricier</span>
        <i className="heat-swatch soldout" /> <span>Sold out</span>
        <i className="heat-swatch missing" /> <span>Not priced yet</span>
      </div>
    </div>
  );
}

// ---------- tiny bar strip (prices across a window, used on deal cards) ----------

export function PriceStrip({ values, best }: { values: (number | null)[]; best?: number }) {
  const priced = values.filter((v): v is number => v != null);
  if (priced.length < 2) return null;
  const lo = Math.min(...priced);
  const hi = Math.max(...priced);
  return (
    <div className="price-strip" aria-hidden="true">
      {values.map((v, i) => (
        <i
          key={i}
          className={v == null ? "na" : v === best ? "best" : ""}
          style={{ height: v == null ? "18%" : `${30 + (hi === lo ? 40 : (1 - (v - lo) / (hi - lo)) * 70)}%` }}
        />
      ))}
    </div>
  );
}

export const monthShort = (iso: string) => fmtMonthShort.format(localDate(iso));
export const daysBetween = (a: string, b: string) => Math.round((localDate(b).getTime() - localDate(a).getTime()) / DAY);

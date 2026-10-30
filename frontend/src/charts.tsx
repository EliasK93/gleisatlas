/** The time series' plain SVG charts: one row per month or per day, drawn on the same pieces. */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { LOCALE, t } from "./i18n";
import { DEFS, formatDay, formatMonth, int, withUnit, type Metric } from "./metrics";
import type { components } from "./schema";
import { show } from "./ui";

type Monat = components["schemas"]["Monat"];
type Stats = components["schemas"]["Stats"];
type Trend = components["schemas"]["Trend"];

/**
 * One point of a series. `key` is a month ("2026-03") or a day ("2026-03-10"), `missing` the
 * hours without complete data, `trend` the day's 28-day trend (days only).
 */
export type Row = Omit<Monat, "monat"> & { key: string; missing: number; trend?: Trend };
export type Scale = { x: (i: number) => number; y: (v: number) => number; bottom: number };
export type Marker = { i: number; label: string; row: number; end: boolean };

export const PAD = { l: 48, r: 22, b: 22 };
const DASH = "5 4";
/** Rows of the marker labels above the plot, and the plot's top edge below them. */
const MARKER_ROW = [11, 31];
export const MARKER_TOP = 46;

/** The first series colours as classes, spelled out so Tailwind sees them. */
export const CAT = { stroke: "stroke-cat1", fill: "fill-cat1" };
export const CANCEL = { stroke: "stroke-cancel", fill: "fill-cancel" };

const num = new Intl.NumberFormat(LOCALE);

/** A day's key is a full date; a month's is shorter. */
export const isDay = (r: Row) => r.key.length > 7;

/** "Mär 26" for a month, "Di., 10.03.2026" for a day. */
export const rowLabel = (r: Row) => (isDay(r) ? formatDay(r.key) : formatMonth(r.key));

/** A row's statistics, or nothing for a row without stops (its rate is null). */
export const stats = (r: Row): Stats | undefined =>
  r.ausfallquote === null ? undefined : { ...r, ausfallquote: r.ausfallquote };

export const percent = (r: Row) => (r.puenktlich === null ? null : r.puenktlich * 100);
export const cancelRate = (r: Row) => (r.ausfallquote === null ? null : r.ausfallquote * 100);
export const median = (r: Row) => r.median;
export const p90 = (r: Row) => r.p90;

const TREND = {
  puenktlich: "puenktlich",
  median: "median",
  p90: "p90",
  ausfall: "ausfallquote",
} as const;

/** A day's trend of `metric` in chart units (percent or minutes), or null. */
export function trendValue(r: Row, metric: Metric) {
  const v = r.trend?.[TREND[metric]] ?? null;
  return v !== null && (metric === "puenktlich" || metric === "ausfall") ? v * 100 : v;
}

/** The trend as the metric's own text ("78 %", "3 min"), or null when the day has none. */
function trendText(r: Row, metric: Metric) {
  const tr = r.trend;
  if (!tr || tr[TREND[metric]] === null) return null;
  const s = { ...tr, n: 0, ausfallquote: tr.ausfallquote ?? 0 };
  return DEFS[metric].format(DEFS[metric].value(s)!);
}

/** Little data by the rule of `show()` (arrived stops for delays), or missing hours: dashed. */
export const thin = (r: Row, metric: Metric) => !!show(metric, stats(r), "").low || r.missing > 0;

/** The text of a row's tooltip: date, value or values (none when little data), trend, n, gaps. */
export function tipOf(r: Row, metric: Metric) {
  const parts = [rowLabel(r)];
  const s = stats(r);
  const low = !!show(metric, s, "").low;
  if (!s) parts.push(t("zv.noData"));
  else if (!low)
    for (const k of metric === "median" ? (["median", "p90"] as const) : [metric]) {
      const v = DEFS[k].value(s);
      parts.push(
        v === null ? t("hm.onlyCancelledLegend") : t(`metric.${k}.cell`, { v: DEFS[k].format(v) }),
      );
    }
  const trend = trendText(r, metric);
  if (trend) parts.push(t("zv.trend", { v: trend }));
  if (s) {
    parts.push(t("station.n", { n: int(r.n) }));
    if (low) parts.push(t("hm.lowLegend"));
  }
  if (r.missing) parts.push(t("zv.gap", { h: int(r.missing) }));
  return parts.join(" · ");
}

const STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];

/** Gridline values from the finest step that covers min to max in at most four intervals. */
export function niceTicks(values: number[]) {
  const [min, max] = values.length ? [Math.min(...values), Math.max(...values)] : [0, 100];
  const step = STEPS.find((s) => Math.ceil(max / s) - Math.floor(min / s) <= 4) ?? 100;
  const from = Math.floor(min / step);
  const to = Math.max(Math.ceil(max / step), from + 1);
  return Array.from({ length: to - from + 1 }, (_, i) => (from + i) * step);
}

export const nonNull = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

/** Measures its box and hands the width to a chart drawn in plain SVG. */
export function Sized({
  height,
  children,
}: {
  height: number;
  children: (width: number) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const watch = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    watch.observe(ref.current!);
    return () => watch.disconnect();
  }, []);
  return (
    <div ref={ref} style={{ height }}>
      {width > 0 && children(width)}
    </div>
  );
}

/** A month names itself on the axis; a day only on the first of its month. */
const axisLabel = (r: Row) =>
  !isDay(r) ? formatMonth(r.key) : r.key.endsWith("-01") ? formatMonth(r.key.slice(0, 7)) : null;

/**
 * The frame of a chart: gridlines with labels, month labels, and a transparent column per row that
 * carries the tooltip. `children` draw in the frame with the row and value scales.
 */
export function Plot({
  id,
  label,
  rows,
  metric,
  width,
  height,
  top,
  ticks,
  unit,
  children,
}: {
  id: string;
  label: string;
  rows: Row[];
  metric: Metric;
  width: number;
  height: number;
  top: number;
  ticks: number[];
  unit: "unit.pct" | "unit.min";
  children: (s: Scale) => ReactNode;
}) {
  const band = (width - PAD.l - PAD.r) / rows.length;
  const bottom = height - PAD.b;
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]];
  const scale: Scale = {
    x: (i) => PAD.l + (i + 0.5) * band,
    y: (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top),
    bottom,
  };
  // Every month gets a label where it fits, the latest always has one; a day series labels the
  // first day of each month the same way.
  const labelled = rows.flatMap((r, i) => {
    const text = axisLabel(r);
    return text ? [{ i, text }] : [];
  });
  const every = Math.ceil(52 / ((width - PAD.l - PAD.r) / labelled.length));
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="block">
      {ticks.map((v) => (
        <g key={v}>
          <line
            x1={PAD.l}
            x2={width - PAD.r}
            y1={scale.y(v)}
            y2={scale.y(v)}
            className="stroke-border"
          />
          <text
            x={PAD.l - 6}
            y={scale.y(v)}
            dy="0.32em"
            textAnchor="end"
            className="fill-text-3 text-[11px]"
          >
            {withUnit(num.format(v), unit)}
          </text>
        </g>
      ))}
      {labelled.map(
        ({ i, text }, k) =>
          (labelled.length - 1 - k) % every === 0 && (
            <text
              key={rows[i].key}
              x={scale.x(i)}
              y={height - 6}
              textAnchor="middle"
              className="fill-text-3 text-[11px]"
            >
              {text}
            </text>
          ),
      )}
      {children(scale)}
      {rows.map((r, i) => (
        <rect
          key={r.key}
          data-testid={`${id}-${r.key}`}
          data-tip={tipOf(r, metric)}
          x={scale.x(i) - band / 2}
          y={0}
          width={band}
          height={height}
          fill="transparent"
        />
      ))}
    </svg>
  );
}

/**
 * One series: a segment between neighbours that both have a value, dashed when either is thin, and
 * a point per month (hollow when thin). A row without a value leaves a hole. Days are drawn as a
 * faint thin line without points, under their bold `TrendLine`.
 */
export function Line({
  rows,
  metric,
  scale,
  value,
  cls = CAT,
}: {
  rows: Row[];
  metric: Metric;
  scale: Scale;
  value: (r: Row) => number | null;
  cls?: typeof CAT;
}) {
  const faint = rows.length > 0 && isDay(rows[0]);
  return (
    <>
      {rows.map((r, i) => {
        const [from, to] = [rows[i - 1], r];
        const [a, b] = [from && value(from), value(to)];
        if (a === undefined || a === null || b === null) return null;
        return (
          <line
            key={r.key}
            data-testid="segment"
            x1={scale.x(i - 1)}
            y1={scale.y(a)}
            x2={scale.x(i)}
            y2={scale.y(b)}
            strokeWidth={faint ? 1 : 2.5}
            strokeOpacity={faint ? 0.45 : undefined}
            strokeDasharray={thin(from, metric) || thin(to, metric) ? DASH : undefined}
            className={cls.stroke}
          />
        );
      })}
      {!faint &&
        rows.map((r, i) => {
          const v = value(r);
          return v === null ? null : (
            <circle
              key={r.key}
              data-testid="point"
              cx={scale.x(i)}
              cy={scale.y(v)}
              r={3.5}
              strokeWidth={2}
              className={
                thin(r, metric) ? `fill-surface ${cls.stroke}` : `${cls.fill} ${cls.stroke}`
              }
            />
          );
        })}
    </>
  );
}

/** The consecutive rows that have a value, as runs of row indexes. */
function runsOf(rows: Row[], has: (r: Row) => boolean) {
  const runs: number[][] = [[]];
  rows.forEach((r, i) => {
    if (has(r)) runs[runs.length - 1].push(i);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  return runs.filter((run) => run.length > 1);
}

/** The bold line of a day series: one polyline per run of days that have a trend. */
export function TrendLine({
  rows,
  scale,
  value,
  cls = CAT,
}: {
  rows: Row[];
  scale: Scale;
  value: (r: Row) => number | null;
  cls?: typeof CAT;
}) {
  return (
    <>
      {runsOf(rows, (r) => value(r) !== null).map((run) => (
        <polyline
          key={run[0]}
          data-testid="trend"
          fill="none"
          strokeWidth={2.5}
          strokeLinejoin="round"
          points={run.map((i) => `${scale.x(i)},${scale.y(value(rows[i])!)}`).join(" ")}
          className={cls.stroke}
        />
      ))}
    </>
  );
}

/** The area between two values, one shape per run of rows that have both. */
export function Band({
  rows,
  scale,
  lo,
  hi,
}: {
  rows: Row[];
  scale: Scale;
  lo: (r: Row) => number | null;
  hi: (r: Row) => number | null;
}) {
  return (
    <>
      {runsOf(rows, (r) => lo(r) !== null && hi(r) !== null).map((run) => {
        const upper = run.map((i) => `${scale.x(i)},${scale.y(hi(rows[i])!)}`);
        const lower = run.map((i) => `${scale.x(i)},${scale.y(lo(rows[i])!)}`).reverse();
        return (
          <polygon
            key={run[0]}
            data-testid="band"
            points={[...upper, ...lower].join(" ")}
            className="fill-cat1/15"
          />
        );
      })}
    </>
  );
}

/** Dotted vertical lines with a label above the plot. */
export function Markers({ markers, scale }: { markers: Marker[]; scale: Scale }) {
  return (
    <>
      {markers.map(({ i, label, row, end }) => {
        const x = scale.x(i);
        return (
          <g key={`${label}-${i}`}>
            <line
              x1={x}
              x2={x}
              y1={MARKER_ROW[row] + 3}
              y2={scale.bottom}
              strokeDasharray="2 3"
              className="stroke-text-3"
            />
            <text
              x={x + (end ? -4 : 4)}
              y={MARKER_ROW[row]}
              textAnchor={end ? "end" : "start"}
              className="fill-text-2 stroke-surface stroke-[3px] text-[11px] [paint-order:stroke]"
            >
              {label}
            </text>
          </g>
        );
      })}
    </>
  );
}

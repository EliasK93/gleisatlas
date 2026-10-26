import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { api, must, useDatenstand } from "./api";
import { Filters } from "./Filters";
import { LOCALE, t } from "./i18n";
import {
  DEFS,
  formatMonth,
  formatPeriod,
  int,
  readFilters,
  seriesMetric,
  withParam,
  writeFilters,
  type Filters as FilterKeys,
  type Metric,
} from "./metrics";
import type { components } from "./schema";
import {
  EmptyCard,
  ErrorBanner,
  Segmented,
  ShareButton,
  show,
  TipBox,
  tipAt,
  useTip,
  MusterSwitch,
  PRIMARY,
} from "./ui";
import { clearParams, useSetParams } from "./useSetParams";

type Monat = components["schemas"]["Monat"];
type Stats = components["schemas"]["Stats"];
type Gaps = components["schemas"]["Datenstand"]["fehlende_stunden"];
type Scale = { x: (i: number) => number; y: (v: number) => number; bottom: number };

const PAD = { l: 48, r: 22, b: 22 };
const DASH = "5 4";
/** Rows of the marker labels above the plot, and the plot's top edge below them. */
const MARKER_ROW = [11, 31];
const MARKER_TOP = 46;

/** Series are stored in the URL as the page's two views: punctuality, or delay with its band. */
const VIEWS = [
  { value: "puenktlich", label: t("metric.puenktlich") },
  { value: "median", label: t("zv.delay") },
] as const;

const num = new Intl.NumberFormat(LOCALE);
const NBSP = " ";

/**
 * The series of one selection: one row per month with its statistics, `titel` names it. A station
 * or line the API does not know is a page state (null), not an error.
 */
const zeitverlaufQuery = (eva?: string, linie?: string, g?: "regional" | "fern") => ({
  queryKey: ["zeitverlauf", eva, linie, g] as const,
  queryFn: () =>
    api
      .GET("/zeitverlauf", { params: { query: { eva, linie, gattung: g ?? "alle" } } })
      .then((r) => (r.response.status === 404 ? null : must(r))),
});

/** A month's statistics, or nothing for a month without stops (its rate is null). */
const stats = (m: Monat): Stats | undefined =>
  m.ausfallquote === null ? undefined : { ...m, ausfallquote: m.ausfallquote };

const percent = (m: Monat) => (m.puenktlich === null ? null : m.puenktlich * 100);
const cancelRate = (m: Monat) => (m.ausfallquote === null ? null : m.ausfallquote * 100);
const median = (m: Monat) => m.median;

/** Little data by the rule of `show()` (arrived stops for delays), or missing hours: dashed. */
const thin = (m: Monat, metric: Metric, gaps: Gaps) =>
  !!show(metric, stats(m), "").low || (gaps[m.monat] ?? 0) > 0;

/** The text of a month's tooltip: month, value or values (none when little data), n, gaps. */
function tipOf(m: Monat, metric: Metric, gaps: Gaps) {
  const parts = [formatMonth(m.monat)];
  const s = stats(m);
  const low = !!show(metric, s, "").low;
  if (!s) parts.push(t("zv.noData"));
  else {
    if (!low)
      for (const k of metric === "median" ? (["median", "p90"] as const) : [metric]) {
        const v = DEFS[k].value(s);
        parts.push(
          v === null
            ? t("hm.onlyCancelledLegend")
            : t(`metric.${k}.cell`, { v: DEFS[k].format(v) }),
        );
      }
    parts.push(t("station.n", { n: int(m.n) }));
    if (low) parts.push(t("hm.lowLegend"));
  }
  const hours = gaps[m.monat];
  if (hours) parts.push(t("zv.gap", { h: int(hours) }));
  return parts.join(" · ");
}

const STEPS = [0.5, 1, 2, 5, 10, 20, 25, 50, 100];

/** Gridline values from the finest step that covers min to max in at most four intervals. */
function niceTicks(values: number[]) {
  const [min, max] = values.length ? [Math.min(...values), Math.max(...values)] : [0, 100];
  const step = STEPS.find((s) => Math.ceil(max / s) - Math.floor(min / s) <= 4) ?? 100;
  const from = Math.floor(min / step);
  const to = Math.max(Math.ceil(max / step), from + 1);
  return Array.from({ length: to - from + 1 }, (_, i) => (from + i) * step);
}

const nonNull = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

/** Measures its box and hands the width to a chart drawn in plain SVG. */
function Sized({ height, children }: { height: number; children: (width: number) => ReactNode }) {
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

/**
 * The frame of a chart: gridlines with labels, month labels, and a transparent column per month
 * that carries the tooltip. `children` draw in the frame with the month and value scales.
 */
function Plot({
  id,
  label,
  months,
  gaps,
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
  months: Monat[];
  gaps: Gaps;
  metric: Metric;
  width: number;
  height: number;
  top: number;
  ticks: number[];
  unit: string;
  children: (s: Scale) => ReactNode;
}) {
  const band = (width - PAD.l - PAD.r) / months.length;
  const bottom = height - PAD.b;
  const [lo, hi] = [ticks[0], ticks[ticks.length - 1]];
  const scale: Scale = {
    x: (i) => PAD.l + (i + 0.5) * band,
    y: (v) => bottom - ((v - lo) / (hi - lo)) * (bottom - top),
    bottom,
  };
  // Every month gets a column, but a label only where it fits; the latest month always has one.
  const every = Math.ceil(52 / band);
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
            {num.format(v)}
            {NBSP}
            {unit}
          </text>
        </g>
      ))}
      {months.map(
        (m, i) =>
          (months.length - 1 - i) % every === 0 && (
            <text
              key={m.monat}
              x={scale.x(i)}
              y={height - 6}
              textAnchor="middle"
              className="fill-text-3 text-[11px]"
            >
              {formatMonth(m.monat)}
            </text>
          ),
      )}
      {children(scale)}
      {months.map((m, i) => (
        <rect
          key={m.monat}
          data-testid={`${id}-${m.monat}`}
          data-tip={tipOf(m, metric, gaps)}
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
 * One series: a segment between neighbours that both have a value, dashed when either month is
 * thin, and a point per month (hollow when thin). A month without a value leaves a hole.
 */
function Line({
  months,
  metric,
  gaps,
  scale,
  value,
}: {
  months: Monat[];
  metric: Metric;
  gaps: Gaps;
  scale: Scale;
  value: (m: Monat) => number | null;
}) {
  return (
    <>
      {months.map((m, i) => {
        const [from, to] = [months[i - 1], m];
        const [a, b] = [from && value(from), value(to)];
        if (a === undefined || a === null || b === null) return null;
        return (
          <line
            key={m.monat}
            data-testid="segment"
            x1={scale.x(i - 1)}
            y1={scale.y(a)}
            x2={scale.x(i)}
            y2={scale.y(b)}
            strokeWidth={2.5}
            strokeDasharray={thin(from, metric, gaps) || thin(to, metric, gaps) ? DASH : undefined}
            className="stroke-cat1"
          />
        );
      })}
      {months.map((m, i) => {
        const v = value(m);
        return v === null ? null : (
          <circle
            key={m.monat}
            data-testid="point"
            cx={scale.x(i)}
            cy={scale.y(v)}
            r={3.5}
            strokeWidth={2}
            className={thin(m, metric, gaps) ? "fill-surface stroke-cat1" : "fill-cat1 stroke-cat1"}
          />
        );
      })}
    </>
  );
}

/** The area between the median and P90, one shape per run of months that have both. */
function Band({ months, scale }: { months: Monat[]; scale: Scale }) {
  const runs: number[][] = [[]];
  months.forEach((m, i) => {
    if (m.median !== null && m.p90 !== null) runs[runs.length - 1].push(i);
    else if (runs[runs.length - 1].length) runs.push([]);
  });
  return (
    <>
      {runs
        .filter((run) => run.length > 1)
        .map((run) => {
          const upper = run.map((i) => `${scale.x(i)},${scale.y(months[i].p90!)}`);
          const lower = run.map((i) => `${scale.x(i)},${scale.y(months[i].median!)}`).reverse();
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

type Marker = { i: number; label: string; row: number; end: boolean };

/** Dotted vertical lines with a label above the plot. */
function Markers({ markers, scale }: { markers: Marker[]; scale: Scale }) {
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

export default function ZeitverlaufPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const read = readFilters(params);
  // A line wins over a station, and the series switch has two views.
  const f: FilterKeys = {
    ...read,
    bhf: read.linie ? undefined : read.bhf,
    k: seriesMetric(read.k),
  };
  const q = useQuery({
    ...zeitverlaufQuery(f.bhf, f.linie, f.g),
    placeholderData: keepPreviousData,
  });
  const datenstand = useDatenstand();

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  const data = q.data;
  const ds = datenstand.data;
  let body;
  if (q.isError || datenstand.isError)
    body = <ErrorBanner onRetry={() => (q.isError ? q.refetch() : datenstand.refetch())} />;
  else if (data === null)
    body = (
      <EmptyCard
        title={t(f.linie ? "zv.unknownLine" : "station.unknown")}
        hint={t(f.linie ? "zv.unknownLineHint" : "station.unknownHint")}
      >
        <button
          type="button"
          className={`${PRIMARY} mt-4`}
          onClick={() => setParams(withParam(f.linie ? "linie" : "bhf", ""))}
        >
          {t("zv.unknownReset")}
        </button>
      </EmptyCard>
    );
  else if (!data || !ds) body = <Skeleton />;
  else if (data.monate.every((m) => m.n === 0))
    body = (
      <EmptyCard
        title={t("zv.empty")}
        hint={t("zv.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else
    body = (
      <View
        months={data.monate}
        title={data.titel ?? t("zv.nationwide")}
        metric={f.k}
        gaps={ds.fehlende_stunden}
        timetable={ds.fahrplanwechsel}
        coverage={ds.vollabdeckung_ab}
        onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
      />
    );

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">
      <MusterSwitch />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("nav.discover")}</p>
          <h1 className="text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
            {t("nav.timeline")}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-text-2">{t("zv.lead")}</p>
        </div>
        <ShareButton />
      </div>
      <Filters noPeriod lineTitle={data?.titel ?? undefined} />
      {body}
    </div>
  );
}

function View({
  months,
  title,
  metric,
  gaps,
  timetable,
  coverage,
  onMetric,
}: {
  months: Monat[];
  title: string;
  metric: Metric;
  gaps: Gaps;
  timetable: string[];
  coverage: string;
  onMetric: (m: Metric) => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useTip();
  const delay = metric === "median";
  const total = months.reduce((sum, m) => sum + m.n, 0);

  // The timetable change labels sit above the coverage label, so two neighbours never overlap.
  const at = (month: string) => months.findIndex((m) => m.monat === month);
  // The start of full coverage only means something when earlier months are shown too.
  const widened = at(coverage) > 0;
  const markers: Marker[] = [
    ...timetable
      .map((d) => at(d.slice(0, 7)))
      .filter((i) => i >= 0)
      .map((i) => ({ i, label: t("zv.marker.timetable"), row: 0, end: i > months.length - 5 })),
    ...(widened
      ? [{ i: at(coverage), label: t("zv.marker.coverage"), row: 1, end: at(coverage) > 4 }]
      : []),
  ];
  const top = markers.length ? MARKER_TOP : 10;
  // A median can lie below zero (an early train), so the delay scale covers it as well.
  const values = nonNull(delay ? months.flatMap((m) => [m.p90, m.median]) : months.map(percent));

  return (
    <div
      className="flex flex-col gap-4"
      onPointerMove={(e) => setTip(tipAt(e))}
      onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}
    >
      <section aria-labelledby="zv-main" className="card min-w-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div>
            <h2 id="zv-main" className="text-base font-[620]">
              {t(delay ? "zv.chart.delay" : "zv.chart.puenktlich")}
            </h2>
            <p className="text-[13px] text-text-2">{title}</p>
          </div>
          <Segmented
            label={t("metric.label")}
            options={[...VIEWS]}
            value={metric}
            onChange={onMetric}
            className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
          />
        </div>
        <p className="mb-2 text-xs text-text-3">
          {t("zv.meta", {
            n: int(total),
            period: formatPeriod(months[0].monat, months[months.length - 1].monat),
          })}
        </p>
        {asTable ? (
          <Table months={months} gaps={gaps} metric={metric} />
        ) : (
          <Sized height={260}>
            {(width) => (
              <Plot
                id="zv"
                label={t(delay ? "zv.chart.delay" : "zv.chart.puenktlich")}
                months={months}
                gaps={gaps}
                metric={metric}
                width={width}
                height={260}
                top={top}
                ticks={niceTicks(delay ? [0, ...values] : values)}
                unit={t(delay ? "unit.min" : "unit.pct")}
              >
                {(scale) => (
                  <>
                    <Markers markers={markers} scale={scale} />
                    {delay && <Band months={months} scale={scale} />}
                    <Line
                      months={months}
                      metric={metric}
                      gaps={gaps}
                      scale={scale}
                      value={delay ? median : percent}
                    />
                  </>
                )}
              </Plot>
            )}
          </Sized>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
          {!asTable && (
            <>
              {delay && <span>{t("zv.legend.band")}</span>}
              <span>{t("zv.legend.dashed")}</span>
              {widened && (
                <span>
                  {t("zv.legend.coverage", {
                    until: formatMonth(months[at(coverage) - 1].monat),
                    from: formatMonth(coverage),
                  })}
                </span>
              )}
            </>
          )}
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
            className={`hit ml-auto cursor-pointer rounded-md px-2 py-1 ${
              asTable ? "bg-accent-soft text-accent" : "text-text-3 hover:text-text"
            }`}
          >
            {t("hm.asTable")}
          </button>
        </div>
      </section>

      {!asTable && (
        <section aria-labelledby="zv-cancel" className="card min-w-0">
          <h2 id="zv-cancel" className="mb-3 text-base font-[620]">
            {t("zv.chart.ausfall")}
          </h2>
          <Sized height={150}>
            {(width) => (
              <Plot
                id="zc"
                label={t("zv.chart.ausfall")}
                months={months}
                gaps={gaps}
                metric="ausfall"
                width={width}
                height={150}
                top={8}
                ticks={niceTicks([0, ...nonNull(months.map(cancelRate))])}
                unit={t("unit.pct")}
              >
                {(scale) =>
                  months.map((m, i) => {
                    const v = cancelRate(m);
                    if (v === null) return null;
                    const w = Math.max((width - PAD.l - PAD.r) / months.length - 3, 2);
                    return (
                      <rect
                        key={m.monat}
                        data-testid="bar"
                        x={scale.x(i) - w / 2}
                        y={scale.y(v)}
                        width={w}
                        height={scale.y(0) - scale.y(v)}
                        rx={2}
                        fillOpacity={thin(m, "ausfall", gaps) ? 0.45 : 1}
                        className="fill-cancel"
                      />
                    );
                  })
                }
              </Plot>
            )}
          </Sized>
        </section>
      )}
      <TipBox tip={tip} />
    </div>
  );
}

/** Every month as a row: the accessible form of both charts. */
function Table({ months, gaps, metric }: { months: Monat[]; gaps: Gaps; metric: Metric }) {
  const keys: Metric[] =
    metric === "median" ? ["median", "p90", "ausfall"] : ["puenktlich", "ausfall"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] tabular-nums">
        <caption className="sr-only">{t("zv.table")}</caption>
        <thead>
          <tr className="text-left text-xs text-text-3">
            <th scope="col" className="py-1.5 pr-3 font-normal">
              {t("zv.col.month")}
            </th>
            {keys.map((k) => (
              <th key={k} scope="col" className="px-3 py-1.5 text-right font-normal">
                {t(`metric.${k}`)}
              </th>
            ))}
            <th scope="col" className="px-3 py-1.5 text-right font-normal">
              {t("zv.col.n")}
            </th>
            <th scope="col" className="py-1.5 pl-3 text-right font-normal">
              {t("zv.col.gap")}
            </th>
          </tr>
        </thead>
        <tbody>
          {months.map((m) => (
            <tr key={m.monat} className="border-t border-border">
              <th scope="row" className="py-1.5 pr-3 text-left font-[550] whitespace-nowrap">
                {formatMonth(m.monat)}
              </th>
              {keys.map((k) => (
                <td key={k} className="px-3 py-1.5 text-right whitespace-nowrap">
                  {show(k, stats(m), "").text}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right">{int(m.n)}</td>
              <td className="py-1.5 pl-3 text-right">{gaps[m.monat] ?? "–"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Skeleton() {
  return (
    <div role="status" className="flex flex-col gap-4">
      <span className="sr-only">{t("state.loading")}</span>
      <div className="h-[330px] animate-pulse rounded-xl bg-surface-2" />
      <div className="h-[220px] animate-pulse rounded-xl bg-surface-2" />
    </div>
  );
}

/**
 * The station page's card: punctuality of the last 12 months with the latest value and a link to
 * the full series of this station. Months with little data or gaps are dashed like in the series.
 */
export function Sparkline({
  eva,
  g,
  to,
}: {
  eva: string;
  g?: "regional" | "fern";
  to: { pathname: string; search: string };
}) {
  const q = useQuery(zeitverlaufQuery(eva, undefined, g));
  const datenstand = useDatenstand();
  const [tip, setTip] = useTip();
  const months = q.data?.monate.slice(-12) ?? [];
  // The headline is the latest month that shows a value, by the same rule as the table.
  const latest = months.findLast((m) => show("puenktlich", stats(m), "").value !== undefined);
  const gaps = datenstand.data?.fehlende_stunden ?? {};

  let body;
  if (q.isError || datenstand.isError)
    body = <ErrorBanner onRetry={() => (q.isError ? q.refetch() : datenstand.refetch())} />;
  else if (q.data === undefined || !datenstand.data)
    body = (
      <div role="status" className="h-[110px] animate-pulse rounded-lg bg-surface-2">
        <span className="sr-only">{t("state.loading")}</span>
      </div>
    );
  else if (!months.some((m) => m.n > 0))
    body = <p className="text-text-2">{t("station.history.none")}</p>;
  else
    body = (
      <div
        onPointerMove={(e) => setTip(tipAt(e))}
        onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}
      >
        <p className="mb-1 flex items-baseline gap-2">
          <b className="text-[22px] font-[650] tabular-nums">
            {latest ? show("puenktlich", stats(latest), "").text : "–"}
          </b>
          <span className="text-[13px] text-text-2">
            {latest
              ? t("station.history.latest", { month: formatMonth(latest.monat), n: int(latest.n) })
              : t("hm.lowLegend")}
          </span>
        </p>
        <Sized height={110}>
          {(width) => (
            <Plot
              id="sp"
              label={t("station.history.chart")}
              months={months}
              gaps={gaps}
              metric="puenktlich"
              width={width}
              height={110}
              top={8}
              ticks={niceTicks(nonNull(months.map(percent)))}
              unit={t("unit.pct")}
            >
              {(scale) => (
                <Line
                  months={months}
                  metric="puenktlich"
                  gaps={gaps}
                  scale={scale}
                  value={percent}
                />
              )}
            </Plot>
          )}
        </Sized>
        <p className="mt-2 text-xs text-text-3">{t("zv.legend.dashed")}</p>
        <TipBox tip={tip} />
      </div>
    );
  return (
    <section aria-labelledby="st-history" className="card min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="st-history" className="text-base font-[620]">
          {t("station.history")}
        </h2>
        <Link to={to} className="hit inline-block text-[13px] text-text-2 hover:text-text">
          {t("station.history.open")}
        </Link>
      </div>
      {body}
    </section>
  );
}

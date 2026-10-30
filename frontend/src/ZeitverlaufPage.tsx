import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { api, must, useDatenstand } from "./api";
import {
  Band,
  cancelRate,
  CANCEL,
  isDay,
  Line,
  Markers,
  MARKER_TOP,
  median,
  niceTicks,
  nonNull,
  p90,
  PAD,
  percent,
  Plot,
  rowLabel,
  Sized,
  stats,
  trendValue,
  TrendLine,
  thin,
  type Marker,
  type Row,
} from "./charts";
import { Filters } from "./Filters";
import { t } from "./i18n";
import {
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
type Tag = components["schemas"]["Tag"];
type Gaps = components["schemas"]["Datenstand"]["fehlende_stunden"];

/** Series are stored in the URL as the page's two views: punctuality, or delay with its band. */
const VIEWS = [
  { value: "puenktlich", label: t("metric.puenktlich") },
  { value: "median", label: t("zv.delay") },
] as const;

/** The resolution switch; the month view is `z=monat`, the day view has no key. */
const RESOLUTIONS = [
  { value: "tag", label: t("zv.view.day") },
  { value: "monat", label: t("zv.view.month") },
] as const;

/** The chart names per resolution; they are the charts' accessible names. */
const NAMES = {
  month: {
    puenktlich: t("zv.chart.puenktlich"),
    delay: t("zv.chart.delay"),
    ausfall: t("zv.chart.ausfall"),
  },
  day: {
    puenktlich: t("zv.chart.puenktlich.day"),
    delay: t("zv.chart.delay.day"),
    ausfall: t("zv.chart.ausfall.day"),
  },
};

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

/** The same for days (no lines), each with its trend. */
const tagesverlaufQuery = (eva?: string, g?: "regional" | "fern") => ({
  queryKey: ["tagesverlauf", eva, g] as const,
  queryFn: () =>
    api
      .GET("/tagesverlauf", { params: { query: { eva, gattung: g ?? "alle" } } })
      .then((r) => (r.response.status === 404 ? null : must(r))),
});

/** Months and days as the rows the charts draw; a month's gap hours come from /datenstand. */
const monthRows = (months: Monat[], gaps: Gaps): Row[] =>
  months.map(({ monat, ...m }) => ({ ...m, key: monat, missing: gaps[monat] ?? 0 }));
const dayRows = (days: Tag[]): Row[] =>
  days.map(({ tag, fehlende_stunden, ...d }) => ({ ...d, key: tag, missing: fehlende_stunden }));

const trendOf = (metric: Metric) => (r: Row) => trendValue(r, metric);

export default function ZeitverlaufPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const read = readFilters(params);
  // A line wins over a station and only exists per month, so it has no view switch either.
  const f: FilterKeys = {
    ...read,
    tag: undefined,
    bhf: read.linie ? undefined : read.bhf,
    z: read.linie ? undefined : read.z,
    k: seriesMetric(read.k),
  };
  // Days are the default; a line only exists per month.
  const day = !f.linie && f.z !== "monat";
  const months = useQuery({
    ...zeitverlaufQuery(f.bhf, f.linie, f.g),
    enabled: !day,
    placeholderData: keepPreviousData,
  });
  const days = useQuery({
    ...tagesverlaufQuery(f.bhf, f.g),
    enabled: day,
    placeholderData: keepPreviousData,
  });
  const q = day ? days : months;
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
  else {
    const rows = "tage" in data ? dayRows(data.tage) : monthRows(data.monate, ds.fehlende_stunden);
    body = rows.every((r) => r.n === 0) ? (
      <EmptyCard
        title={t(day ? "zv.empty.day" : "zv.empty")}
        hint={t(day ? "zv.emptyHint.day" : "zv.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    ) : (
      <View
        rows={rows}
        title={data.titel ?? t("zv.nationwide")}
        metric={f.k}
        timetable={ds.fahrplanwechsel}
        coverage={ds.vollabdeckung_ab}
        onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
      />
    );
  }

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">
      <MusterSwitch />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("nav.discover")}</p>
          <h1 className="text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
            {t("nav.timeline")}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-text-2">{t(day ? "zv.lead.day" : "zv.lead")}</p>
        </div>
        <ShareButton />
      </div>
      <Filters noPeriod lineTitle={data?.titel ?? undefined} />
      {!f.linie && (
        <div className="mb-3">
          <Segmented
            label={t("zv.view.label")}
            options={[...RESOLUTIONS]}
            value={day ? "tag" : "monat"}
            onChange={(v) => setParams(withParam("z", v === "monat" ? v : ""))}
            className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
          />
        </div>
      )}
      {body}
    </div>
  );
}

function View({
  rows,
  title,
  metric,
  timetable,
  coverage,
  onMetric,
}: {
  rows: Row[];
  title: string;
  metric: Metric;
  timetable: string[];
  coverage: string;
  onMetric: (m: Metric) => void;
}) {
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useTip();
  const day = isDay(rows[0]);
  const names = NAMES[day ? "day" : "month"];
  const delay = metric === "median";
  const total = rows.reduce((sum, r) => sum + r.n, 0);

  // The timetable change labels sit above the coverage label, so two neighbours never overlap.
  const at = (date: string) => {
    const key = day ? (date.length === 7 ? `${date}-01` : date) : date.slice(0, 7);
    return rows.findIndex((r) => r.key === key);
  };
  // The start of full coverage only means something when earlier months are shown too.
  const widened = at(coverage) > 0;
  // A label this close to a side is anchored to it (the last four months, or the same share of days).
  const near = day ? Math.round(rows.length * 0.16) : 4;
  const markers: Marker[] = [
    ...timetable
      .map(at)
      .filter((i) => i >= 0)
      .map((i) => ({
        i,
        label: t("zv.marker.timetable"),
        row: 0,
        end: i > rows.length - 1 - near,
      })),
    ...(widened
      ? [{ i: at(coverage), label: t("zv.marker.coverage"), row: 1, end: at(coverage) > near }]
      : []),
  ];
  const top = markers.length ? MARKER_TOP : 10;
  // A median can lie below zero (an early train), so the delay scale covers it as well.
  const values = nonNull(
    rows.flatMap((r) =>
      delay
        ? [r.median, r.p90, trendValue(r, "median"), trendValue(r, "p90")]
        : [percent(r), trendValue(r, "puenktlich")],
    ),
  );
  const cancelValues = rows.flatMap((r) => [cancelRate(r), trendValue(r, "ausfall")]);
  const [first, last] = [rows[0].key.slice(0, 7), rows[rows.length - 1].key.slice(0, 7)];

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
              {delay ? names.delay : names.puenktlich}
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
          {t(day ? "zv.meta.day" : "zv.meta", { n: int(total), period: formatPeriod(first, last) })}
        </p>
        {asTable ? (
          <Table rows={rows} metric={metric} />
        ) : (
          <Sized height={260}>
            {(width) => (
              <Plot
                id="zv"
                label={delay ? names.delay : names.puenktlich}
                rows={rows}
                metric={metric}
                width={width}
                height={260}
                top={top}
                ticks={niceTicks(delay ? [0, ...values] : values)}
                unit={delay ? "unit.min" : "unit.pct"}
              >
                {(scale) => (
                  <>
                    <Markers markers={markers} scale={scale} />
                    {delay && (
                      <Band
                        rows={rows}
                        scale={scale}
                        lo={day ? trendOf("median") : median}
                        hi={day ? trendOf("p90") : p90}
                      />
                    )}
                    <Line
                      rows={rows}
                      metric={metric}
                      scale={scale}
                      value={delay ? median : percent}
                    />
                    {day && (
                      <TrendLine
                        rows={rows}
                        scale={scale}
                        value={trendOf(delay ? "median" : "puenktlich")}
                      />
                    )}
                  </>
                )}
              </Plot>
            )}
          </Sized>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-2">
          {!asTable && (
            <>
              {day && <span>{t("zv.legend.trend")}</span>}
              {delay && <span>{t(day ? "zv.legend.bandDay" : "zv.legend.band")}</span>}
              <span>{t("zv.legend.dashed")}</span>
              {widened && (
                <span>
                  {t("zv.legend.coverage", {
                    until: formatMonth(rows[at(coverage) - 1].key.slice(0, 7)),
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
            {names.ausfall}
          </h2>
          <Sized height={150}>
            {(width) => (
              <Plot
                id="zc"
                label={names.ausfall}
                rows={rows}
                metric="ausfall"
                width={width}
                height={150}
                top={8}
                ticks={niceTicks([0, ...nonNull(cancelValues)])}
                unit="unit.pct"
              >
                {(scale) =>
                  day ? (
                    <>
                      <Line
                        rows={rows}
                        metric="ausfall"
                        scale={scale}
                        value={cancelRate}
                        cls={CANCEL}
                      />
                      <TrendLine
                        rows={rows}
                        scale={scale}
                        value={trendOf("ausfall")}
                        cls={CANCEL}
                      />
                    </>
                  ) : (
                    rows.map((r, i) => {
                      const v = cancelRate(r);
                      if (v === null) return null;
                      const w = Math.max((width - PAD.l - PAD.r) / rows.length - 3, 2);
                      return (
                        <rect
                          key={r.key}
                          data-testid="bar"
                          x={scale.x(i) - w / 2}
                          y={scale.y(v)}
                          width={w}
                          height={scale.y(0) - scale.y(v)}
                          rx={2}
                          fillOpacity={thin(r, "ausfall") ? 0.45 : 1}
                          className="fill-cancel"
                        />
                      );
                    })
                  )
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

/** Every row as a line: the accessible form of both charts. */
function Table({ rows, metric }: { rows: Row[]; metric: Metric }) {
  const day = isDay(rows[0]);
  const keys: Metric[] =
    metric === "median" ? ["median", "p90", "ausfall"] : ["puenktlich", "ausfall"];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] tabular-nums">
        <caption className="sr-only">{t(day ? "zv.table.day" : "zv.table")}</caption>
        <thead>
          <tr className="text-left text-xs text-text-3">
            <th scope="col" className="py-1.5 pr-3 font-normal">
              {t(day ? "zv.col.day" : "zv.col.month")}
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
          {rows.map((r) => (
            <tr key={r.key} className="border-t border-border">
              <th scope="row" className="py-1.5 pr-3 text-left font-[550] whitespace-nowrap">
                {rowLabel(r)}
              </th>
              {keys.map((k) => (
                <td key={k} className="px-3 py-1.5 text-right whitespace-nowrap">
                  {show(k, stats(r), "").text}
                </td>
              ))}
              <td className="px-3 py-1.5 text-right">{int(r.n)}</td>
              <td className="py-1.5 pl-3 text-right">{r.missing || "–"}</td>
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
  const rows = monthRows(q.data?.monate.slice(-12) ?? [], datenstand.data?.fehlende_stunden ?? {});
  // The headline is the latest month that shows a value, by the same rule as the table.
  const latest = rows.findLast((r) => show("puenktlich", stats(r), "").value !== undefined);

  let body;
  if (q.isError || datenstand.isError)
    body = <ErrorBanner onRetry={() => (q.isError ? q.refetch() : datenstand.refetch())} />;
  else if (q.data === undefined || !datenstand.data)
    body = (
      <div role="status" className="h-[110px] animate-pulse rounded-lg bg-surface-2">
        <span className="sr-only">{t("state.loading")}</span>
      </div>
    );
  else if (!rows.some((r) => r.n > 0))
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
              ? t("station.history.latest", { month: formatMonth(latest.key), n: int(latest.n) })
              : t("hm.lowLegend")}
          </span>
        </p>
        <Sized height={110}>
          {(width) => (
            <Plot
              id="sp"
              label={t("station.history.chart")}
              rows={rows}
              metric="puenktlich"
              width={width}
              height={110}
              top={8}
              ticks={niceTicks(nonNull(rows.map(percent)))}
              unit="unit.pct"
            >
              {(scale) => <Line rows={rows} metric="puenktlich" scale={scale} value={percent} />}
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

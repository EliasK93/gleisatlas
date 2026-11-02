import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, must, useMonthPeriod } from "./api";
import { Filters } from "./Filters";
import { t, type MessageKey } from "./i18n";
import { Icon, type IconName } from "./Icon";
import {
  binLabel,
  dayName,
  DEFS,
  formatPeriod,
  int,
  METRICS,
  readFilters,
  share,
  tenths,
  withParam,
  writeFilters,
  type Filters as FilterKeys,
  type Metric,
} from "./metrics";
import type { components } from "./schema";
import {
  Badge,
  Cancelled,
  EmptyCard,
  ErrorBanner,
  FILL,
  HEATMAP,
  MAP,
  MetricSwitch,
  MiniBar,
  Segmented,
  ShareButton,
  show,
  SoonTag,
  ZEITVERLAUF,
  type Shown,
  SlowHint,
} from "./ui";
import { StationSearch, useOpenStation } from "./StationSearch";
import { Sparkline } from "./ZeitverlaufPage";

type Statistik = components["schemas"]["Statistik"];
type Heatmap = components["schemas"]["Heatmap"];

const DAYS = Array.from({ length: 7 }, (_, d) => d);
const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Scale class of each delay bin, as in the mockup. */
const BIN_CLASS = [1, 1, 2, 3, 4, 5, 5];
/** The tallest bar in px. */
const BAR_MAX = 120;

export default function StationPage() {
  const { eva = "" } = useParams();
  const valid = /^\d+$/.test(eva);
  const [params] = useSearchParams();
  const setParams = useSetParams();
  // The station is the page, so a bhf key has no meaning here, nor has a line.
  const f: FilterKeys = {
    ...readFilters(params),
    bhf: undefined,
    tag: undefined,
    land: undefined,
    linie: undefined,
    z: undefined,
  };
  // Days in the URL round outward: this page asks for whole months.
  const m = useMonthPeriod(f);
  const q = useQuery({
    queryKey: ["statistik", eva, f.g, m.von, m.bis],
    queryFn: async () => {
      const r = await api.GET("/stationen/{eva}/statistik", {
        params: { path: { eva }, query: { gattung: f.g ?? "alle", von: m.von, bis: m.bis } },
      });
      // An unknown station is a page state, not an error.
      return r.response.status === 404 ? null : must(r);
    },
    enabled: valid && m.ready,
    // A filter change keeps the old numbers on screen; another station does not.
    placeholderData: (previous, query) => (query?.queryKey[1] === eva ? previous : undefined),
  });

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  const data = q.data;
  if (!valid || data === null)
    return (
      <Page>
        <Unknown />
      </Page>
    );

  const period = data?.n ? formatPeriod(data.von, data.bis) : undefined;
  const name = data?.station.name ?? t("filter.eva", { eva });
  const to = (pathname: string) => ({
    pathname,
    search: writeFilters({ ...f, bhf: eva }).toString(),
  });

  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!data) body = <Skeleton />;
  else if (data.n === 0)
    body = (
      <EmptyCard
        title={t("station.empty")}
        hint={t("station.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else
    body = (
      <StationView
        data={data}
        f={f}
        metric={f.k}
        period={period}
        heatmapTo={to(HEATMAP)}
        timelineTo={to(ZEITVERLAUF)}
        onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
      />
    );

  return (
    <Page>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <nav aria-label={t("station.crumb")} className="mb-1.5 text-[12.5px] text-text-3">
            <Link to={to(MAP)} className="hit inline-block hover:text-text">
              {t("nav.map")}
            </Link>
            <span aria-hidden="true"> › </span>
            {name}
          </nav>
          <h1 className="text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
            {name}
          </h1>
          <p className="mt-1 text-xs text-text-3">
            {[t("filter.eva", { eva }), data?.station.land].filter(Boolean).join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ShareButton />
          <SoonAction icon="route" label="map.fromHere" />
          <SoonAction icon="xfer" label="station.transfers" />
        </div>
      </div>
      <Filters noStation />
      {body}
    </Page>
  );
}

const Page = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">{children}</div>
);

/** A page that is not built yet: dimmed, tagged "bald", not a link. */
function SoonAction({ icon, label }: { icon: IconName; label: MessageKey }) {
  return (
    <span className="inline-flex h-[34px] items-center gap-1.5 rounded-lg border border-border px-3 font-medium text-text-2 opacity-55">
      <Icon name={icon} className="size-4" />
      {t(label)}
      <SoonTag />
    </span>
  );
}

function Unknown() {
  const open = useOpenStation();
  return (
    <EmptyCard heading="h1" title={t("station.unknown")} hint={t("station.unknownHint")}>
      <div className="mx-auto mt-4 max-w-sm text-left">
        <StationSearch variant="inline" label={t("filter.stationSearch")} onPick={open} />
      </div>
    </EmptyCard>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      <SlowHint />
      <div role="status" className="flex animate-pulse flex-col gap-4">
        <span className="sr-only">{t("state.loading")}</span>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-[118px] rounded-xl bg-surface-2" />
          ))}
        </div>
        <div className="h-[260px] rounded-xl bg-surface-2" />
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="h-[180px] rounded-xl bg-surface-2" />
          <div className="h-[180px] rounded-xl bg-surface-2" />
        </div>
      </div>
    </div>
  );
}

/** The sentence under a tile's value; what stands in for a value that is not shown. */
function sentence(metric: Metric, shown: Shown, data: Statistik) {
  if (shown.value === undefined) return shown.low ? t("hm.lowLegend") : t("hm.onlyCancelledLegend");
  if (metric === "puenktlich") return t("station.sentence.puenktlich", { x: tenths(shown.value) });
  if (metric !== "ausfall") return t(`station.sentence.${metric}`);
  if (data.ausgefallen === 0) return t("station.sentence.noCancel");
  // The rate is rounded to 0.1 %, so a smaller one has no sensible "1 von N".
  if (shown.value < 0.1) return t("station.sentence.ausfallRare");
  return t("station.sentence.ausfall", { n: int(Math.round(100 / shown.value)) });
}

function StationView({
  data,
  f,
  metric,
  period,
  heatmapTo,
  timelineTo,
  onMetric,
}: {
  data: Statistik;
  f: FilterKeys;
  metric: Metric;
  period?: string;
  heatmapTo: { pathname: string; search: string };
  timelineTo: { pathname: string; search: string };
  onMetric: (m: Metric) => void;
}) {
  const meta = t("hm.meta", { n: int(data.n), period: period ?? "" });
  const tiles = METRICS.map((m) => ({ m, shown: show(m, data.gesamt ?? undefined, "") }));
  return (
    <div className="flex flex-col gap-4">
      {tiles.some((x) => x.shown.low) && (
        <p className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px]">
          <span aria-hidden="true">◌</span>
          {t("map.lowNote", { n: int(data.n) })}
        </p>
      )}

      <ul
        aria-label={t("station.tiles")}
        className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4"
      >
        {tiles.map(({ m, shown }) => {
          const cancel = m === "ausfall";
          return (
            <li
              key={m}
              className="relative flex flex-col gap-1 overflow-hidden rounded-xl border border-border bg-surface p-4 pl-5"
            >
              <i
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 w-1 ${cancel && !shown.low ? "bg-cancel" : shown.fill}`}
              />
              <div className="flex items-center gap-1.5 text-[12.5px] font-[550] text-text-2">
                {cancel && (
                  <span aria-hidden="true" className="font-semibold text-cancel">
                    ✕
                  </span>
                )}
                {/* ponytail: a native title is hover-only; use a popover when touch users need the explanation */}
                <span
                  title={t(`metric.${m}.help`)}
                  className="cursor-help underline decoration-text-3 decoration-dotted underline-offset-[3px]"
                >
                  {t(`metric.${m}`)}
                </span>
              </div>
              <div
                className={`text-[32px] leading-[1.1] font-[650] tracking-[-0.02em] tabular-nums ${
                  shown.low ? "text-text-3" : cancel ? "text-cancel" : ""
                }`}
              >
                {shown.text}
              </div>
              <p className="text-[13px] text-text-2">{sentence(m, shown, data)}</p>
              <p className="mt-auto pt-1.5 text-xs text-text-3">{meta}</p>
            </li>
          );
        })}
      </ul>

      <Distribution data={data} meta={meta} />

      <MetricSwitch
        metric={metric}
        onMetric={onMetric}
        className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <MiniHeatmap eva={data.station.eva} f={f} metric={metric} to={heatmapTo} />
        <Groups data={data} metric={metric} />
      </div>

      <Lines key={data.station.eva} eva={data.station.eva} f={f} />
      <Sparkline eva={data.station.eva} g={f.g} to={timelineTo} />
    </div>
  );
}

/** Shares of all planned stops by delay, with the cancelled share set apart as its own bar. */
function Distribution({ data, meta }: { data: Statistik; meta: string }) {
  const shares = data.verteilung.map((v) => (v / data.n) * 100);
  const cancelled = Math.round((data.ausgefallen / data.n) * 1000) / 10;
  const most = Math.max(...shares, cancelled, 1);
  const height = (v: number) => ({
    height: v > 0 ? Math.max(Math.round((v / most) * BAR_MAX), 3) : 0,
  });
  const cancelledText = DEFS.ausfall.format(cancelled);
  return (
    <section aria-labelledby="st-dist" className="card">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="st-dist" className="text-base font-[620]">
            {t("station.dist.title")}
          </h2>
          <p className="text-[13px] text-text-2">{t("station.dist.sub")}</p>
        </div>
        <span className="text-xs text-text-3">{meta}</span>
      </div>
      <ul className="flex items-end gap-1 pt-4 md:gap-1.5">
        {shares.map((v, i) => (
          <li key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end">
            <span className="sr-only">
              {t("station.dist.bin", { range: binLabel(i), share: share(v) })}
            </span>
            <span aria-hidden="true" className="mb-[3px] text-[11.5px] font-semibold tabular-nums">
              {share(v)}
            </span>
            <i
              aria-hidden="true"
              className={`block w-full rounded-t-[5px] ${FILL.r[BIN_CLASS[i] - 1]}`}
              style={height(v)}
            />
            <span aria-hidden="true" className="mt-[5px] text-[11px] whitespace-nowrap text-text-3">
              {binLabel(i)}
            </span>
          </li>
        ))}
        <li className="ml-2 flex min-w-0 flex-[2.2] flex-col items-center justify-end border-l border-dashed border-border pl-1.5 md:ml-3 md:flex-[0.9] md:pl-3">
          <span className="sr-only">{t("metric.ausfall.cell", { v: cancelledText })}</span>
          <span
            aria-hidden="true"
            className="mb-[3px] text-[11.5px] font-semibold text-cancel tabular-nums"
          >
            {cancelledText}
          </span>
          <i
            aria-hidden="true"
            className="hatch-cancel block w-full rounded-t-[5px] border-[1.5px] border-b-0 border-cancel"
            style={height(cancelled)}
          />
          <span
            aria-hidden="true"
            className="mt-[5px] text-[10.5px] font-semibold whitespace-nowrap text-cancel md:text-[11px]"
          >
            ✕ {t("station.dist.cancelled")}
          </span>
        </li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-x-4 text-xs text-text-2">
        <span>{t("station.dist.onTime")}</span>
        <span className="ml-auto">{t("station.dist.late")}</span>
      </div>
    </section>
  );
}

/** Compact weekday × hour colour grid for the selected metric; the full heatmap is the accessible table. */
function MiniHeatmap({
  eva,
  f,
  metric,
  to,
}: {
  eva: string;
  f: FilterKeys;
  metric: Metric;
  to: { pathname: string; search: string };
}) {
  // The same key shape as the heatmap page, so the cache is shared.
  const m = useMonthPeriod(f);
  const q = useQuery({
    queryKey: ["heatmap", f.g, eva, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/heatmap", {
          params: { query: { gattung: f.g ?? "alle", eva, von: m.von, bis: m.bis } },
        })
        .then(must),
    enabled: m.ready,
  });
  let body;
  if (q.isError) body = <p className="text-text-2">{t("state.error")}</p>;
  else if (!q.data)
    body = (
      <div role="status" className="h-[130px] animate-pulse rounded-lg bg-surface-2">
        <span className="sr-only">{t("state.loading")}</span>
      </div>
    );
  else body = <HeatGrid data={q.data} metric={metric} />;
  return (
    <section aria-labelledby="st-hm" className="card min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="st-hm" className="text-base font-[620]">
          {t("nav.heatmap")}
        </h2>
        <Link to={to} className="hit inline-block text-[13px] text-text-2 hover:text-text">
          {t("station.hm.open")}
        </Link>
      </div>
      {body}
      <p className="mt-3 text-xs text-text-3">
        {t("station.hm.note", { metric: t(`metric.${metric}`) })}
      </p>
    </section>
  );
}

function HeatGrid({ data, metric }: { data: Heatmap; metric: Metric }) {
  const byKey = new Map(data.cells.map((c) => [c.weekday * 24 + c.hour, c]));
  return (
    <div
      role="img"
      aria-label={t("hm.caption", { metric: t(`metric.${metric}`) })}
      className="grid grid-cols-[auto_repeat(24,minmax(0,1fr))] gap-0.5 text-[10px] text-text-3"
    >
      {DAYS.map((d) => (
        <Fragment key={d}>
          <span className="pr-1.5 leading-[14px] font-[550]">{dayName(d, true)}</span>
          {HOURS.map((h) => (
            <i
              key={h}
              className={`block h-3.5 rounded-xs ${show(metric, byKey.get(d * 24 + h), "").fill}`}
            />
          ))}
        </Fragment>
      ))}
      <span />
      {[0, 6, 12, 18].map((h) => (
        <span key={h} className="col-span-6 tabular-nums">
          {h}
        </span>
      ))}
    </div>
  );
}

/** One bar per train category with the selected metric's value and n. */
function Groups({ data, metric }: { data: Statistik; metric: Metric }) {
  const rows = data.gruppen.map((g) => ({ g, shown: show(metric, g, g.gruppe) }));
  const most = Math.max(...rows.map((r) => r.shown.value ?? 0), 1);
  return (
    <section aria-labelledby="st-groups" className="card min-w-0">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 id="st-groups" className="text-base font-[620]">
          {t("station.groups")}
        </h2>
        <span className="text-xs text-text-3">{t(`metric.${metric}`)}</span>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map(({ g, shown }) => (
          <li key={g.gruppe} className="grid grid-cols-[96px_1fr_auto] items-center gap-3">
            <Badge>{t(g.gruppe === "fern" ? "filter.fern" : "filter.regional")}</Badge>
            <MiniBar metric={metric} shown={shown} most={most} />
            <span className="text-right">
              <b className="block font-semibold tabular-nums">{shown.text}</b>
              <span className="block text-xs text-text-3">{t("station.n", { n: int(g.n) })}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const LINES_FIRST = 10;

type Linie = components["schemas"]["StationLinie"];

/**
 * The lines with a value in reverse order, then the ones whose stops were all cancelled, then the
 * ones with too little data, each as they were.
 */
const bestFirst = (lines: Linie[]) => {
  const rank = (l: Linie) => {
    const s = show("puenktlich", l, "");
    return s.low ? 2 : s.value === undefined ? 1 : 0;
  };
  const part = (r: number) => lines.filter((l) => rank(l) === r);
  return [...part(0).reverse(), ...part(1), ...part(2)];
};

const ORDERS = [
  { value: "worst", label: t("station.lines.worstFirst") },
  { value: "best", label: t("station.lines.bestFirst") },
] as const;

/**
 * The lines at this station, worst first as the API orders them (lines with too little data
 * last) or best first: the first ten, then all.
 */
function Lines({ eva, f }: { eva: string; f: FilterKeys }) {
  const id = useId();
  const [all, setAll] = useState(false);
  const [order, setOrder] = useState<"worst" | "best">("worst");
  // After "Alle anzeigen" focus moves on to the first row it revealed; after "Weniger anzeigen"
  // it stays on the same button, which then reads "Alle anzeigen" again.
  const firstNew = useRef<HTMLAnchorElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (all) firstNew.current?.focus();
  }, [all]);
  const m = useMonthPeriod(f);
  const q = useQuery({
    queryKey: ["linien", eva, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/stationen/{eva}/linien", {
          params: { path: { eva }, query: { gattung: f.g ?? "alle", von: m.von, bis: m.bis } },
        })
        .then(must),
    enabled: m.ready,
    placeholderData: keepPreviousData,
  });
  // The API lists the lines with a value worst first, then the all-cancelled ones, then the ones
  // with too little data; best first reverses only the first group.
  const lines = q.data && (order === "worst" ? q.data : bestFirst(q.data));
  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!lines)
    body = (
      <div role="status" className="h-[180px] animate-pulse rounded-lg bg-surface-2">
        <span className="sr-only">{t("state.loading")}</span>
      </div>
    );
  else if (lines.length === 0) body = <p className="text-text-2">{t("station.lines.none")}</p>;
  else
    body = (
      <>
        {/* The column names, for the table look; every row also reads fine on its own. */}
        <div
          aria-hidden="true"
          className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_52px_72px_104px] gap-3 px-1 pb-2 text-xs text-text-3 md:grid"
        >
          <span>{t("station.lines.line")}</span>
          <span className="col-span-2">{t("metric.puenktlich")}</span>
          <span>{t("station.lines.n")}</span>
          <span className="text-right">✕ {t("metric.ausfall")}</span>
        </div>
        <ul className="flex flex-col gap-2.5 md:gap-0">
          {(all ? lines : lines.slice(0, LINES_FIRST)).map((l, i) => {
            const shown = show("puenktlich", l, l.name);
            return (
              <li key={l.linie} className="md:last:*:border-b-0">
                <Link
                  ref={i === LINES_FIRST ? firstNew : undefined}
                  to={{
                    pathname: ZEITVERLAUF,
                    search: writeFilters({ k: f.k, g: f.g, linie: l.linie }).toString(),
                  }}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3 hover:bg-surface-2 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_52px_72px_104px] md:gap-y-0 md:rounded-none md:border-0 md:border-b md:px-1 md:py-2.5"
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 md:order-1">
                    <Badge>{l.typ}</Badge>
                    <b className="font-semibold">{l.name}</b>
                  </span>
                  <b
                    className={`text-right font-[650] tabular-nums md:order-3 ${shown.low ? "text-text-3" : ""}`}
                  >
                    {shown.text}
                  </b>
                  <div className="col-span-2 md:order-2 md:col-span-1">
                    <MiniBar metric="puenktlich" shown={shown} />
                  </div>
                  <span className="text-xs text-text-3 tabular-nums md:order-4">
                    {t("station.n", { n: int(l.n) })}
                  </span>
                  <Cancelled stats={l} className="text-right text-xs md:order-5" />
                </Link>
              </li>
            );
          })}
        </ul>
        {lines.length > LINES_FIRST && (
          <button
            ref={toggle}
            type="button"
            className="btn mt-3"
            onClick={() => {
              setAll(!all);
              if (all) toggle.current?.focus();
            }}
          >
            {all ? t("station.lines.less") : t("station.lines.all", { count: int(lines.length) })}
          </button>
        )}
      </>
    );
  return (
    <section aria-labelledby={id} className="card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <h2 id={id} className="text-base font-[620]">
          {t("station.lines")}
        </h2>
        <Segmented
          label={t("station.lines.order")}
          options={[...ORDERS]}
          value={order}
          onChange={setOrder}
          className="-my-2 py-2 md:m-0 md:p-0"
        />
      </div>
      {body}
    </section>
  );
}

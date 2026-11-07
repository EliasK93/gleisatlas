import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, must, useMonthPeriod } from "./api";
import { Filters } from "./Filters";
import { t, type MessageKey } from "./i18n";
import {
  API_FIELD,
  formatPeriod,
  int,
  linePageSearch,
  MIN_NS,
  readFilters,
  readRank,
  withParam,
  withRank,
  writeFilters,
  writeRank,
  type Filters as FilterKeys,
  type Metric,
  type Rank,
} from "./metrics";
import type { components } from "./schema";
import {
  Badge,
  Cancelled,
  EmptyCard,
  ErrorBanner,
  MetricSwitch,
  MiniBar,
  MusterSwitch,
  Segmented,
  ShareButton,
  show,
  linePath,
  stationPath,
  useNarrow,
  SlowHint,
  Page,
  PageTitle,
  Pulse,
} from "./ui";

type Rangliste = components["schemas"]["Rangliste"];
type Eintrag = components["schemas"]["RanglistenEintrag"];

const TYPES = (["linien", "bahnhoefe"] as const).map((v) => ({
  value: v,
  label: t(`rk.typ.${v}`),
}));
const ARTS = (["linien", "zuege"] as const).map((v) => ({
  value: v,
  label: t(`rk.art.${v}`),
}));
const MINS = MIN_NS.map((n) => ({ value: n, label: int(n) }));
const COLUMNS = [
  { key: "schlechteste", title: "rk.worst" },
  { key: "beste", title: "rk.best" },
] as const satisfies readonly { key: keyof Rangliste; title: MessageKey }[];
type Column = (typeof COLUMNS)[number]["key"];

export default function RankingsPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  // The rankings cover every station, so a bhf key has no meaning here, nor has a line.
  const f: FilterKeys = {
    ...readFilters(params),
    bhf: undefined,
    tag: undefined,
    land: undefined,
    linie: undefined,
    z: undefined,
    richtung: undefined,
    abschnitt: undefined,
  };
  const rank = readRank(params);
  // Days in the URL round outward: this page asks for whole months.
  const m = useMonthPeriod(f);
  // Lines are the default: the request names single trains only.
  const single = rank.typ === "linien" && rank.art === "zuege";
  const q = useQuery({
    queryKey: ["rankings", rank.typ, single, f.k, rank.min, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/rankings", {
          params: {
            query: {
              typ: rank.typ,
              art: single ? "zuege" : undefined,
              metrik: API_FIELD[f.k],
              min_n: rank.min,
              gattung: f.g ?? "alle",
              von: m.von,
              bis: m.bis,
            },
          },
        })
        .then(must),
    enabled: m.ready,
    placeholderData: keepPreviousData,
  });
  const data = q.data;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeRank(f, rank).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!data) body = <Skeleton />;
  else if (data.anzahl === 0)
    body = (
      <EmptyCard
        title={t("rk.empty", { min: int(data.min_n) })}
        hint={t("rk.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else body = <Lists data={data} metric={f.k} rank={rank} filters={f} />;

  const meta =
    data && data.anzahl > 0
      ? t(
          single ? "rk.meta.zuege" : rank.typ === "linien" ? "rk.meta.linien" : "rk.meta.bahnhoefe",
          {
            count: int(data.anzahl),
            min: int(data.min_n),
            period: formatPeriod(data.von, data.bis),
          },
        )
      : "";

  return (
    <Page>
      <MusterSwitch />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("nav.discover")}</p>
          <PageTitle>{t("nav.rankings")}</PageTitle>
          <p className="mt-1.5 max-w-[68ch] text-text-2">{t("rk.lead")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            label={t("rk.typeLabel")}
            options={TYPES}
            value={rank.typ}
            onChange={(typ) => setParams(withRank({ typ }))}
            className="-my-2 py-2 md:m-0 md:p-0"
          />
          {rank.typ === "linien" && (
            <Segmented
              label={t("rk.artLabel")}
              options={ARTS}
              value={rank.art}
              onChange={(art) => setParams(withRank({ art }))}
              className="-my-2 py-2 md:m-0 md:p-0"
            />
          )}
          <ShareButton />
        </div>
      </div>
      <Filters noStation />
      <div className="card mb-4 flex flex-col gap-3">
        <MetricSwitch
          metric={f.k}
          onMetric={(k) => setParams(withParam("k", k))}
          className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="text-[13px] text-text-2">{t("rk.min")}</span>
          <Segmented
            label={t("rk.min")}
            options={MINS}
            value={rank.min}
            onChange={(min) => setParams(withRank({ min }))}
            className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
          />
          <span className="text-xs text-text-3 md:ml-auto">{meta}</span>
        </div>
      </div>
      {body}
    </Page>
  );
}

/** The worst and the best ten side by side, or as tabs on a narrow screen. */
function Lists({
  data,
  metric,
  rank,
  filters,
}: {
  data: Rangliste;
  metric: Metric;
  rank: Rank;
  filters: FilterKeys;
}) {
  const narrow = useNarrow();
  const [tab, setTab] = useState<Column>("schlechteste");
  // Only punctuality has a natural scale; the other bars are relative to the largest value.
  const most = Math.max(
    ...[...data.schlechteste, ...data.beste].map((e) => show(metric, e, "").value ?? 0),
    1,
  );
  // Station rows keep the filters; the rankings keys are this page's own. A line row opens
  // the line's page in the same metric and period.
  const search = writeFilters(filters).toString();
  const shown = narrow ? COLUMNS.filter((c) => c.key === tab) : COLUMNS;
  return (
    <>
      {narrow && (
        <Segmented
          tabs
          label={t("rk.tabs")}
          options={COLUMNS.map((c) => ({ value: c.key, label: t(c.title) }))}
          value={tab}
          onChange={setTab}
          className="-mx-4 -my-2 mb-1 px-4 py-2"
        />
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {shown.map(({ key, title }) => (
          <section key={key} aria-labelledby={`rk-${key}`} className="card min-w-0">
            <h2 id={`rk-${key}`} className="mb-2 text-base font-[620]">
              {t(title)}
            </h2>
            {/* The names of the two figure columns: the selected metric, and the grey cancellations. */}
            <div className={`${GRID} px-1 pb-1 text-xs`}>
              <b className="col-span-3 col-start-2 text-right font-[650]">
                {t(`metric.${metric}`)}
              </b>
              <span aria-hidden="true" className="text-right text-cancel">
                {t("metric.ausfall")}
              </span>
            </div>
            <ul>
              {data[key].map((e, i) => (
                <Row
                  key={e.id}
                  entry={e}
                  rank={i + 1}
                  metric={metric}
                  most={most}
                  to={
                    rank.typ === "bahnhoefe"
                      ? { pathname: stationPath(e.id), search }
                      : { pathname: linePath(e.id), search: linePageSearch(filters) }
                  }
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

/**
 * Rank, name, bar, value, cancellation rate. The last column is 80 px, which fits the English
 * header "Cancellations" (about 77 px at 12 px) and "✕ 10,9 %" on one line; the bar gives way.
 */
const GRID =
  "grid grid-cols-[24px_minmax(0,1fr)_40px_52px_80px] gap-2 md:grid-cols-[24px_minmax(0,1fr)_72px_58px_80px] md:gap-2.5";
const ROW = `${GRID} min-h-11 items-center border-b border-border px-1 py-2`;

function Row({
  entry,
  rank,
  metric,
  most,
  to,
}: {
  entry: Eintrag;
  rank: number;
  metric: Metric;
  most: number;
  to: { pathname: string; search: string };
}) {
  const shown = show(metric, entry, entry.name);
  const cells = (
    <>
      <span className="text-xs text-text-3 tabular-nums">{rank}</span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-1.5">
          {entry.typ && <Badge>{entry.typ}</Badge>}
          <span className="font-[550]">{entry.name}</span>
        </span>
        <span className="block text-xs text-text-3 tabular-nums">
          {t("station.n", { n: int(entry.n) })}
        </span>
      </span>
      <MiniBar metric={metric} shown={shown} most={most} />
      <b className={`text-right font-[650] tabular-nums ${shown.low ? "text-text-3" : ""}`}>
        {shown.text}
      </b>
      <Cancelled stats={entry} className="text-right text-xs" />
    </>
  );
  return (
    <li className="last:*:border-b-0">
      <Link to={to} className={`${ROW} hover:bg-surface-2`}>
        {cells}
      </Link>
    </li>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      <SlowHint />
      <Pulse className="grid animate-pulse gap-4 xl:grid-cols-2">
        {[0, 1].map((c) => (
          <div key={c} className="card flex flex-col gap-2">
            {Array.from({ length: 10 }, (_, i) => (
              <div key={i} className="h-9 rounded-md bg-surface-2" />
            ))}
          </div>
        ))}
      </Pulse>
    </div>
  );
}

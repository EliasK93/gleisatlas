import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, must, useMonthPeriod } from "./api";
import { Filters } from "./Filters";
import { LOCALE, t, type MessageKey } from "./i18n";
import {
  API_FIELD,
  formatPeriod,
  int,
  linePageSearch,
  LOW_N,
  MIN_NS,
  NBSP,
  oneDecimal,
  RANK_TYPES,
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
import { minutesText, stepOf } from "./sections";
import {
  Badge,
  Cancelled,
  EmptyCard,
  ErrorBanner,
  FILL,
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
type AbschnittsRangliste = components["schemas"]["AbschnittsRangliste"];
type RanglistenAbschnitt = components["schemas"]["RanglistenAbschnitt"];
type Rekorde = components["schemas"]["Rekorde"];
type RekordEintrag = components["schemas"]["RekordEintrag"];

const TYPES = RANK_TYPES.map((v) => ({ value: v, label: t(`rk.typ.${v}`) }));
const ARTS = (["linien", "zuege"] as const).map((v) => ({
  value: v,
  label: t(`rk.art.${v}`),
}));
const REKORDS = (["halte", "takt"] as const).map((v) => ({
  value: v,
  label: t(`rk.rekord.${v}`),
}));
const MINS = MIN_NS.map((n) => ({ value: n, label: int(n) }));

const TWO = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/**
 * Stops per day: one decimal below 10, so the fewest do not all read 1 or 2. Trains per hour: two
 * decimals below one, so a line that hardly runs does not read 0,0.
 */
const SERVICE_HOURS = 16; // the hours of service the API divides the trains by: 06:00 to 21:59
const perDay = (v: number) => (v < 10 ? oneDecimal.format(v) : int(v));
const recordText = (art: Rank["rekord"], v: number) =>
  art === "halte"
    ? `${perDay(v)}${NBSP}${t("unit.stopsPerDay")}`
    : `${(v >= 1 ? oneDecimal : TWO).format(v)}${NBSP}${t("unit.trainsPerHour")}`;

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
  // Stations and lines have the metric; sections and records have their own value.
  const listed = rank.typ === "bahnhoefe" || rank.typ === "linien";
  // The records take no minimum: they ask for the API's lowest, so the fewest list is not a row of
  // stations that just reach a threshold. `min` stays in the URL for the other tabs.
  const isRecords = rank.typ === "rekorde";
  const list = useQuery({
    queryKey: ["rankings", rank.typ, single, f.k, rank.min, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/rankings", {
          params: {
            query: {
              typ: rank.typ === "linien" ? "linien" : "bahnhoefe",
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
    enabled: m.ready && listed,
    placeholderData: keepPreviousData,
  });
  const sections = useQuery({
    queryKey: ["rankings-abschnitte", rank.min, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/rankings/abschnitte", {
          params: { query: { min_n: rank.min, gattung: f.g ?? "alle", von: m.von, bis: m.bis } },
        })
        .then(must),
    enabled: m.ready && rank.typ === "abschnitte",
    placeholderData: keepPreviousData,
  });
  const records = useQuery({
    queryKey: ["rankings-rekorde", rank.rekord, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/rankings/rekorde", {
          params: {
            query: {
              art: rank.rekord,
              min_n: LOW_N,
              gattung: f.g ?? "alle",
              von: m.von,
              bis: m.bis,
            },
          },
        })
        .then(must),
    enabled: m.ready && rank.typ === "rekorde",
    placeholderData: keepPreviousData,
  });
  const q = rank.typ === "abschnitte" ? sections : rank.typ === "rekorde" ? records : list;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeRank(f, rank).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!q.data) body = <Skeleton />;
  else if (q.data.anzahl === 0)
    body = (
      <EmptyCard
        title={t(rank.typ === "abschnitte" ? "rk.empty.abschnitte" : "rk.empty", {
          min: int(q.data.min_n),
        })}
        hint={t("rk.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else if (rank.typ === "abschnitte" && sections.data)
    body = <SectionLists data={sections.data} filters={f} />;
  else if (rank.typ === "rekorde" && records.data)
    body = <RecordLists data={records.data} art={rank.rekord} filters={f} />;
  else if (list.data) body = <Lists data={list.data} metric={f.k} rank={rank} filters={f} />;

  const metaKey = {
    bahnhoefe: "rk.meta.bahnhoefe",
    linien: single ? "rk.meta.zuege" : "rk.meta.linien",
    abschnitte: "rk.meta.abschnitte",
    rekorde: rank.rekord === "halte" ? "rk.meta.bahnhoefe" : "rk.meta.linien",
  } as const satisfies Record<Rank["typ"], MessageKey>;
  const meta =
    q.data && q.data.anzahl > 0
      ? t(metaKey[rank.typ], {
          count: int(q.data.anzahl),
          min: int(q.data.min_n),
          period: formatPeriod(q.data.von, q.data.bis),
        })
      : "";
  const help =
    rank.typ === "abschnitte"
      ? t("rk.help.abschnitte")
      : rank.typ === "rekorde"
        ? t(`rk.help.${rank.rekord}`, { min: int(LOW_N) })
        : null;

  return (
    <Page>
      <MusterSwitch />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("nav.discover")}</p>
          <PageTitle>{t("nav.rankings")}</PageTitle>
          <p className="mt-1.5 max-w-[68ch] text-text-2">{t("rk.lead")}</p>
        </div>
        {/* A row gap of 12 px keeps the 44 px tap areas of a wrapped switch apart. */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-3">
          <Segmented
            label={t("rk.typeLabel")}
            options={TYPES}
            value={rank.typ}
            onChange={(typ) => setParams(withRank({ typ }))}
            className="-my-2 py-2 md:m-0 md:p-0"
          />
          <ShareButton />
        </div>
      </div>
      <Filters noStation />
      <div className="card mb-4 flex flex-col gap-3">
        {rank.typ === "linien" && (
          <Segmented
            label={t("rk.artLabel")}
            options={ARTS}
            value={rank.art}
            onChange={(art) => setParams(withRank({ art }))}
            className="-mx-4 -my-2 self-start px-4 py-2 md:m-0 md:p-0"
          />
        )}
        {rank.typ === "rekorde" && (
          <Segmented
            label={t("rk.rekordLabel")}
            options={REKORDS}
            value={rank.rekord}
            onChange={(rekord) => setParams(withRank({ rekord }))}
            className="-mx-4 -my-2 self-start px-4 py-2 md:m-0 md:p-0"
          />
        )}
        {listed && (
          <MetricSwitch
            metric={f.k}
            onMetric={(k) => setParams(withParam("k", k))}
            className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
          />
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {isRecords ? null : (
            <>
              <span className="text-[13px] text-text-2">{t("rk.min")}</span>
              <Segmented
                label={t("rk.min")}
                options={MINS}
                value={rank.min}
                onChange={(min) => setParams(withRank({ min }))}
                className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
              />
            </>
          )}
          <span className={`text-xs text-text-3 ${isRecords ? "" : "md:ml-auto"}`}>{meta}</span>
        </div>
        {help && <p className="max-w-[88ch] text-xs text-text-3">{help}</p>}
      </div>
      {body}
    </Page>
  );
}

type Column = { key: string; title: MessageKey; list: ReactNode };

/** The columns of a ranking side by side, or as tabs on a narrow screen. */
function Columns({ columns }: { columns: Column[] }) {
  const narrow = useNarrow();
  const [tab, setTab] = useState(columns[0].key);
  const shown = narrow ? [columns.find((c) => c.key === tab) ?? columns[0]] : columns;
  return (
    <>
      {narrow && (
        <Segmented
          tabs
          label={t("rk.tabs")}
          options={columns.map((c) => ({ value: c.key, label: t(c.title) }))}
          value={shown[0].key}
          onChange={setTab}
          className="-mx-4 -my-2 mb-1 px-4 py-2"
        />
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {shown.map(({ key, title, list }) => (
          <section key={key} aria-labelledby={`rk-${key}`} className="card min-w-0">
            <h2 id={`rk-${key}`} className="mb-2 text-base font-[620]">
              {t(title)}
            </h2>
            {list}
          </section>
        ))}
      </div>
    </>
  );
}

/** The worst and the best ten of stations or lines. */
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
  // Only punctuality has a natural scale; the other bars are relative to the largest value.
  const most = Math.max(
    ...[...data.schlechteste, ...data.beste].map((e) => show(metric, e, "").value ?? 0),
    1,
  );
  // Station rows keep the filters; the rankings keys are this page's own. A line row opens
  // the line's page in the same metric and period.
  const search = writeFilters(filters).toString();
  const columns = (
    [
      { key: "schlechteste", title: "rk.worst" },
      { key: "beste", title: "rk.best" },
    ] as const
  ).map(({ key, title }) => ({
    key,
    title,
    list: (
      <>
        {/* The names of the two figure columns: the selected metric, and the grey cancellations. */}
        <div className={`${GRID} px-1 pb-1 text-xs`}>
          <b className="col-span-3 col-start-2 text-right font-[650]">{t(`metric.${metric}`)}</b>
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
      </>
    ),
  }));
  return <Columns columns={columns} />;
}

/**
 * Rank, name, bar, value, cancellation rate. The last column is 80 px, which fits the English
 * header "Cancellations" (about 77 px at 12 px) and "✕ 10,9 %" on one line; the bar gives way.
 */
const GRID =
  "grid grid-cols-[24px_minmax(0,1fr)_40px_52px_80px] gap-2 md:grid-cols-[24px_minmax(0,1fr)_72px_58px_80px] md:gap-2.5";
const ROW = `${GRID} min-h-11 items-center border-b border-border px-1 py-2`;
/** Rank, name with its small print, value: the rows of sections and records. */
const FIGURE_ROW =
  "grid min-h-11 grid-cols-[24px_minmax(0,1fr)_auto] gap-x-2 px-1 py-2 md:gap-x-2.5";

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

/** The sections that lose the most time and those that make up the most. */
function SectionLists({ data, filters }: { data: AbschnittsRangliste; filters: FilterKeys }) {
  const columns = (
    [
      { key: "schlechteste", title: "rk.sections.worst" },
      { key: "beste", title: "rk.sections.best" },
    ] as const
  ).map(({ key, title }) => ({
    key,
    title,
    list: (
      <ul>
        {data[key].map((s, i) => (
          <SectionRow
            key={`${s.von_eva}-${s.nach_eva}`}
            section={s}
            rank={i + 1}
            filters={filters}
          />
        ))}
      </ul>
    ),
  }));
  return <Columns columns={columns} />;
}

/**
 * One section: the stations, its trips and line count, the busiest lines as links, and the mean
 * minutes in the colour the line page gives them. The row is no link itself, it holds several.
 */
function SectionRow({
  section: s,
  rank,
  filters,
}: {
  section: RanglistenAbschnitt;
  rank: number;
  filters: FilterKeys;
}) {
  const pair = `${s.von_eva}-${s.nach_eva}`;
  const more = s.linien_anzahl - s.linien.length;
  return (
    <li className={`${FIGURE_ROW} border-b border-border last:border-b-0`}>
      <span className="text-xs text-text-3 tabular-nums">{rank}</span>
      <span className="min-w-0">
        <span className="font-[550]">
          {s.von_name} → {s.nach_name}
        </span>
        <span className="block text-xs text-text-3 tabular-nums">
          {t("line.trips", { n: int(s.n) })} ·{" "}
          {s.linien_anzahl === 1
            ? t("rk.sections.lines.one")
            : t("rk.sections.lines", { count: int(s.linien_anzahl) })}
        </span>
        {/* One link per row with a 44 px height on a phone, so no tap area overlaps another. */}
        <span className="mt-1 flex flex-col text-xs md:flex-row md:flex-wrap md:gap-x-3 md:gap-y-0.5">
          {s.linien.map((l) => (
            <Link
              key={l.id}
              // Without a direction the line's usual route lacks the section: no selection.
              to={{
                pathname: linePath(l.id),
                search: linePageSearch(
                  filters,
                  l.richtung === null
                    ? undefined
                    : { richtung: l.richtung === 2 ? "2" : undefined, abschnitt: pair },
                ),
              }}
              className="flex min-h-11 items-center text-accent hover:underline md:min-h-0"
            >
              {l.label}
            </Link>
          ))}
          {more > 0 && (
            <span className="text-text-3">{t("rk.sections.more", { count: int(more) })}</span>
          )}
        </span>
      </span>
      <b className="inline-flex items-start gap-1.5 font-[650] tabular-nums">
        <i
          aria-hidden="true"
          className={`mt-[5px] inline-block size-2.5 shrink-0 rounded-full ${FILL.r[stepOf(s.minuten) - 1]}`}
        />
        {minutesText(s.minuten)}
      </b>
    </li>
  );
}

/** The most and the fewest stops of stations or trains of lines. */
function RecordLists({
  data,
  art,
  filters,
}: {
  data: Rekorde;
  art: Rank["rekord"];
  filters: FilterKeys;
}) {
  // A station opens its page with the filters, a line its page in the same metric and period.
  const search = art === "halte" ? writeFilters(filters).toString() : linePageSearch(filters);
  const columns = (
    [
      { key: "meiste", title: "rk.records.most" },
      { key: "wenigste", title: "rk.records.fewest" },
    ] as const
  ).map(({ key, title }) => ({
    key,
    title,
    list: (
      <ul>
        {data[key].map((e, i) => (
          <RecordRow
            key={e.id}
            entry={e}
            rank={i + 1}
            art={art}
            to={{ pathname: art === "halte" ? stationPath(e.id) : linePath(e.id), search }}
          />
        ))}
      </ul>
    ),
  }));
  return <Columns columns={columns} />;
}

function RecordRow({
  entry,
  rank,
  art,
  to,
}: {
  entry: RekordEintrag;
  rank: number;
  art: Rank["rekord"];
  to: { pathname: string; search: string };
}) {
  return (
    <li className="last:*:border-b-0">
      <Link
        to={to}
        className={`${FIGURE_ROW} items-center border-b border-border hover:bg-surface-2`}
      >
        <span className="text-xs text-text-3 tabular-nums">{rank}</span>
        <span className="min-w-0">
          <span className="font-[550]">{entry.name}</span>
          <span className="block text-xs text-text-3 tabular-nums">
            {art === "halte"
              ? t("station.n", { n: int(entry.n) })
              : t("rk.records.perDay", { v: perDay(entry.wert * SERVICE_HOURS) })}
          </span>
        </span>
        <b className="text-right font-[650] tabular-nums">{recordText(art, entry.wert)}</b>
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

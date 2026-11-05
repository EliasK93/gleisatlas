import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Fragment, useId, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { api, must, useMonthPeriod } from "./api";
import { Bildfahrplan } from "./Bildfahrplan";
import { Filters } from "./Filters";
import { t } from "./i18n";
import { LineMap } from "./LineMap";
import {
  int,
  linePageSearch,
  MAX_LINE_ID,
  lineSearch,
  readFilters,
  withParam,
  writeFilters,
  writeRank,
  type Filters as FilterKeys,
  type Metric,
} from "./metrics";
import type { components } from "./schema";
import {
  axisStations,
  cutLine,
  limitText,
  minutesText,
  sectionText,
  STEPS,
  stepOf,
  THIN_N,
  type Row,
} from "./sections";
import {
  Badge,
  EmptyCard,
  ErrorBanner,
  FILL,
  MetricSwitch,
  MetricTiles,
  Page,
  PageTitle,
  PRIMARY,
  Pulse,
  RANKINGS,
  RowHead,
  Segmented,
  ShareButton,
  show,
  SlowHint,
  StatRow,
  stationPath,
  ZEITVERLAUF,
} from "./ui";
import { clearParams, useSetParams } from "./useSetParams";
import { Sparkline } from "./ZeitverlaufPage";

type Linie = components["schemas"]["Linie"];
type Bahnhof = components["schemas"]["LinienBahnhof"];
type Abschnitt = components["schemas"]["Abschnitt"];
type Stats = components["schemas"]["Stats"];

export default function LinePage() {
  const { id = "" } = useParams();
  const valid = id.length > 0 && id.length <= MAX_LINE_ID;
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const read = readFilters(params);
  // A line has one train type and is itself the page, so category, station, state, line and view
  // keys have no meaning here. The day is the Bildfahrplan's, settled once the line is known.
  const f: FilterKeys = {
    ...read,
    g: undefined,
    bhf: undefined,
    tag: undefined,
    land: undefined,
    linie: undefined,
    z: undefined,
  };
  // Days in the URL round outward: this page asks for whole months.
  const m = useMonthPeriod(f);
  const range = { linie: id, von: m.von, bis: m.bis };
  const q = useQuery({
    queryKey: ["linie", id, m.von, m.bis],
    queryFn: async () => {
      const r = await api.GET("/linie", { params: { query: range } });
      // An unknown line is a page state, not an error.
      return r.response.status === 404 ? null : must(r);
    },
    enabled: valid && m.ready,
    // A filter change keeps the old numbers on screen; another line does not.
    placeholderData: (previous, query) => (query?.queryKey[1] === id ? previous : undefined),
  });
  const sections = useQuery({
    queryKey: ["linie-abschnitte", id, m.von, m.bis],
    queryFn: async () => {
      const r = await api.GET("/linie/abschnitte", { params: { query: range } });
      return r.response.status === 404 ? [] : must(r);
    },
    enabled: valid && m.ready,
    placeholderData: (previous, query) => (query?.queryKey[1] === id ? previous : undefined),
  });

  const data = q.data;
  // The Bildfahrplan's day stays while the line loads; then only a day of its trip window that is
  // not the newest one (the default) is kept.
  const tag =
    data === undefined
      ? read.tag
      : read.tag &&
          data?.fahrplan_von &&
          data.fahrplan_bis &&
          read.tag >= data.fahrplan_von &&
          read.tag < data.fahrplan_bis
        ? read.tag
        : undefined;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters({ ...f, tag }).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  if (!valid || data === null)
    return (
      <Page>
        <EmptyCard heading="h1" title={t("line.unknown")} hint={t("line.unknownHint")}>
          <Link
            to={{
              pathname: RANKINGS,
              search: writeRank(
                { k: "puenktlich" },
                { typ: "linien", min: 500, art: "linien" },
              ).toString(),
            }}
            className={`${PRIMARY} mt-4`}
          >
            {t("line.unknownBack")}
          </Link>
        </EmptyCard>
      </Page>
    );

  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!data) body = <Skeleton />;
  else if (data.bahnhoefe.every((s) => s.n === 0))
    body = (
      <EmptyCard
        title={t("line.empty")}
        hint={t("line.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else
    body = (
      <LineView
        line={data}
        sections={sections}
        f={f}
        direction={f.richtung === "2" ? 2 : 1}
        tag={tag}
        onMetric={(k) => setParams(withParam("k", k))}
        onDirection={(d) => setParams(withParam("richtung", d === 2 ? "2" : ""))}
        onDay={(d) => setParams(withParam("tag", d === data.fahrplan_bis ? "" : d))}
      />
    );

  const label = data?.label ?? id.split(":")[0];
  return (
    <Page>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <nav aria-label={t("station.crumb")} className="mb-1.5 text-[12.5px] text-text-3">
            <Link
              to={{
                pathname: RANKINGS,
                search: writeRank(
                  { k: f.k, von: f.von, bis: f.bis },
                  { typ: "linien", min: 500, art: data?.zug ? "zuege" : "linien" },
                ).toString(),
              }}
              className="hit inline-block hover:text-text"
            >
              {t("nav.rankings")}
            </Link>
            <span aria-hidden="true"> › </span>
            {label}
          </nav>
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <PageTitle>{label}</PageTitle>
            {data?.typ && <Badge>{data.typ}</Badge>}
          </div>
          {data?.zug && <p className="mt-1 text-xs text-text-3">{t("line.single")}</p>}
        </div>
        <ShareButton />
      </div>
      <Filters noStation noCategory />
      {body}
    </Page>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      <SlowHint />
      <Pulse className="flex animate-pulse flex-col gap-4">
        <div className="h-[260px] rounded-xl bg-surface-2" />
        <div className="h-[110px] rounded-xl bg-surface-2" />
        <div className="h-[420px] rounded-xl bg-surface-2" />
      </Pulse>
    </div>
  );
}

function LineView({
  line,
  sections,
  f,
  direction,
  tag,
  onMetric,
  onDirection,
  onDay,
}: {
  line: Linie;
  sections: UseQueryResult<Abschnitt[]>;
  f: FilterKeys;
  direction: 1 | 2;
  /** The Bildfahrplan's day; undefined is its newest day. */
  tag?: string;
  onMetric: (m: Metric) => void;
  onDirection: (d: 1 | 2) => void;
  onDay: (day: string) => void;
}) {
  // A line that runs one way has no values in the other direction: no toggle, that direction.
  const cuts = sections.data && {
    one: cutLine(line.achse, line.bahnhoefe, sections.data, 1),
    two: cutLine(line.achse, line.bahnhoefe, sections.data, 2),
  };
  const both = !!cuts && cuts.one.has && cuts.two.has;
  const shown = both ? direction : cuts?.two.has ? 2 : cuts ? 1 : direction;
  const ends = cuts && [cuts.one.axis[0]?.name, cuts.one.axis.at(-1)?.name];
  const cut = cuts && (shown === 1 ? cuts.one : cuts.two);
  const jump = "chip border-border bg-surface text-text-2 hover:text-text";
  return (
    <div className="flex flex-col gap-4">
      {both && ends && (
        <Segmented
          label={t("line.dir.label")}
          options={[
            { value: 1 as const, label: t("line.dir", { to: ends[1]! }) },
            { value: 2 as const, label: t("line.dir", { to: ends[0]! }) },
          ]}
          value={direction}
          onChange={onDirection}
          className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
        />
      )}
      <nav aria-label={t("line.jump")} className="flex flex-wrap gap-2">
        <a href="#strecke" className={jump}>
          {t("line.route")}
        </a>
        <a href="#bildfahrplan" className={jump}>
          {t("line.bf")}
        </a>
      </nav>
      {line.ohne_echtzeit && (
        <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px]">
          {t("line.noLive")}
        </p>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] xl:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          <MetricTiles
            stats={line.gesamt ?? undefined}
            noCancel={line.gesamt?.ausfallquote === 0}
            meta={t("station.n", { n: int(line.gesamt?.n ?? 0) })}
            label={t("line.tiles")}
            className="xl:grid-cols-2"
          />
        </div>
        <Sparkline
          linie={line.linie}
          to={{ pathname: ZEITVERLAUF, search: lineSearch({ k: f.k }, line.linie) }}
        />
      </div>
      <MetricSwitch
        metric={f.k}
        onMetric={onMetric}
        className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
      />
      {/* The map comes first, so it stands above the route in one column; from 1280 px it
          moves to the right and stays in view while the route scrolls. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] xl:items-start">
        <ZeitfresserMap stations={line.bahnhoefe} sections={sections} cut={cut} />
        <Route
          axis={axisStations(line.achse, line.bahnhoefe)}
          other={line.bahnhoefe.filter((s) => s.pos === null)}
          reversed={shown === 2}
          metric={f.k}
          search={linePageSearch(f)}
          sections={sections}
          cut={cut}
        />
      </div>
      <div id="bildfahrplan" className="scroll-mt-4">
        <Bildfahrplan line={line} tag={tag} onDay={onDay} />
      </div>
    </div>
  );
}

const stats = (s: Bahnhof): Stats => ({ ...s, ausfallquote: s.ausfallquote ?? 0 });

type Cut = ReturnType<typeof cutLine>;

/** The colour of a section's piece of line: its step, pale when thin, very pale grey without values. */
const tone = (s?: Abschnitt) =>
  s
    ? `${FILL.r[stepOf(s.minuten) - 1]} ${s.n < THIN_N ? "opacity-50" : ""}`
    : "bg-text-3 opacity-30";
const PIECE = "absolute left-1/2 w-0.5 -translate-x-1/2";

/** The column left of a route item that holds its piece of the line. */
const Track = ({ children }: { children: ReactNode }) => (
  <span
    aria-hidden="true"
    // On a phone the items are 10 px apart: the pieces reach into the gap and meet.
    className="pointer-events-none absolute inset-y-[-5px] left-[-24px] w-6 md:inset-y-0"
  >
    {children}
  </span>
);

/**
 * A dot of the route with a piece of the line towards each neighbour, in the colour classes `up`
 * and `down` (none at an end); the ends have a larger dot.
 */
function RouteMark({ end, up, down }: { end: boolean; up?: string; down?: string }) {
  return (
    <Track>
      {up && <i data-testid="route-line" className={`${PIECE} top-0 bottom-1/2 ${up}`} />}
      {down && <i data-testid="route-line" className={`${PIECE} top-1/2 bottom-0 ${down}`} />}
      <i
        data-testid="stop-dot"
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface ${
          end ? "size-4 border-[3px] border-text-2" : "size-2.5 border-2 border-text-3"
        }`}
      />
    </Track>
  );
}

/**
 * One section between two stations of the route: its piece of the line in the step colour and
 * the minutes and trips as text, after the pair of stations for a screen reader.
 */
function Connector({ row }: { row: Row }) {
  return (
    <li data-testid="section" className="relative px-1 py-1.5 text-xs text-text-2 tabular-nums">
      <Track>
        <i data-testid="route-line" className={`${PIECE} inset-y-0 ${tone(row.section)}`} />
      </Track>
      <span className="sr-only">{row.name}: </span>
      {sectionText(row.section)}
    </li>
  );
}

/**
 * The route card: the axis from the start of the shown direction at the top to its end at the
 * bottom, a dot and the selected metric per station, a station the axis visits twice at each
 * place, and between two stations their section (`cut`); then the sum, the stations off the axis
 * and the other sections. Until the sections arrive, or when they fail, the route is a plain line.
 */
function Route({
  axis,
  other,
  reversed,
  metric,
  search,
  sections,
  cut,
}: {
  /** The stations along the axis in direction 1 (`axisStations`). */
  axis: Bahnhof[];
  other: Bahnhof[];
  reversed: boolean;
  metric: Metric;
  /** The metric and the period, which a station's page keeps. */
  search: string;
  sections: UseQueryResult<Abschnitt[]>;
  /** The line cut for the shown direction; undefined while the sections load or failed. */
  cut: Cut | undefined;
}) {
  const id = useId();
  const route = reversed ? [...axis].reverse() : axis;
  // Row i is the section from route station i to i + 1 (`cutLine`).
  const none = !!cut && (cut.axis.length < 2 || sections.data?.length === 0);
  const rows = cut && !none ? cut.rows : undefined;
  const piece = (i: number) => (rows ? tone(rows[i]?.section) : "bg-text-3");
  // Only punctuality has a natural scale; the other bars are relative to the largest value.
  const most = Math.max(
    ...[...axis, ...other].map((s) => show(metric, stats(s), "").value ?? 0),
    1,
  );
  const row = (s: Bahnhof, key: string | number, marker?: ReactNode) => (
    <StatRow
      key={key}
      to={{ pathname: stationPath(s.eva), search }}
      name={s.name}
      metric={metric}
      stats={stats(s)}
      most={most}
      marker={marker}
    />
  );
  return (
    <section
      id="strecke"
      aria-labelledby={id}
      className="card flex min-w-0 scroll-mt-4 flex-col gap-3"
    >
      <div>
        <h2 id={id} className="text-base font-[620]">
          {t("line.route")}
        </h2>
        <p className="mt-1 max-w-[80ch] text-xs text-text-3">{t("line.route.help")}</p>
      </div>
      {rows && <Legend />}
      {sections.isError && <ErrorBanner onRetry={() => sections.refetch()} />}
      {none && <p className="text-text-2">{t("line.noSections")}</p>}
      <div>
        <div className="pl-6">
          <RowHead first={t("line.stations.col")} metric={t(`metric.${metric}`)} />
        </div>
        {route.length > 0 && (
          <ul aria-label={t("line.stations.axis")} className="flex flex-col gap-2.5 pl-6 md:gap-0">
            {route.map((s, i) => (
              // A ring visits a station more than once, so the EVA is no key.
              <Fragment key={i}>
                {row(
                  s,
                  i,
                  <RouteMark
                    end={i === 0 || i === route.length - 1}
                    up={i > 0 ? piece(i - 1) : undefined}
                    down={i < route.length - 1 ? piece(i) : undefined}
                  />,
                )}
                {rows?.[i] && <Connector row={rows[i]} />}
              </Fragment>
            ))}
          </ul>
        )}
      </div>
      {rows && cut && (
        <p className="text-[13px] font-[550]">{t("line.sum", { v: minutesText(cut.sum) })}</p>
      )}
      {other.length > 0 && (
        // The bottom margin keeps its 44 px tap area off the next summary's on a phone.
        <details className="mt-2 mb-4 border-t border-border pt-3">
          <summary className="hit cursor-pointer text-[13px] text-text-2 hover:text-text">
            {t("line.stations.other")} ({other.length})
          </summary>
          <ul
            aria-label={t("line.stations.other")}
            className="mt-2 flex flex-col gap-2.5 pl-6 md:gap-0"
          >
            {other.map((s) => row(s, s.eva))}
          </ul>
        </details>
      )}
      {cut && cut.others.length > 0 && (
        <details>
          <summary className="hit cursor-pointer text-[13px] text-text-2 hover:text-text">
            {t("line.other")} ({cut.others.length})
          </summary>
          <ul aria-label={t("line.other")} className="mt-1 flex flex-col">
            {cut.others.map(({ section, name }, i) => (
              // A ring visits a pair of stations more than once, so a name is no key.
              <li
                key={i}
                className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border py-2 last:border-b-0"
              >
                <i aria-hidden="true" className={`block size-3 rounded-sm ${tone(section)}`} />
                <span className="font-[550]">{name}</span>
                <span className="ml-auto text-xs text-text-2 tabular-nums">
                  {sectionText(section)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Legend() {
  const labels = [
    t("line.step.low", { a: limitText(STEPS[0]) }),
    t("line.step.range", { a: limitText(STEPS[0]), b: limitText(STEPS[1]) }),
    t("line.step.range", { a: limitText(STEPS[1]), b: limitText(STEPS[2]) }),
    t("line.step.range", { a: limitText(STEPS[2]), b: limitText(STEPS[3]) }),
    t("line.step.high", { a: limitText(STEPS[3]) }),
  ];
  return (
    <>
      <ul
        aria-label={t("line.legend.label")}
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-text-2"
      >
        {labels.map((label, i) => (
          <li key={label} className="flex items-center gap-1.5">
            <i aria-hidden="true" className={`block size-3 rounded-sm ${FILL.r[i]}`} />
            {label}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-xs text-text-3">{t("line.legend.thin", { n: THIN_N })}</p>
    </>
  );
}

/** The Zeitfresser map card: the sections of the shown direction solid, the others dashed. */
function ZeitfresserMap({
  stations,
  sections,
  cut,
}: {
  stations: Bahnhof[];
  sections: UseQueryResult<Abschnitt[]>;
  /** The line cut for the shown direction; undefined while the sections load or failed. */
  cut: Cut | undefined;
}) {
  const id = useId();
  const points = stations
    .filter((s) => s.lon !== null && s.lat !== null)
    .map((s) => ({ eva: s.eva, name: s.name, lon: s.lon!, lat: s.lat! }));
  let body;
  if (points.length === 0) body = <p className="text-text-2">{t("line.map.none")}</p>;
  else if (sections.isPending)
    body = <Pulse className="h-[340px] animate-pulse rounded-lg bg-surface-2 md:h-[420px]" />;
  // Failed sections leave the stations on the map; the route card says what failed.
  else body = <LineMap points={points} segments={cut?.segments ?? []} />;
  return (
    <section
      aria-labelledby={id}
      className="card flex min-w-0 flex-col gap-3 xl:sticky xl:top-6 xl:col-start-2 xl:row-start-1"
    >
      <h2 id={id} className="text-base font-[620]">
        {t("line.zf")}
      </h2>
      {body}
    </section>
  );
}

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useId, type ReactNode } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router";
import { api, must, useMonthPeriod } from "./api";
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
  // A line has one train type and is itself the page, so category, station, day, state, line and
  // view keys have no meaning here.
  const f: FilterKeys = {
    ...readFilters(params),
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

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  const data = q.data;
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
        onMetric={(k) => setParams(withParam("k", k))}
        onDirection={(d) => setParams(withParam("richtung", d === 2 ? "2" : ""))}
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
  onMetric,
  onDirection,
}: {
  line: Linie;
  sections: UseQueryResult<Abschnitt[]>;
  f: FilterKeys;
  direction: 1 | 2;
  onMetric: (m: Metric) => void;
  onDirection: (d: 1 | 2) => void;
}) {
  // A line that runs one way has no values in the other direction: no toggle, that direction.
  const cuts = sections.data && {
    one: cutLine(line.achse, line.bahnhoefe, sections.data, 1),
    two: cutLine(line.achse, line.bahnhoefe, sections.data, 2),
  };
  const both = !!cuts && cuts.one.has && cuts.two.has;
  const shown = both ? direction : cuts?.two.has ? 2 : cuts ? 1 : direction;
  const ends = cuts && [cuts.one.axis[0]?.name, cuts.one.axis.at(-1)?.name];
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
      {line.ohne_echtzeit && (
        <p className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px]">
          {t("line.noLive")}
        </p>
      )}
      <MetricTiles
        stats={line.gesamt ?? undefined}
        noCancel={line.gesamt?.ausfallquote === 0}
        meta={t("station.n", { n: int(line.gesamt?.n ?? 0) })}
        label={t("line.tiles")}
      />
      <MetricSwitch
        metric={f.k}
        onMetric={onMetric}
        className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
      />
      <Stops
        axis={axisStations(line.achse, line.bahnhoefe)}
        other={line.bahnhoefe.filter((s) => s.pos === null)}
        reversed={shown === 2}
        metric={f.k}
        search={linePageSearch(f)}
      />
      <Sparkline
        linie={line.linie}
        to={{ pathname: ZEITVERLAUF, search: lineSearch({ k: f.k }, line.linie) }}
      />
      <Zeitfresser
        stations={line.bahnhoefe}
        sections={sections}
        cut={cuts && (shown === 1 ? cuts.one : cuts.two)}
        shown={shown}
      />
    </div>
  );
}

const stats = (s: Bahnhof): Stats => ({ ...s, ausfallquote: s.ausfallquote ?? 0 });
/** A dot of the route with a piece of the line towards each neighbour; the ends have a larger dot. */
function RouteMark({ end, up, down }: { end: boolean; up: boolean; down: boolean }) {
  const piece = "absolute left-1/2 w-0.5 -translate-x-1/2 bg-text-3";
  return (
    <span
      aria-hidden="true"
      // On a phone the rows are cards 10 px apart: the pieces reach into the gap and meet.
      className="pointer-events-none absolute inset-y-[-5px] left-[-24px] w-6 md:inset-y-0"
    >
      {up && <i data-testid="route-line" className={`${piece} top-0 bottom-1/2`} />}
      {down && <i data-testid="route-line" className={`${piece} top-1/2 bottom-0`} />}
      <i
        data-testid="stop-dot"
        className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-surface ${
          end ? "size-4 border-[3px] border-text-2" : "size-2.5 border-2 border-text-3"
        }`}
      />
    </span>
  );
}

/**
 * The stations of the line as a route plan: the axis from the start of the shown direction at the
 * top to its end at the bottom, a dot each, a station the axis visits twice at each place; the
 * stations off the axis below, outside the route, with the selected metric.
 */
function Stops({
  axis,
  other,
  reversed,
  metric,
  search,
}: {
  /** The stations along the axis in direction 1 (`axisStations`). */
  axis: Bahnhof[];
  other: Bahnhof[];
  reversed: boolean;
  metric: Metric;
  /** The metric and the period, which a station's page keeps. */
  search: string;
}) {
  const id = useId();
  const route = reversed ? [...axis].reverse() : axis;
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
    <section aria-labelledby={id} className="card">
      <h2 id={id} className="mb-3 text-base font-[620]">
        {t("line.stations")}
      </h2>
      <div className="pl-6">
        <RowHead first={t("line.stations.col")} metric={t(`metric.${metric}`)} />
      </div>
      {route.length > 0 && (
        <ul aria-label={t("line.stations.axis")} className="flex flex-col gap-2.5 pl-6 md:gap-0">
          {route.map((s, i) =>
            // A ring visits a station more than once, so the EVA is no key.
            row(
              s,
              i,
              <RouteMark
                end={i === 0 || i === route.length - 1}
                up={i > 0}
                down={i < route.length - 1}
              />,
            ),
          )}
        </ul>
      )}
      {other.length > 0 && (
        <>
          <h3 className="mt-5 mb-2 border-t border-border pt-4 pl-6 text-[13px] font-semibold text-text-2">
            {t("line.stations.other")}
          </h3>
          <ul aria-label={t("line.stations.other")} className="flex flex-col gap-2.5 pl-6 md:gap-0">
            {other.map((s) => row(s, s.eva))}
          </ul>
        </>
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

type Cut = ReturnType<typeof cutLine>;

/** The Zeitfresser card: the legend, the map and the strip of sections of the shown direction. */
function Zeitfresser({
  stations,
  sections,
  cut,
  shown,
}: {
  stations: Bahnhof[];
  sections: UseQueryResult<Abschnitt[]>;
  /** The line cut for the shown direction; undefined while the sections load. */
  cut: Cut | undefined;
  shown: 1 | 2;
}) {
  const id = useId();
  let body;
  if (sections.isError) body = <ErrorBanner onRetry={() => sections.refetch()} />;
  else if (!sections.data || !cut)
    body = <Pulse className="h-[300px] animate-pulse rounded-lg bg-surface-2" />;
  else if (cut.axis.length < 2 || sections.data.length === 0)
    body = <p className="text-text-2">{t("line.noSections")}</p>;
  else {
    const to = (shown === 1 ? cut.axis.at(-1) : cut.axis[0])!.name;
    const points = stations
      .filter((s) => s.lon !== null && s.lat !== null)
      .map((s) => ({ eva: s.eva, name: s.name, lon: s.lon!, lat: s.lat! }));
    body = (
      <>
        <Legend />
        {points.length > 0 ? (
          <LineMap points={points} segments={cut.segments} />
        ) : (
          <p className="text-text-2">{t("line.map.none")}</p>
        )}
        <Strip rows={cut.rows} label={t("line.strip", { to })} />
        <p className="text-[13px] font-[550]">{t("line.sum", { v: minutesText(cut.sum) })}</p>
        {cut.others.length > 0 && (
          <details>
            <summary className="hit cursor-pointer text-[13px] text-text-2 hover:text-text">
              {t("line.other")} ({cut.others.length})
            </summary>
            <Strip
              rows={cut.others.map(({ section, name }) => ({ name, section }))}
              label={t("line.other")}
            />
          </details>
        )}
      </>
    );
  }
  return (
    <section aria-labelledby={id} className="card flex min-w-0 flex-col gap-3">
      <div>
        <h2 id={id} className="text-base font-[620]">
          {t("line.zf")}
        </h2>
        <p className="mt-1 max-w-[80ch] text-xs text-text-3">{t("line.zf.help")}</p>
      </div>
      {body}
    </section>
  );
}

type StripRow = Pick<Row, "name" | "section">;

/** One row per section: the name and trips, a bar centred at 0 minutes, the signed minutes. */
function Strip({ rows, label }: { rows: StripRow[]; label: string }) {
  // The longest bar is the largest section here; a floor keeps small values from filling it.
  const most = Math.max(...rows.map((r) => Math.abs(r.section?.minuten ?? 0)), 0.5);
  return (
    <ol aria-label={label} className="flex flex-col">
      {rows.map(({ name, section }, i) => (
        <li
          // A ring visits a pair of stations more than once, so a name is no key.
          key={i}
          className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 border-b border-border py-2 last:border-b-0 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_84px]"
        >
          <span className="min-w-0 md:order-1">
            <span className="font-[550]">{name}</span>
            <span className="block text-xs text-text-3 tabular-nums">
              {section ? t("line.trips", { n: int(section.n) }) : t("line.strip.none")}
            </span>
          </span>
          <b className="text-right font-[650] tabular-nums md:order-3">
            {section ? minutesText(section.minuten) : "–"}
          </b>
          <div className="relative col-span-2 h-2 rounded-sm bg-surface-2 md:order-2 md:col-span-1">
            <i aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-border" />
            {section && <Bar section={section} most={most} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Bar({ section, most }: { section: Abschnitt; most: number }) {
  const step = stepOf(section.minuten);
  const width = Math.max((Math.abs(section.minuten) / most) * 50, 2);
  return (
    <i
      aria-hidden="true"
      data-testid="section-bar"
      className={`absolute inset-y-0 rounded-sm ${FILL.r[step - 1]} ${section.n < THIN_N ? "opacity-50" : ""}`}
      style={{ [section.minuten < 0 ? "right" : "left"]: "50%", width: `${width}%` }}
    />
  );
}

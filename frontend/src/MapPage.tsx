import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AttributionControl,
  LngLat,
  LngLatBounds,
  Map as MapLibre,
  NavigationControl,
  setWorkerUrl,
  type ExpressionSpecification,
  type FilterSpecification,
  type GeoJSONSource,
  type GeoJSONSourceSpecification,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useEffectEvent, useMemo, useRef, useState, type RefObject } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, LIVE_REFRESH, must, useDatenstand } from "./api";
import { AreaCard, stateTip } from "./AreaCard";
import { Filters } from "./Filters";
import { t, tx } from "./i18n";
import { Icon } from "./Icon";
import { ANCHORS, landName } from "./laender";
import {
  classOf,
  DEFS,
  deviation,
  formatDay,
  formatLive,
  formatPeriod,
  formatStand,
  int,
  legend,
  localLabel,
  APPROX_N,
  LOW_N,
  METRICS,
  readFilters,
  REFERENCE_WEEKS,
  tenths,
  weekdayOf,
  withParam,
  writeFilters,
  type Filters as FilterKeys,
  type Metric,
} from "./metrics";
import { useTheme, type Theme } from "./prefs";
import type { components } from "./schema";
import { StateMarkers, type Tip } from "./StateMarkers";
import {
  EmptyCard,
  ErrorBanner,
  FILL,
  MetricSwitch,
  narrow,
  PRIMARY,
  show,
  SoonTag,
  stationPath,
  useNarrow,
} from "./ui";

type KartenStation = components["schemas"]["KartenStation"];
type Land = components["schemas"]["Land"];
/** A station of either map; only the day map knows its normal, its class, its source and its state. */
type Entry = KartenStation &
  Partial<Pick<components["schemas"]["TageskartenStation"], "normal" | "klasse" | "live" | "land">>;

// Bundled worker per the MapLibre v6 docs for Vite.
setWorkerUrl(workerUrl);

const STYLE: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
const GERMANY: [[number, number], [number, number]] = [
  [5.9, 47.3],
  [15.0, 55.05],
];
/** Base map labels appear from this zoom on, so the stations dominate the overview. */
const LABEL_ZOOM = 7;
const FOCUS_ZOOM = 9;
/** The Live-Lage page shows its state cards and areas until one zoom step past the start view. */
const DETAIL_STEP = 1;
/** The closest a state's fit zooms in, so a city state (Berlin, Hamburg, Bremen) keeps its surroundings. */
const STATE_ZOOM = 8;
/** The state areas fade out from the detail zoom to this one, where the base map's own borders take over. */
const AREAS_GONE = 8;
/** The dots' opacity under the state cards. */
const FADED = 0.2;
/** The opacity of the wash outside Germany. */
const MASK = 0.6;
/** Free space between a measured card and the start view of Germany. */
const CARD_GAP = 12;
/** Opacity of the dots with "~" values and of the hollow rings; both stay visible on either base map. */
const PALE = 0.5;
const VERY_PALE = 0.3;
const NO_STATIONS = { type: "FeatureCollection" as const, features: [] };

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

/**
 * Room for the floating cards on top of the map `box`: on desktop the filter card's measured bottom
 * edge; on a phone the measured top edge of the bottom card stack, if given (`stack`).
 */
function padding(card: HTMLElement, box: HTMLElement, stack?: HTMLElement | null) {
  const bottom = stack
    ? box.getBoundingClientRect().bottom - stack.getBoundingClientRect().top + CARD_GAP
    : 40;
  return narrow.matches
    ? { top: 140, bottom, left: 8, right: 8 }
    : {
        top: card.getBoundingClientRect().bottom - box.getBoundingClientRect().top + CARD_GAP,
        bottom: 24,
        left: 24,
        right: 24,
      };
}

/** Each dot's own opacity times `fade`, which is below 1 under the state cards. */
function setFade(m: MapLibre, fade: number) {
  m.setPaintProperty("stations", "circle-opacity", [
    "*",
    fade,
    ["get", "alpha"],
    ["-", 1, ["get", "hollow"]],
  ]);
  m.setPaintProperty("stations", "circle-stroke-opacity", ["*", fade, ["get", "alpha"]]);
}

/** The state shapes of `public/laender.geojson`. */
type Shapes = GeoJSONSourceSpecification["data"];

/** The bounds of all polygons of the state `code` in `shapes`; none if the shapes lack it. */
function shapeBounds(shapes: Shapes | null | undefined, code: string) {
  const file = shapes as
    | { features: { properties: { code: string }; geometry: { coordinates: unknown[] } }[] }
    | null
    | undefined;
  const shape = file?.features.find((f) => f.properties.code === code);
  if (!shape) return;
  const bounds = new LngLatBounds();
  const xy = shape.geometry.coordinates.flat(Infinity) as number[];
  for (let i = 0; i < xy.length; i += 2) bounds.extend([xy[i], xy[i + 1]]);
  return bounds;
}

/** An opacity of `from` at the detail zoom `z0` that falls to 0 at AREAS_GONE. */
const fadeOut = (z0: number, from: number): ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  z0,
  from,
  Math.max(AREAS_GONE, z0 + 0.5),
  0,
];

/** Moves the fade of the state areas to the detail zoom `z0`; without the areas it does nothing. */
function fadeAreas(m: MapLibre, z0: number) {
  if (!m.getLayer("mask")) return;
  m.setPaintProperty("mask", "fill-opacity", fadeOut(z0, MASK));
  m.setPaintProperty("laender-line", "line-opacity", fadeOut(z0, 1));
  m.setPaintProperty("de-edge", "line-opacity", fadeOut(z0, 1));
}

/**
 * The Live-Lage overview's state areas from `shapes` (16 states plus the `mask`, a large
 * rectangle with Germany cut out), under the base map's labels and the dots: a wash outside
 * Germany, a transparent fill per state that tints while hovered (feature-state `hover`), thin
 * state lines and Germany's outline. All but the fill fade out above the detail zoom `z0`.
 */
function addAreas(m: MapLibre, shapes: Shapes, z0: number) {
  if (m.getSource("laender")) return;
  const before =
    m.getStyle().layers.find((l) => l.type === "symbol")?.id ??
    (m.getLayer("stations") ? "stations" : undefined);
  const states: FilterSpecification = ["!=", ["get", "code"], "mask"];
  const outside: FilterSpecification = ["==", ["get", "code"], "mask"];
  m.addSource("laender", { type: "geojson", data: shapes, promoteId: "code" });
  m.addLayer(
    {
      id: "mask",
      type: "fill",
      source: "laender",
      filter: outside,
      paint: { "fill-color": token("mask") },
    },
    before,
  );
  m.addLayer(
    {
      id: "laender",
      type: "fill",
      source: "laender",
      filter: states,
      paint: {
        "fill-color": token("accent"),
        "fill-opacity": [
          "case",
          ["boolean", ["feature-state", "hover"], false],
          Number(token("tint")),
          0,
        ],
      },
    },
    before,
  );
  m.addLayer(
    {
      id: "laender-line",
      type: "line",
      source: "laender",
      filter: states,
      paint: { "line-color": token("state-line"), "line-width": 0.8 },
    },
    before,
  );
  m.addLayer(
    {
      id: "de-edge",
      type: "line",
      source: "laender",
      filter: outside,
      paint: { "line-color": token("text-3"), "line-width": 1.5 },
    },
    before,
  );
  fadeAreas(m, z0);
}

const palette: Partial<Record<Theme, Record<string, string>>> = {};
const SCALE_TOKENS = ["r", "c"].flatMap((scale) => [1, 2, 3, 4, 5].map((i) => `${scale}${i}`));

/**
 * One point per station with everything the layers need. Colours are the tokens of `theme`, so a
 * theme switch only has to rebuild this. The day map (`day`) colours by the deviation from the
 * API's class (`klasse`) on the `r` scale and draws a station with nothing to compare in the
 * neutral grey `c3`. On today a tooltip also names the stand of the station's source: `stands`
 * for the collector's stations (`live`), the others take the rest.
 * ponytail: a metric switch rebuilds and re-sends all ~5k points; move to feature-state if it stutters
 */
function toFeatures(
  stations: Entry[],
  metric: Metric,
  theme: Theme,
  day: boolean,
  stands: { live?: string; rest?: string },
) {
  // <html data-theme> already is `theme` when this runs; the tokens are read once per theme.
  const colours = (palette[theme] ??= Object.fromEntries(
    ["surface", "cancel", ...SCALE_TOKENS].map((n) => [n, token(n)]),
  ));
  const surface = colours.surface;
  const most = stations.reduce((a, s) => Math.max(a, s.n), 1);
  return {
    type: "FeatureCollection" as const,
    features: stations.map((s) => {
      const shown = show(metric, s, s.name);
      const v = DEFS[metric].value(s);
      const dev = day ? deviation(metric, s) : null;
      let cls: number | null = null;
      if (day) cls = dev?.cls ?? null;
      else if (v !== null) cls = classOf(metric, v);
      const fill = colours[cls ? `${day ? "r" : DEFS[metric].scale}${cls}` : day ? "c3" : "cancel"];
      let value = shown.text;
      // Only the live day lists a station without stops (one the collector does not cover).
      if (day && s.n === 0) value = t("map.day.todayNone");
      else if (shown.low) value = t("map.lowShort");
      else if (v === null) value = t("hm.onlyCancelledLegend");
      else if (day)
        value = dev
          ? t("map.day.tip", {
              value: shown.text,
              normal: dev.normal,
              class: t(`map.day.class.${dev.cls}`),
            })
          : t("map.day.tipNone", { value: shown.text });
      // The "~" tier of `show` is pale, the tier without a value very pale.
      const faint = shown.low || shown.approx;
      const alpha = shown.low ? VERY_PALE : faint ? PALE : 1;
      const stand = s.n > 0 ? (s.live ? stands.live : stands.rest) : undefined;
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: {
          eva: s.eva,
          tip: t("map.tip", { name: s.name, value }) + (stand ? ` · ${stand}` : ""),
          r: 3 + 7 * Math.sqrt(s.n / most),
          fill,
          // Little data: a hollow circle with a ring in the scale colour.
          stroke: shown.low ? fill : surface,
          hollow: shown.low ? 1 : 0,
          alpha,
          // Dots with enough data draw above the faint ones; within a group worse classes are on
          // top, so problem spots are never hidden.
          sort: (faint ? 0 : 10) + (cls ?? (day ? 0 : 5)),
        },
      };
    }),
  };
}

const categoryName = (g: FilterKeys["g"]) =>
  g ? t(g === "fern" ? "filter.fern" : "filter.regional") : t("map.allCategories");

/**
 * The period map (`/karte`), or with `day` the Live-Lage page (`/lage`): the large stations on one
 * day against the usual, today if there is a today.
 */
export default function MapPage({ day = false }: { day?: boolean }) {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const root = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const stack = useRef<HTMLDivElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  // A state was picked: its card's back button takes the focus once it is there, since the
  // picked card goes with the zoom.
  const focusBack = useRef(false);
  // Counts the picks of the state already picked, each of which fits it again.
  const [refits, setRefits] = useState(0);
  const status = useDatenstand();
  const datenstand = status.data;
  const read = readFilters(params);
  // The Live-Lage page shows one day and has no period or train type (it ignores g, von and bis).
  // A day outside the data moves
  // to its nearest edge (the middle of three ISO dates in order is the clamped one); any day after
  // the last complete one moves to the live day, which is the only one served beyond it. Without
  // a tag the page shows the newest day, which also is not written, so a bookmark opens live.
  const newest = datenstand && (datenstand.heute ?? datenstand.letzter_tag);
  const wanted =
    read.tag && datenstand
      ? read.tag > datenstand.letzter_tag && datenstand.heute
        ? datenstand.heute
        : [datenstand.erster_tag, read.tag, datenstand.letzter_tag].sort()[1]
      : read.tag;
  const tag = day && wanted !== newest ? wanted : undefined;
  const shown = tag ?? newest;
  const f: FilterKeys = {
    ...read,
    tag,
    // Only a state's code; an unknown one is dropped from the URL like any invalid key.
    land: day && read.land && Object.hasOwn(ANCHORS, read.land) ? read.land : undefined,
    linie: undefined,
    z: undefined,
  };
  const periodMap = useQuery({
    queryKey: ["karte", f.g, f.von, f.bis],
    queryFn: () =>
      api
        .GET("/karte", { params: { query: { gattung: f.g ?? "alle", von: f.von, bis: f.bis } } })
        .then(must),
    enabled: !day,
    placeholderData: keepPreviousData,
  });
  const dayMap = useQuery({
    queryKey: ["tageskarte", shown],
    queryFn: async () => {
      const answer = await api.GET("/tageskarte", { params: { query: { tag: shown! } } });
      // Today's map is gone (a tab left open across midnight): ask what the data covers now, so
      // the clamp moves the day before the failure shows.
      if (answer.response.status === 404 && shown === datenstand?.heute) await status.refetch();
      return must(answer);
    },
    // The day is clamped to the data first, so the request never names a day outside it.
    enabled: day && !!shown && !!datenstand,
    placeholderData: keepPreviousData,
    // The live day grows while the tab is open.
    refetchInterval: shown && shown === datenstand?.heute ? LIVE_REFRESH : false,
  });
  const q = day ? dayMap : periodMap;
  const data = q.data;
  // Labels name the day the data on screen is for, which lags behind the URL while a day loads.
  const shownDay = dayMap.data?.tag ?? shown;
  // The Live-Lage page also needs /datenstand to know its day, so its failure is the page's error
  // too, unless it already has it (a failed refresh of the data stand leaves a working map alone).
  const failed = q.isError || (day && status.isError && !datenstand);
  // Today has up to two sources, each with a data time and a cut hour: the collector's run for the
  // large stations (`stand`) and piebro's partial day for the others (`stand_rest`).
  const d = day ? dayMap.data : undefined;
  const live = d?.stand && d.bis_stunde != null ? { stand: d.stand, cut: d.bis_stunde } : undefined;
  const rest =
    d?.stand_rest && d.bis_stunde_rest != null
      ? { stand: d.stand_rest, cut: d.bis_stunde_rest }
      : undefined;
  const today = !!(live || rest);
  const liveStand = live && formatStand(live.stand, live.cut);
  const restStand = rest && formatStand(rest.stand, rest.cut);
  const period = day
    ? shownDay && (today ? t("map.day.today") : formatDay(shownDay))
    : periodMap.data?.n
      ? formatPeriod(periodMap.data.von, periodMap.data.bis)
      : undefined;
  // The Live-Lage page ignores g, von and bis and leaves them in the URL, so the other pages
  // get them back; it counts all trains.
  const category = categoryName(day ? undefined : f.g);
  const station = f.bhf ? data?.stationen.find((s) => s.eva === f.bhf) : undefined;
  // The panel names the stand of the station's own source.
  const own = (station as Entry | undefined)?.live ? live : rest;
  const panelPeriod = today && own ? formatLive(own.stand, own.cut) : period;
  // The Germany card counts the collector's stations if there is a run, else all that report.
  const source = d?.deutschland_live ? live : (rest ?? live);
  // The picked state and its values, if the day lists it.
  const picked = f.land;
  const land = d?.laender.find((l) => l.land === picked);

  useEffect(() => {
    if (!focusBack.current || !back.current) return;
    focusBack.current = false;
    back.current.focus();
  });

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let meta = "";
  if (q.isPending && !failed) meta = t("map.loading");
  else if (data)
    meta =
      t("map.meta", {
        period: period ?? "–",
        category,
        x: int(data.stationen.length),
      }) + (data.ohne_koordinaten ? t("map.metaMissing", { n: int(data.ohne_koordinaten) }) : "");

  return (
    <div ref={root} className="absolute inset-0 overflow-hidden">
      <StationMap
        card={card}
        stack={day ? stack : undefined}
        panel={!!f.bhf}
        stations={data?.stationen}
        day={day}
        liveStand={liveStand}
        restStand={restStand}
        metric={f.k}
        selected={station}
        onPick={(eva) => setParams(withParam("bhf", eva))}
        laender={d?.laender}
        today={today}
        land={picked}
        refits={refits}
        onLand={(code) => {
          focusBack.current = true;
          if (code === picked) setRefits((n) => n + 1);
          else setParams(withParam("land", code));
        }}
      />

      <div
        ref={card}
        data-testid="map-card"
        // With the 360 px panel open the card stops 12 px before it, and its rows wrap.
        className={`absolute inset-x-2.5 top-2.5 z-10 flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border bg-surface p-2.5 shadow-card md:top-3 md:right-auto md:left-3 md:p-3 ${f.bhf ? "md:max-w-[calc(100%-396px)]" : "md:max-w-[calc(100%-24px)]"}`}
      >
        <div className="max-md:-mb-2.5">
          <h1 className="text-lg leading-tight font-[650] tracking-[-0.015em] max-md:sr-only">
            {t(day ? "nav.live" : "map.title")}
          </h1>
          <p className="mt-0.5 hidden text-[13px] text-text-2 md:block">
            {t(day ? "lage.lead" : "map.lead")}
          </p>
        </div>
        <MetricSwitch
          metric={f.k}
          onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
          className="-mx-2.5 -my-2 px-2.5 py-2 md:m-0 md:p-0"
          helpOnPhone={false}
        />
        <div className="-mb-2.5">
          <Filters lage={day} stationName={data ? station?.name : null} />
        </div>
      </div>

      <div
        ref={stack}
        className="absolute bottom-4 left-2.5 z-10 flex flex-col gap-2.5 md:bottom-6 md:left-3 md:w-[300px]"
      >
        {d && (
          <AreaCard
            {...(picked
              ? {
                  title: landName(picked),
                  // A state the day does not list has no stations and no values.
                  count: land?.bahnhoefe ?? 0,
                  onBack: () => {
                    setParams(withParam("land", ""));
                    // The button goes with the state's card: hand the focus to the map.
                    root.current?.querySelector("canvas")?.focus();
                  },
                  backRef: back,
                  area: land?.alle ?? null,
                  fern: land?.fern ?? null,
                  regional: land?.regional ?? null,
                }
              : {
                  title: t("map.day.germany"),
                  area: d.deutschland,
                  fern: d.deutschland_fern,
                  regional: d.deutschland_regional,
                })}
            tag={d.tag}
            today={source && formatLive(source.stand, source.cut)}
            metric={f.k}
            gap={d.fehlende_stunden}
          />
        )}
        <Legend
          metric={f.k}
          meta={meta}
          fresh={[
            liveStand && t("map.day.freshLive", { stand: liveStand }),
            restStand && t(live ? "map.day.freshRest" : "map.day.freshAll", { stand: restStand }),
          ].filter((line): line is string => !!line)}
          day={
            day
              ? {
                  weekday: shownDay ? weekdayOf(shownDay) : "",
                  refs: dayMap.data?.referenztage.length,
                }
              : undefined
          }
        />
      </div>

      {data && data.stationen.length === 0 && (
        <EmptyCard
          title={t("map.empty")}
          onReset={() => setParams(clearParams)}
          className="absolute top-1/2 left-1/2 z-10 w-[min(340px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-card"
        />
      )}

      {failed && (
        <div className="absolute bottom-6 left-1/2 z-30 w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-xl bg-surface shadow-card">
          <ErrorBanner onRetry={() => (q.isError ? q : status).refetch()} />
        </div>
      )}

      {f.bhf && (
        <StationPanel
          eva={f.bhf}
          station={station}
          loaded={!!data}
          day={day}
          category={category}
          period={panelPeriod}
          onClose={() => {
            setParams(withParam("bhf", ""));
            // The panel is about to go, with the focus inside it: hand the focus to the map.
            root.current?.querySelector("canvas")?.focus();
          }}
        />
      )}
    </div>
  );
}

function StationMap({
  card,
  stack,
  panel,
  stations,
  day,
  liveStand,
  restStand,
  metric,
  selected,
  onPick,
  laender,
  today,
  land,
  refits,
  onLand,
}: {
  /** The floating filter card, which the start view keeps clear of. */
  card: RefObject<HTMLElement | null>;
  /** The bottom card stack, which the start view keeps clear of on a phone (Live-Lage only). */
  stack?: RefObject<HTMLElement | null>;
  /** The station panel is open, which a state's fit keeps clear of on desktop. */
  panel: boolean;
  stations?: Entry[];
  /** True for the day map, which colours by the deviation from the normal. */
  day: boolean;
  /** On today the stand of each source, which the tooltips name. */
  liveStand?: string;
  restStand?: string;
  metric: Metric;
  selected?: KartenStation;
  onPick: (eva: string) => void;
  /** The day map's states, drawn as cards and areas at the overview. */
  laender?: Land[];
  today: boolean;
  /** The picked state, which the map zooms to (again with each new `refits`); none zooms back to Germany. */
  land?: string;
  refits: number;
  onLand: (land: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  // Zoomed in past the overview: no state cards, full dots that take hover and click. The ref is
  // the same for the map's own event handlers.
  const [detail, setDetail] = useState(false);
  const detailNow = useRef(false);
  const fade = day && !detail ? FADED : 1;
  // The state under the mouse or the hovered/focused card; its area is tinted at the overview.
  const [hovered, setHovered] = useState<string | null>(null);
  const tint = day && !detail ? hovered : null;
  const tinted = useRef<string | null>(null);
  // The camera of the last fit of Germany, the start view, and the state the camera was fitted to.
  const home = useRef({ z: 0, c: { lng: 0, lat: 0 } });
  const fitted = useRef<{ land?: string; refits: number }>({ refits: 0 });
  // The state shapes (none if they failed to load) and the zoom of the picked state's fit.
  const [fitShapes, setFitShapes] = useState<Shapes | null>();
  const stateZoom = useRef<number | undefined>(undefined);
  // The zoom past which the cards go and the dots are full: one step past the start view, or the
  // picked state's fit if that is lower, so the whole state shows its dots.
  const detailAt = useEffectEvent(() =>
    Math.min(home.current.z + DETAIL_STEP, stateZoom.current ?? Infinity),
  );
  const { resolved } = useTheme();
  // The theme of the base style the map shows or is loading.
  const styled = useRef(resolved);
  const features = useMemo(
    () =>
      stations && toFeatures(stations, metric, resolved, day, { live: liveStand, rest: restStand }),
    [stations, metric, resolved, day, liveStand, restStand],
  );
  // What a freshly loaded base style needs to draw the stations again.
  const current = useEffectEvent(() => ({
    data: features ?? NO_STATIONS,
    eva: selected?.eva ?? "",
    day,
    fade,
  }));
  // The station picked on the map itself, which needs no camera move.
  const clicked = useRef<string | null>(null);
  const pick = useEffectEvent((eva: string) => {
    // Already selected: no new history entry, and no stale mark that would swallow a later camera move.
    if (eva === selected?.eva) return;
    clicked.current = eva;
    onPick(eva);
  });
  const hoverArea = useEffectEvent((code: string, x: number, y: number) => {
    setHovered(code);
    if (laender && matchMedia("(hover: hover)").matches)
      setTip({
        text: stateTip(
          code,
          laender.find((l) => l.land === code),
          metric,
          today,
        ),
        x,
        y,
      });
  });
  const pickArea = useEffectEvent((code: string) => {
    setTip(null);
    onLand(code);
  });

  useEffect(() => {
    const m = new MapLibre({
      container: box.current!,
      style: STYLE[styled.current],
      bounds: GERMANY,
      fitBoundsOptions: { padding: padding(card.current!, box.current!, stack?.current) },
      attributionControl: false,
      locale: {
        "Map.Title": t("map.region"),
        "NavigationControl.ZoomIn": t("map.zoomIn"),
        "NavigationControl.ZoomOut": t("map.zoomOut"),
        "AttributionControl.ToggleAttribution": t("map.attributionToggle"),
      },
    });
    // A bottom corner stacks each new control above the previous one, so the attribution comes
    // first to sit below the zoom buttons.
    // The control renders HTML, like the style's own attribution links.
    const licence = `<a href="${t("data.licenceUrl")}" target="_blank" rel="noopener">${t("data.licence")}</a>`;
    m.addControl(
      new AttributionControl({
        compact: true,
        customAttribution: t("map.attribution", { licence }),
      }),
      "bottom-right",
    );
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    // The Live-Lage page's state areas, fetched once and kept for every base style.
    let shapes: Shapes | undefined;
    let gone = false;
    if (current().day)
      fetch(`${import.meta.env.BASE_URL}laender.geojson`)
        .then((r) => r.json())
        .then((json: Shapes) => {
          if (gone) return;
          shapes = json;
          setFitShapes(json);
          // The style is in already: add them now, else style.load does.
          if (m.getLayer("stations")) addAreas(m, json, detailAt());
        })
        // The state cards work without the areas, and a state's fit falls back to its stations.
        .catch(() => setFitShapes(null));
    // Runs for every base style, so a theme switch (which drops our source and layers) gets them back.
    m.on("style.load", () => {
      for (const l of m.getStyle().layers)
        if (l.type === "symbol") {
          m.setLayerZoomRange(l.id, Math.max(l.minzoom ?? 0, LABEL_ZOOM), l.maxzoom ?? 24);
          const field = l.layout?.["text-field"];
          if (field) m.setLayoutProperty(l.id, "text-field", localLabel(field));
        }
      const now = current();
      if (shapes) addAreas(m, shapes, detailAt());
      // A new base style drops the feature-state: the state tinted at the switch keeps its tint.
      if (shapes && tinted.current)
        m.setFeatureState({ source: "laender", id: tinted.current }, { hover: true });
      m.addSource("stations", { type: "geojson", data: now.data });
      m.addLayer({
        id: "stations",
        type: "circle",
        source: "stations",
        layout: { "circle-sort-key": ["get", "sort"] },
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["get", "fill"],
          "circle-stroke-color": ["get", "stroke"],
          "circle-stroke-width": ["+", 1, ["*", 0.5, ["get", "hollow"]]],
        },
      });
      setFade(m, now.fade);
      m.addLayer({
        id: "selected",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "eva"], now.eva],
        paint: {
          "circle-radius": ["+", ["get", "r"], 4],
          "circle-opacity": 0,
          "circle-stroke-color": token("accent"),
          "circle-stroke-width": 2.5,
        },
      });
    });
    m.on("load", () => setMap(m));
    const hover = matchMedia("(hover: hover)").matches;
    // At the Live-Lage overview the faded dots take no hover and no click; the state areas do.
    const dots = () => !current().day || detailNow.current;
    m.on("mousemove", "stations", (e) => {
      if (!dots()) return;
      m.getCanvas().style.cursor = "pointer";
      const text = e.features?.[0]?.properties.tip;
      if (hover && text) setTip({ text, x: e.point.x, y: e.point.y });
    });
    m.on("mouseleave", "stations", () => {
      if (!dots()) return;
      m.getCanvas().style.cursor = "";
      setTip(null);
    });
    m.on("click", "stations", (e) => {
      const eva = e.features?.[0]?.properties.eva;
      if (!eva || !dots()) return;
      // The panel opening narrows the card; a click on the map must not move the camera.
      watch.disconnect();
      pick(String(eva));
    });
    // MapLibre also turns events on the state cards (markers inside its container) into map events
    // at the pointer, which may lie over a neighbouring state: the areas take only the canvas's.
    const areas = (e: MapMouseEvent) =>
      !detailNow.current && e.originalEvent.target === m.getCanvas();
    m.on("mousemove", "laender", (e) => {
      const code = e.features?.[0]?.properties.code;
      if (!areas(e) || !code) return;
      m.getCanvas().style.cursor = "pointer";
      hoverArea(String(code), e.point.x, e.point.y);
    });
    m.on("mouseleave", "laender", (e) => {
      if (!areas(e)) return;
      m.getCanvas().style.cursor = "";
      setHovered(null);
      setTip(null);
    });
    m.on("click", "laender", (e) => {
      const code = e.features?.[0]?.properties.code;
      if (areas(e) && code) pickArea(String(code));
    });
    // The cards' heights change while the page loads (period list, font, the day's card) and with
    // the width: fit again as long as the camera still sits where the last fit put it and nobody
    // picked a station or a state (whose zoom starts on the next frame, so the camera may not have
    // moved yet).
    home.current = { z: m.getZoom(), c: m.getCenter() };
    const refit = () => {
      // A callback queued before the cleanup can run once the page's elements are gone.
      if (!card.current || !box.current || fitted.current.land) return;
      const { z, c } = home.current;
      if (m.getZoom() !== z || m.getCenter().lng !== c.lng || m.getCenter().lat !== c.lat) return;
      m.fitBounds(GERMANY, {
        padding: padding(card.current, box.current, stack?.current),
        animate: false,
      });
      home.current = { z: m.getZoom(), c: m.getCenter() };
      fadeAreas(m, detailAt());
    };
    m.on("zoom", () => {
      // An eased zoom can end a rounding error short of its target.
      const now = m.getZoom() > detailAt() - 1e-6;
      if (now === detailNow.current) return;
      detailNow.current = now;
      // A keyboard zoom from a focused state card takes the card away: the focus goes to the map.
      if (now && document.activeElement?.closest(".maplibregl-marker")) m.getCanvas().focus();
      // A state's tooltip and tint, or a dot's, belong to the other side of the detail zoom.
      setTip(null);
      setHovered(null);
      setDetail(now);
    });
    // Tests read where the camera ended: the zoom and the visible bounds as west,south,east,north.
    const el = box.current!;
    m.on("moveend", () => {
      el.dataset.zoom = String(m.getZoom());
      el.dataset.bounds = m.getBounds().toArray().flat().join();
    });
    const watch = new ResizeObserver(refit);
    watch.observe(card.current!);
    if (stack?.current) watch.observe(stack.current);
    return () => {
      gone = true;
      watch.disconnect();
      m.remove();
    };
  }, [card, stack]);

  useEffect(() => {
    // Only a change after the map exists; the first style is already the right one.
    if (!map || styled.current === resolved) return;
    styled.current = resolved;
    const el = box.current!;
    el.dataset.ready = "false";
    // A full reload, so style.load fires again and re-adds the station layers.
    map.setStyle(STYLE[resolved], { diff: false });
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, resolved]);

  useEffect(() => {
    // While a new base style loads the layer is missing; style.load sets the latest fade.
    if (map?.getLayer("stations")) setFade(map, fade);
  }, [map, fade]);

  useEffect(() => {
    // Without the areas (not fetched yet, or a new base style loading) there is nothing to tint.
    if (!map?.getSource("laender")) return;
    if (tinted.current)
      map.setFeatureState({ source: "laender", id: tinted.current }, { hover: false });
    if (tint) map.setFeatureState({ source: "laender", id: tint }, { hover: true });
    tinted.current = tint;
  }, [map, tint]);

  // Zoom to the picked state, or back to Germany once it is dropped: once per change or new pick of
  // the same state, with data.
  useEffect(() => {
    const now = fitted.current;
    // On the day map a state fits its shape, so it waits for the shapes (or their failure).
    if (!map || !stations || (day && fitShapes === undefined)) return;
    if (now.land === land && now.refits === refits) return;
    fitted.current = { land, refits };
    const room = padding(card.current!, box.current!, stack?.current);
    // On desktop the open panel takes the right 360 px plus its 12 px margin and a 12 px gap.
    const options = { padding: panel && !narrow.matches ? { ...room, right: 384 } : room };
    if (!land) {
      // The start view is the fit's target, not wherever an interrupted ease stops.
      const target = map.cameraForBounds(GERMANY, options);
      if (!target) return;
      home.current = { z: target.zoom!, c: LngLat.convert(target.center!) };
      stateZoom.current = undefined;
      fadeAreas(map, detailAt());
      map.fitBounds(GERMANY, options);
      map.once("moveend", () => {
        // The camera the ease ends on, which the refit compares exactly; only if it got there.
        if (Math.abs(map.getZoom() - target.zoom!) < 1e-6)
          home.current = { z: map.getZoom(), c: map.getCenter() };
      });
      return;
    }
    // The whole shape; without the shapes the state's stations, or for none that day its card's anchor.
    const bounds = shapeBounds(fitShapes, land) ?? new LngLatBounds();
    if (bounds.isEmpty())
      for (const s of stations) if (s.land === land) bounds.extend([s.lon, s.lat]);
    if (bounds.isEmpty()) bounds.extend(ANCHORS[land]);
    const camera = map.cameraForBounds(bounds, { ...options, maxZoom: STATE_ZOOM });
    if (!camera) return;
    // The state's dots show in full from its fit on, even where that is short of the usual detail zoom.
    stateZoom.current = camera.zoom;
    fadeAreas(map, detailAt());
    map.easeTo(camera);
  }, [map, stations, day, fitShapes, land, refits, panel, card, stack]);

  useEffect(() => {
    const el = box.current;
    // While a new base style loads there is no source yet; style.load adds it with the latest data.
    const source = map?.getSource("stations") as GeoJSONSource | undefined;
    if (!map || !source || !features || !el) return;
    // Tests wait for data-ready: the map is idle with this data drawn.
    el.dataset.ready = "false";
    source.setData(features);
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, features]);

  const eva = selected?.eva;
  const lon = selected?.lon;
  const lat = selected?.lat;
  useEffect(() => {
    if (!map) return;
    // While a new base style loads the layer is missing (setFilter would throw); style.load adds it with this selection.
    if (map.getLayer("selected")) map.setFilter("selected", ["==", ["get", "eva"], eva ?? ""]);
    if (clicked.current === eva) {
      clicked.current = null;
      return;
    }
    if (lon === undefined || lat === undefined) return;
    // Keep the station clear of the panel: right of centre on desktop, above the sheet on mobile.
    const offset: [number, number] = narrow.matches
      ? [0, -map.getContainer().clientHeight * 0.3]
      : [-180, 0];
    map.easeTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), FOCUS_ZOOM), offset });
  }, [map, eva, lon, lat]);

  return (
    <>
      {/* MapLibre's own CSS makes its container position: relative, so the wrapper positions it. */}
      <div className="absolute inset-0">
        <div ref={box} data-testid="map" className="size-full bg-surface-2" />
      </div>
      {map && laender && !detail && (
        <StateMarkers
          map={map}
          laender={laender}
          today={today}
          metric={metric}
          onPick={onLand}
          onTip={setTip}
          onHover={setHovered}
        />
      )}
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-20 max-w-[260px] -translate-x-1/2 -translate-y-full rounded-[7px] bg-text px-[9px] py-1.5 text-[12.5px] text-bg shadow-card"
          style={{ left: tip.x, top: tip.y - 12 }}
        >
          {tip.text}
        </div>
      )}
    </>
  );
}

const CLASSES = [1, 2, 3, 4, 5] as const;

/** `day` is set on the day map: its steps are the deviation classes, not the metric's limits. */
function Legend({
  metric,
  meta,
  fresh,
  day,
}: {
  metric: Metric;
  meta: string;
  /** On today one line per source: which stations it covers, its data time and its cut. */
  fresh: string[];
  day?: { weekday: string; refs?: number };
}) {
  const isNarrow = useNarrow();
  const [open, setOpen] = useState(!isNarrow);
  const scale = day ? "r" : DEFS[metric].scale;
  return (
    <section
      aria-label={t("map.legend")}
      className="rounded-xl border border-border bg-surface px-3 py-2 shadow-card md:w-[300px] md:px-3.5 md:py-3"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="hit inline-flex cursor-pointer items-center gap-1 text-[12.5px] font-semibold md:hidden"
      >
        {t("map.legend")}
        <Icon name="chev" className={`size-4 ${open ? "rotate-180" : ""}`} />
      </button>
      <div className={open ? "mt-1.5 md:mt-0" : "hidden md:block"}>
        <p className="text-[13px] font-semibold">
          {t(`metric.${metric}`)}
          {day && <span className="text-xs font-normal text-text-3"> · {t("map.day.help")}</span>}
        </p>
        <div aria-hidden="true" className="mt-2 mb-1 grid grid-cols-5 gap-0.5">
          {FILL[scale].map((c) => (
            <i key={c} className={`block h-2.5 first:rounded-l-[5px] last:rounded-r-[5px] ${c}`} />
          ))}
        </div>
        <div className="grid grid-cols-5 gap-x-1 text-center text-[11px] text-text-3 tabular-nums">
          {(day ? CLASSES.map((i) => t(`map.day.class.${i}`)) : legend(metric)).map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
        {!day && (
          <div className="mt-1 flex justify-between text-[11.5px] font-[550] text-text-2">
            <span>{t(`map.good.${metric}`)}</span>
            <span>{t(`map.bad.${metric}`)}</span>
          </div>
        )}
        <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-text-2">
          {day && (
            <span className="inline-flex items-center gap-1.5">
              <i className="size-2.5 rounded-full bg-c3" />
              {t("map.day.noCompare")}
            </span>
          )}
          {fresh.length > 0 && (
            // Only today lists stations without stops: the ring they are drawn with
            <span className="inline-flex items-center gap-1.5">
              <i
                className="size-2.5 rounded-full border-[1.5px] border-c3"
                style={{ opacity: VERY_PALE }}
              />
              {t("map.day.todayNone")}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <i
              className="size-2.5 rounded-full border-[1.5px] border-text-3"
              style={{ opacity: VERY_PALE }}
            />
            {t("map.lowKey", { n: LOW_N })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2.5 rounded-full bg-text-3" style={{ opacity: PALE }} />
            {t("map.paleKey", { n: APPROX_N })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-[5px] rounded-full bg-text-3" />
            <i className="size-[9px] rounded-full bg-text-3" />
            {t("map.sizeKey")}
          </span>
        </div>
        {day && <p className="mt-2 text-xs text-text-2">{t("map.day.rule")}</p>}
        {day?.refs !== undefined && (
          <p className="mt-1 text-xs text-text-2">
            {t("map.day.refs", { n: day.refs, weekday: day.weekday, weeks: REFERENCE_WEEKS })}
          </p>
        )}
        {fresh.map((line) => (
          <p key={line} className="mt-1 text-xs text-text-2">
            {line}
          </p>
        ))}
        <p className="mt-2 text-xs text-text-3">{meta}</p>
      </div>
    </section>
  );
}

function StationPanel({
  eva,
  station,
  loaded,
  day,
  category,
  period,
  onClose,
}: {
  eva: string;
  station?: Entry;
  loaded: boolean;
  /** True on the day map: each tile also shows its normal. */
  day: boolean;
  category: string;
  period?: string;
  onClose: () => void;
}) {
  const { search } = useLocation();
  const lookup = useQuery({
    queryKey: ["station", eva],
    queryFn: () => api.GET("/stationen/{eva}", { params: { path: { eva } } }).then(must),
    // Until the map data is in, the station may still be part of it.
    enabled: loaded && !station,
    staleTime: Infinity,
  });
  const name = station?.name ?? lookup.data?.name ?? t("filter.eva", { eva });
  const tiles = station && METRICS.map((m) => ({ m, ...show(m, station, name) }));
  const [onTime, , bad] = tiles ?? [];

  // ponytail: fixed-height bottom sheet without drag or snap levels (design.md 2.1); add when users ask
  return (
    <aside
      aria-label={name}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
      className="absolute inset-x-0 bottom-0 z-20 max-h-[62%] overflow-auto rounded-t-[18px] border border-b-0 border-border bg-surface p-[18px] pt-[22px] shadow-card before:absolute before:top-2 before:left-1/2 before:h-1 before:w-10 before:-translate-x-1/2 before:rounded-sm before:bg-border md:inset-x-auto md:top-3 md:right-3 md:bottom-auto md:max-h-[calc(100%-24px)] md:w-[360px] md:rounded-xl md:border-b md:pt-[18px] md:before:hidden"
    >
      <button
        type="button"
        aria-label={t("map.close")}
        onClick={onClose}
        className="hit absolute top-2.5 right-2.5 grid size-8 cursor-pointer place-items-center rounded-lg text-text-3 hover:bg-surface-2 hover:text-text"
      >
        <Icon name="x" />
      </button>
      <h2 className="pr-8 text-[19px] leading-tight font-[650]">{name}</h2>
      <p className="mt-0.5 text-xs text-text-3">
        {t("map.sub", { eva: t("filter.eva", { eva }), category })}
      </p>

      {station && day && station.n === 0 ? (
        <p className="my-3 text-text-2">{t("map.day.todayNoneLong")}</p>
      ) : station && tiles ? (
        <>
          {tiles.some((x) => x.low) && (
            <p className="mt-3 flex items-center gap-1.5 text-xs font-[550] text-text-2">
              <span aria-hidden="true">◌</span>
              {t("map.lowNote", { n: int(station.n) })}
            </p>
          )}
          {onTime.value !== undefined && bad.value !== undefined && (
            <p className="my-3 text-[15px]">
              {tx("map.sentence", {
                share: <b className="font-[650]">{t("map.share", { x: tenths(onTime.value) })}</b>,
                p90: <b className="font-[650]">{bad.text}</b>,
              })}
            </p>
          )}
          <div className="mt-3 mb-3.5 grid grid-cols-2 gap-2">
            {tiles.map((x) => {
              // The day map: the stripe is the deviation class, and the normal stands below the value.
              const dev = day ? deviation(x.m, station) : null;
              let fill = x.fill;
              if (day) fill = dev ? FILL.r[dev.cls - 1] : x.low ? x.fill : "bg-c3";
              return (
                <div
                  key={x.m}
                  className="relative overflow-hidden rounded-[10px] bg-surface-2 py-2.5 pr-3 pl-4"
                >
                  <i aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${fill}`} />
                  <div className="text-[11.5px] text-text-2">
                    {x.m === "ausfall" && (
                      <span aria-hidden="true" className="font-semibold text-cancel">
                        ✕{" "}
                      </span>
                    )}
                    {t(`metric.${x.m}`)}
                  </div>
                  <div className="text-[19px] font-[650] tabular-nums">{x.text}</div>
                  {day && (
                    <div className="text-[11.5px] text-text-3">
                      {dev
                        ? `${t("map.day.usual", { v: dev.normal })} · ${t(`map.day.class.${dev.cls}`)}`
                        : t("map.day.noCompare")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mb-3.5 text-xs text-text-3">
            {t("hm.meta", { n: int(station.n), period: period ?? "" })}
          </p>
        </>
      ) : (
        loaded && <p className="my-3 text-text-2">{t(day ? "lage.notLarge" : "map.noData")}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link to={{ pathname: stationPath(eva), search }} className={PRIMARY}>
          {t("map.details")}
        </Link>
        <span className="inline-flex h-[34px] items-center gap-1.5 px-2 font-medium text-text-2 opacity-55">
          {t("map.fromHere")}
          <SoonTag />
        </span>
      </div>
    </aside>
  );
}

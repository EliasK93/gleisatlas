import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  AttributionControl,
  Map as MapLibre,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { api, must } from "./api";
import { Filters } from "./Filters";
import { t, tx } from "./i18n";
import { Icon } from "./Icon";
import {
  classOf,
  DEFS,
  formatPeriod,
  int,
  legend,
  LOW_N,
  readFilters,
  tenths,
  withParam,
  writeFilters,
  type Filters as FilterKeys,
  type Metric,
} from "./metrics";
import type { components } from "./schema";
import {
  EmptyCard,
  ErrorBanner,
  FILL,
  MetricSwitch,
  narrow,
  PRIMARY,
  show,
  SoonTag,
  useNarrow,
} from "./ui";

type Karte = components["schemas"]["Karte"];
type KartenStation = components["schemas"]["KartenStation"];
type Tip = { text: string; x: number; y: number } | null;

// Bundled worker per the MapLibre v6 docs for Vite.
setWorkerUrl(workerUrl);

const STYLE = "https://tiles.openfreemap.org/styles/positron";
const GERMANY: [[number, number], [number, number]] = [
  [5.9, 47.3],
  [15.0, 55.05],
];
/** Base map labels appear from this zoom on, so the stations dominate the overview. */
const LABEL_ZOOM = 7;
const FOCUS_ZOOM = 9;
const NO_STATIONS = { type: "FeatureCollection" as const, features: [] };

const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
const SCALE_TOKENS = ["r", "c"].flatMap((scale) => [1, 2, 3, 4, 5].map((i) => `${scale}${i}`));

/**
 * One point per station with everything the layers need. Colours come from the theme tokens
 * at call time, so a theme switch only has to rebuild this.
 * ponytail: a metric switch rebuilds and re-sends all ~5k points; move to feature-state if it stutters
 */
function toFeatures(data: Karte, metric: Metric) {
  const colours = Object.fromEntries(
    ["surface", "cancel", ...SCALE_TOKENS].map((n) => [n, token(n)]),
  );
  const surface = colours.surface;
  const most = data.stationen.reduce((a, s) => Math.max(a, s.n), 1);
  return {
    type: "FeatureCollection" as const,
    features: data.stationen.map((s) => {
      const shown = show(metric, s, s.name);
      const v = DEFS[metric].value(s);
      const cls = v === null ? null : classOf(metric, v);
      const fill = colours[cls ? `${DEFS[metric].scale}${cls}` : "cancel"];
      let value = shown.text;
      if (shown.low) value = t("map.lowShort");
      else if (v === null) value = t("hm.onlyCancelledLegend");
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [s.lon, s.lat] },
        properties: {
          eva: s.eva,
          tip: t("map.tip", { name: s.name, value }),
          r: 3 + 7 * Math.sqrt(s.n / most),
          fill,
          // Little data: a hollow circle with a ring in the scale colour.
          stroke: shown.low ? fill : surface,
          hollow: shown.low ? 1 : 0,
          // Worse classes draw on top, so problem spots are never hidden.
          sort: cls ?? 5,
        },
      };
    }),
  };
}

const categoryName = (g: FilterKeys["g"]) =>
  g ? t(g === "fern" ? "filter.fern" : "filter.regional") : t("map.allCategories");

export default function MapPage() {
  const [params, setParams] = useSearchParams();
  const root = useRef<HTMLDivElement>(null);
  const f = readFilters(params);
  const q = useQuery({
    queryKey: ["karte", f.g, f.von, f.bis],
    queryFn: () =>
      api
        .GET("/karte", { params: { query: { gattung: f.g ?? "alle", von: f.von, bis: f.bis } } })
        .then(must),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const period = data?.n ? formatPeriod(data.von, data.bis) : undefined;
  const station = f.bhf ? data?.stationen.find((s) => s.eva === f.bhf) : undefined;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let meta = "";
  if (q.isPending) meta = t("map.loading");
  else if (data)
    meta =
      t("map.meta", {
        period: period ?? "–",
        category: categoryName(f.g),
        x: int(data.stationen.length),
      }) + (data.ohne_koordinaten ? t("map.metaMissing", { n: int(data.ohne_koordinaten) }) : "");

  return (
    <div ref={root} className="absolute inset-0 overflow-hidden">
      <StationMap
        data={data}
        metric={f.k}
        selected={station}
        onPick={(eva) => setParams(withParam("bhf", eva))}
      />

      <div className="absolute inset-x-2.5 top-2.5 z-10 flex flex-col gap-2.5 overflow-hidden rounded-xl border border-border bg-surface p-2.5 shadow-card md:top-3 md:right-auto md:left-3 md:max-w-[calc(100%-24px)] md:p-3">
        <div className="max-md:-mb-2.5">
          <h1 className="text-lg leading-tight font-[650] tracking-[-0.015em] max-md:sr-only">
            {t("map.title")}
          </h1>
          <p className="mt-0.5 hidden text-[13px] text-text-2 md:block">{t("map.lead")}</p>
        </div>
        <MetricSwitch
          metric={f.k}
          onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
          className="-mx-2.5 -my-2 px-2.5 py-2 md:m-0 md:p-0"
        />
        <div className="-mb-2.5">
          <Filters period={period} stationName={data ? station?.name : null} />
        </div>
      </div>

      <Legend metric={f.k} meta={meta} />

      {data && data.stationen.length === 0 && (
        <EmptyCard
          title={t("map.empty")}
          onReset={() => setParams({})}
          className="absolute top-1/2 left-1/2 z-10 w-[min(340px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-surface p-5 shadow-card"
        />
      )}

      {q.isError && (
        <div className="absolute bottom-6 left-1/2 z-30 w-[min(520px,calc(100%-32px))] -translate-x-1/2 rounded-xl bg-surface shadow-card">
          <ErrorBanner onRetry={() => q.refetch()} />
        </div>
      )}

      {f.bhf && (
        <StationPanel
          eva={f.bhf}
          station={station}
          loaded={!!data}
          category={categoryName(f.g)}
          period={period}
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
  data,
  metric,
  selected,
  onPick,
}: {
  data?: Karte;
  metric: Metric;
  selected?: KartenStation;
  onPick: (eva: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre | null>(null);
  const [tip, setTip] = useState<Tip>(null);
  // The station picked on the map itself, which needs no camera move.
  const clicked = useRef<string | null>(null);
  const pick = useEffectEvent((eva: string) => {
    // Already selected: no new history entry, and no stale mark that would swallow a later camera move.
    if (eva === selected?.eva) return;
    clicked.current = eva;
    onPick(eva);
  });

  useEffect(() => {
    const m = new MapLibre({
      container: box.current!,
      style: STYLE,
      bounds: GERMANY,
      // Room for the floating filter card on top.
      fitBoundsOptions: {
        padding: narrow.matches ? { top: 140, bottom: 40, left: 8, right: 8 } : 24,
      },
      attributionControl: false,
      locale: {
        "Map.Title": t("map.region"),
        "NavigationControl.ZoomIn": t("map.zoomIn"),
        "NavigationControl.ZoomOut": t("map.zoomOut"),
        "AttributionControl.ToggleAttribution": t("map.attributionToggle"),
      },
    });
    m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
    m.addControl(
      new AttributionControl({ compact: true, customAttribution: t("map.attribution") }),
      "bottom-right",
    );
    m.on("style.load", () => {
      for (const l of m.getStyle().layers)
        if (l.type === "symbol")
          m.setLayerZoomRange(l.id, Math.max(l.minzoom ?? 0, LABEL_ZOOM), l.maxzoom ?? 24);
    });
    m.on("load", () => {
      m.addSource("stations", { type: "geojson", data: NO_STATIONS });
      m.addLayer({
        id: "stations",
        type: "circle",
        source: "stations",
        layout: { "circle-sort-key": ["get", "sort"] },
        paint: {
          "circle-radius": ["get", "r"],
          "circle-color": ["get", "fill"],
          "circle-opacity": ["-", 1, ["get", "hollow"]],
          "circle-stroke-color": ["get", "stroke"],
          "circle-stroke-width": ["+", 1, ["*", 0.5, ["get", "hollow"]]],
        },
      });
      m.addLayer({
        id: "selected",
        type: "circle",
        source: "stations",
        filter: ["==", ["get", "eva"], ""],
        paint: {
          "circle-radius": ["+", ["get", "r"], 4],
          "circle-opacity": 0,
          "circle-stroke-color": token("accent"),
          "circle-stroke-width": 2.5,
        },
      });
      setMap(m);
    });
    const hover = matchMedia("(hover: hover)").matches;
    m.on("mousemove", "stations", (e) => {
      m.getCanvas().style.cursor = "pointer";
      const text = e.features?.[0]?.properties.tip;
      if (hover && text) setTip({ text, x: e.point.x, y: e.point.y });
    });
    m.on("mouseleave", "stations", () => {
      m.getCanvas().style.cursor = "";
      setTip(null);
    });
    m.on("click", "stations", (e) => {
      const eva = e.features?.[0]?.properties.eva;
      if (eva) pick(String(eva));
    });
    return () => m.remove();
  }, []);

  const features = useMemo(() => data && toFeatures(data, metric), [data, metric]);
  useEffect(() => {
    const el = box.current;
    if (!map || !features || !el) return;
    // Tests wait for data-ready: the map is idle with this data drawn.
    el.dataset.ready = "false";
    (map.getSource("stations") as GeoJSONSource).setData(features);
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, features]);

  const eva = selected?.eva;
  const lon = selected?.lon;
  const lat = selected?.lat;
  useEffect(() => {
    if (!map) return;
    map.setFilter("selected", ["==", ["get", "eva"], eva ?? ""]);
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

function Legend({ metric, meta }: { metric: Metric; meta: string }) {
  const isNarrow = useNarrow();
  const [open, setOpen] = useState(!isNarrow);
  const scale = DEFS[metric].scale;
  return (
    <section
      aria-label={t("map.legend")}
      className="absolute bottom-4 left-2.5 z-10 rounded-xl border border-border bg-surface px-3 py-2 shadow-card md:bottom-6 md:left-3 md:w-[300px] md:px-3.5 md:py-3"
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
          {t(`metric.${metric}`)}{" "}
          <span className="text-xs font-normal text-text-3">· {t(`map.help.${metric}`)}</span>
        </p>
        <div aria-hidden="true" className="mt-2 mb-1 grid grid-cols-5 gap-0.5">
          {FILL[scale].map((c) => (
            <i key={c} className={`block h-2.5 first:rounded-l-[5px] last:rounded-r-[5px] ${c}`} />
          ))}
        </div>
        <div className="grid grid-cols-5 text-center text-[11px] text-text-3 tabular-nums">
          {legend(metric).map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
        <div className="mt-1 flex justify-between text-[11.5px] font-[550] text-text-2">
          <span>{t(`map.good.${metric}`)}</span>
          <span>{t(`map.bad.${metric}`)}</span>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-text-2">
          <span className="inline-flex items-center gap-1.5">
            <i className="size-2.5 rounded-full border-[1.5px] border-text-3" />
            {t("map.lowKey", { n: LOW_N })}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <i className="size-[5px] rounded-full bg-text-3" />
            <i className="size-[9px] rounded-full bg-text-3" />
            {t("map.sizeKey")}
          </span>
        </div>
        <p className="mt-2 text-xs text-text-3">{meta}</p>
      </div>
    </section>
  );
}

const TILES: [Metric, "map.onTime" | `metric.${Metric}`][] = [
  ["puenktlich", "map.onTime"],
  ["median", "metric.median"],
  ["p90", "metric.p90"],
  ["ausfall", "metric.ausfall"],
];

function StationPanel({
  eva,
  station,
  loaded,
  category,
  period,
  onClose,
}: {
  eva: string;
  station?: KartenStation;
  loaded: boolean;
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
  const tiles = station && TILES.map(([m, title]) => ({ m, title, ...show(m, station, name) }));
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

      {station && tiles ? (
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
            {tiles.map((x) => (
              <div
                key={x.m}
                className="relative overflow-hidden rounded-[10px] bg-surface-2 py-2.5 pr-3 pl-4"
              >
                <i aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${x.fill}`} />
                <div className="text-[11.5px] text-text-2">
                  {x.m === "ausfall" && (
                    <span aria-hidden="true" className="font-semibold text-cancel">
                      ✕{" "}
                    </span>
                  )}
                  {t(x.title)}
                </div>
                <div className="text-[19px] font-[650] tabular-nums">{x.text}</div>
              </div>
            ))}
          </div>
          <p className="mb-3.5 text-xs text-text-3">
            {t("hm.meta", { n: int(station.n), period: period ?? "" })}
          </p>
        </>
      ) : (
        loaded && <p className="my-3 text-text-2">{t("map.noData")}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link to={{ pathname: `/bahnhof/${eva}`, search }} className={PRIMARY}>
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

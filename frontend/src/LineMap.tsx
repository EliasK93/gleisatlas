import {
  LngLatBounds,
  type ExpressionSpecification,
  type GeoJSONSource,
  type Map as MapLibre,
} from "maplibre-gl";
import { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { t } from "./i18n";
import { baseMap, STYLE, themeColours, token } from "./MapPage";
import { useTheme, type Theme } from "./prefs";
import type { MapSegment } from "./sections";
import { TipBox, type Tip } from "./ui";

export type MapPoint = { eva: string; name: string; lon: number; lat: number };

/** The segments as a line collection in the colours of `theme`, and the stations as points. */
function collections(points: MapPoint[], segments: MapSegment[], theme: Theme) {
  // <html data-theme> already is `theme` when this runs; the tokens are read once per theme.
  const colours = themeColours(theme, ["r1", "r2", "r3", "r4", "r5", "c3"]);
  const fill = (step: MapSegment["step"]) => colours[step ? `r${step}` : "c3"];
  return {
    segments: {
      type: "FeatureCollection" as const,
      features: segments.map((s) => ({
        type: "Feature" as const,
        geometry: { type: "LineString" as const, coordinates: s.coords },
        properties: {
          fill: fill(s.step),
          alpha: s.alpha,
          dashed: s.dashed ? 1 : 0,
          tip: s.tip,
          pair: s.pair ?? "",
        },
      })),
    },
    dots: {
      type: "FeatureCollection" as const,
      features: points.map((p) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
        properties: { tip: p.name },
      })),
    },
  };
}

/** The filter of the highlight layer: the segment of `pair`, none for no selection. */
const only = (pair?: string): ExpressionSpecification => ["==", ["get", "pair"], pair ?? "-"];

/**
 * A small map of one line: its sections as straight segments between the stations, coloured by
 * the caller's step (`fill` from the theme tokens), the stations on top. A click on a solid
 * segment picks its section (`onSelect`), and the `selected` one is drawn wider and fitted to its
 * two stations. The map fits all stations when they change or the selection ends, not when only
 * the segments do. Tests wait for `data-ready`, read the drawn segments from `data-segments`, the
 * selection from `data-selected` and where each solid segment's middle is from `data-mids`.
 */
export function LineMap({
  points,
  segments,
  selected,
  onSelect,
}: {
  points: MapPoint[];
  segments: MapSegment[];
  /** The `abschnitt` pair of the selected section. */
  selected?: string;
  onSelect: (pair: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre>();
  const [tip, setTip] = useState<Tip>(null);
  const { resolved } = useTheme();
  // The theme of the base style the map shows or is loading.
  const styled = useRef(resolved);
  const data = useMemo(() => collections(points, segments, resolved), [points, segments, resolved]);
  // What a freshly loaded base style needs to draw the line again.
  const current = useEffectEvent(() => ({ ...data, selected }));
  const pick = useEffectEvent(onSelect);

  useEffect(() => {
    const m = baseMap(box.current!, t("line.map.label"), styled.current, {
      center: [10.4, 51.2],
      zoom: 5,
    });
    // The compact attribution opens on load and would cover a third of this small map; it starts
    // collapsed here and opens from its button.
    box
      .current!.querySelector(".maplibregl-compact-show")
      ?.classList.remove("maplibregl-compact-show");
    // Runs for every base style, so a theme switch (which drops our sources and layers) gets them back.
    m.on("style.load", () => {
      const now = current();
      m.addSource("segments", { type: "geojson", data: now.segments });
      m.addSource("dots", { type: "geojson", data: now.dots });
      const line: Record<string, ExpressionSpecification> = {
        "line-color": ["get", "fill"],
        "line-opacity": ["get", "alpha"],
      };
      // Under the solid line, so the section's own colour stays visible inside the wider band.
      m.addLayer({
        id: "segments-selected",
        type: "line",
        source: "segments",
        filter: only(now.selected),
        layout: { "line-cap": "round" },
        paint: { "line-color": token("accent"), "line-width": 12, "line-opacity": 0.45 },
      });
      m.addLayer({
        id: "segments-solid",
        type: "line",
        source: "segments",
        filter: ["==", ["get", "dashed"], 0],
        paint: { ...line, "line-width": 5 },
      });
      m.addLayer({
        id: "segments-dashed",
        type: "line",
        source: "segments",
        filter: ["==", ["get", "dashed"], 1],
        paint: { ...line, "line-width": 4, "line-dasharray": [2, 1.5] },
      });
      m.addLayer({
        id: "dots",
        type: "circle",
        source: "dots",
        paint: {
          "circle-radius": 4.5,
          "circle-color": token("surface"),
          "circle-stroke-color": token("text-2"),
          "circle-stroke-width": 2,
        },
      });
    });
    m.on("load", () => setMap(m));
    m.on("click", "segments-solid", (e) => {
      const pair = e.features?.[0]?.properties.pair;
      if (pair) pick(pair);
    });
    m.on("mouseenter", "segments-solid", () => (m.getCanvas().style.cursor = "pointer"));
    m.on("mouseleave", "segments-solid", () => (m.getCanvas().style.cursor = ""));
    const hover = matchMedia("(hover: hover)").matches;
    for (const layer of ["segments-solid", "segments-dashed", "dots"]) {
      m.on("mousemove", layer, (e) => {
        const text = e.features?.[0]?.properties.tip;
        if (hover && text) setTip({ text, x: e.point.x, y: e.point.y });
      });
      m.on("mouseleave", layer, () => setTip(null));
    }
    return () => m.remove();
  }, []);

  useEffect(() => {
    // Only a change after the map exists; the first style is already the right one.
    if (!map || styled.current === resolved) return;
    styled.current = resolved;
    const el = box.current!;
    el.dataset.ready = "false";
    // A full reload, so style.load fires again and re-adds the line.
    map.setStyle(STYLE[resolved], { diff: false });
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, resolved]);

  // The test hook: what the map draws, ready or not.
  useEffect(() => {
    box.current!.dataset.segments = JSON.stringify(
      data.segments.features.map((f) => ({ ...f.properties, dashed: !!f.properties.dashed })),
    );
  }, [data]);

  useEffect(() => {
    const el = box.current;
    // While a new base style loads there is no source yet; style.load adds it with the latest data.
    const segmentsSource = map?.getSource("segments") as GeoJSONSource | undefined;
    const dotsSource = map?.getSource("dots") as GeoJSONSource | undefined;
    if (!map || !el || !segmentsSource || !dotsSource) return;
    el.dataset.ready = "false";
    segmentsSource.setData(data.segments);
    dotsSource.setData(data.dots);
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, data]);

  // The test hooks of the selection and of where a click can land.
  useEffect(() => {
    const el = box.current!;
    el.dataset.selected = selected ?? "";
    if (map?.getLayer("segments-selected")) map.setFilter("segments-selected", only(selected));
  }, [map, selected]);
  useEffect(() => {
    if (!map) return;
    const publish = () => {
      // The map's resize observer can fire once more after the page has left.
      const el = box.current;
      if (!el) return;
      const middles = data.segments.features.flatMap((f) => {
        if (!f.properties.pair) return [];
        const [a, b] = f.geometry.coordinates.map((c) => map.project(c as [number, number]));
        return [[f.properties.pair, [(a.x + b.x) / 2, (a.y + b.y) / 2]]];
      });
      el.dataset.mids = JSON.stringify(Object.fromEntries(middles));
    };
    publish();
    map.on("moveend", publish);
    return () => void map.off("moveend", publish);
  }, [map, data]);

  const fitKey = points.map((p) => p.eva).join();
  useEffect(() => {
    if (!map || !fitKey) return;
    // The selected section's two stations, else (also when one has no coordinates) all of them.
    const ends = selected?.split("-").map((eva) => points.find((p) => p.eva === eva));
    const fit = ends?.every(Boolean) ? (ends as MapPoint[]) : points;
    const bounds = new LngLatBounds();
    for (const p of fit) bounds.extend([p.lon, p.lat]);
    map.fitBounds(bounds, { padding: 40, maxZoom: 11, animate: false });
    // `points` is read only when the stations change, which `fitKey` names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey, selected]);

  return (
    <div className="relative h-[340px] overflow-hidden rounded-lg border border-border md:h-[420px]">
      <div ref={box} data-testid="line-map" className="size-full bg-surface-2" />
      <TipBox tip={tip} local />
    </div>
  );
}

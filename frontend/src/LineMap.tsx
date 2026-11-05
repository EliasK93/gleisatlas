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
        properties: { fill: fill(s.step), alpha: s.alpha, dashed: s.dashed ? 1 : 0, tip: s.tip },
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

/**
 * A small map of one line: its sections as straight segments between the stations, coloured by
 * the caller's step (`fill` from the theme tokens), the stations on top. The map fits the
 * stations when they change, not when only the segments do. Tests wait for `data-ready` and
 * read the drawn segments from `data-segments`.
 */
export function LineMap({ points, segments }: { points: MapPoint[]; segments: MapSegment[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibre>();
  const [tip, setTip] = useState<Tip>(null);
  const { resolved } = useTheme();
  // The theme of the base style the map shows or is loading.
  const styled = useRef(resolved);
  const data = useMemo(() => collections(points, segments, resolved), [points, segments, resolved]);
  // What a freshly loaded base style needs to draw the line again.
  const current = useEffectEvent(() => data);

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
    box.current!.dataset.ready = "false";
    // A full reload, so style.load fires again and re-adds the line.
    map.setStyle(STYLE[resolved], { diff: false });
    map.once("idle", () => {
      box.current!.dataset.ready = "true";
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

  const fitKey = points.map((p) => p.eva).join();
  useEffect(() => {
    if (!map || !fitKey) return;
    const bounds = new LngLatBounds();
    for (const p of points) bounds.extend([p.lon, p.lat]);
    map.fitBounds(bounds, { padding: 40, maxZoom: 11, animate: false });
    // `points` is read only when the stations change, which `fitKey` names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);

  return (
    <div className="relative h-[340px] overflow-hidden rounded-lg border border-border md:h-[420px]">
      <div ref={box} data-testid="line-map" className="size-full bg-surface-2" />
      <TipBox tip={tip} local />
    </div>
  );
}

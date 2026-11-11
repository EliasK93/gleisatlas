/** The map base both maps share: MapLibre's worker, the base styles, the controls and the theme tokens. */
import {
  AttributionControl,
  Map as MapLibre,
  NavigationControl,
  setWorkerUrl,
  type MapOptions,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";
import { t } from "./i18n";
import { localLabel } from "./metrics";
import { useTheme, type Theme } from "./prefs";

// Bundled worker per the MapLibre v6 docs for Vite.
setWorkerUrl(workerUrl);

export const STYLE: Record<Theme, string> = {
  light: "https://tiles.openfreemap.org/styles/positron",
  dark: "https://tiles.openfreemap.org/styles/dark",
};
/**
 * A map with the base both map pages share: the style of `theme`, the zoom buttons and the
 * attribution with its licence and dataset links (below the zoom buttons: a bottom corner stacks
 * each new control above the previous one), the control texts from the catalog (`title` names the
 * map for screen readers) and the base map's labels in the page language, for every base style
 * that loads. `view` says where the map looks.
 */
export function baseMap(
  container: HTMLElement,
  title: string,
  theme: Theme,
  view: Pick<MapOptions, "bounds" | "fitBoundsOptions" | "center" | "zoom">,
) {
  const m = new MapLibre({
    ...view,
    container,
    style: STYLE[theme],
    attributionControl: false,
    locale: {
      "Map.Title": title,
      "NavigationControl.ZoomIn": t("map.zoomIn"),
      "NavigationControl.ZoomOut": t("map.zoomOut"),
      "AttributionControl.ToggleAttribution": t("map.attributionToggle"),
    },
  });
  // The control renders HTML, like the style's own attribution links.
  const licence = `<a href="${t("data.licenceUrl")}" target="_blank" rel="noopener">${t("data.licence")}</a>`;
  const dataset = `<a href="${t("data.datasetUrl")}" target="_blank" rel="noopener">${t("data.dataset")}</a>`;
  m.addControl(
    new AttributionControl({
      compact: true,
      customAttribution: t("data.attribution", { dataset, licence }),
    }),
    "bottom-right",
  );
  m.addControl(new NavigationControl({ showCompass: false }), "bottom-right");
  m.on("style.load", () => {
    for (const l of m.getStyle().layers) {
      const field = l.type === "symbol" && l.layout?.["text-field"];
      if (field) m.setLayoutProperty(l.id, "text-field", localLabel(field));
    }
  });
  return m;
}

/**
 * The theme of the base style `map` shows or is loading; pass `.current` to `baseMap`. A theme
 * switch after the map exists loads the other style in full, so style.load fires again and the
 * caller's own sources and layers come back; the map's container is not `data-ready` until the
 * map is idle again.
 */
export function useBaseStyle(map: MapLibre | null | undefined) {
  const { resolved } = useTheme();
  const styled = useRef(resolved);
  useEffect(() => {
    // Only a change after the map exists; the first style is already the right one.
    if (!map || styled.current === resolved) return;
    styled.current = resolved;
    const el = map.getContainer();
    el.dataset.ready = "false";
    map.setStyle(STYLE[resolved], { diff: false });
    map.once("idle", () => {
      el.dataset.ready = "true";
    });
  }, [map, resolved]);
  return styled;
}

const palettes: Partial<Record<Theme, Record<string, string>>> = {};
/** The colours of the tokens `names` in `theme`, each read once. <html data-theme> already is `theme` when this runs. */
export function themeColours(theme: Theme, names: string[]) {
  const have = (palettes[theme] ??= {});
  for (const n of names) have[n] ??= token(n);
  return have;
}

export const token = (name: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();

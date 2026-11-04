import { Marker, type Map as MapLibre } from "maplibre-gl";
import { useEffect, useMemo } from "react";
import { createPortal } from "react-dom";
import { stateTip, stepOf } from "./AreaCard";
import { t } from "./i18n";
import { ANCHORS, landName } from "./laender";
import { NBSP, type Metric } from "./metrics";
import type { components } from "./schema";
import type { Tip } from "./ui";

type Land = components["schemas"]["Land"];

/**
 * The Live-Lage overview's state cards: one button for each of the 16 states at its anchor, on
 * the step colour of the state's class for the selected metric with its deviation from the usual
 * ("+4 min"), grey where there is no comparison. A state the day does not list has a dashed card,
 * named by its reason: no data yet on `today`, else none on this day. A click picks the state; a
 * hover shows its figures as a tooltip; a hover or the focus tints the state's area (`onHover`).
 */
export function StateMarkers({
  map,
  laender,
  today,
  metric,
  onPick,
  onTip,
  onHover,
}: {
  map: MapLibre;
  laender: Land[];
  today: boolean;
  metric: Metric;
  onPick: (land: string) => void;
  onTip: (tip: Tip) => void;
  onHover: (land: string | null) => void;
}) {
  // One element per state for MapLibre to place, built once, so a refresh keeps the buttons (and
  // the focus); React renders the button into it.
  const slots = useMemo(
    () => Object.keys(ANCHORS).map((code) => [code, document.createElement("div")] as const),
    [],
  );
  useEffect(() => {
    const markers = slots.map(([code, el]) =>
      new Marker({ element: el }).setLngLat(ANCHORS[code]).addTo(map),
    );
    return () => {
      markers.forEach((m) => m.remove());
      // A card that goes while hovered takes its tooltip and tint along.
      onTip(null);
      onHover(null);
    };
  }, [map, slots, onTip, onHover]);

  return slots.map(([code, el]) => {
    const l = laender.find((x) => x.land === code);
    const step = l && stepOf(metric, l.alle);
    const none = t(today ? "map.day.todayNone" : "map.day.noData");
    const [number, unit] = (step?.text ?? "–").split(NBSP);
    return createPortal(
      <button
        type="button"
        aria-label={t("map.tip", { name: landName(code), value: step ? step.label : none })}
        onClick={() => {
          onTip(null);
          onPick(code);
        }}
        onMouseEnter={() => {
          onHover(code);
          if (!matchMedia("(hover: hover)").matches) return;
          const at = map.project(ANCHORS[code]);
          onTip({ text: stateTip(code, l, metric, today), x: at.x, y: at.y - 14 });
        }}
        onMouseLeave={() => {
          onHover(null);
          onTip(null);
        }}
        onFocus={() => onHover(code)}
        onBlur={() => onHover(null)}
        className={`hit flex min-h-7 min-w-7 cursor-pointer items-center justify-center rounded-md px-1 text-[11px] font-semibold whitespace-nowrap tabular-nums shadow-card md:min-h-11 md:min-w-11 md:rounded-lg md:px-2 md:text-[13px] ${step ? step.colours : "border border-dashed border-text-3 bg-surface text-text-3"}`}
      >
        {/* On a phone the number alone, so 16 cards fit; the unit is in the name and the tooltip. */}
        {number}
        {unit && <span className="max-md:hidden">{NBSP + unit}</span>}
      </button>,
      el,
      code,
    );
  });
}

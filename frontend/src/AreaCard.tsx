import type { Ref } from "react";
import { t } from "./i18n";
import { landName } from "./laender";
import { API_FIELD, figureText, formatDay, offsetText, type Class, type Metric } from "./metrics";
import type { components } from "./schema";

type Deutschland = components["schemas"]["Deutschland"];
type Land = components["schemas"]["Land"];

/** Background and text of each step of the dots' scale, and of "no comparison" (null). */
const STEP = {
  1: "bg-r1 text-on-r1",
  2: "bg-r2 text-on-r2",
  3: "bg-r3 text-on-r3",
  4: "bg-r4 text-on-r4",
  5: "bg-r5 text-on-r5",
} as Record<number, string>;
const NO_STEP = "bg-c3 text-on-c3";

/**
 * An area's step for the metric: the API's class, its colours and the day's value against the
 * usual as text ("−4 %-Pkt."). Without a class (too few reference days, a gap, too few stops)
 * there is no comparison, so no number either.
 */
export function stepOf(metric: Metric, g: Deutschland) {
  const field = API_FIELD[metric];
  const cls = g.klasse[field];
  const text = cls ? offsetText(metric, g[field], g.normal[field]) : null;
  return {
    colours: cls ? STEP[cls] : NO_STEP,
    text: text ?? "–",
    label: cls && text ? `${text} · ${t(`map.day.class.${cls as Class}`)}` : t("map.day.noCompare"),
  };
}

/** "1 großer Bahnhof", "11 große Bahnhöfe". */
export const stationCount = (n: number) =>
  n === 1 ? t("lage.stations.one") : t("lage.stations", { n });

/** The value of the metric and its normal as one line: "78,9 % pünktlich · üblich 83,3 %". */
export function figures(metric: Metric, g: Deutschland) {
  const field = API_FIELD[metric];
  const value = g[field];
  const normal = g.normal[field];
  return [
    value === null
      ? t("hm.onlyCancelledLegend")
      : t(`metric.${metric}.cell`, { v: figureText(metric, value) }),
    normal === null
      ? t("map.day.noCompare")
      : t("map.day.usual", { v: figureText(metric, normal) }),
  ].join(" · ");
}

/**
 * A state's tooltip: its name, the deviation (if there is a comparison), value and usual, and its
 * number of stations; a state the day does not list says why (no data yet on `today`).
 */
export function stateTip(code: string, l: Land | undefined, metric: Metric, today: boolean) {
  const name = landName(code);
  if (!l) return t("map.tip", { name, value: t(today ? "map.day.todayNone" : "map.day.noData") });
  const parts = [figures(metric, l.alle), stationCount(l.bahnhoefe)];
  if (l.alle.klasse[API_FIELD[metric]]) parts.unshift(stepOf(metric, l.alle).text);
  return t("map.tip", { name, value: parts.join(" · ") });
}

/** The step block: the deviation on the step colour, named by the deviation and the step word. */
function Step({ metric, g, small }: { metric: Metric; g: Deutschland; small?: boolean }) {
  const step = stepOf(metric, g);
  return (
    <span
      role="img"
      aria-label={step.label}
      title={step.label}
      className={`inline-grid shrink-0 place-items-center font-semibold whitespace-nowrap tabular-nums ${step.colours} ${small ? "min-w-16 rounded px-1.5 text-[11px] leading-4" : "min-h-11 min-w-14 rounded-lg px-2 text-[14px]"}`}
    >
      {step.text}
    </span>
  );
}

/**
 * The Live-Lage page's card for Germany or one state (`title`): the deviation of the selected
 * metric on its step colour, the day's value and the normal, a smaller line each for Fern and
 * Regional with their own step (left out where the API has none), and a note for hours missing
 * from the data. Without `area` (a day with no stops, or none yet today) it only says so. A
 * state's card also names its number of large stations (`count`) and has a button back to
 * Germany (`onBack`, with `backRef` to focus it).
 */
export function AreaCard({
  title,
  count,
  onBack,
  backRef,
  tag,
  today,
  metric,
  area,
  fern,
  regional,
  gap,
}: {
  title: string;
  count?: number;
  onBack?: () => void;
  backRef?: Ref<HTMLButtonElement>;
  tag: string;
  /** On today: the label of the source the card counts ("Heute, Stand 14:37 · bis 14:00"). */
  today?: string;
  metric: Metric;
  area: Deutschland | null;
  fern: Deutschland | null;
  regional: Deutschland | null;
  gap: number;
}) {
  const line = area ? figures(metric, area) : t(today ? "map.day.todayNone" : "map.day.noData");
  return (
    <section
      aria-label={t(today ? "map.day.cardToday" : "map.day.card", { name: title })}
      // On a phone it stops 56 px short of the right edge, clear of the map's zoom buttons.
      className="rounded-xl border border-border bg-surface px-3 py-2.5 shadow-card max-md:max-w-[calc(100vw-66px)] md:px-3.5 md:py-3"
    >
      <div className="flex items-center gap-3">
        {area && <Step metric={metric} g={area} />}
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">
            {title}
            {count !== undefined && (
              <span className="font-normal text-text-2"> · {stationCount(count)}</span>
            )}
          </p>
          <p className="text-[12.5px] text-text-2">
            {today ?? formatDay(tag)} · {line}
          </p>
        </div>
      </div>
      {(
        [
          ["filter.fern", fern],
          ["filter.regional", regional],
        ] as const
      ).map(
        ([label, g]) =>
          g && (
            <p key={label} className="mt-1.5 flex items-center gap-2 text-xs text-text-2">
              <Step metric={metric} g={g} small />
              <span>
                {t(label)} · {figures(metric, g)}
              </span>
            </p>
          ),
      )}
      {gap > 0 && (
        <p className="mt-1.5 text-xs font-[550] text-text-2">{t("map.day.gap", { h: gap })}</p>
      )}
      {onBack && (
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          className="hit mt-1.5 cursor-pointer text-xs font-semibold text-accent hover:underline"
        >
          {t("lage.back")}
        </button>
      )}
    </section>
  );
}

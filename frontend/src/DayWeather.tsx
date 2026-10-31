import { t, type MessageKey } from "./i18n";
import { API_FIELD, figureText, formatDay, type Metric } from "./metrics";
import type { components } from "./schema";

type Deutschland = components["schemas"]["Deutschland"];

const CLOUD = "M14 35 a7 7 0 0 1 -1 -13.9 a10 10 0 0 1 19 -2.6 a7.5 7.5 0 0 1 3 16.5 z";
const cloud = (dy: number) => (
  <path
    d={CLOUD}
    transform={`translate(0 ${dy})`}
    strokeWidth="2"
    strokeLinejoin="round"
    className="fill-surface-2 stroke-text-3"
  />
);
const RAYS = "stroke-r3 fill-none";

/** The five symbols, from sun (1, much better than usual) to thunderstorm (5, much worse). */
const SYMBOLS = {
  1: (
    <>
      <circle cx="24" cy="24" r="8" className="fill-r3 stroke-r3" strokeWidth="2" />
      <path
        d="M24 5v5M24 38v5M5 24h5M38 24h5M10.5 10.5l3.5 3.5M34 34l3.5 3.5M10.5 37.5l3.5-3.5M34 14l3.5-3.5"
        className={RAYS}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </>
  ),
  2: (
    <>
      <circle cx="33" cy="14" r="6.5" className="fill-r3 stroke-r3" strokeWidth="2" />
      <path
        d="M33 2v3M45 14h-3M42 5l-2 2M24 5l2 2"
        className={RAYS}
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      {cloud(1)}
    </>
  ),
  3: cloud(4),
  4: (
    <>
      {cloud(-2)}
      <path
        d="M17 37l-2 6M25 37l-2 6M33 37l-2 6"
        className="fill-none stroke-r1"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </>
  ),
  5: (
    <>
      {cloud(-3)}
      <path
        d="M27 30 19 40h5l-2 6 10-11h-5l3-5z"
        className="fill-r4 stroke-r4"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </>
  ),
};

/**
 * The weather symbol of a rank, or a dashed circle where there is none (on a day with missing
 * hours, `gap`, that is why). The label is its name.
 */
function Weather({ rank, gap }: { rank: keyof typeof SYMBOLS | null; gap: boolean }) {
  const none = gap ? "map.weather.gap" : "map.weather.none";
  const label = t(rank ? (`map.weather.${rank}` as MessageKey) : none);
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label={label} className="size-11 shrink-0">
      <title>{label}</title>
      {rank ? (
        SYMBOLS[rank]
      ) : (
        <circle
          cx="24"
          cy="24"
          r="13"
          strokeWidth="2"
          strokeDasharray="4 4"
          className="fill-none stroke-text-3"
        />
      )}
    </svg>
  );
}

/**
 * The day map's card for Germany: the weather symbol of the selected metric's rank among the
 * reference days, the day's value and the normal, and a note for hours missing from the data.
 * Without `germany` (a day with no stops) it only says so.
 */
export function WeatherCard({
  tag,
  today,
  metric,
  germany,
  gap,
}: {
  tag: string;
  /**
   * On today: the label of the source the card counts ("Heute, Stand 14:37 · bis 14:00"), and
   * whether that is the collector's large stations or every station that reports so far.
   */
  today?: { label: string; large: boolean };
  metric: Metric;
  germany: Deutschland | null;
  gap: number;
}) {
  const field = API_FIELD[metric];
  let line = t("map.day.noData");
  if (germany) {
    const value = germany[field];
    const normal = germany.normal[field];
    line = [
      value === null
        ? t("hm.onlyCancelledLegend")
        : t(`metric.${metric}.cell`, { v: figureText(metric, value) }),
      normal === null
        ? t("map.day.noCompare")
        : t("map.day.usual", { v: figureText(metric, normal) }),
    ].join(" · ");
  }
  return (
    <section
      aria-label={t(
        !today ? "map.day.card" : today.large ? "map.day.cardLive" : "map.day.cardToday",
      )}
      className="rounded-xl border border-border bg-surface px-3 py-2.5 shadow-card md:px-3.5 md:py-3"
    >
      <div className="flex items-center gap-3">
        {germany && (
          <Weather rank={germany.wetter[field] as keyof typeof SYMBOLS | null} gap={gap > 0} />
        )}
        <div className="min-w-0">
          <p className="text-[13px] font-semibold">
            {t(today?.large ? "map.day.large" : "map.day.germany")}
          </p>
          <p className="text-[12.5px] text-text-2">
            {today?.label ?? formatDay(tag)} · {line}
          </p>
        </div>
      </div>
      {gap > 0 && (
        <p className="mt-1.5 text-xs font-[550] text-text-2">{t("map.day.gap", { h: gap })}</p>
      )}
    </section>
  );
}

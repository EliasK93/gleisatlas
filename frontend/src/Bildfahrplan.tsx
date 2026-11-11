/** The Bildfahrplan card of the line page: one day's trips, planned against actual, in plain SVG. */
import { useQuery } from "@tanstack/react-query";
import { Fragment, useId, useLayoutEffect, useMemo, useRef } from "react";
import { api, must } from "./api";
import {
  actualSegments,
  cancelled,
  clock,
  delayOf,
  distances,
  pieces,
  place,
  planPoints,
  tripsText,
  tripTip,
} from "./fahrplan";
import { DayField } from "./Filters";
import { t } from "./i18n";
import { formatDay, int, legend } from "./metrics";
import type { components } from "./schema";
import { axisStations } from "./sections";
import { ErrorBanner, FILL, Pulse, TipBox, useTip, type Point } from "./ui";

type Linie = components["schemas"]["Linie"];
type Fahrt = components["schemas"]["Fahrt"];
/** The shown trip under the pointer (its place among the drawn trips) and where the pointer is. */
type Hover = { k: number; x: number; y: number };

/**
 * The trip under a pointer, or none outside the drawn trips. Its own attribute `data-k`, not
 * `data-tip`: a tap here then never opens the tooltip of another chart on the page.
 */
function tripAt(e: Point): Hover | null {
  const g = e.target instanceof Element ? e.target.closest<SVGElement>("[data-k]") : null;
  return g ? { k: Number(g.dataset.k), x: e.clientX, y: e.clientY } : null;
}

// Static class names, so Tailwind can see them.
const STROKE = ["stroke-r1", "stroke-r2", "stroke-r3", "stroke-r4", "stroke-r5"];
/** Pixels per minute: an hour is 60 px wide, a day 1,440 px. */
const PX = 1;
const PAD = { x: 20, top: 12, bottom: 26 };
const DASH = "4 3";
/** The plot opens scrolled to this time of day. */
const OPENS_AT = 6 * 60;
/** Station labels closer than this to the one above are left out. */
const LABEL_GAP = 12;
const COLUMNS = [
  "line.bf.col.train",
  "line.bf.col.from",
  "line.bf.col.to",
  "line.bf.col.dep",
  "line.bf.col.delay",
] as const;

/**
 * The card: heading, explanation, the day field (limited to the days of the trip table, the
 * newest by default) and the chart of the day, or the state instead of it.
 */
export function Bildfahrplan({
  line,
  tag,
  onDay,
}: {
  line: Linie;
  /** The day of the URL, already inside the window; undefined is the newest day. */
  tag?: string;
  onDay: (day: string) => void;
}) {
  const id = useId();
  const day = line.fahrplan_von && line.fahrplan_bis ? (tag ?? line.fahrplan_bis) : undefined;
  const q = useQuery({
    queryKey: ["linie-fahrplan", line.linie, day],
    queryFn: async () =>
      must(
        await api.GET("/linie/fahrplan", { params: { query: { linie: line.linie, tag: day! } } }),
      ),
    enabled: !!day,
    // Another day keeps the old chart on screen while it loads; another line does not.
    placeholderData: (previous, query) =>
      query?.queryKey[1] === line.linie ? previous : undefined,
  });
  let body;
  if (!day) body = <p className="text-text-2">{t("line.bf.none")}</p>;
  else if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!q.data) body = <Pulse className="h-[300px] animate-pulse rounded-lg bg-surface-2" />;
  else if (q.data.fahrten.length === 0) body = <p className="text-text-2">{t("line.bf.empty")}</p>;
  // A new day opens at 06:00 again.
  else body = <Chart key={q.data.tag} line={line} tag={q.data.tag} fahrten={q.data.fahrten} />;
  return (
    <section aria-labelledby={id} className="card flex min-w-0 flex-col gap-3">
      <div>
        <h2 id={id} className="text-base font-[620]">
          {t("line.bf")}
        </h2>
        <p className="mt-1 max-w-[80ch] text-xs text-text-3">{t("line.bf.help")}</p>
      </div>
      {day && (
        <span className="chip w-fit border-border bg-surface text-text-2">
          {t("filter.chip", { label: t("filter.day") })}
          <DayField
            label={t("line.bf.day")}
            value={day}
            min={line.fahrplan_von!}
            max={line.fahrplan_bis!}
            onPick={onDay}
          />
        </span>
      )}
      {body}
    </section>
  );
}

/**
 * The chart: the time of day left to right, the axis stations top to bottom by distance, a
 * dashed planned and a coloured actual path per trip; the legend, the trips left out and the list.
 */
// shortcut: every trip is drawn as SVG, no virtualisation; a line with many hundred trips a day may get slow
function Chart({ line, tag, fahrten }: { line: Linie; tag: string; fahrten: Fahrt[] }) {
  const [hover, setHover] = useTip(tripAt);
  const scroller = useRef<HTMLDivElement>(null);
  // The geometry changes with the day or the line, never with the pointer.
  const { axis, shown, branches, end, height, x, y } = useMemo(() => {
    const axis = axisStations(line.achse, line.bahnhoefe);
    const km = distances(axis);
    const evas = axis.map((s) => s.eva);
    const placed = fahrten.map((f) => ({ zug: f.zug, stops: place(evas, f.halte) }));
    const shown = placed
      .filter((p) => p.stops.length >= 2)
      .map((p) => ({ ...p, parts: pieces(evas, p.stops) }));
    // Trips belong to their start day, so a night trip runs past 24:00.
    const last = shown
      .flatMap((p) => p.stops.flatMap(({ halt: h }) => [h.an_plan, h.an_ist, h.ab_plan, h.ab_ist]))
      .reduce<number>((a, m) => Math.max(a, m ?? 0), 0);
    const height = Math.min(Math.max(axis.length * 28, 220), 520);
    const total = km.at(-1) || 1;
    return {
      axis,
      shown,
      branches: placed.length - shown.length,
      end: Math.max(24 * 60, Math.ceil(last / 60) * 60),
      height,
      x: (m: number) => PAD.x + m * PX,
      y: (i: number) => PAD.top + (km[i] / total) * (height - PAD.top - PAD.bottom),
    };
  }, [fahrten, line]);
  const width = end * PX + 2 * PAD.x;
  const active = hover?.k ?? -1;
  // A pointer move that stays on the same trip only moves the tooltip.
  const layer = useMemo(
    () =>
      shown.map((p, k) => (
        <g
          // A train may run twice a day, so its name is no key.
          key={k}
          data-trip={p.zug}
          data-k={k}
          className={active >= 0 && active !== k ? "opacity-25" : ""}
        >
          {p.parts.map((part, j) => {
            const plan = planPoints(part)
              .map(([m, i]) => `${x(m)},${y(i)}`)
              .join(" ");
            return (
              <Fragment key={j}>
                {/* A wide transparent line under the paths takes the pointer near the trip. */}
                <polyline points={plan} fill="none" stroke="transparent" strokeWidth={12} />
                <polyline
                  data-path="plan"
                  points={plan}
                  fill="none"
                  strokeWidth={1}
                  strokeDasharray={DASH}
                  className="stroke-text-3"
                />
              </Fragment>
            );
          })}
          <g data-path="ist" strokeWidth={active === k ? 3.5 : 2} strokeLinecap="round">
            {p.parts
              .flatMap((part) => actualSegments(part))
              .map((s, j) => (
                <line
                  key={j}
                  x1={x(s.from[0])}
                  y1={y(s.from[1])}
                  x2={x(s.to[0])}
                  y2={y(s.to[1])}
                  className={STROKE[s.step - 1]}
                />
              ))}
          </g>
          {p.stops
            .filter((s) => cancelled(s.halt))
            .map(({ i, halt }, j) => (
              <text
                key={j}
                data-testid="cancel"
                x={x(halt.an_plan ?? halt.ab_plan ?? 0)}
                y={y(i)}
                dy="0.35em"
                textAnchor="middle"
                className="fill-cancel text-[12px] font-bold"
              >
                ✕
              </text>
            ))}
        </g>
      )),
    [shown, active, x, y],
  );
  const hours = Array.from({ length: end / 60 + 1 }, (_, h) => h * 60);
  // shortcut: a label too close to the one above is left out; the list and the tooltip name every stop; revisit if users miss labels
  const labels: { i: number; at: number }[] = [];
  axis.forEach((_, i) => {
    const prev = labels.at(-1);
    if (!prev || y(i) - prev.at >= LABEL_GAP) labels.push({ i, at: y(i) });
  });

  // Only when the chart opens: a later scroll is the reader's. 06:00 lands PAD.x from the left edge.
  useLayoutEffect(() => {
    scroller.current!.scrollLeft = OPENS_AT * PX;
  }, []);

  return (
    <>
      <div
        className="flex"
        onPointerMove={(e) => setHover(tripAt(e))}
        onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}
      >
        <div
          data-testid="bf-stations"
          aria-hidden="true"
          className="relative w-24 shrink-0 md:w-40"
          style={{ height }}
        >
          {labels.map(({ i, at }) => (
            <span
              key={i}
              title={axis[i].name}
              className="absolute right-2 left-0 -translate-y-1/2 truncate text-right text-[11px] leading-4 text-text-2"
              style={{ top: at }}
            >
              {axis[i].name}
            </span>
          ))}
        </div>
        <div ref={scroller} className="min-w-0 flex-1 overflow-x-auto">
          <svg
            data-testid="bildfahrplan"
            data-trips={shown.length}
            role="img"
            aria-label={t("line.bf.chart", {
              line: line.label,
              day: formatDay(tag),
              trips: tripsText(shown.length),
            })}
            width={width}
            height={height}
            className="block"
          >
            {hours.map((m) => (
              <g key={m}>
                <line
                  x1={x(m)}
                  x2={x(m)}
                  y1={PAD.top}
                  y2={height - PAD.bottom}
                  className="stroke-border"
                />
                <text
                  data-testid="hour"
                  x={x(m)}
                  y={height - 8}
                  textAnchor="middle"
                  className="fill-text-3 text-[11px]"
                >
                  {clock(m)}
                </text>
              </g>
            ))}
            {axis.map((_, i) => (
              <line
                key={i}
                x1={PAD.x}
                x2={width - PAD.x}
                y1={y(i)}
                y2={y(i)}
                className="stroke-border"
              />
            ))}
            {layer}
          </svg>
        </div>
      </div>
      <TipBox
        tip={hover && { text: tripTip(shown[hover.k].zug, shown[hover.k].stops, axis), ...hover }}
      />
      <Legend />
      {branches > 0 && (
        <p className="text-xs text-text-3">
          {branches === 1 ? t("line.bf.branches.one") : t("line.bf.branches", { n: int(branches) })}
        </p>
      )}
      <details>
        <summary className="hit cursor-pointer text-[13px] text-text-2 hover:text-text">
          {t("line.bf.list")} ({shown.length})
        </summary>
        <div className="overflow-x-auto">
          <table className="mt-2 w-full text-left text-[13px]">
            <thead className="text-xs text-text-3">
              <tr>
                {COLUMNS.map((c) => (
                  <th key={c} className="py-1.5 pr-3 font-medium">
                    {t(c)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="tabular-nums">
              {shown.map(({ zug, stops }, k) => {
                const [first, last] = [stops[0], stops.at(-1)!];
                const dep = first.halt.ab_plan ?? first.halt.an_plan;
                return (
                  <tr key={k} className="border-t border-border">
                    <td className="py-1.5 pr-3 font-[550] whitespace-nowrap">{zug}</td>
                    <td className="py-1.5 pr-3">{axis[first.i].name}</td>
                    <td className="py-1.5 pr-3">{axis[last.i].name}</td>
                    <td className="py-1.5 pr-3">{dep === null ? "–" : clock(dep)}</td>
                    <td className="py-1.5 whitespace-nowrap">{delayOf(last.halt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/** The dashed timetable, the cancelled mark and the delay steps of the actual run. */
function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-text-2">
      <span className="flex items-center gap-1.5">
        <svg aria-hidden="true" width="20" height="4">
          <line x1="0" x2="20" y1="2" y2="2" strokeDasharray={DASH} className="stroke-text-3" />
        </svg>
        {t("line.bf.legend.plan")}
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="font-bold text-cancel">
          ✕
        </span>
        {t("line.bf.cancelled")}
      </span>
      <span>{t("line.bf.legend.delay")}</span>
      <ul aria-label={t("line.bf.legend.label")} className="flex flex-wrap gap-x-3 gap-y-1">
        {legend("median").map((label, i) => (
          <li key={label} className="flex items-center gap-1.5">
            <i aria-hidden="true" className={`block h-1 w-4 rounded-sm ${FILL.r[i]}`} />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Navigate, useSearchParams } from "react-router";
import { api, must } from "./api";
import { Filters } from "./Filters";
import { t, tx } from "./i18n";
import { Icon } from "./Icon";
import {
  APPROX_N,
  classOf,
  dayName,
  DEFS,
  formatPeriod,
  int,
  legend,
  LOW_N,
  METRICS,
  readFilters,
  withParam,
  worse,
  writeFilters,
  type Metric,
} from "./metrics";
import type { components } from "./schema";

type Heatmap = components["schemas"]["Heatmap"];
type Stats = components["schemas"]["Day"];
type Tip = { text: string; x: number; y: number } | null;
type Point = { target: EventTarget | null; clientX: number; clientY: number };

// Static class names, so Tailwind can see them.
const FILL = {
  r: ["bg-r1", "bg-r2", "bg-r3", "bg-r4", "bg-r5"],
  c: ["bg-c1", "bg-c2", "bg-c3", "bg-c4", "bg-c5"],
};
const DAYS = [0, 1, 2, 3, 4, 5, 6];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

const narrow = window.matchMedia("(max-width: 767px)");
const onNarrowChange = (cb: () => void) => {
  narrow.addEventListener("change", cb);
  return () => narrow.removeEventListener("change", cb);
};

type Shown = { text: string; fill: string; label: string; value?: number; low?: boolean };

/**
 * What one cell (or day total) shows: the value with "~" when approximate, nothing below LOW_N.
 * Delay metrics only see arrived stops, so they count those; Ausfälle counts all stops.
 */
function show(metric: Metric, s: Stats | undefined, slot: string): Shown {
  const n = s?.n ?? 0;
  const label = (key: "hm.low" | "hm.onlyCancelled") => t(key, { slot, n: int(n) });
  if (!s || n < LOW_N) return { text: "–", fill: "hatch", label: label("hm.low"), low: true };
  const v = DEFS[metric].value(s);
  if (v === null) return { text: "✕", fill: "bg-cancel", label: label("hm.onlyCancelled") };
  const counted = metric === "ausfall" ? n : Math.round(n * (1 - s.ausfallquote));
  if (counted < LOW_N) return { text: "–", fill: "hatch", label: label("hm.low"), low: true };
  const text = (counted < APPROX_N ? "~" : "") + DEFS[metric].format(v);
  const value = t(`metric.${metric}.cell`, { v: text });
  return {
    text,
    value: v,
    fill: FILL[DEFS[metric].scale][classOf(metric, v) - 1],
    label: t("hm.cell", { slot, value, n: int(n) }),
  };
}

export default function HeatmapPage() {
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  const q = useQuery({
    queryKey: ["heatmap", f.g, f.bhf, f.von, f.bis],
    queryFn: () =>
      api
        .GET("/heatmap", {
          params: { query: { gattung: f.g ?? "alle", eva: f.bhf, von: f.von, bis: f.bis } },
        })
        .then(must),
    placeholderData: keepPreviousData,
  });
  const data = q.data;
  const period = data?.n ? formatPeriod(data.von, data.bis) : undefined;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let body;
  if (q.isError)
    body = (
      <div
        role="alert"
        className="flex items-start gap-3 rounded-xl border border-r5/40 bg-r5/8 px-4 py-3.5"
      >
        <Icon name="alert" className="mt-0.5 size-[18px] text-r5" />
        <div className="flex-1">
          <b className="font-semibold">{t("state.error")}</b>
          <p className="text-[13px] text-text-2">{t("state.errorHint")}</p>
        </div>
        <button type="button" className="btn" onClick={() => q.refetch()}>
          {t("state.retry")}
        </button>
      </div>
    );
  else if (!data) body = <Skeleton />;
  else if (data.n === 0)
    body = (
      <div className="card px-6 py-14 text-center">
        <div className="mx-auto mb-3.5 grid size-[52px] place-items-center rounded-full bg-surface-2 text-text-2">
          <Icon name="empty" />
        </div>
        <h2 className="text-[17px] font-[620]">{t("hm.empty")}</h2>
        <p className="mt-1.5 mb-4 text-text-2">{t("hm.emptyHint")}</p>
        <button
          type="button"
          className="btn border-accent! bg-accent! text-on-accent! hover:brightness-110"
          onClick={() => setParams({})}
        >
          {t("filter.resetAll")}
        </button>
      </div>
    );
  else
    body = (
      <HeatmapView
        data={data}
        metric={f.k}
        period={period}
        onMetric={(k) => setParams(withParam("k", k === "puenktlich" ? "" : k))}
      />
    );

  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("hm.crumb")}</p>
          <h1 className="text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
            {t("hm.title")}
          </h1>
          <p className="mt-1.5 max-w-[68ch] text-text-2">
            {t("hm.lead", { metric: t(`metric.${f.k}`) })}
          </p>
        </div>
        <ShareButton />
      </div>
      <Filters period={period} />
      {body}
    </div>
  );
}

function HeatmapView({
  data,
  metric,
  period,
  onMetric,
}: {
  data: Heatmap;
  metric: Metric;
  period?: string;
  onMetric: (m: Metric) => void;
}) {
  const transposed = useSyncExternalStore(onNarrowChange, () => narrow.matches);
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useState<Tip>(null);

  // A tap shows the cell under it and a tap anywhere else clears it; any scroll clears it too.
  useEffect(() => {
    const off = () => setTip(null);
    const tap = (e: PointerEvent) => setTip(tipAt(e));
    addEventListener("scroll", off, true);
    addEventListener("pointerdown", tap);
    return () => {
      removeEventListener("scroll", off, true);
      removeEventListener("pointerdown", tap);
    };
  }, []);

  const byKey = new Map(data.cells.map((c) => [c.weekday * 24 + c.hour, c]));
  const slots = DAYS.flatMap((d) =>
    HOURS.map((h) => {
      const slot = t("hm.slot", { day: dayName(d), from: h, to: h + 1 });
      return { slot, ...show(metric, byKey.get(d * 24 + h), slot) };
    }),
  );
  const totals = DAYS.map((d) =>
    show(
      metric,
      data.tage.find((x) => x.weekday === d),
      "",
    ),
  );

  const cell = (d: number, h: number) => {
    const s = slots[d * 24 + h];
    return (
      <td
        key={`${d}-${h}`}
        data-tip={s.label}
        className={`rounded-[3px] p-0 hover:outline-2 hover:-outline-offset-1 hover:outline-text ${
          asTable ? "bg-surface-2 px-1 py-0.5 text-center text-text" : s.fill
        }`}
      >
        <span className="sr-only">{s.label}</span>
        {asTable ? (
          <span aria-hidden="true">{s.text}</span>
        ) : (
          <div
            aria-hidden="true"
            className={`grid place-items-center text-[9px] leading-none text-on-accent ${
              transposed ? "h-[18px]" : "aspect-square min-h-2.5"
            }`}
          >
            {s.fill === "bg-cancel" && s.text}
          </div>
        )}
      </td>
    );
  };

  // Desktop: rows are weekdays and "Ø Tag" is a column. Mobile: rows are hours and "Ø" is a row.
  const dayHead = (d: number) => dayName(d, true);
  const hourHead = (h: number) => (
    <span className={h % 3 && !asTable && !transposed ? "sr-only" : ""}>{h}</span>
  );
  const [rows, cols] = transposed ? [HOURS, DAYS] : [DAYS, HOURS];
  const [rowHead, colHead] = transposed ? [hourHead, dayHead] : [dayHead, hourHead];
  const rowHeader = "text-left font-[550] text-text-2";

  const ok = slots.filter((s) => s.value !== undefined);
  const worst = ok.reduce((a, s) => (worse(metric, s.value!, a.value!) ? s : a), ok[0]);
  const best = ok.reduce((a, s) => (worse(metric, a.value!, s.value!) ? s : a), ok[0]);
  const thin = slots.filter((s) => s.low).length;
  const insight = (key: "hm.worst" | "hm.best", s: (typeof slots)[number]) =>
    tx(key, {
      slot: <b className="font-[650]">{s.slot}</b>,
      value: tx(`metric.${metric}.cell`, { v: <b className="font-[650]">{s.text}</b> }),
    });
  const insightBox = "rounded-[10px] bg-surface-2 px-3 py-2.5 text-[13.5px]";

  return (
    <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
      <div className="card min-w-0">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          {/* Mobile: one row that scrolls, padded so the tap areas fit inside the scroll box. */}
          <div className="-mx-4 -my-2 overflow-x-auto px-4 py-2 [scrollbar-width:none] md:m-0 md:overflow-visible md:p-0">
            <div
              role="group"
              aria-label={t("metric.label")}
              className="inline-flex gap-0.5 rounded-[9px] bg-surface-2 p-[3px] md:flex-wrap"
            >
              {METRICS.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={m === metric}
                  onClick={() => onMetric(m)}
                  className={`hit cursor-pointer rounded-[7px] px-[11px] py-[5px] text-[13px] font-medium whitespace-nowrap ${
                    m === metric ? "bg-surface text-text shadow-sm" : "text-text-2"
                  }`}
                >
                  {t(`metric.${m}`)}
                </button>
              ))}
            </div>
          </div>
          <span className="text-xs text-text-3">
            {t("hm.meta", { n: int(data.n), period: period ?? "" })}
          </span>
        </div>

        <div
          className="overflow-x-auto"
          onPointerMove={(e) => setTip(tipAt(e))}
          onPointerLeave={(e) => e.pointerType === "mouse" && setTip(null)}
        >
          <table
            className={`w-full border-separate border-spacing-[2px] text-[11px] text-text-3 tabular-nums ${
              asTable ? "" : "table-fixed"
            }`}
          >
            <caption className="sr-only">
              {t("hm.caption", { metric: t(`metric.${metric}`) })}
            </caption>
            <colgroup>
              <col className={transposed ? "w-9" : "w-8"} />
              {cols.map((c) => (
                <col key={c} />
              ))}
              {!transposed && <col className="w-16" />}
            </colgroup>
            <thead>
              <tr>
                <td />
                {cols.map((c) => (
                  <th key={c} scope="col" className="font-normal">
                    {colHead(c)}
                  </th>
                ))}
                {!transposed && (
                  <th scope="col" className="pl-1.5 text-left font-normal whitespace-nowrap">
                    {t("hm.dayTotal")}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r}>
                  <th scope="row" className={rowHeader}>
                    {rowHead(r)}
                  </th>
                  {cols.map((c) => (transposed ? cell(c, r) : cell(r, c)))}
                  {!transposed && (
                    <td className="pl-1.5 font-semibold whitespace-nowrap text-text-2">
                      {totals[r].text}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {transposed && (
              <tfoot>
                <tr>
                  <th scope="row" className={rowHeader}>
                    {t("hm.dayTotalShort")}
                  </th>
                  {DAYS.map((d) => (
                    <td key={d} className="text-center font-semibold text-text-2">
                      {totals[d].text}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-text-2">
          {legend(metric).map((l, i) => (
            <span key={l} className="inline-flex items-center gap-1">
              <i className={`inline-block size-3 rounded-[3px] ${FILL[DEFS[metric].scale][i]}`} />
              {l}
            </span>
          ))}
          <span className="inline-flex items-center gap-1">
            <i className="hatch inline-block size-3 rounded-[3px]" />
            {t("hm.lowLegend")}
          </span>
          {metric !== "ausfall" && (
            <span className="inline-flex items-center gap-1">
              <i
                aria-hidden="true"
                className="inline-grid size-3 place-items-center rounded-[3px] bg-cancel text-[8px] text-on-accent not-italic"
              >
                ✕
              </i>
              {t("hm.onlyCancelledLegend")}
            </span>
          )}
          <button
            type="button"
            aria-pressed={asTable}
            onClick={() => setAsTable(!asTable)}
            className={`hit ml-auto cursor-pointer rounded-md px-2 py-1 ${
              asTable ? "bg-accent-soft text-accent" : "text-text-3 hover:text-text"
            }`}
          >
            {t("hm.asTable")}
          </button>
        </div>
      </div>

      <section aria-labelledby="hm-glance" className="card min-w-0">
        <h2 id="hm-glance" className="mb-1 text-base font-[620]">
          {t("hm.glance")}
        </h2>
        <p className="mb-3 text-[13px] text-text-2">{t("hm.glanceSub")}</p>
        <ul className="flex flex-col gap-2">
          {worst && <li className={insightBox}>{insight("hm.worst", worst)}</li>}
          {best && best !== worst && <li className={insightBox}>{insight("hm.best", best)}</li>}
          {thin > 0 && <li className={insightBox}>{t("hm.thin", { count: int(thin) })}</li>}
        </ul>
      </section>

      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 max-w-[260px] -translate-x-1/2 -translate-y-full rounded-[7px] bg-text px-[9px] py-1.5 text-[12.5px] text-bg shadow-card"
          style={{ left: Math.min(Math.max(tip.x, 138), innerWidth - 138), top: tip.y - 12 }}
        >
          {tip.text}
        </div>
      )}
    </div>
  );
}

/** The tooltip for the cell under a pointer, or none outside the cells. */
function tipAt(e: Point): Tip {
  const el = e.target instanceof Element ? e.target : null;
  const td = el?.closest<HTMLElement>("[data-tip]");
  return td ? { text: td.dataset.tip!, x: e.clientX, y: e.clientY } : null;
}

function Skeleton() {
  return (
    <div role="status" className="card">
      <span className="sr-only">{t("state.loading")}</span>
      <div className="grid animate-pulse grid-cols-7 gap-0.5 md:grid-cols-24">
        {Array.from({ length: 168 }, (_, i) => (
          <div key={i} className="h-[18px] rounded-[3px] bg-surface-2 md:aspect-square md:h-auto" />
        ))}
      </div>
    </div>
  );
}

function ShareButton() {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <button
        type="button"
        className="btn"
        onClick={() =>
          navigator.clipboard.writeText(location.href).then(
            () => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1800);
            },
            // ponytail: no feedback when the browser denies the clipboard; add a fallback text field if users hit it
            () => {},
          )
        }
      >
        <Icon name="share" className="size-4" />
        {t("share.button")}
      </button>
      <div
        role="status"
        className={`pointer-events-none fixed bottom-24 left-1/2 z-50 -translate-x-1/2 rounded-full bg-text px-4 py-[9px] text-[13px] text-bg transition-opacity md:bottom-7 ${
          copied ? "opacity-100" : "opacity-0"
        }`}
      >
        {copied && t("share.done")}
      </div>
    </>
  );
}

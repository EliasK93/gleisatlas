import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, must, useMonthPeriod } from "./api";
import { Filters } from "./Filters";
import { t, tx } from "./i18n";
import { dayName, DEFS, formatPeriod, int, legend, worse, type Metric } from "./metrics";
import type { components } from "./schema";
import { readFilters, withParam, writeFilters, type Filters as FilterKeys } from "./urlKeys";
import {
  EmptyCard,
  ErrorBanner,
  FILL,
  MetricSwitch,
  MusterSwitch,
  PRIMARY,
  ShareButton,
  show,
  TipBox,
  tipAt,
  useNarrow,
  useTip,
  SlowHint,
  Page,
  PageTitle,
  TableToggle,
  Pulse,
} from "./ui";

type Heatmap = components["schemas"]["Heatmap"];

const DAYS = [0, 1, 2, 3, 4, 5, 6];
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export default function HeatmapPage() {
  const [params] = useSearchParams();
  const setParams = useSetParams();
  const read = readFilters(params);
  // The API takes a station or a line, not both: a line wins, as on the time series page.
  const f: FilterKeys = {
    ...read,
    tag: undefined,
    land: undefined,
    z: undefined,
    richtung: undefined,
    abschnitt: undefined,
    bhf: read.linie ? undefined : read.bhf,
  };
  // Days in the URL round outward: this page asks for whole months.
  const m = useMonthPeriod(f);
  const q = useQuery({
    queryKey: ["heatmap", f.g, f.bhf, f.linie, m.von, m.bis],
    // A line the API does not know is a page state (null), not an error.
    queryFn: () =>
      api
        .GET("/heatmap", {
          params: {
            query: { gattung: f.g ?? "alle", eva: f.bhf, linie: f.linie, von: m.von, bis: m.bis },
          },
        })
        .then((r) => (r.response.status === 404 ? null : must(r))),
    enabled: m.ready,
    // The old grid stays only for the same station and line, never under another one's name.
    placeholderData: (previous, query) =>
      query?.queryKey[2] === f.bhf && query?.queryKey[3] === f.linie ? previous : undefined,
  });
  const data = q.data;
  const period = data?.n ? formatPeriod(data.von, data.bis) : undefined;

  // Drop invalid or unknown keys once, so a shared link only carries what the page shows.
  const clean = writeFilters(f).toString();
  if (clean !== params.toString()) return <Navigate to={{ search: clean }} replace />;

  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (data === null)
    body = (
      <EmptyCard title={t("zv.unknownLine")} hint={t("zv.unknownLineHint")}>
        <button
          type="button"
          className={`${PRIMARY} mt-4`}
          onClick={() => setParams(withParam("linie", ""))}
        >
          {t("zv.unknownReset")}
        </button>
      </EmptyCard>
    );
  else if (!data) body = <Skeleton />;
  else if (data.n === 0)
    body = (
      <EmptyCard
        title={t("hm.empty")}
        hint={t("hm.emptyHint")}
        onReset={() => setParams(clearParams)}
      />
    );
  else
    body = (
      <HeatmapView
        data={data}
        metric={f.k}
        period={period}
        onMetric={(k) => setParams(withParam("k", k))}
      />
    );

  return (
    <Page>
      <MusterSwitch />
      <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1.5 text-[12.5px] text-text-3">{t("nav.discover")}</p>
          <PageTitle>{t("nav.heatmap")}</PageTitle>
          <p className="mt-1.5 max-w-[68ch] text-text-2">
            {t("hm.lead", { metric: t(`metric.${f.k}`) })}
          </p>
        </div>
        <ShareButton />
      </div>
      <Filters lines lineTitle={data?.titel ?? undefined} />
      {body}
    </Page>
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
  const transposed = useNarrow();
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useTip();

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
          <MetricSwitch
            metric={metric}
            onMetric={onMetric}
            className="-mx-4 -my-2 px-4 py-2 md:m-0 md:p-0"
          />
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
          <TableToggle on={asTable} onToggle={() => setAsTable(!asTable)} />
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

      <TipBox tip={tip} />
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-4">
      <SlowHint />
      <Pulse className="card">
        <div className="grid animate-pulse grid-cols-7 gap-0.5 md:grid-cols-24">
          {Array.from({ length: 168 }, (_, i) => (
            <div
              key={i}
              className="h-[18px] rounded-[3px] bg-surface-2 md:aspect-square md:h-auto"
            />
          ))}
        </div>
      </Pulse>
    </div>
  );
}

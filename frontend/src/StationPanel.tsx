/** The station panel of both maps: the station's figures, its actions and its busiest lines. */
import { useId } from "react";
import { Link, useLocation } from "react-router";
import { useDatenstand, useMonthPeriod, useStation, useStationLines } from "./api";
import { t, tx } from "./i18n";
import { Icon } from "./Icon";
import { deviation, formatPeriod, int, METRICS, tenths } from "./metrics";
import type { components } from "./schema";
import {
  Badge,
  ErrorBanner,
  FILL,
  linePath,
  PRIMARY,
  Pulse,
  show,
  SoonTag,
  stationPath,
} from "./ui";
import { linePageSearch, type Filters as FilterKeys } from "./urlKeys";

/** A station of either map; only the day map knows its normal, its class, its source and its state. */
export type Entry = components["schemas"]["KartenStation"] &
  Partial<Pick<components["schemas"]["TageskartenStation"], "normal" | "klasse" | "live" | "land">>;

export function StationPanel({
  eva,
  station,
  loaded,
  day,
  category,
  period,
  f,
  onClose,
}: {
  eva: string;
  station?: Entry;
  loaded: boolean;
  /** True on the day map: each tile also shows its normal. */
  day: boolean;
  category: string;
  period?: string;
  /** The map's filters: the lines below follow its category, months and metric. */
  f: FilterKeys;
  onClose: () => void;
}) {
  const { search } = useLocation();
  // Until the map data is in, the station may still be part of it.
  const lookup = useStation(eva, loaded && !station);
  const name = station?.name ?? lookup.data?.name ?? t("filter.eva", { eva });
  const tiles = station && METRICS.map((m) => ({ m, ...show(m, station, name) }));
  const [onTime, , bad] = tiles ?? [];

  // shortcut: fixed-height bottom sheet without drag or snap levels (design.md 2.1); add when users ask
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

      {station && day && station.n === 0 ? (
        <p className="my-3 text-text-2">{t("map.day.todayNoneLong")}</p>
      ) : station && tiles ? (
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
            {tiles.map((x) => {
              // The day map: the stripe is the deviation class, and the normal stands below the value.
              const dev = day ? deviation(x.m, station) : null;
              let fill = x.fill;
              if (day) fill = dev ? FILL.r[dev.cls - 1] : x.low ? x.fill : "bg-c3";
              return (
                <div
                  key={x.m}
                  className="relative overflow-hidden rounded-[10px] bg-surface-2 py-2.5 pr-3 pl-4"
                >
                  <i aria-hidden="true" className={`absolute inset-y-0 left-0 w-[3px] ${fill}`} />
                  <div className="text-[11.5px] text-text-2">
                    {x.m === "ausfall" && (
                      <span aria-hidden="true" className="font-semibold text-cancel">
                        ✕{" "}
                      </span>
                    )}
                    {t(`metric.${x.m}`)}
                  </div>
                  <div className="text-[19px] font-[650] tabular-nums">{x.text}</div>
                  {day && (
                    <div className="text-[11.5px] text-text-3">
                      {dev
                        ? `${t("map.day.usual", { v: dev.normal })} · ${t(`map.day.class.${dev.cls}`)}`
                        : t("map.day.noCompare")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="mb-3.5 text-xs text-text-3">
            {t("hm.meta", { n: int(station.n), period: period ?? "" })}
          </p>
        </>
      ) : (
        loaded && <p className="my-3 text-text-2">{t(day ? "lage.notLarge" : "map.noData")}</p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Link to={{ pathname: stationPath(eva), search }} className={PRIMARY}>
          {t("map.details")}
        </Link>
        <span className="inline-flex h-[34px] items-center gap-1.5 px-2 font-medium text-text-2 opacity-55">
          {t("map.fromHere")}
          <SoonTag />
        </span>
      </div>

      {/* After the actions, so they stay in view on a phone. Line values are monthly, and the day
          map has none per day: the Karte only. */}
      {!day && (station || lookup.data) && <PanelLines key={eva} eva={eva} f={f} search={search} />}
    </aside>
  );
}

/** How many lines the panel lists; the station page has the rest. */
const PANEL_LINES = 5;

/**
 * The station's busiest lines in the map's metric, each a link to its page, and a link to all of
 * them on the station page. It asks what the station page asks, so that page comes from the cache.
 */
function PanelLines({ eva, f, search }: { eva: string; f: FilterKeys; search: string }) {
  const id = useId();
  const q = useStationLines(eva, f);
  // The months the lines cover: the URL's rounded to the data, else the covered range (the API's
  // default, as the filter bar shows it).
  const m = useMonthPeriod(f);
  const stand = useDatenstand().data;
  const von = m.von ?? stand?.vollabdeckung_ab;
  const bis = m.bis ?? stand?.monate.at(-1);
  const period = von && bis ? formatPeriod(von, bis) : undefined;
  const busiest = q.data && [...q.data].sort((a, b) => b.n - a.n);
  let body;
  if (q.isError) body = <ErrorBanner onRetry={() => q.refetch()} />;
  else if (!busiest) body = <Pulse className="h-[120px] animate-pulse rounded-lg bg-surface-2" />;
  else if (busiest.length === 0) body = <p className="text-text-2">{t("station.lines.none")}</p>;
  else
    body = (
      <>
        <ul>
          {busiest.slice(0, PANEL_LINES).map((l) => {
            const shown = show(f.k, l, l.name);
            return (
              <li key={l.linie}>
                <Link
                  to={{ pathname: linePath(l.linie), search: linePageSearch(f) }}
                  className="flex items-center gap-2 rounded-lg px-1 py-1.5 hover:bg-surface-2 max-md:min-h-11"
                >
                  {l.typ && <Badge>{l.typ}</Badge>}
                  <b className="min-w-0 flex-1 font-semibold">{l.name}</b>
                  <b className={`tabular-nums ${shown.low ? "text-text-3" : ""}`}>{shown.text}</b>
                </Link>
              </li>
            );
          })}
        </ul>
        {busiest.length > PANEL_LINES && (
          <Link
            to={{ pathname: stationPath(eva), search, hash: "#linien" }}
            className="flex items-center rounded-lg px-1 py-1.5 text-[13px] font-medium text-text-2 hover:bg-surface-2 hover:text-text max-md:min-h-11"
          >
            {t("map.lines.all", { count: int(busiest.length) })}
          </Link>
        )}
      </>
    );
  return (
    <section aria-labelledby={id} className="mt-3.5 border-t border-border pt-3">
      <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
        <h3 id={id} className="text-[13px] font-[620]">
          {t("map.lines")}
        </h3>
        <span className="text-xs text-text-3">{t(`metric.${f.k}`)}</span>
      </div>
      {period && <p className="mb-1 px-1 text-xs whitespace-nowrap text-text-3">{period}</p>}
      {body}
    </section>
  );
}

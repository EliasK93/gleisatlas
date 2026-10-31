import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef } from "react";
import { useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { api, must, useDatenstand } from "./api";
import { t } from "./i18n";
import { Icon } from "./Icon";
import { addDays, formatChip, formatPeriod, readFilters, withParam, withPeriod } from "./metrics";
import { StationSearch } from "./StationSearch";

const chip = (on: boolean) =>
  `chip ${on ? "border-transparent bg-accent-soft text-accent" : "border-border bg-surface text-text-2"}`;

/**
 * Global filter bar of the Discover area. All state lives in the URL. `noStation` leaves out the
 * Bahnhof chip and `noPeriod` the Zeitraum chip. `stationName` is the selected station's name when
 * the page already has it: a string uses it, `null` waits for the page's data, `undefined` looks
 * the station up. With a `linie` in the URL, a removable chip shows `lineTitle`. `lage` (the
 * Live-Lage page) shows a day instead of a period and a train type: a day field and the last
 * seven days as chips. Its newest day is the default and so never written as `tag`.
 */
export function Filters({
  noStation,
  noPeriod,
  lage,
  stationName,
  lineTitle,
}: {
  noStation?: boolean;
  noPeriod?: boolean;
  lage?: boolean;
  stationName?: string | null;
  lineTitle?: string;
}) {
  const setParams = useSetParams();
  const [params] = useSearchParams();
  const f = readFilters(params);
  // The API's default range is the covered one.
  const datenstand = useDatenstand();
  const months = datenstand.data?.monate ?? [];
  const now = {
    von: f.von ?? datenstand.data?.vollabdeckung_ab ?? "",
    bis: f.bis ?? months.at(-1) ?? "",
  };
  const first = datenstand.data?.erster_tag;
  const complete = datenstand.data?.letzter_tag;
  // The live day, where there is one, is the newest day.
  const heute = datenstand.data?.heute ?? undefined;
  const newest = heute ?? complete;
  const day = f.tag ?? newest;
  // The newest day and the six before it, none before the first day of the data. A day between
  // the last complete one and today has no map yet, so it gets no chip.
  const recent: string[] = [];
  if (lage && newest && complete && first)
    for (let d = newest; recent.length < 7 && d >= first; d = addDays(d, -1))
      if (d === newest || d <= complete) recent.push(d);
  // Uncontrolled: React would put the URL's day back after every key of a half-typed year. The
  // field follows the URL only when the URL's day changes by other means (a clamped link).
  const dayField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dayField.current && day && dayField.current.value !== day) dayField.current.value = day;
  }, [day]);
  return (
    // The vertical padding keeps the mobile tap areas of the chips inside the scroll box.
    <div className="-mx-4 -mt-1.5 mb-2.5 flex gap-2 overflow-x-auto px-4 pt-1.5 pb-2 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
      {lage && (
        <>
          <span className={chip(true)}>
            {t("filter.chip", { label: t("filter.day") })}
            <label className="hit">
              <input
                type="date"
                aria-label={t("map.day.pick")}
                ref={dayField}
                defaultValue={day}
                min={first}
                max={newest}
                onChange={(e) => {
                  // Only a day inside the data: while a year is typed the field passes
                  // through values like 0002-09-15, which must neither move the map nor query.
                  const v = e.target.value;
                  if (first && newest && v >= first && v <= newest)
                    setParams(withParam("tag", v === newest ? "" : v));
                }}
                className="cursor-pointer bg-transparent px-1 font-semibold"
              />
            </label>
          </span>
          <div
            role="group"
            aria-label={t("lage.recent")}
            className="flex shrink-0 gap-2 md:flex-wrap"
          >
            {recent.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={d === day}
                onClick={() => setParams(withParam("tag", d === newest ? "" : d))}
                className={`${chip(d === day)} cursor-pointer`}
              >
                {d === heute ? t("map.day.today") : formatChip(d)}
              </button>
            ))}
          </div>
        </>
      )}
      {!noPeriod && !lage && (
        <span className={chip(!!(f.von || f.bis))}>
          {t("filter.chip", { label: t("filter.period") })}
          {(["von", "bis"] as const).map((edge, i) => (
            <Fragment key={edge}>
              {i > 0 && t("filter.periodSeparator")}
              <label className="hit">
                <select
                  aria-label={t(edge === "von" ? "filter.periodFrom" : "filter.periodTo")}
                  value={now[edge]}
                  onChange={(e) => setParams(withPeriod(edge, e.target.value, now))}
                  className={`cursor-pointer bg-transparent px-1 font-semibold ${f.von || f.bis ? "" : "text-text"}`}
                >
                  {months.map((m) => (
                    <option key={m} value={m}>
                      {formatPeriod(m)}
                    </option>
                  ))}
                </select>
              </label>
            </Fragment>
          ))}
        </span>
      )}
      {!lage && (
        <label className={chip(!!f.g)}>
          {t("filter.chip", { label: t("filter.category") })}
          <select
            value={f.g ?? ""}
            onChange={(e) => setParams(withParam("g", e.target.value))}
            className={`cursor-pointer bg-transparent px-1 font-semibold ${f.g ? "" : "text-text"}`}
          >
            <option value="">{t("filter.all")}</option>
            <option value="regional">{t("filter.regional")}</option>
            <option value="fern">{t("filter.fern")}</option>
          </select>
        </label>
      )}
      {!noStation && (
        <StationFilter
          eva={f.bhf}
          name={stationName}
          // A picked station wins over a line, which only the time series knows.
          onPick={(eva) =>
            setParams((p) => {
              p.delete("linie");
              return withParam("bhf", eva)(p);
            })
          }
        />
      )}
      {f.linie && (
        <span className={chip(true)}>
          {t("filter.chip", { label: t("filter.line") })}
          <b className="px-1 font-semibold">{lineTitle ?? f.linie}</b>
          <button
            type="button"
            aria-label={t("filter.lineRemove")}
            onClick={() => setParams(withParam("linie", ""))}
            className="hit -mr-1.5 grid size-6 cursor-pointer place-items-center rounded-full hover:bg-surface/60"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </span>
      )}
      <button
        type="button"
        onClick={() => setParams(clearParams)}
        className="hit h-8 shrink-0 cursor-pointer px-2 text-[13px] text-text-3 hover:text-text"
      >
        {t("filter.reset")}
      </button>
    </div>
  );
}

// Below the chip where anchor positioning exists; elsewhere the default centred popover.
const ANCHORED =
  "supports-[anchor-name:--a]:inset-auto supports-[anchor-name:--a]:m-0 supports-[anchor-name:--a]:mt-1 supports-[anchor-name:--a]:[position-anchor:--bhf] supports-[anchor-name:--a]:[position-try-fallbacks:flip-inline] supports-[anchor-name:--a]:[top:anchor(bottom)] supports-[anchor-name:--a]:[left:anchor(left)]";

/** Chip with a native popover holding a small combobox over /stationen. Filters by EVA only. */
function StationFilter({
  eva,
  name,
  onPick,
}: {
  eva?: string;
  name?: string | null;
  onPick: (eva: string) => void;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const station = useQuery({
    queryKey: ["station", eva],
    queryFn: () => api.GET("/stationen/{eva}", { params: { path: { eva: eva! } } }).then(must),
    enabled: !!eva && name === undefined,
    staleTime: Infinity,
  });
  return (
    <>
      <button
        ref={invoker}
        type="button"
        popoverTarget="bhf-pop"
        className={`${chip(!!eva)} cursor-pointer [anchor-name:--bhf]`}
      >
        {t("filter.chip", { label: t("filter.station") })}
        <b className={`px-1 font-semibold ${eva ? "" : "text-text"}`}>
          {!eva ? t("filter.all") : (name ?? station.data?.name ?? t("filter.eva", { eva }))}
        </b>
        <Icon name="chev" className="size-4" />
      </button>
      <div
        id="bhf-pop"
        popover="auto"
        ref={pop}
        onToggle={(e) => {
          if (e.newState === "open") input.current?.focus();
        }}
        // Light dismiss covers clicks and Esc; this covers Tab. The chip toggles it itself.
        onBlur={(e) => {
          const to = e.relatedTarget;
          if (to && to !== invoker.current && !e.currentTarget.contains(to))
            pop.current?.hidePopover();
        }}
        className={`w-80 max-w-[calc(100vw-32px)] rounded-[10px] border border-border bg-surface p-1 text-text shadow-card ${ANCHORED}`}
      >
        <StationSearch
          variant="inline"
          label={t("filter.stationSearch")}
          inputRef={input}
          onPick={(picked) => {
            onPick(picked);
            pop.current?.hidePopover();
          }}
        />
      </div>
    </>
  );
}

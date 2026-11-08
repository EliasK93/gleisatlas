import { Fragment, useEffect, useId, useRef, type ReactNode } from "react";
import { useSearchParams } from "react-router";
import { clearParams, useSetParams } from "./useSetParams";
import { lageDays, useDatenstand, useStation } from "./api";
import { t } from "./i18n";
import { Icon } from "./Icon";
import {
  addDays,
  berlinToday,
  firstDay,
  formatPeriod,
  lastDay,
  monthOf,
  readFilters,
  withParam,
  withPeriod,
  within,
} from "./metrics";
import { StationSearch } from "./StationSearch";

const chip = (on: boolean) =>
  `chip ${on ? "border-transparent bg-accent-soft text-accent" : "border-border bg-surface text-text-2"}`;

/**
 * Global filter bar of the Discover area. All state lives in the URL. `noStation` leaves out the
 * Bahnhof chip, `noCategory` the Gattung chip and `noPeriod` the Zeitraum chip. `stationName` is the selected station's name when
 * the page already has it: a string uses it, `null` waits for the page's data, `undefined` looks
 * the station up. `lines` (the time series and the heatmap) adds a Linie chip that picks a line; with a `linie` in
 * the URL the chip shows `lineTitle`, opens the picker to change it and has a remove button. `lage` (the
 * Live-Lage page) shows a day instead of a period and a train type: a day field and chips for
 * Heute, Gestern and Vorgestern. Its newest day is the default and so never written as `tag`.
 * `days` (the period map) shows the period as two day fields instead of month selects; the month
 * selects of the other pages show the months that a period of days reaches into.
 */
export function Filters({
  noStation,
  noCategory,
  noPeriod,
  lage,
  days,
  stationName,
  lines,
  lineTitle,
}: {
  noStation?: boolean;
  noCategory?: boolean;
  noPeriod?: boolean;
  lage?: boolean;
  days?: boolean;
  stationName?: string | null;
  lines?: boolean;
  lineTitle?: string;
}) {
  const setParams = useSetParams();
  const [params] = useSearchParams();
  const f = readFilters(params);
  // The API's default range is the covered one.
  const datenstand = useDatenstand();
  const months = datenstand.data?.monate ?? [];
  const first = datenstand.data?.erster_tag;
  const complete = datenstand.data?.letzter_tag;
  // The month selects hold months inside the list (as the month pages ask for them): a day shows
  // its month, one outside the data the nearest month with data.
  const month = (v: string) => within(monthOf(v), months[0], months.at(-1));
  const now = {
    von: month(f.von ?? datenstand.data?.vollabdeckung_ab ?? ""),
    bis: month(f.bis ?? months.at(-1) ?? ""),
  };
  // The day fields: the covered range from its first day to the last complete one, by default;
  // a day outside the data shows its nearest edge.
  const nowDays = {
    von: within(firstDay(f.von ?? datenstand.data?.vollabdeckung_ab ?? ""), first, complete),
    bis: within(lastDay(f.bis ?? complete ?? ""), first, complete),
  };
  // The live day, where there is one, is the newest day; else the collector's last finished day.
  const served = datenstand.data && lageDays(datenstand.data);
  const newest = served?.newest;
  const day = f.tag ?? newest;
  // Today, yesterday and the day before in Germany. A chip whose day has no map (today before the
  // first data, a day after the last complete one that the collector did not keep) stays,
  // disabled, and names the reason.
  const recent =
    lage && served
      ? (["map.day.today", "lage.yesterday", "lage.dayBefore"] as const).map((label, i) => {
          const d = addDays(berlinToday(), -i);
          const why = served.has(d)
            ? undefined
            : t(i === 0 ? "map.day.todayNone" : "lage.incomplete");
          return { d, label: t(label), why };
        })
      : [];
  const reasons = useId();
  const station = useStation(f.bhf, !noStation && !!f.bhf && stationName === undefined);
  // A picked line wins over a station.
  const pickLine = (linie: string) =>
    setParams((p) => {
      p.delete("bhf");
      return withParam("linie", linie)(p);
    });
  return (
    // The vertical padding keeps the mobile tap areas of the chips inside the scroll box.
    <div className="-mx-4 -mt-1.5 mb-2.5 flex gap-2 overflow-x-auto px-4 pt-1.5 pb-2 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
      {lage && (
        <>
          <span className={chip(true)}>
            {t("filter.chip", { label: t("filter.day") })}
            <DayField
              label={t("map.day.pick")}
              value={day}
              min={first}
              max={newest}
              onPick={(v) => setParams(withParam("tag", v === newest ? "" : v))}
            />
          </span>
          <div
            role="group"
            aria-label={t("lage.recent")}
            className="flex shrink-0 gap-2 md:flex-wrap"
          >
            {recent.map(({ d, label, why }, i) => (
              <Fragment key={label}>
                <button
                  type="button"
                  aria-pressed={!why && d === day}
                  disabled={!!why}
                  // The title for the mouse; a disabled button takes no focus and a touch shows no
                  // title, so the reason is also hidden page text that a screen reader reaches.
                  title={why}
                  aria-describedby={why && `${reasons}-${i}`}
                  onClick={() => setParams(withParam("tag", d === newest ? "" : d))}
                  className={`${chip(!why && d === day)} cursor-pointer disabled:cursor-default disabled:opacity-55`}
                >
                  {label}
                </button>
                {why && (
                  <span id={`${reasons}-${i}`} className="sr-only">
                    {why}
                  </span>
                )}
              </Fragment>
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
              {days ? (
                <DayField
                  label={t(edge === "von" ? "filter.periodFrom" : "filter.periodTo")}
                  value={nowDays[edge]}
                  min={first}
                  max={complete}
                  className={f.von || f.bis ? "" : "text-text"}
                  holds={(v) => (edge === "von" ? v > nowDays.bis : v < nowDays.von)}
                  onPick={(v) => setParams(withPeriod(edge, v, nowDays))}
                />
              ) : (
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
              )}
            </Fragment>
          ))}
        </span>
      )}
      {!lage && !noCategory && (
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
        <Picker
          id="bhf"
          scope="bahnhoefe"
          className={`${chip(!!f.bhf)} cursor-pointer`}
          // A picked station replaces a line, which only the time series and the heatmap know.
          onPick={(eva) =>
            setParams((p) => {
              p.delete("linie");
              return withParam("bhf", eva)(p);
            })
          }
        >
          {t("filter.chip", { label: t("filter.station") })}
          <b className={`px-1 font-semibold ${f.bhf ? "" : "text-text"}`}>
            {!f.bhf
              ? t("filter.all")
              : (stationName ?? station.data?.name ?? t("filter.eva", { eva: f.bhf }))}
          </b>
        </Picker>
      )}
      {lines && !f.linie && (
        <Picker
          id="linie"
          scope="linien"
          className={`${chip(false)} cursor-pointer`}
          onPick={pickLine}
        >
          {t("filter.chip", { label: t("filter.line") })}
          <b className="px-1 font-semibold text-text">{t("filter.all")}</b>
        </Picker>
      )}
      {lines && f.linie && (
        <div className={chip(true)}>
          {/* The chip's title opens the same picker, to change the line. */}
          <Picker
            id="linie"
            scope="linien"
            className="hit inline-flex cursor-pointer items-center"
            onPick={pickLine}
          >
            {t("filter.chip", { label: t("filter.line") })}
            <b className="px-1 font-semibold">{lineTitle ?? f.linie}</b>
          </Picker>
          <button
            type="button"
            aria-label={t("filter.lineRemove")}
            onClick={() => setParams(withParam("linie", ""))}
            className="hit -mr-1.5 grid size-6 cursor-pointer place-items-center rounded-full hover:bg-surface/60"
          >
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
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

/**
 * A native day field that writes only days inside min..max: while a year is typed the field passes
 * through values like 0002-09-15, which must neither move anything nor query. Uncontrolled, because
 * React would put the URL's day back after every key of a half-typed year; it follows `value` only
 * when that changes by other means (a clamped link, the other edge moving along). A day for
 * which `holds` is true (it would move the other edge) is not passed on while the field has the
 * focus, since typing passes through such days (a 2 on the way to 25); it is passed on when the
 * field is left.
 */
export function DayField({
  label,
  value,
  min,
  max,
  className = "",
  holds,
  onPick,
}: {
  label: string;
  value?: string;
  min?: string;
  max?: string;
  className?: string;
  holds?: (day: string) => boolean;
  onPick: (day: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Not while the field has the focus: a slow echo of a day typed earlier would undo the keys
    // typed since.
    const el = input.current;
    if (el && value && el.value !== value && document.activeElement !== el) el.value = value;
  }, [value]);
  const inside = (v: string) => !!min && !!max && v >= min && v <= max;
  return (
    <label className="hit">
      <input
        type="date"
        aria-label={label}
        ref={input}
        defaultValue={value}
        min={min}
        max={max}
        onChange={(e) => {
          const v = e.target.value;
          if (inside(v) && !(holds?.(v) && document.activeElement === e.target)) onPick(v);
        }}
        onBlur={(e) => {
          const v = e.target.value;
          if (holds && inside(v) && v !== value) onPick(v);
        }}
        className={`cursor-pointer bg-transparent px-1 font-semibold ${className}`}
      />
    </label>
  );
}

// Below the chip where anchor positioning exists (the anchor is named per picker in `style`);
// elsewhere the default centred popover.
const ANCHORED =
  "supports-[anchor-name:--a]:inset-auto supports-[anchor-name:--a]:m-0 supports-[anchor-name:--a]:mt-1 supports-[anchor-name:--a]:[position-try-fallbacks:flip-inline] supports-[anchor-name:--a]:[top:anchor(bottom)] supports-[anchor-name:--a]:[left:anchor(left)]";

/**
 * A button (`children` and a chevron) with a native popover holding a small combobox: stations
 * (by EVA) or lines (by id). `id` names the popover and its CSS anchor.
 */
function Picker({
  id,
  scope,
  className,
  onPick,
  children,
}: {
  id: string;
  scope: "bahnhoefe" | "linien";
  className: string;
  onPick: (value: string) => void;
  children: ReactNode;
}) {
  const pop = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const done = (value: string) => {
    onPick(value);
    pop.current?.hidePopover();
  };
  return (
    <>
      <button
        ref={invoker}
        type="button"
        popoverTarget={`${id}-pop`}
        style={{ anchorName: `--${id}` }}
        className={className}
      >
        {children}
        <Icon name="chev" className="size-4" />
      </button>
      <div
        id={`${id}-pop`}
        popover="auto"
        ref={pop}
        style={{ positionAnchor: `--${id}` }}
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
          scope={scope}
          label={t(scope === "bahnhoefe" ? "filter.stationSearch" : "filter.lineSearch")}
          inputRef={input}
          onPick={done}
          onLine={(line) => done(line.linie)}
        />
      </div>
    </>
  );
}

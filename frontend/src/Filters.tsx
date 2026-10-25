import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { api, must } from "./api";
import { t } from "./i18n";
import { Icon } from "./Icon";
import { readFilters, withParam } from "./metrics";

const chip = (on: boolean) =>
  `chip ${on ? "border-transparent bg-accent-soft text-accent" : "border-border bg-surface text-text-2"}`;

/** Global filter bar of the Discover area. All state lives in the URL. */
export function Filters({ period }: { period?: string }) {
  const [params, setParams] = useSearchParams();
  const f = readFilters(params);
  return (
    // The vertical padding keeps the mobile tap areas of the chips inside the scroll box.
    <div className="-mx-4 -mt-1.5 mb-2.5 flex gap-2 overflow-x-auto px-4 pt-1.5 pb-2 [scrollbar-width:none] md:mx-0 md:flex-wrap md:overflow-visible md:px-0">
      {/* ponytail: read-only until multi-month data and a picker arrive */}
      <span className={chip(true)}>
        {t("filter.chip", { label: t("filter.period") })}
        <b className="px-1 font-semibold">{period ?? "–"}</b>
      </span>
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
      <StationFilter eva={f.bhf} onPick={(eva) => setParams(withParam("bhf", eva))} />
      <button
        type="button"
        onClick={() => setParams({})}
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
function StationFilter({ eva, onPick }: { eva?: string; onPick: (eva: string) => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const pop = useRef<HTMLDivElement>(null);
  const invoker = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const station = useQuery({
    queryKey: ["station", eva],
    queryFn: () => api.GET("/stationen/{eva}", { params: { path: { eva: eva! } } }).then(must),
    enabled: !!eva,
    staleTime: Infinity,
  });
  const term = q.trim();
  // ponytail: one request per keystroke, cached per term; debounce if the API gets slow
  const hits = useQuery({
    queryKey: ["stationen", term],
    queryFn: () => api.GET("/stationen", { params: { query: { q: term, limit: 8 } } }).then(must),
    enabled: term !== "",
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const list = term ? (hits.data ?? []) : [];
  const pick = (i: number) => {
    const s = list[i];
    if (!s) return;
    onPick(s.eva);
    pop.current?.hidePopover();
    setQ("");
  };
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
          {!eva ? t("filter.all") : (station.data?.name ?? t("filter.eva", { eva }))}
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
        <input
          ref={input}
          role="combobox"
          aria-label={t("filter.stationSearch")}
          aria-expanded={list.length > 0}
          aria-controls="bhf-list"
          aria-autocomplete="list"
          aria-activedescendant={list[active] ? `bhf-${list[active].eva}` : undefined}
          placeholder={t("filter.stationSearchPlaceholder")}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown")
              setActive((a) => Math.max(0, Math.min(a + 1, list.length - 1)));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter") pick(active);
            else return;
            e.preventDefault();
          }}
          className="h-9 w-full rounded-lg border border-border bg-surface-2 px-2.5 focus:border-accent focus:bg-surface"
        />
        <ul id="bhf-list" role="listbox" aria-label={t("filter.station")} className="mt-1">
          {list.map((s, i) => (
            <li
              key={s.eva}
              id={`bhf-${s.eva}`}
              role="option"
              aria-selected={i === active}
              onClick={() => pick(i)}
              onPointerMove={() => setActive(i)}
              className={`cursor-pointer rounded-md px-2.5 py-1.5 ${i === active ? "bg-surface-2" : ""}`}
            >
              <span className="block font-semibold">{s.name}</span>
              <span className="block text-xs text-text-3">{t("filter.eva", { eva: s.eva })}</span>
            </li>
          ))}
        </ul>
        {term && hits.isSuccess && list.length === 0 && (
          <p className="px-2.5 py-2 text-xs text-text-3">{t("filter.stationNone")}</p>
        )}
      </div>
    </>
  );
}

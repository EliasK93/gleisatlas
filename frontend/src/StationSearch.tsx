import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useState, type Ref } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, must } from "./api";
import { t } from "./i18n";
import { Icon } from "./Icon";
import { int, readFilters, writeFilters } from "./metrics";
import { stationPath } from "./ui";

type Variant = "global" | "inline";

// "global": icon and shortcut hint in a field whose list floats over the page. "inline": a plain
// field with its list below, for the filter popover and the unknown-station page.
const STYLE = {
  global: {
    input:
      "h-9 w-full rounded-lg border border-border bg-surface-2 pr-3 pl-[32px] focus:border-accent focus:bg-surface md:pr-11",
    box: "absolute inset-x-0 top-[calc(100%+4px)] z-50 rounded-[10px] border border-border bg-surface shadow-card",
    list: "max-h-80 overflow-auto p-1",
    none: "px-3 py-2.5 text-xs text-text-3",
  },
  inline: {
    input:
      "h-9 w-full rounded-lg border border-border bg-surface-2 px-2.5 focus:border-accent focus:bg-surface",
    box: "mt-1",
    list: "",
    none: "px-2.5 py-2 text-xs text-text-3",
  },
};

/** Combobox over /stationen: type, arrow keys, Enter or click. Ids come from useId, so several can coexist. */
export function StationSearch({
  variant,
  label,
  onPick,
  inputRef,
}: {
  variant: Variant;
  label: string;
  onPick: (eva: string) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const term = q.trim();
  // ponytail: one request per keystroke, cached per term; debounce if the API gets slow
  const hits = useQuery({
    queryKey: ["stationen", term],
    queryFn: () => api.GET("/stationen", { params: { query: { q: term, limit: 8 } } }).then(must),
    enabled: term !== "",
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const list = term && open ? (hits.data ?? []) : [];
  const same = (name: string) => list.filter((s) => s.name === name).length;
  const style = STYLE[variant];
  const optionId = (eva: string) => `${id}-${eva}`;
  const pick = (i: number) => {
    const s = list[i];
    if (!s) return;
    onPick(s.eva);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="relative">
      {variant === "global" && (
        <Icon
          name="search"
          className="pointer-events-none absolute top-[9px] left-2.5 z-10 size-[18px] text-text-3"
        />
      )}
      {/* The label gives the field a 44 px tap area on mobile; a tap on it focuses the input. */}
      <label className="hit block">
        <input
          ref={inputRef}
          data-global-search={variant === "global" || undefined}
          role="combobox"
          aria-label={label}
          aria-expanded={list.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={list[active] ? optionId(list[active].eva) : undefined}
          placeholder={t("filter.stationSearchPlaceholder")}
          autoComplete="off"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown")
              setActive((a) => Math.max(0, Math.min(a + 1, list.length - 1)));
            else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
            else if (e.key === "Enter") {
              // While the hits of the new term load, the list still shows the old term's.
              if (!hits.isPlaceholderData) pick(active);
            } else {
              // Not prevented, so Escape still closes a popover around the field.
              if (e.key === "Escape") setQ("");
              return;
            }
            e.preventDefault();
          }}
          className={style.input}
        />
      </label>
      {variant === "global" && (
        <kbd className="pointer-events-none absolute top-2 right-2 hidden rounded border border-border bg-surface px-[5px] py-px text-[11px] text-text-3 md:block">
          {t("search.shortcut")}
        </kbd>
      )}
      <div className={list.length ? style.box : ""}>
        <ul
          id={`${id}-list`}
          role="listbox"
          aria-label={t("filter.station")}
          className={list.length ? style.list : ""}
        >
          {list.map((s, i) => (
            <li
              key={s.eva}
              id={optionId(s.eva)}
              role="option"
              aria-selected={i === active}
              // Keeps the focus in the field, so the blur does not close the list before the click.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
              onPointerMove={() => setActive(i)}
              className={`cursor-pointer rounded-md px-2.5 py-1.5 max-md:min-h-11 ${i === active ? "bg-surface-2" : ""}`}
            >
              <span className="block font-semibold">
                {s.name}
                {same(s.name) > 1 && (
                  <span className="ml-1.5 text-[11px] font-medium text-text-2">
                    {t("search.duplicates", { count: same(s.name) })}
                  </span>
                )}
              </span>
              <span className="block text-xs text-text-3">
                {[s.land, t("filter.eva", { eva: s.eva }), t("search.stops", { n: int(s.n) })]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {term && open && hits.isSuccess && list.length === 0 && (
        <p className={`${style.box} ${style.none}`}>{t("filter.stationNone")}</p>
      )}
    </div>
  );
}

/** Opens a station page, keeping the filters of the current page except the station itself. */
export function useOpenStation() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  return (eva: string) =>
    navigate({
      pathname: stationPath(eva),
      search: writeFilters({ ...readFilters(params), bhf: undefined, tag: undefined }).toString(),
    });
}

/** The search field of the sidebar and the mobile top bar. */
export function GlobalSearch() {
  const open = useOpenStation();
  return <StationSearch variant="global" label={t("search.label")} onPick={open} />;
}

/** Ctrl+K and Cmd+K focus the global field that is displayed, instead of the browser's own shortcut. */
export function useSearchShortcut() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      // The sidebar and the top bar each hold a field; the one in a hidden container has no offsetParent.
      Array.from(document.querySelectorAll<HTMLInputElement>("input[data-global-search]"))
        .find((input) => input.offsetParent !== null)
        ?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
}

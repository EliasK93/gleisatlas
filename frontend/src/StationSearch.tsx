import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useId, useState, type Ref } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, must } from "./api";
import { t } from "./i18n";
import { Icon } from "./Icon";
import { stationLand } from "./laender";
import { int } from "./metrics";
import type { components } from "./schema";
import { Badge, linePath, stationPath } from "./ui";
import { readFilters, writeFilters } from "./urlKeys";

type Variant = "global" | "inline";
type Station = components["schemas"]["Station"];
type SuchLinie = components["schemas"]["SuchLinie"];
type Suche = components["schemas"]["Suche"];
/** What the field finds: stations and lines (the global search), or one of them. */
type Scope = "alle" | "bahnhoefe" | "linien";
type Hit = { group: "bahnhoefe"; s: Station } | { group: "linien"; l: SuchLinie };

// "global": icon and shortcut hint in a field whose list floats over the page. "inline": a plain
// field with its list below, for the filter popovers and the unknown-station page.
const STYLE = {
  global: {
    input:
      "h-9 w-full rounded-lg border border-border bg-surface-2 pr-3 pl-[32px] text-ellipsis focus:border-accent focus:bg-surface md:pr-16",
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

/** Per scope: the placeholder, the list's name and the text when nothing matches. */
const TEXT = {
  alle: { placeholder: "search.placeholder", list: "search.label", none: "search.none" },
  bahnhoefe: {
    placeholder: "filter.stationSearchPlaceholder",
    list: "filter.station",
    none: "filter.stationNone",
  },
  linien: {
    placeholder: "filter.lineSearchPlaceholder",
    list: "filter.line",
    none: "filter.lineNone",
  },
} as const;

/**
 * Combobox: type, arrow keys, Enter or click. Stations come from /stationen; with lines in scope
 * everything comes from /suche, shown in the groups and order the API gives. Ids come from useId,
 * so several can coexist.
 */
export function StationSearch({
  variant,
  scope = "bahnhoefe",
  label,
  onPick,
  onLine,
  inputRef,
}: {
  variant: Variant;
  scope?: Scope;
  label: string;
  onPick?: (eva: string) => void;
  onLine?: (line: SuchLinie) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const id = useId();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const term = q.trim();
  const stations = scope === "bahnhoefe";
  // ponytail: one request per keystroke, cached per term; debounce if the API gets slow
  const hits = useQuery({
    queryKey: [stations ? "stationen" : "suche", term],
    queryFn: (): Promise<Suche> =>
      stations
        ? api
            .GET("/stationen", { params: { query: { q: term, limit: 8 } } })
            .then(must)
            .then((bahnhoefe) => ({ bahnhoefe, linien: [], zuerst: "bahnhoefe" }))
        : api.GET("/suche", { params: { query: { q: term, limit: 8 } } }).then(must),
    enabled: term !== "",
    staleTime: Infinity,
    placeholderData: keepPreviousData,
  });
  const data = term && open ? hits.data : undefined;
  // The groups in the API's order, each left out when it has no hits or lies outside the scope.
  const order =
    data?.zuerst === "linien"
      ? (["linien", "bahnhoefe"] as const)
      : (["bahnhoefe", "linien"] as const);
  const groups = order
    .filter((g) => scope === "alle" || g === scope)
    .map((g): Hit[] =>
      g === "bahnhoefe"
        ? (data?.bahnhoefe ?? []).map((s) => ({ group: g, s }))
        : (data?.linien ?? []).map((l) => ({ group: g, l })),
    )
    .filter((g) => g.length > 0);
  // The arrow keys run through the options in their shown order, across the groups.
  const list = groups.flat();
  // ponytail: the duplicate-name hint only counts the eight results shown; ask the API for the total if namesakes beyond eight confuse
  const same = (name: string) =>
    list.filter((h) => h.group === "bahnhoefe" && h.s.name === name).length;
  const style = STYLE[variant];
  const text = TEXT[scope];
  const optionId = (i: number) => `${id}-${i}`;
  const pick = (i: number) => {
    const h = list[i];
    if (!h) return;
    if (h.group === "bahnhoefe") onPick?.(h.s.eva);
    else onLine?.(h.l);
    setQ("");
    setOpen(false);
  };
  const option = (h: Hit) => {
    const i = list.indexOf(h);
    return (
      <div
        key={h.group === "bahnhoefe" ? h.s.eva : h.l.linie}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        // Keeps the focus in the field, so the blur does not close the list before the click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(i)}
        onPointerMove={() => setActive(i)}
        className={`cursor-pointer rounded-md px-2.5 py-1.5 max-md:min-h-11 ${i === active ? "bg-surface-2" : ""}`}
      >
        {h.group === "bahnhoefe" ? (
          <>
            <span className="block font-semibold">
              {h.s.name}
              {same(h.s.name) > 1 && (
                <span className="ml-1.5 text-[11px] font-medium text-text-2">
                  {t("search.duplicates", { count: same(h.s.name) })}
                </span>
              )}
            </span>
            <span className="block text-xs text-text-3">
              {[
                stationLand(h.s.land),
                t("filter.eva", { eva: h.s.eva }),
                t("search.stops", { n: int(h.s.n) }),
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </>
        ) : (
          <>
            <span className="flex flex-wrap items-center gap-x-1.5">
              {h.l.typ && <Badge>{h.l.typ}</Badge>}
              <span className="font-semibold">{h.l.label}</span>
            </span>
            {h.l.ziel && (
              <span className="block text-xs text-text-3">
                {t("search.direction", { ziel: h.l.ziel })}
              </span>
            )}
          </>
        )}
      </div>
    );
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
          maxLength={100}
          data-global-search={variant === "global" || undefined}
          role="combobox"
          aria-label={label}
          aria-expanded={list.length > 0}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={list[active] ? optionId(active) : undefined}
          placeholder={t(text.placeholder)}
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
        <div
          id={`${id}-list`}
          role="listbox"
          aria-label={t(text.list)}
          className={list.length ? style.list : ""}
        >
          {groups.map((g) => {
            const name = g[0].group;
            // Only the global search names its groups; a picker of one kind needs no heading.
            return scope === "alle" ? (
              <div key={name} role="group" aria-labelledby={`${id}-${name}`}>
                <div
                  id={`${id}-${name}`}
                  role="presentation"
                  className="px-2.5 pt-2 pb-1 text-[11px] font-semibold text-text-3"
                >
                  {t(`search.${name}`)}
                </div>
                {g.map(option)}
              </div>
            ) : (
              <Fragment key={name}>{g.map(option)}</Fragment>
            );
          })}
        </div>
      </div>
      {term && open && hits.isSuccess && list.length === 0 && (
        <p className={`${style.box} ${style.none}`}>{t(text.none)}</p>
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
      search: writeFilters({
        ...readFilters(params),
        bhf: undefined,
        tag: undefined,
        land: undefined,
      }).toString(),
    });
}

/** The search field of the sidebar and the mobile top bar: stations and lines. */
export function GlobalSearch() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const open = useOpenStation();
  // A line opens with the search of linePageSearch (metric and period) plus a matched direction 2.
  const openLine = ({ linie, richtung }: SuchLinie) => {
    const { k, von, bis } = readFilters(params);
    navigate({
      pathname: linePath(linie),
      search: writeFilters({ k, von, bis, richtung: richtung === 2 ? "2" : undefined }).toString(),
    });
  };
  return (
    <StationSearch
      variant="global"
      scope="alle"
      label={t("search.label")}
      onPick={open}
      onLine={openLine}
    />
  );
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

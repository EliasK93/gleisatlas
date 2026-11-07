/** Pieces shared by the Discover pages: metric switch, value display, states and Teilen. */
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import { Link, NavLink, useLocation, type To } from "react-router";
import { t, type MessageKey } from "./i18n";
import { Icon } from "./Icon";
import { APPROX_N, classOf, DEFS, int, LOW_N, METRICS, tenths, type Metric } from "./metrics";
import type { components } from "./schema";

type Stats = components["schemas"]["Stats"];

// Static class names, so Tailwind can see them.
export const FILL = {
  r: ["bg-r1", "bg-r2", "bg-r3", "bg-r4", "bg-r5"],
  c: ["bg-c1", "bg-c2", "bg-c3", "bg-c4", "bg-c5"],
};

export const narrow = window.matchMedia("(max-width: 767px)");
const onNarrowChange = (cb: () => void) => {
  narrow.addEventListener("change", cb);
  return () => narrow.removeEventListener("change", cb);
};
/** True below 768 px; follows window resizes. */
export const useNarrow = () => useSyncExternalStore(onNarrowChange, () => narrow.matches);

export type Shown = {
  text: string;
  fill: string;
  label: string;
  value?: number;
  low?: boolean;
  approx?: boolean;
};

/**
 * What one value shows: the value with "~" when approximate, nothing below LOW_N.
 * Delay metrics only see arrived stops, so they count those; Ausfälle counts all stops.
 */
export function show(metric: Metric, s: Stats | undefined, slot: string): Shown {
  // ponytail: the API's `shown(...)` is a second implementation of this rule and nothing checks that they agree; serve the flag in the API if one of them changes
  const n = s?.n ?? 0;
  const label = (key: "hm.low" | "hm.onlyCancelled") => t(key, { slot, n: int(n) });
  if (!s || n < LOW_N) return { text: "–", fill: "hatch", label: label("hm.low"), low: true };
  const v = DEFS[metric].value(s);
  if (v === null) return { text: "✕", fill: "bg-cancel", label: label("hm.onlyCancelled") };
  const counted = metric === "ausfall" ? n : Math.round(n * (1 - s.ausfallquote));
  if (counted < LOW_N) return { text: "–", fill: "hatch", label: label("hm.low"), low: true };
  const approx = counted < APPROX_N;
  const text = (approx ? "~" : "") + DEFS[metric].format(v);
  const value = t(`metric.${metric}.cell`, { v: text });
  return {
    text,
    value: v,
    approx,
    fill: FILL[DEFS[metric].scale][classOf(metric, v) - 1],
    label: t("hm.cell", { slot, value, n: int(n) }),
  };
}

/** The sentence under a tile's value; what stands in for a value that is not shown. */
function sentence(metric: Metric, shown: Shown, noCancel: boolean) {
  if (shown.value === undefined) return shown.low ? t("hm.lowLegend") : t("hm.onlyCancelledLegend");
  if (metric === "puenktlich") return t("station.sentence.puenktlich", { x: tenths(shown.value) });
  if (metric !== "ausfall") return t(`station.sentence.${metric}`);
  if (noCancel) return t("station.sentence.noCancel");
  // The rate is rounded to 0.1 %, so a smaller one has no sensible "1 von N".
  if (shown.value < 0.1) return t("station.sentence.ausfallRare");
  return t("station.sentence.ausfall", { n: int(Math.round(100 / shown.value)) });
}

/**
 * The four metric tiles of a station or a whole line: value, sentence, `meta`, a coloured edge,
 * and a note above when a value has too little data. `stats` undefined shows the empty look.
 */
export function MetricTiles({
  stats,
  noCancel,
  meta,
  label,
  className = "",
}: {
  stats: Stats | undefined;
  /** True when not one stop was cancelled, which the sentence of the cancellations says. */
  noCancel: boolean;
  meta: string;
  label: string;
  /** Extra classes for the tile grid. */
  className?: string;
}) {
  const tiles = METRICS.map((m) => ({ m, shown: show(m, stats, "") }));
  return (
    <>
      {tiles.some((x) => x.shown.low) && (
        <p className="flex items-center gap-2 rounded-xl border border-border bg-surface-2 px-4 py-3 text-[13px]">
          <span aria-hidden="true">◌</span>
          {t("map.lowNote", { n: int(stats?.n ?? 0) })}
        </p>
      )}

      <ul
        aria-label={label}
        className={`grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4 ${className}`}
      >
        {tiles.map(({ m, shown }) => {
          const cancel = m === "ausfall";
          return (
            <li
              key={m}
              className="relative flex flex-col gap-1 overflow-hidden rounded-xl border border-border bg-surface p-4 pl-5"
            >
              <i
                aria-hidden="true"
                className={`absolute inset-y-0 left-0 w-1 ${cancel && !shown.low ? "bg-cancel" : shown.fill}`}
              />
              <div className="flex items-center gap-1.5 text-[12.5px] font-[550] text-text-2">
                {cancel && (
                  <span aria-hidden="true" className="font-semibold text-cancel">
                    ✕
                  </span>
                )}
                {/* ponytail: a native title is hover-only; use a popover when touch users need the explanation */}
                <span
                  title={t(`metric.${m}.help`)}
                  className="cursor-help underline decoration-text-3 decoration-dotted underline-offset-[3px]"
                >
                  {t(`metric.${m}`)}
                </span>
              </div>
              <div
                className={`text-[32px] leading-[1.1] font-[650] tracking-[-0.02em] tabular-nums ${
                  shown.low ? "text-text-3" : cancel ? "text-cancel" : ""
                }`}
              >
                {shown.text}
              </div>
              <p className="text-[13px] text-text-2">{sentence(m, shown, noCancel)}</p>
              <p className="mt-auto pt-1.5 text-xs text-text-3">{meta}</p>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/** How long a first load may take before the hint says the server is probably starting up. */
const SLOW_MS = 5000;

/**
 * Nothing for the first 5 s after it mounts, then a line counting the seconds. It stays outside
 * the live region of the skeleton ("Daten werden geladen …"), so a screen reader hears that once
 * and not the counter every second. Mount it only while loading: its clock starts at mount.
 */
export function SlowHint() {
  const [ms, setMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const id = setInterval(() => setMs(Date.now() - start), 1000);
    return () => clearInterval(id);
  }, []);
  if (ms < SLOW_MS) return null;
  return <p className="text-[13px] text-text-2">{t("state.slow", { s: Math.floor(ms / 1000) })}</p>;
}

/** The width, gutters and top space every page shares. */
export const Page = ({ children }: { children: ReactNode }) => (
  <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">{children}</div>
);

/** A page's h1; `className` adds spacing. */
export const PageTitle = ({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) => (
  <h1
    className={`${className} text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]`}
  >
    {children}
  </h1>
);

/** The "Als Tabelle" toggle under a chart or heatmap. */
export const TableToggle = ({ on, onToggle }: { on: boolean; onToggle: () => void }) => (
  <button
    type="button"
    aria-pressed={on}
    onClick={onToggle}
    className={`hit ml-auto cursor-pointer rounded-md px-2 py-1 ${
      on ? "bg-accent-soft text-accent" : "text-text-3 hover:text-text"
    }`}
  >
    {t("hm.asTable")}
  </button>
);

/**
 * A loading skeleton's status region, named for screen readers; `className` brings the shape and
 * the `animate-pulse` of the skeleton, and `children` its blocks.
 */
export const Pulse = ({ className, children }: { className: string; children?: ReactNode }) => (
  <div role="status" className={className}>
    <span className="sr-only">{t("state.loading")}</span>
    {children}
  </div>
);

const SEG = "rounded-[7px] px-[11px] py-[5px] text-[13px] font-medium whitespace-nowrap";
const segState = (on: boolean) => (on ? "bg-surface text-text shadow-sm" : "text-text-2");

/**
 * Segmented switch of buttons; `tabs` makes it a tab list instead of pressed buttons. `className`
 * places the mobile scroll box inside its container.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  tabs,
  describedBy,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
  /** The id of the element that explains the switch. */
  describedBy?: string;
  className: string;
}) {
  return (
    <div className={`overflow-x-auto [scrollbar-width:none] md:overflow-visible ${className}`}>
      <div
        role={tabs ? "tablist" : "group"}
        aria-label={label}
        aria-describedby={describedBy}
        className="inline-flex gap-0.5 rounded-[9px] bg-surface-2 p-[3px] md:flex-wrap"
      >
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? o.value === value : undefined}
            aria-pressed={tabs ? undefined : o.value === value}
            onClick={() => onChange(o.value)}
            className={`hit cursor-pointer ${SEG} ${segState(o.value === value)}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const METRIC_OPTIONS = METRICS.map((m) => ({ value: m, label: t(`metric.${m}`) }));

/**
 * Segmented metric switch with a line under it that explains the selected metric. The line is
 * as wide as the switch (`w-0 min-w-full`), so it wraps there and never widens its container.
 */
export function MetricSwitch({
  metric,
  onMetric,
  className,
  helpOnPhone = true,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  className: string;
  /** False hides the line below 768 px; the switch stays described by it. */
  helpOnPhone?: boolean;
}) {
  const help = useId();
  return (
    <div className="min-w-0">
      <Segmented
        label={t("metric.label")}
        options={METRIC_OPTIONS}
        value={metric}
        onChange={onMetric}
        describedBy={help}
        className={className}
      />
      <p
        id={help}
        className={`mt-2.5 w-0 min-w-full text-xs text-text-3 md:mt-1.5 ${helpOnPhone ? "" : "max-md:hidden"}`}
      >
        {t(`metric.${metric}.help`)}
      </p>
    </div>
  );
}

/**
 * Scrolls once to the element named by the URL hash when `ready` turns true: the data that sizes
 * the page above it has arrived, so the target no longer moves. A new hash scrolls again.
 */
export function useHashScroll(ready: boolean) {
  const { hash } = useLocation();
  const done = useRef("");
  useEffect(() => {
    if (!ready || !hash || done.current === hash) return;
    done.current = hash;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [ready, hash]);
}

export const MAP = "/karte";
export const LAGE = "/lage";
export const stationPath = (eva: string) => `/bahnhof/${eva}`;
/** A line's page; ids hold a colon and may hold spaces. */
export const linePath = (id: string) => `/linie/${encodeURIComponent(id)}`;
export const HEATMAP = "/muster/heatmap";
export const RANKINGS = "/muster/rankings";
export const ZEITVERLAUF = "/muster/zeitverlauf";

/** Mobile switch between the pattern pages. */
export function MusterSwitch() {
  const { search } = useLocation();
  const link = (to: string, label: MessageKey) => (
    <NavLink
      key={to}
      to={{ pathname: to, search }}
      className={({ isActive }) => `hit flex-1 text-center ${SEG} ${segState(isActive)}`}
    >
      {t(label)}
    </NavLink>
  );
  return (
    <nav
      aria-label={t("nav.patterns")}
      className="mb-3 flex gap-0.5 rounded-[9px] bg-surface-2 p-[3px] md:hidden"
    >
      {link(HEATMAP, "nav.heatmapShort")}
      {link(RANKINGS, "nav.rankings")}
      {link(ZEITVERLAUF, "nav.timeline")}
    </nav>
  );
}

export type Tip = { text: string; x: number; y: number } | null;
export type Point = { target: EventTarget | null; clientX: number; clientY: number };

/** The tooltip for the `data-tip` element under a pointer, or none outside such elements. */
export function tipAt(e: Point): Tip {
  const el = e.target instanceof Element ? e.target : null;
  const hit = el?.closest<HTMLElement>("[data-tip]");
  return hit ? { text: hit.dataset.tip!, x: e.clientX, y: e.clientY } : null;
}

/**
 * Tooltip state: a tap shows what `at` finds under it and a tap anywhere else clears it; any scroll
 * clears it too. The caller sets it from its own pointer moves. A chart with its own `at` (and its
 * own attribute) keeps its taps apart from the `data-tip` charts on the same page; `at` must be
 * stable (defined outside the component).
 */
export function useTip<T = NonNullable<Tip>>(at = tipAt as (e: Point) => T | null) {
  const [tip, setTip] = useState<T | null>(null);
  useEffect(() => {
    const off = () => setTip(null);
    const tap = (e: PointerEvent) => setTip(at(e));
    addEventListener("scroll", off, true);
    addEventListener("pointerdown", tap);
    return () => {
      removeEventListener("scroll", off, true);
      removeEventListener("pointerdown", tap);
    };
  }, [at]);
  return [tip, setTip] as const;
}

/**
 * The floating tooltip box at the pointer: by default in window coordinates, kept inside the
 * window; `local` places it inside the nearest positioned parent, as the map does.
 */
export const TipBox = ({ tip, local }: { tip: Tip; local?: boolean }) =>
  tip && (
    <div
      role="tooltip"
      className={`pointer-events-none ${local ? "absolute z-20" : "fixed z-50"} max-w-[260px] -translate-x-1/2 -translate-y-full rounded-[7px] bg-text px-[9px] py-1.5 text-[12.5px] text-bg shadow-card`}
      style={{
        left: local ? tip.x : Math.min(Math.max(tip.x, 138), innerWidth - 138),
        top: tip.y - 12,
      }}
    >
      {tip.text}
    </div>
  );

/** The small bordered label of a train category or line type. */
export const Badge = ({ children }: { children: ReactNode }) => (
  <span className="w-fit rounded-sm border-[1.5px] border-text-2 px-1 text-[11px] leading-4 font-[650] text-text-2">
    {children}
  </span>
);

/**
 * A thin bar for one shown value. Punctuality is a share of 100; the other metrics are scaled to
 * `most`, the largest value in view. A hatched value fills the bar.
 */
export function MiniBar({
  metric,
  shown,
  most = 100,
}: {
  metric: Metric;
  shown: Shown;
  most?: number;
}) {
  const v = shown.value;
  const width = v === undefined ? 100 : metric === "puenktlich" ? v : (v / most) * 100;
  return (
    <div className="h-2 overflow-hidden rounded-sm bg-surface-2">
      <i
        aria-hidden="true"
        className={`block h-full rounded-sm ${shown.fill}`}
        style={{ width: `${Math.round(width)}%` }}
      />
    </div>
  );
}

/** The cancellation rate as its own grey figure, separate from every delay value. */
export function Cancelled({ stats, className = "" }: { stats: Stats; className?: string }) {
  const { text } = show("ausfall", stats, "");
  return (
    <span className={`text-cancel tabular-nums whitespace-nowrap ${className}`}>
      <span className="sr-only">{t("metric.ausfall.cell", { v: text })}</span>
      <span aria-hidden="true">✕ {text}</span>
    </span>
  );
}

const ROW_COLUMNS = "md:grid-cols-[minmax(0,1.3fr)_minmax(0,1.2fr)_52px_72px_104px]";

/** The column names above a list of `StatRow`s, for the table look; every row also reads fine on its own. */
export function RowHead({ first, metric }: { first: string; metric: string }) {
  return (
    <div
      aria-hidden="true"
      className={`hidden gap-3 px-1 pb-2 text-xs text-text-3 md:grid ${ROW_COLUMNS}`}
    >
      <span>{first}</span>
      <span className="col-span-2">{metric}</span>
      <span>{t("station.lines.n")}</span>
      <span className="text-right">✕ {t("metric.ausfall")}</span>
    </div>
  );
}

/**
 * One row of a station's or a line's table, a link: name (with an optional type badge), bar,
 * value, stops and cancellations. A row card on a phone, a table row from 768 px.
 */
export function StatRow({
  to,
  name,
  badge,
  metric,
  stats,
  most,
  linkRef,
  marker,
}: {
  to: To;
  name: string;
  badge?: string;
  metric: Metric;
  stats: Stats;
  /** The largest value in view, for the bar of a metric that is not a share. */
  most?: number;
  linkRef?: Ref<HTMLAnchorElement>;
  /** Drawn beside the row, positioned by the caller relative to the row. */
  marker?: ReactNode;
}) {
  const shown = show(metric, stats, name);
  return (
    <li className="relative md:last:*:border-b-0">
      <Link
        ref={linkRef}
        to={to}
        className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 rounded-lg border border-border p-3 hover:bg-surface-2 md:gap-y-0 md:rounded-none md:border-0 md:border-b md:px-1 md:py-2.5 ${ROW_COLUMNS}`}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 md:order-1">
          {badge && <Badge>{badge}</Badge>}
          <b className="font-semibold">{name}</b>
        </span>
        <b
          className={`text-right font-[650] tabular-nums md:order-3 ${shown.low ? "text-text-3" : ""}`}
        >
          {shown.text}
        </b>
        <div className="col-span-2 md:order-2 md:col-span-1">
          <MiniBar metric={metric} shown={shown} most={most} />
        </div>
        <span className="text-xs text-text-3 tabular-nums md:order-4">
          {t("station.n", { n: int(stats.n) })}
        </span>
        <Cancelled stats={stats} className="text-right text-xs md:order-5" />
      </Link>
      {marker}
    </li>
  );
}

/** The "bald" tag of a page that is not built yet. */
export const SoonTag = ({ className = "" }: { className?: string }) => (
  <span
    className={`rounded-full border border-border px-1.5 text-[10.5px] text-text-3 ${className}`}
  >
    {t("nav.soon")}
  </span>
);

/** The primary button look. */
export const PRIMARY = "btn border-accent! bg-accent! text-on-accent! hover:brightness-110";

export function ErrorBanner({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-r5/40 bg-r5/8 px-4 py-3.5"
    >
      <Icon name="alert" className="mt-0.5 size-[18px] text-r5" />
      <div className="flex-1">
        <b className="font-semibold">{t("state.error")}</b>
        <p className="text-[13px] text-text-2">{t("state.errorHint")}</p>
      </div>
      <button type="button" className="btn" onClick={onRetry}>
        {t("state.retry")}
      </button>
    </div>
  );
}

/** An empty or unknown state. Without `onReset` there is no reset button; `children` follow the hint. */
export function EmptyCard({
  title,
  hint,
  onReset,
  className = "card px-6 py-14",
  heading: H = "h2",
  children,
}: {
  title: string;
  hint?: string;
  onReset?: () => void;
  className?: string;
  heading?: "h1" | "h2";
  children?: ReactNode;
}) {
  return (
    <div className={`text-center ${className}`}>
      <div className="mx-auto mb-3.5 grid size-[52px] place-items-center rounded-full bg-surface-2 text-text-2">
        <Icon name="empty" />
      </div>
      <H className="text-[17px] font-[620]">{title}</H>
      {hint && <p className="mt-1.5 text-text-2">{hint}</p>}
      {children}
      {onReset && (
        <button type="button" className={`${PRIMARY} mt-4`} onClick={onReset}>
          {t("filter.resetAll")}
        </button>
      )}
    </div>
  );
}

export function ShareButton() {
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

/** Pieces shared by the Discover pages: metric switch, value display, states and Teilen. */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router";
import { t, type MessageKey } from "./i18n";
import { Icon } from "./Icon";
import { APPROX_N, classOf, DEFS, int, LOW_N, METRICS, type Metric } from "./metrics";
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

export type Shown = { text: string; fill: string; label: string; value?: number; low?: boolean };

/**
 * What one value shows: the value with "~" when approximate, nothing below LOW_N.
 * Delay metrics only see arrived stops, so they count those; Ausfälle counts all stops.
 */
export function show(metric: Metric, s: Stats | undefined, slot: string): Shown {
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
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
  className: string;
}) {
  return (
    <div className={`overflow-x-auto [scrollbar-width:none] md:overflow-visible ${className}`}>
      <div
        role={tabs ? "tablist" : "group"}
        aria-label={label}
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

/** Segmented metric switch. */
export const MetricSwitch = ({
  metric,
  onMetric,
  className,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  className: string;
}) => (
  <Segmented
    label={t("metric.label")}
    options={METRIC_OPTIONS}
    value={metric}
    onChange={onMetric}
    className={className}
  />
);

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
type Point = { target: EventTarget | null; clientX: number; clientY: number };

/** The tooltip for the `data-tip` element under a pointer, or none outside such elements. */
export function tipAt(e: Point): Tip {
  const el = e.target instanceof Element ? e.target : null;
  const hit = el?.closest<HTMLElement>("[data-tip]");
  return hit ? { text: hit.dataset.tip!, x: e.clientX, y: e.clientY } : null;
}

/**
 * Tooltip state: a tap shows the element under it and a tap anywhere else clears it; any scroll
 * clears it too. The caller sets it from its own pointer moves.
 */
export function useTip() {
  const [tip, setTip] = useState<Tip>(null);
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
  return [tip, setTip] as const;
}

/** The floating tooltip box at the pointer. */
export const TipBox = ({ tip }: { tip: Tip }) =>
  tip && (
    <div
      role="tooltip"
      className="pointer-events-none fixed z-50 max-w-[260px] -translate-x-1/2 -translate-y-full rounded-[7px] bg-text px-[9px] py-1.5 text-[12.5px] text-bg shadow-card"
      style={{ left: Math.min(Math.max(tip.x, 138), innerWidth - 138), top: tip.y - 12 }}
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

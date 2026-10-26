/** Pieces shared by the Discover pages: metric switch, value display, states and Teilen. */
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { t } from "./i18n";
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

/** Segmented metric switch. `className` places the mobile scroll box inside its container. */
export function MetricSwitch({
  metric,
  onMetric,
  className,
}: {
  metric: Metric;
  onMetric: (m: Metric) => void;
  className: string;
}) {
  return (
    <div className={`overflow-x-auto [scrollbar-width:none] md:overflow-visible ${className}`}>
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

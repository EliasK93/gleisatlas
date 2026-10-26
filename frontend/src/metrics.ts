/** Metric classes, number formatting and URL filters. Pure functions, no React. */
import { LOCALE, t } from "./i18n";
import type { components } from "./schema";

type Stats = components["schemas"]["Stats"];

export const METRICS = ["puenktlich", "median", "p90", "ausfall"] as const;
export type Metric = (typeof METRICS)[number];

/** Below LOW_N a value is not shown; below APPROX_N it gets a "~". */
export const LOW_N = 15;
export const APPROX_N = 50;

const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const int = (v: number) => whole.format(v);
const NBSP = String.fromCharCode(0xa0); // keeps value and unit on one line
const withUnit = (v: string, unit: "unit.pct" | "unit.min") => `${v}${NBSP}${t(unit)}`;
const pct = (v: number) => withUnit(int(v), "unit.pct");
const min = (v: number) => withUnit(int(v), "unit.min");
const round = (v: number | null, factor = 1) =>
  v === null ? null : Math.round(v * factor) / factor;

type Def = {
  /** Class limits from class 1 to class 4; class 5 is everything beyond. */
  bounds: [number, number, number, number];
  higherIsBetter?: boolean;
  scale: "r" | "c";
  unit: "unit.pct" | "unit.min";
  /** The value in display units, rounded as shown, so colour and number always agree. */
  value: (s: Stats) => number | null;
  format: (v: number) => string;
};

export const DEFS: Record<Metric, Def> = {
  puenktlich: {
    bounds: [90, 80, 70, 60],
    higherIsBetter: true,
    scale: "r",
    unit: "unit.pct",
    value: (s) => round(s.puenktlich === null ? null : s.puenktlich * 100),
    format: pct,
  },
  median: {
    bounds: [1, 2, 4, 7],
    scale: "r",
    unit: "unit.min",
    value: (s) => round(s.median),
    format: (v) => (v < 1 ? `< ${min(1)}` : min(v)),
  },
  p90: {
    bounds: [5, 8, 12, 18],
    scale: "r",
    unit: "unit.min",
    value: (s) => round(s.p90),
    format: min,
  },
  ausfall: {
    bounds: [1, 2, 3.5, 5],
    scale: "c",
    unit: "unit.pct",
    value: (s) => round(s.ausfallquote * 100, 10),
    format: (v) => withUnit(oneDecimal.format(v), "unit.pct"),
  },
};

/** A share of all stops in whole percent; a non-zero share below 0.5 % reads "< 1 %", never "0 %". */
export const share = (pct: number) => withUnit(pct > 0 && pct < 0.5 ? "< 1" : int(pct), "unit.pct");

/** Lower limits in minutes of the seven delay bins of `verteilung`; the last bin is open. */
const BIN_FROM = [0, 1, 3, 6, 10, 20, 30];
export const binLabel = (i: number) =>
  i === BIN_FROM.length - 1 ? `> ${BIN_FROM[i]}` : `${BIN_FROM[i]}–${BIN_FROM[i + 1]}`;

/** Class 1 (very reliable) … 5 (very unreliable). */
export function classOf(m: Metric, v: number): 1 | 2 | 3 | 4 | 5 {
  const { bounds, higherIsBetter } = DEFS[m];
  const i = bounds.findIndex((b) => (higherIsBetter ? v >= b : v < b));
  return (i < 0 ? 5 : i + 1) as 1 | 2 | 3 | 4 | 5;
}

/** True when `a` is less reliable than `b`. */
export const worse = (m: Metric, a: number, b: number) => (DEFS[m].higherIsBetter ? a < b : a > b);

/** Five legend labels, e.g. "≥90 %", "80–90", …, "<60 %". */
export function legend(m: Metric): string[] {
  const { bounds, higherIsBetter, unit } = DEFS[m];
  const b = bounds.map((v) => (Number.isInteger(v) ? int(v) : oneDecimal.format(v)));
  const [first, last] = higherIsBetter ? ["≥", "<"] : ["<", "≥"];
  const middle = [1, 2, 3].map((i) =>
    higherIsBetter ? `${b[i]}–${b[i - 1]}` : `${b[i - 1]}–${b[i]}`,
  );
  return [withUnit(first + b[0], unit), ...middle, withUnit(last + b[3], unit)];
}

const monthFormat = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
const monthDate = (ym: string) => new Date(`${ym}-01T00:00:00Z`);

/** "2026-09" → "Sept. 2026"; a range becomes "Okt. 2025 – Sept. 2026". */
export const formatPeriod = (von: string, bis = von) =>
  monthFormat.formatRange(monthDate(von), monthDate(bis));

// 2024-01-01 was a Monday, so day 0 = Monday like the API.
const dayDate = (d: number) => new Date(Date.UTC(2024, 0, 1 + d));
const dayLong = new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" });
const dayShort = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" });
export const dayName = (d: number, short = false) =>
  (short ? dayShort : dayLong).format(dayDate(d));

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export type Filters = {
  g?: "regional" | "fern";
  bhf?: string;
  von?: string;
  bis?: string;
  k: Metric;
};

/** Reads the URL keys; unknown values fall back to the default. */
export function readFilters(p: URLSearchParams): Filters {
  const g = p.get("g");
  const k = p.get("k");
  const bhf = p.get("bhf");
  const von = p.get("von");
  const bis = p.get("bis");
  return {
    g: g === "regional" || g === "fern" ? g : undefined,
    bhf: bhf && /^\d+$/.test(bhf) ? bhf : undefined,
    von: von && MONTH.test(von) ? von : undefined,
    bis: bis && MONTH.test(bis) ? bis : undefined,
    k: METRICS.find((m) => m === k) ?? "puenktlich",
  };
}

/** The URL keys for `f`, without defaults: what readFilters accepted, nothing else. */
export function writeFilters({ k, ...rest }: Filters): URLSearchParams {
  const keys = { ...rest, k: k === "puenktlich" ? undefined : k };
  return new URLSearchParams(Object.entries(keys).filter((e): e is [string, string] => !!e[1]));
}

/**
 * URL updater: sets one filter key, or removes it when the value is empty. The result is always
 * in canonical order, so a write never makes the page rewrite its own URL (and remount).
 */
export const withParam = (key: string, value: string) => (p: URLSearchParams) => {
  if (value) p.set(key, value);
  else p.delete(key);
  return writeFilters(readFilters(p));
};

/**
 * URL updater for the month range: sets `edge` and, when that crosses the other edge (shown or
 * defaulted from `now`), moves the other edge to the same month, so von never lies after bis.
 */
export const withPeriod =
  (edge: "von" | "bis", month: string, now: { von: string; bis: string }) =>
  (p: URLSearchParams) => {
    const f = readFilters(p);
    const other = edge === "von" ? "bis" : "von";
    const kept = f[other] ?? now[other];
    const crossed = edge === "von" ? month > kept : month < kept;
    const next: Filters = { ...f };
    next[edge] = month;
    if (crossed) next[other] = month;
    return writeFilters(next);
  };

/** "x von 10" for a share in whole percent: rounded down, so 96 % never reads "10 von 10". */
export const tenths = (pct: number) => Math.floor(pct / 10);

/**
 * Base map label in the UI language: the OpenFreeMap styles prefer English (`name_en`). Any text
 * field that reads a name becomes the name in our language, else the local one; road numbers stay.
 */
export function localLabel<T>(field: T): T {
  return JSON.stringify(field).includes('"name')
    ? (["coalesce", ["get", `name:${LOCALE.slice(0, 2)}`], ["get", "name"]] as T)
    : field;
}

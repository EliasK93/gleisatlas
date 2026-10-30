/** Metric classes, number formatting and URL filters. Pure functions, no React. */
import { LOCALE, t } from "./i18n";
import type { components } from "./schema";

type Stats = components["schemas"]["Stats"];
type Normal = components["schemas"]["Normal"];

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
// The percent sign is spaced per language (German "87 %", English "87%"), so it comes from the catalog.
export const withUnit = (v: string, unit: "unit.pct" | "unit.min") =>
  unit === "unit.pct" ? t("format.pct", { v }) : `${v}${NBSP}${t(unit)}`;
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

/** The API's field for each metric (in `Normal`, `Wetter`, `Klasse`, `Trend`, the rankings' `metrik`). */
export const API_FIELD = {
  puenktlich: "puenktlich",
  median: "median",
  p90: "p90",
  ausfall: "ausfallquote",
} as const satisfies Record<Metric, keyof Normal>;

/** A raw API value of the metric (a share as 0–1, minutes as they are) in display units, rounded as shown. */
// DEFS' `value` reads only the field of its own metric, so the value goes into all of them.
export const display = (m: Metric, v: number) =>
  DEFS[m].value({ n: 0, puenktlich: v, ausfallquote: v, median: v, p90: v });

/** How many weeks before a day its reference days reach. */
export const REFERENCE_WEEKS = 12;

/** Class 1 (much better than usual) … 5 (much worse), 3 = as usual. */
export type Class = 1 | 2 | 3 | 4 | 5;

/** A normal or a day figure as text: punctuality with one decimal, the rest as the scale shows it. */
export function figureText(m: Metric, v: number): string {
  return m === "puenktlich"
    ? withUnit(oneDecimal.format(v * 100), "unit.pct")
    : DEFS[m].format(display(m, v) ?? v);
}

/**
 * A station's day against its usual: the API's class (it knows the station's own variation) and
 * the normal as text. Null where there is nothing to compare: no class, or no normal.
 */
export function deviation(
  m: Metric,
  s: { normal?: Normal; klasse?: components["schemas"]["Klasse"] },
) {
  const cls = s.klasse?.[API_FIELD[m]] ?? null;
  const raw = s.normal?.[API_FIELD[m]] ?? null;
  if (cls === null || raw === null) return null;
  return { cls: cls as Class, normal: DEFS[m].format(display(m, raw)!) };
}

/** A share of all stops in whole percent; a non-zero share below 0.5 % reads "< 1 %", never "0 %". */
export const share = (pct: number) => withUnit(pct > 0 && pct < 0.5 ? "< 1" : int(pct), "unit.pct");

/** Lower limits in minutes of the seven delay bins of `verteilung`; the first bin (including early
 * arrivals) and the last are open. */
const BIN_FROM = [0, 1, 3, 6, 10, 20, 30];
export const binLabel = (i: number) =>
  i === 0
    ? `< ${BIN_FROM[1]}`
    : i === BIN_FROM.length - 1
      ? `≥ ${BIN_FROM[i]}`
      : `${BIN_FROM[i]}–${BIN_FROM[i + 1]}`;

/** Class 1 (very reliable) … 5 (very unreliable) on the period map. */
export function classOf(m: Metric, v: number): Class {
  const { bounds, higherIsBetter } = DEFS[m];
  const i = bounds.findIndex((b) => (higherIsBetter ? v >= b : v < b));
  return (i < 0 ? 5 : i + 1) as Class;
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

const monthName = new Intl.DateTimeFormat(LOCALE, { month: "long", timeZone: "UTC" });
/** "2026-03" → "Mär 26" (en: "Mar '26"): three letters and the year, as on the chart axes. */
export const formatMonth = (ym: string) =>
  t("format.monthShort", {
    month: monthName.format(monthDate(ym)).slice(0, 3),
    yy: ym.slice(2, 4),
  });

/** "2026-09" → "Sept. 2026"; a range becomes "Okt. 2025 – Sept. 2026". */
export const formatPeriod = (von: string, bis = von) =>
  monthFormat.formatRange(monthDate(von), monthDate(bis));

const dayFormat = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});
/** "2026-03-10" → "Di., 10.03.2026" (en: "Tue, 03/10/2026"): the weekday with the date. */
export const formatDay = (ymd: string) => dayFormat.format(new Date(`${ymd}T00:00:00Z`));

// 2024-01-01 was a Monday, so day 0 = Monday like the API.
const dayDate = (d: number) => new Date(Date.UTC(2024, 0, 1 + d));
const dayLong = new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" });
const dayShort = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" });
/** "2026-03-10" → "Dienstag" (en: "Tuesday"). */
export const weekdayOf = (ymd: string) => dayLong.format(new Date(`${ymd}T00:00:00Z`));
export const dayName = (d: number, short = false) =>
  (short ? dayShort : dayLong).format(dayDate(d));

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A real calendar day as YYYY-MM-DD; "2026-02-31" is not one. */
function validDay(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
}

export type Filters = {
  g?: "regional" | "fern";
  bhf?: string;
  von?: string;
  bis?: string;
  /** One past day; only the map uses it (day mode), which drops `von` and `bis`. */
  tag?: string;
  /** A line id; only the time series page uses it, and it wins over `bhf` there. Lines are monthly. */
  linie?: string;
  /** The time series' resolution: only "monat" is written, the day view is the default. */
  z?: "monat";
  k: Metric;
};

/** Reads the URL keys; unknown values fall back to the default. */
export function readFilters(p: URLSearchParams): Filters {
  const g = p.get("g");
  const k = p.get("k");
  const bhf = p.get("bhf");
  const von = p.get("von");
  const bis = p.get("bis");
  const tag = p.get("tag");
  const linie = p.get("linie");
  const z = p.get("z");
  return {
    g: g === "regional" || g === "fern" ? g : undefined,
    bhf: bhf && /^\d+$/.test(bhf) ? bhf : undefined,
    von: von && MONTH.test(von) ? von : undefined,
    bis: bis && MONTH.test(bis) ? bis : undefined,
    tag: validDay(tag) ? tag : undefined,
    linie: linie && linie.length <= 200 ? linie : undefined,
    z: z === "monat" ? z : undefined,
    k: METRICS.find((m) => m === k) ?? "puenktlich",
  };
}

/** The URL keys for `f`, without defaults: what readFilters accepted, nothing else. */
export function writeFilters({ g, bhf, von, bis, tag, linie, z, k }: Filters): URLSearchParams {
  // The order is fixed, so a link built here equals the URL the page would write itself.
  const keys = { g, bhf, von, bis, tag, linie, z, k: k === "puenktlich" ? undefined : k };
  return new URLSearchParams(Object.entries(keys).filter((e): e is [string, string] => !!e[1]));
}

/** The time series has two views: punctuality, or delay (median with a P90 band). */
export const seriesMetric = (k: Metric): Metric =>
  k === "median" || k === "p90" ? "median" : "puenktlich";

/** The rankings page's own URL keys: what it lists and the minimum sample. */
export const MIN_NS = [100, 500, 1000, 5000] as const;
export type Rank = { typ: "linien" | "bahnhoefe"; min: number };

/** Reads `typ` and `min`; unknown values fall back to the default (stations, 500). */
export function readRank(p: URLSearchParams): Rank {
  return {
    typ: p.get("typ") === "linien" ? "linien" : "bahnhoefe",
    min: MIN_NS.find((n) => String(n) === p.get("min")) ?? 500,
  };
}

/** The filter keys, then the rankings keys, each without its default. */
export function writeRank(f: Filters, { typ, min }: Rank): URLSearchParams {
  const p = writeFilters(f);
  if (typ !== "bahnhoefe") p.set("typ", typ);
  if (min !== 500) p.set("min", String(min));
  return p;
}

/** URL updater for the rankings keys; the filters stay as they are. */
export const withRank = (change: Partial<Rank>) => (p: URLSearchParams) =>
  writeRank(readFilters(p), { ...readRank(p), ...change });

/**
 * URL updater: sets one filter key, or removes it when the value is empty. The result is always
 * in canonical order, so a write never makes the page rewrite its own URL (and remount).
 */
export const withParam = (key: string, value: string) => (p: URLSearchParams) => {
  if (value) p.set(key, value);
  else p.delete(key);
  return writeRank(readFilters(p), readRank(p));
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
    return writeRank(next, readRank(p));
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

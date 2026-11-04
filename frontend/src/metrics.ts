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
export const NBSP = String.fromCharCode(0xa0); // keeps value and unit on one line
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

/** The API's field for each metric (in `Normal`, `Klasse`, `Trend`, the rankings' `metrik`). */
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

/** A raw API value as the metric's text (the scale of `show`, without "~" or a low-data mark). */
export const formatRaw = (m: Metric, v: number) => DEFS[m].format(display(m, v) ?? v);

/** A normal or a day figure as text: punctuality with one decimal, the rest as the scale shows it. */
export function figureText(m: Metric, v: number): string {
  return m === "puenktlich" ? withUnit(oneDecimal.format(v * 100), "unit.pct") : formatRaw(m, v);
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
  return { cls: cls as Class, normal: formatRaw(m, raw) };
}

/**
 * A day's value against its usual in the metric's unit, with a sign: "+1 min", "−30 %-Pkt."
 * (en: "−30 pp"), "±0 min". It is the difference of the two figures as `figureText` shows them,
 * so "1 min · üblich 2 min" reads "−1 min"; punctuality's then in whole points. Null without
 * both raw values.
 */
export function offsetText(m: Metric, value: number | null, normal: number | null) {
  if (value === null || normal === null) return null;
  // figureText's rounding: punctuality with one decimal, the rest as the metric's scale.
  const shown = (v: number) => (m === "puenktlich" ? Math.round(v * 1000) / 10 : display(m, v)!);
  const diff = shown(value) - shown(normal);
  const d = m === "puenktlich" ? Math.round(diff) : diff;
  const sign = d > 0 ? "+" : d < 0 ? "−" : "±";
  const v = m === "ausfall" ? oneDecimal.format(Math.abs(d)) : int(Math.abs(d));
  return `${sign}${v}${NBSP}${t(DEFS[m].unit === "unit.pct" ? "unit.pp" : "unit.min")}`;
}

/** Today's calendar day in Germany as YYYY-MM-DD. */
export const berlinToday = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin" }).format(new Date());

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

/** The month of a month or a day: "2026-03-10" → "2026-03". */
export const monthOf = (v: string) => v.slice(0, 7);
/** `v` moved into `lo..hi` (the middle of three ISO strings in order is the clamped one). */
export const within = (v: string, lo?: string, hi?: string) =>
  lo && hi ? [lo, v, hi].sort()[1] : v;
/**
 * Both edges of a period as months for the month pages: days round outward and a month outside
 * the data moves to the nearest month with data, so the selects and the requests agree. A missing
 * edge stays missing.
 */
export const monthsOf = (f: { von?: string; bis?: string }, months: readonly string[]) => ({
  von: f.von && within(monthOf(f.von), months[0], months.at(-1)),
  bis: f.bis && within(monthOf(f.bis), months[0], months.at(-1)),
});
/** A month's first day; a day stays. */
export const firstDay = (v: string) => (v.length === 7 ? `${v}-01` : v);
/** A month's last day; a day stays. */
export const lastDay = (v: string) =>
  v.length === 7 ? `${v}-${new Date(Date.UTC(+v.slice(0, 4), +v.slice(5), 0)).getUTCDate()}` : v;

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

const rangeFormat = new Intl.DateTimeFormat(LOCALE, {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});
/** Two days as "1.–29. Okt. 2026" (en: "1 – 29 Oct 2026"). */
export const formatDays = (von: string, bis = von) =>
  rangeFormat.formatRange(new Date(`${von}T00:00:00Z`), new Date(`${bis}T00:00:00Z`));

const dayFormat = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});
/** "2026-03-10" → "Di., 10.03.2026" (en: "Tue, 03/10/2026"): the weekday with the date. */
export const formatDay = (ymd: string) => dayFormat.format(new Date(`${ymd}T00:00:00Z`));

const clock = new Intl.DateTimeFormat(LOCALE, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "Europe/Berlin",
});
/** The data time and the cut of a source of today: "Stand 14:37 · bis 14:00"
 * (en: "as of 14:37 · up to 14:00"). */
export const formatStand = (stand: string, cut: number) =>
  t("map.day.stand", {
    time: clock.format(new Date(stand)),
    cut: `${String(cut).padStart(2, "0")}:00`,
  });
/** "Heute, Stand 14:37 · bis 14:00" (en: "Today, as of 14:37 · up to 14:00"). */
export const formatLive = (stand: string, cut: number) =>
  t("map.day.live", { stand: formatStand(stand, cut) });

// 2024-01-01 was a Monday, so day 0 = Monday like the API.
const dayDate = (d: number) => new Date(Date.UTC(2024, 0, 1 + d));
const dayLong = new Intl.DateTimeFormat(LOCALE, { weekday: "long", timeZone: "UTC" });
const dayShort = new Intl.DateTimeFormat(LOCALE, { weekday: "short", timeZone: "UTC" });
/** "2026-03-10" → "Dienstag" (en: "Tuesday"). */
export const weekdayOf = (ymd: string) => dayLong.format(new Date(`${ymd}T00:00:00Z`));
export const dayName = (d: number, short = false) =>
  (short ? dayShort : dayLong).format(dayDate(d));
/** "2026-03-01" shifted by `n` days. */
export const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A real calendar day as YYYY-MM-DD; "2026-02-31" is not one. */
function validDay(s: string | null): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(s);
}

/** A month or a real day: the values `von` and `bis` take. */
const validPeriod = (s: string | null): s is string => !!s && (MONTH.test(s) || validDay(s));

export type Filters = {
  g?: "regional" | "fern";
  bhf?: string;
  /** A month or a day; only the period map reads days, the other pages round them to months. */
  von?: string;
  bis?: string;
  /** One day; only the Live-Lage page uses it, and it is left out for the newest day. */
  tag?: string;
  /** A federal state's code ("nw"); only the Live-Lage page uses it, and every other page drops it. */
  land?: string;
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
  const land = p.get("land");
  const linie = p.get("linie");
  const z = p.get("z");
  return {
    g: g === "regional" || g === "fern" ? g : undefined,
    bhf: bhf && /^\d+$/.test(bhf) ? bhf : undefined,
    von: validPeriod(von) ? von : undefined,
    bis: validPeriod(bis) ? bis : undefined,
    tag: validDay(tag) ? tag : undefined,
    land: land && /^[a-z]{2}$/.test(land) ? land : undefined,
    linie: linie && linie.length <= 200 ? linie : undefined,
    z: z === "monat" ? z : undefined,
    k: METRICS.find((m) => m === k) ?? "puenktlich",
  };
}

/** The URL keys for `f`, without defaults: what readFilters accepted, nothing else. */
export function writeFilters({
  g,
  bhf,
  von,
  bis,
  tag,
  land,
  linie,
  z,
  k,
}: Filters): URLSearchParams {
  // The order is fixed, so a link built here equals the URL the page would write itself.
  const keys = { g, bhf, von, bis, tag, land, linie, z, k: k === "puenktlich" ? undefined : k };
  return new URLSearchParams(Object.entries(keys).filter((e): e is [string, string] => !!e[1]));
}

/** The rankings page's own URL keys: what it lists and the minimum sample. */
// ponytail: four minimum-sample values only, though the API accepts any value from 15; a number field when users want other limits
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

/** The search string of a line's time series: the line in the page's category and metric. */
export const lineSearch = (f: Pick<Filters, "k" | "g">, linie: string) =>
  writeFilters({ k: f.k, g: f.g, linie }).toString();

/**
 * URL updater for the period: sets `edge` and, when that crosses the other edge (shown or
 * defaulted from `now`), moves the other edge to the same value, so von never lies after bis. A
 * month is written as a month and a day as a day: the other edge is brought into the same form.
 */
export const withPeriod =
  (edge: "von" | "bis", value: string, now: { von: string; bis: string }) =>
  (p: URLSearchParams) => {
    const f = readFilters(p);
    const other = edge === "von" ? "bis" : "von";
    const set = f[other];
    const same = (v: string) =>
      value.length === 7 ? monthOf(v) : other === "von" ? firstDay(v) : lastDay(v);
    const kept = same(set ?? now[other]);
    const crossed = edge === "von" ? value > kept : value < kept;
    const next: Filters = { ...f };
    next[edge] = value;
    // A day leaves the other edge as it is (a month stays a month); a month rounds it to its month.
    next[other] = crossed ? value : set && (value.length === 7 ? kept : set);
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

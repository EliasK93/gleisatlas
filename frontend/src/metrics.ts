/** Metric classes, number and date formatting. Pure functions, no React; the URL keys are in urlKeys.ts. */
import { LOCALE, t } from "./i18n";
import type { components } from "./schema";

type Stats = components["schemas"]["Stats"];
type Normal = components["schemas"]["Normal"];

export const METRICS = ["puenktlich", "median", "p90", "ausfall"] as const;
export type Metric = (typeof METRICS)[number];

/** Below LOW_N a value is not shown; below APPROX_N it gets a "~". */
export const LOW_N = 15;
export const APPROX_N = 50;
/** The most a line's id can hold (the API's limit). */
export const MAX_LINE_ID = 200;

const whole = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 0 });
export const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
export const int = (v: number) => whole.format(v);
/** The number of `format` with its sign: "+3", "+1,8", "−0,4" (a real minus), "±0". */
export function signed(v: number, format = whole) {
  const text = format.format(Math.abs(v));
  return `${text === format.format(0) ? "±" : v < 0 ? "−" : "+"}${text}`;
}
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
const display = (m: Metric, v: number) =>
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

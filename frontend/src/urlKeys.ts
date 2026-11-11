/** The URL keys: the shared filters and the rankings' own keys, read, written and updated. Pure functions, no React. */
import { firstDay, lastDay, MAX_LINE_ID, METRICS, monthOf, type Metric } from "./metrics";

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
  /**
   * One day; the Live-Lage page and the line page's Bildfahrplan use it, each leaving it out for
   * its newest day, and the line page also for a day outside its trip window.
   */
  tag?: string;
  /** A federal state's code ("nw"); only the Live-Lage page uses it, and every other page drops it. */
  land?: string;
  /** A line id; only the time series page uses it, and it wins over `bhf` there. Lines are monthly. */
  linie?: string;
  /** The time series' resolution: only "monat" is written, the day view is the default. */
  z?: "monat";
  /** The line page's direction of travel: only "2" is written, direction 1 is the default. */
  richtung?: "2";
  /** The line page's selected section, the two EVAs in the shown direction: "08000080-08000149". */
  abschnitt?: string;
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
  const richtung = p.get("richtung");
  const abschnitt = p.get("abschnitt");
  return {
    g: g === "regional" || g === "fern" ? g : undefined,
    bhf: bhf && /^\d+$/.test(bhf) ? bhf : undefined,
    von: validPeriod(von) ? von : undefined,
    bis: validPeriod(bis) ? bis : undefined,
    tag: validDay(tag) ? tag : undefined,
    land: land && /^[a-z]{2}$/.test(land) ? land : undefined,
    linie: linie && linie.length <= MAX_LINE_ID ? linie : undefined,
    z: z === "monat" ? z : undefined,
    richtung: richtung === "2" ? richtung : undefined,
    abschnitt: abschnitt && /^\d+-\d+$/.test(abschnitt) ? abschnitt : undefined,
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
  richtung,
  abschnitt,
  k,
}: Filters): URLSearchParams {
  // The order is fixed, so a link built here equals the URL the page would write itself.
  const keys = {
    g,
    bhf,
    von,
    bis,
    tag,
    land,
    linie,
    z,
    richtung,
    abschnitt,
    k: k === "puenktlich" ? undefined : k,
  };
  return new URLSearchParams(Object.entries(keys).filter((e): e is [string, string] => !!e[1]));
}

/**
 * The rankings page's own URL keys: what it lists, the minimum sample, for lines lines or single
 * trains, and for the records stops or trains.
 */
// shortcut: four minimum-sample values only, though the API accepts any value from 15; a number field when users want other limits
export const MIN_NS = [100, 500, 1000, 5000] as const;
export const RANK_TYPES = ["linien", "bahnhoefe", "abschnitte", "rekorde"] as const;
export type Rank = {
  typ: (typeof RANK_TYPES)[number];
  min: number;
  art: "linien" | "zuege";
  rekord: "halte" | "takt";
};

/**
 * Reads `typ`, `min`, `art` and `rekord`; unknown values fall back to the default (stations, 500,
 * lines, stops).
 */
export function readRank(p: URLSearchParams): Rank {
  return {
    typ: RANK_TYPES.find((v) => v === p.get("typ")) ?? "bahnhoefe",
    min: MIN_NS.find((n) => String(n) === p.get("min")) ?? 500,
    art: p.get("art") === "zuege" ? "zuege" : "linien",
    rekord: p.get("rekord") === "takt" ? "takt" : "halte",
  };
}

/** The filter keys, then the rankings keys, each without its default; `art` only for lines, `rekord` only for records. */
export function writeRank(
  f: Filters,
  { typ, min, art, rekord }: Omit<Rank, "rekord"> & { rekord?: Rank["rekord"] },
): URLSearchParams {
  const p = writeFilters(f);
  if (typ !== "bahnhoefe") p.set("typ", typ);
  if (min !== 500) p.set("min", String(min));
  if (typ === "linien" && art === "zuege") p.set("art", art);
  if (typ === "rekorde" && rekord === "takt") p.set("rekord", rekord);
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
 * The search string of a line's page: the metric and the period, and with `at` the direction and
 * section to open on. A line has one train type, so no category.
 */
export const linePageSearch = (
  f: Pick<Filters, "k" | "von" | "bis">,
  at?: Pick<Filters, "richtung" | "abschnitt">,
) => writeFilters({ k: f.k, von: f.von, bis: f.bis, ...at }).toString();

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

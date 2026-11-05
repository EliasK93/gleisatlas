/** The sections of a line along its axis: the strip's rows, the map's segments, the colour steps. Pure functions, no React. */
import { LOCALE, t } from "./i18n";
import { int, NBSP } from "./metrics";
import type { components } from "./schema";

type Abschnitt = components["schemas"]["Abschnitt"];
type Bahnhof = components["schemas"]["LinienBahnhof"];

/**
 * Upper limits in minutes of steps 1 to 4 of the section colours (the `r1`–`r5` tokens): steps 1
 * and 2 end below their limit, steps 3 and 4 at it. Step 5 is everything above. This is the one
 * place that holds them.
 */
export const STEPS = [-0.5, -0.15, 0.15, 1.0] as const;
/** Sections with fewer trips are drawn pale, like the map's dots with little data. */
export const THIN_N = 50;
export type Step = 1 | 2 | 3 | 4 | 5;

export function stepOf(minutes: number): Step {
  const i = STEPS.findIndex((limit, j) => (j < 2 ? minutes < limit : minutes <= limit));
  return (i < 0 ? 5 : i + 1) as Step;
}

const oneDecimal = new Intl.NumberFormat(LOCALE, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const limitFormat = new Intl.NumberFormat(LOCALE, { maximumFractionDigits: 2 });

/** The number of `format` with its sign: "+1,8", "−0,4" (a real minus), "±0,0". */
function signed(v: number, format: Intl.NumberFormat) {
  const text = format.format(Math.abs(v));
  return `${text === format.format(0) ? "±" : v < 0 ? "−" : "+"}${text}`;
}
/** Minutes of a section with sign and unit: "+1,8 min". */
export const minutesText = (v: number) => `${signed(v, oneDecimal)}${NBSP}${t("unit.min")}`;
/** A step limit with its sign and no unit: "−0,15". */
export const limitText = (v: number) => signed(v, limitFormat);

/** One section as the strip and the map's tooltip say it: "A → B: +1,8 min · 12.345 Fahrten". */
const tipText = (names: string, section?: Abschnitt) =>
  `${names}: ${section ? minutesText(section.minuten) : "–"} · ${
    section ? t("line.trips", { n: int(section.n) }) : t("line.strip.none")
  }`;

export type Row = { from: Bahnhof; to: Bahnhof; name: string; section?: Abschnitt };
export type MapSegment = {
  coords: [[number, number], [number, number]];
  /** The colour step, or none for a section without trips. */
  step: Step | null;
  alpha: number;
  dashed: boolean;
  tip: string;
};

/** The stations along `achse`: one that the axis visits twice stands twice; an EVA without a station is skipped. */
export const axisStations = (achse: string[], stations: Bahnhof[]) => {
  const byEva = new Map(stations.map((s) => [s.eva, s]));
  return achse.flatMap((eva) => byEva.get(eva) ?? []);
};

/**
 * The line cut for one direction: `axis` (`axisStations`), `rows` (one per pair of
 * consecutive axis stations, in travel order, with the section if it had values), `sum` of their
 * minutes, `has` (some row has a section), `others` (every section that is not between consecutive
 * axis stations: branches and sections that skip stops, each with its own direction) and the map's
 * `segments`.
 */
export function cutLine(
  achse: string[],
  stations: Bahnhof[],
  sections: Abschnitt[],
  direction: 1 | 2,
) {
  const byEva = new Map(stations.map((s) => [s.eva, s]));
  const axis = axisStations(achse, stations);
  const byKey = new Map(sections.map((s) => [`${s.von_eva}>${s.nach_eva}`, s]));
  const pairs = axis.slice(1).map((to, i) => [axis[i], to] as const);
  const travel = direction === 1 ? pairs : pairs.map(([a, b]) => [b, a] as const).reverse();
  const rows: Row[] = travel.map(([from, to]) => ({
    from,
    to,
    name: `${from.name} → ${to.name}`,
    section: byKey.get(`${from.eva}>${to.eva}`),
  }));
  const sum = rows.reduce((total, r) => total + (r.section?.minuten ?? 0), 0);
  const onAxis = new Set(pairs.flatMap(([a, b]) => [`${a.eva}>${b.eva}`, `${b.eva}>${a.eva}`]));
  const others = sections
    .filter((s) => !onAxis.has(`${s.von_eva}>${s.nach_eva}`))
    .map((section) => ({
      section,
      name: `${byEva.get(section.von_eva)?.name ?? section.von_eva} → ${byEva.get(section.nach_eva)?.name ?? section.nach_eva}`,
    }));
  const has = rows.some((r) => r.section);
  return { axis, rows, sum, has, others, segments: segmentsOf(rows, others, byEva) };
}

const at = (s?: Bahnhof): [number, number] | null =>
  s && s.lon !== null && s.lat !== null ? [s.lon, s.lat] : null;

/**
 * What the map draws. The chosen direction's axis sections are solid. Every other section is
 * dashed, one per pair of stations, with the mean of both directions weighted by trips; a
 * section to a station without coordinates is left out.
 */
function segmentsOf(
  rows: Row[],
  others: { section: Abschnitt; name: string }[],
  named: Map<string, Bahnhof>,
): MapSegment[] {
  const out: MapSegment[] = [];
  for (const r of rows) {
    const [a, b] = [at(r.from), at(r.to)];
    if (!a || !b) continue;
    const s = r.section;
    out.push({
      coords: [a, b],
      step: s ? stepOf(s.minuten) : null,
      alpha: !s ? 0.3 : s.n < THIN_N ? 0.5 : 1,
      dashed: false,
      tip: tipText(r.name, s),
    });
  }
  // ponytail: a branch has no "Richtung", so both directions are averaged; revisit if branch directions matter
  const pairs = new Map<string, { sections: Abschnitt[]; first: Abschnitt }>();
  for (const { section } of others) {
    const key = [section.von_eva, section.nach_eva].sort().join(">");
    const pair = pairs.get(key) ?? { sections: [], first: section };
    pair.sections.push(section);
    pairs.set(key, pair);
  }
  for (const { sections, first } of pairs.values()) {
    const [from, to] = [named.get(first.von_eva), named.get(first.nach_eva)];
    const [a, b] = [at(from), at(to)];
    if (!a || !b) continue;
    const n = sections.reduce((total, s) => total + s.n, 0);
    const minutes = sections.reduce((total, s) => total + s.minuten * s.n, 0) / n;
    const both = sections.length > 1;
    out.push({
      coords: [a, b],
      step: stepOf(minutes),
      alpha: n < THIN_N ? 0.5 : 1,
      dashed: true,
      tip: tipText(`${from!.name} ${both ? "↔" : "→"} ${to!.name}`, {
        ...first,
        minuten: minutes,
        n,
      }),
    });
  }
  return out;
}

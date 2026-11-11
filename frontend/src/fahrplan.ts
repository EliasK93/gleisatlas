/** The Bildfahrplan of a line: the axis by distance, a trip's place on it, its paths and texts. Pure functions, no React. */
import { t } from "./i18n";
import { classOf, int, NBSP, signed, type Class } from "./metrics";
import type { components } from "./schema";

type Bahnhof = components["schemas"]["LinienBahnhof"];
type Halt = components["schemas"]["Halt"];

const EARTH_KM = 6371;
const RAD = Math.PI / 180;
const located = (s: Bahnhof) => s.lat !== null && s.lon !== null;

/** Straight-line distance in km between two stations with coordinates. */
function haversine(a: Bahnhof, b: Bahnhof) {
  const h =
    Math.sin(((b.lat! - a.lat!) * RAD) / 2) ** 2 +
    Math.cos(a.lat! * RAD) * Math.cos(b.lat! * RAD) * Math.sin(((b.lon! - a.lon!) * RAD) / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * The place of each axis station in km from the first one, summing the straight-line distances
 * along the axis. With fewer than two located stations the axis is spaced evenly.
 */
export function distances(axis: Bahnhof[]): number[] {
  const known = axis.flatMap((s, i) => (located(s) ? [i] : []));
  if (known.length < 2) return axis.map((_, i) => i);
  const km: number[] = [];
  known.forEach((i, k) => {
    const prev = known[k - 1];
    km[i] = k === 0 ? 0 : km[prev] + haversine(axis[prev], axis[i]);
  });
  // shortcut: a station without coordinates sits evenly between its located neighbours (halfway
  // for one), an end without them on its neighbour; revisit if many axis stations lack coordinates
  return axis.map((_, i) => {
    if (km[i] !== undefined) return km[i];
    const before = known.findLast((j) => j < i);
    const after = known.find((j) => j > i);
    if (before === undefined) return km[after!];
    if (after === undefined) return km[before];
    return km[before] + ((km[after] - km[before]) * (i - before)) / (after - before);
  });
}

/** A stop of a trip on the axis: `i` is its place in `achse`. */
type Placed = { i: number; halt: Halt };

/**
 * The stops of a trip on the axis `evas`, in trip order. A stop off the axis is skipped. A station
 * the axis visits more than once (a ring, a reversal) takes the visit nearest the previous placed
 * stop; the first stop takes the one nearest the next stop on the axis.
 */
export function place(evas: string[], halte: Halt[]): Placed[] {
  const visits = (eva: string) => evas.flatMap((e, i) => (e === eva ? [i] : []));
  const out: Placed[] = [];
  halte.forEach((halt, k) => {
    const at = visits(halt.eva);
    if (at.length === 0) return;
    const near =
      out.at(-1)?.i ??
      halte
        .slice(k + 1)
        .map((h) => visits(h.eva)[0])
        .find((i) => i !== undefined) ??
      at[0];
    const i = at.reduce((best, j) => (Math.abs(j - near) < Math.abs(best - near) ? j : best));
    out.push({ i, halt });
  });
  return out;
}

/**
 * The placed stops in pieces that are drawn as one path each. On a ring axis (it ends where it
 * starts) a trip that does not start at the seam jumps from one end of the axis to the other there;
 * the path is cut between two consecutive stops more than half the axis apart, as no real section
 * spans half a ring.
 * shortcut: the seam is cut, not crossed; place the seam station at both of its visits if a ring
 * trip should run on through it.
 */
export function pieces(evas: string[], placed: Placed[]): Placed[][] {
  const ring = evas.length > 1 && evas[0] === evas.at(-1);
  const out: Placed[][] = [];
  placed.forEach((p, k) => {
    if (k === 0 || (ring && Math.abs(p.i - placed[k - 1].i) > evas.length / 2)) out.push([]);
    out.at(-1)!.push(p);
  });
  return out;
}

/** The colour step of a delay in minutes: the steps of the typical delay ("Typische Verspätung"). */
const delayStep = (minutes: number): Class => classOf("median", minutes);

/** The planned path through the arrival and departure of each placed stop, as [minute, axis place]. */
export const planPoints = (placed: Placed[]) =>
  placed.flatMap(({ i, halt }) =>
    [halt.an_plan, halt.ab_plan].flatMap((m) => (m === null ? [] : [[m, i] as const])),
  );

type Segment = {
  from: readonly [number, number];
  to: readonly [number, number];
  step: Class;
};

/**
 * The actual path as segments between consecutive actual events ([minute, axis place]), each in
 * the step of the delay at its end. A cancelled event breaks the path; a missing one is skipped.
 */
export function actualSegments(placed: Placed[]): Segment[] {
  const points = placed.flatMap(({ i, halt: h }) =>
    (
      [
        [h.an_plan, h.an_ist, h.ausfall_an],
        [h.ab_plan, h.ab_ist, h.ausfall_ab],
      ] as const
    ).flatMap(([plan, ist, gone]) =>
      gone
        ? [null]
        : plan === null || ist === null
          ? []
          : [{ at: [ist, i] as const, delay: ist - plan }],
    ),
  );
  return points.flatMap((p, k) => {
    const prev = points[k - 1];
    return p && prev ? [{ from: prev.at, to: p.at, step: delayStep(p.delay) }] : [];
  });
}

/** True when an event of the stop is cancelled. */
export const cancelled = (h: Halt) => h.ausfall_an || h.ausfall_ab;

/** The event a stop's delay is read from: its arrival, else its departure (the pipeline's rule). */
const main = (h: Halt) =>
  h.an_plan !== null ? { plan: h.an_plan, ist: h.an_ist } : { plan: h.ab_plan, ist: h.ab_ist };

/** Minutes since midnight as a clock time; past midnight it starts again: 1470 → "00:30". */
export const clock = (m: number) =>
  `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** Whole minutes with a sign: "+3 min", "−1 min", "±0 min". */
const delayText = (d: number) => `${signed(d)}${NBSP}${t("unit.min")}`;

/** A stop's delay as text: "+3 min", "fällt aus", or "–" without times. */
export function delayOf(h: Halt) {
  if (cancelled(h)) return t("line.bf.cancelled");
  const { plan, ist } = main(h);
  return plan === null || ist === null ? "–" : delayText(ist - plan);
}

/** The planned time of a stop's main event, or "–". */
const planTime = (h: Halt) => {
  const { plan } = main(h);
  return plan === null ? "–" : clock(plan);
};

/** A trip's tooltip: "RE 10101: Dortmund Hbf 06:00 ±0 min · Hamm (Westf) Hbf 06:20 +1 min". */
export const tripTip = (zug: string, placed: Placed[], axis: Bahnhof[]) =>
  `${zug}: ${placed.map(({ i, halt }) => `${axis[i].name} ${planTime(halt)} ${delayOf(halt)}`).join(" · ")}`;

/** "1 Fahrt", "3 Fahrten". */
export const tripsText = (n: number) =>
  n === 1 ? t("line.trips.one") : t("line.trips", { n: int(n) });

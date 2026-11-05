import type { Page } from "@playwright/test";
import type { components } from "../src/schema";

type Heatmap = components["schemas"]["Heatmap"];
type Cell = components["schemas"]["Cell"];
type Station = components["schemas"]["Station"];
type Datenstand = components["schemas"]["Datenstand"];
type Karte = components["schemas"]["Karte"];
type Statistik = components["schemas"]["Statistik"];
type Rangliste = components["schemas"]["Rangliste"];
type StationLinie = components["schemas"]["StationLinie"];
type Zeitverlauf = components["schemas"]["Zeitverlauf"];
type Monat = components["schemas"]["Monat"];
type Tagesverlauf = components["schemas"]["Tagesverlauf"];
type Tag = components["schemas"]["Tag"];
type Tageskarte = components["schemas"]["Tageskarte"];
type Normal = components["schemas"]["Normal"];
type Klasse = components["schemas"]["Klasse"];
type Linie = components["schemas"]["Linie"];
type Abschnitt = components["schemas"]["Abschnitt"];
type Fahrplan = components["schemas"]["Fahrplan"];
type Halt = components["schemas"]["Halt"];
type Suche = components["schemas"]["Suche"];
type SuchLinie = components["schemas"]["SuchLinie"];

/** The dummies of frontend/.env.development, which only the dev server reads; the e2e build has none. */
export const IMPRESSUM = {
  name: "Erika Musterfrau",
  street: "Musterstraße 1",
  city: "12345 Musterstadt",
  email: "impressum@example.org",
};

// Routed by path, so a set VITE_API_URL can never send a test to a real server.
const API_PATH =
  /^\/(heatmap|datenstand|stationen|suche|karte|tageskarte|rankings|zeitverlauf|tagesverlauf|linie)(?:\/([^/]+)(\/statistik|\/linien)?)?$/;
const CORS = { "access-control-allow-origin": "*" };

/** Stand in for the OpenFreeMap styles (light and dark), so map tests never touch the network.
 * The empty source carries the real attribution, which MapLibre shows only for a source in use. */
const baseStyle = (background: string) => ({
  version: 8,
  sources: {
    openmaptiles: {
      type: "geojson",
      data: { type: "FeatureCollection", features: [] },
      attribution:
        '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
    },
  },
  layers: [
    { id: "background", type: "background", paint: { "background-color": background } },
    { id: "base", type: "fill", source: "openmaptiles" },
  ],
});
const BASE_STYLE = baseStyle("#eef0f3");
const DARK_STYLE = baseStyle("#1f242c");

export const STATIONS: Station[] = [
  { eva: "8000207", name: "Köln Hbf", land: "Nordrhein-Westfalen", n: 90000 },
  { eva: "8000105", name: "Frankfurt (Main) Hbf", land: "Hessen", n: 80000 },
  // Known station without map data (no coordinates); its EVA has a leading zero, as in the data.
  { eva: "08002549", name: "Hamburg Hbf", land: "Hamburg", n: 70000 },
  // Two stations with the same name, one with no federal state and very little data.
  { eva: "8000300", name: "Neustadt", land: "Bayern", n: 5000 },
  { eva: "8000301", name: "Neustadt", land: "Hessen", n: 4000 },
  { eva: "8000999", name: "Kleinstadt", land: null, n: 9 },
];

/** Four stations: a typical one, a good one, one with little data and a bad one. */
export function karteFixture(): Karte {
  const at = (lat: number, lon: number) => ({ lat, lon });
  return {
    von: "2026-09-01",
    bis: "2026-09-30",
    n: 70000,
    ohne_koordinaten: 10,
    stationen: [
      {
        eva: "8000207",
        name: "Köln Hbf",
        ...at(50.943, 6.959),
        n: 33744,
        ausfallquote: 0.0428,
        median: 3,
        p90: 21,
        puenktlich: 0.6689,
      },
      {
        eva: "8000105",
        name: "Frankfurt (Main) Hbf",
        ...at(50.107, 8.663),
        n: 30000,
        ausfallquote: 0.005,
        median: 0.4,
        p90: 4,
        puenktlich: 0.93,
      },
      {
        eva: "8000999",
        name: "Kleinstadt",
        ...at(52.0, 10.0),
        n: 9,
        ausfallquote: 0,
        median: 1,
        p90: 3,
        puenktlich: 0.89,
      },
      {
        eva: "8000555",
        name: "Problemhausen",
        ...at(53.0, 12.0),
        n: 6247,
        ausfallquote: 0.08,
        median: 9,
        p90: 34,
        puenktlich: 0.41,
      },
    ],
  };
}

export const EMPTY_KARTE: Karte = { von: "", bis: "", n: 0, ohne_koordinaten: 0, stationen: [] };

/**
 * What /stationen/{eva}/statistik returns: 33,744 stops, 1,444 of them cancelled, the rest in
 * seven delay bins. "fern" and "regional" narrow it to that group. A station with fewer than
 * 15 stops gets a tiny sample.
 */
export function statistikFixture(station: Station, gattung: string): Statistik {
  const stats = (
    n: number,
    ausfallquote: number,
    median: number,
    p90: number,
    puenktlich: number,
  ) => ({
    n,
    ausfallquote,
    median,
    p90,
    puenktlich,
  });
  const regionalStats = stats(30000, 0.04, 3, 20, 0.7);
  const fernStats = stats(3744, 0.06, 5, 30, 0.4);
  const regional = { gruppe: "regional", ...regionalStats };
  const fern = { gruppe: "fern", ...fernStats };
  const base = { station, von: "2026-09", bis: "2026-09" };
  if (station.n < 15)
    return {
      ...base,
      n: 9,
      gesamt: stats(9, 0, 1, 3, 0.89),
      verteilung: [5, 2, 1, 0, 1, 0, 0],
      ausgefallen: 0,
      gruppen: [{ ...regional, n: 9 }],
    };
  const one = { fern, regional }[gattung as "fern" | "regional"];
  if (one) {
    const gesamt = gattung === "fern" ? fernStats : regionalStats;
    const ausgefallen = Math.round(gesamt.n * gesamt.ausfallquote);
    return {
      ...base,
      n: gesamt.n,
      gesamt,
      verteilung: [gesamt.n - ausgefallen - 100, 50, 30, 10, 5, 3, 2],
      ausgefallen,
      gruppen: [one],
    };
  }
  return {
    ...base,
    n: 33744,
    gesamt: stats(33744, 0.0428, 3, 21, 0.6689),
    verteilung: [15000, 7000, 4500, 3000, 1800, 700, 300],
    ausgefallen: 1444,
    gruppen: [regional, fern],
  };
}

export const emptyStatistik = (station: Station): Statistik => ({
  station,
  von: "",
  bis: "",
  n: 0,
  gesamt: null,
  verteilung: [],
  ausgefallen: 0,
  gruppen: [],
});

const DATENSTAND: Datenstand = {
  monate: [
    "2025-10",
    "2025-11",
    "2025-12",
    "2026-01",
    "2026-02",
    "2026-03",
    "2026-04",
    "2026-05",
    "2026-06",
    "2026-07",
    "2026-08",
    "2026-09",
  ],
  bahnhoefe: 5219,
  vollabdeckung_ab: "2025-11",
  fehlende_stunden: { "2025-06": 12 },
  fahrplanwechsel: ["2024-12-15", "2025-12-14"],
  erster_tag: "2024-07-01",
  letzter_tag: "2026-09-30",
  fehlende_stunden_tage: { "2026-03-14": 6 },
  heute: null,
  heute_stand: null,
  heute_stand_rest: null,
  live_tage: [],
};

/** The collector's "today": a day after the last complete one, with 2026-10-01 between them. */
export const TODAY = "2026-10-02";
/** The collector's run at 14:37 in Berlin (summer time), and piebro's newest snapshot at 09:37. */
const LIVE_STAND = "2026-10-02T12:37:00+00:00";
const REST_STAND = "2026-10-02T07:37:00+00:00";

/** Where today's data comes from: the collector (large stations), piebro's raw day, or both. */
export type Sources = "live" | "rest" | "both";

/** /datenstand with a "today" from `sources`: live data up to 14:00, rest data up to 09:00. */
export const datenstandHeute = (sources: Sources = "live"): Datenstand => ({
  ...DATENSTAND,
  heute: TODAY,
  heute_stand: sources === "rest" ? null : LIVE_STAND,
  heute_stand_rest: sources === "live" ? null : REST_STAND,
});

const base = { n: 1240, ausfallquote: 0.02, median: 2, p90: 8, puenktlich: 0.75 };

/** 7 × 24 cells; Monday (row 0) holds the boundary cases, Sunday 3–4 Uhr is missing entirely. */
export function heatmapFixture(): Heatmap {
  const special: Record<number, Partial<Cell>> = {
    0: { puenktlich: 0.9 }, // class 1
    1: { puenktlich: 0.89 }, // class 2
    2: { puenktlich: 0.59 }, // class 5
    3: { n: 9 }, // too little data
    4: { median: 1 }, // median class 2
    5: { n: 30 }, // approximate: "~"
    6: { puenktlich: 0.894 }, // shows 89 %: class 2
    7: { puenktlich: 0.895 }, // shows 90 %: class 1, the class follows the shown value
    8: { n: 40, ausfallquote: 1, median: null, p90: null, puenktlich: null }, // only cancellations
    9: { puenktlich: 0.6 }, // class 4
    10: { n: 20, ausfallquote: 0.5 }, // 10 arrivals: too little data for delays
    11: { n: 60, ausfallquote: 0.5 }, // 30 arrivals: "~" for delays, not for cancellations
  };
  const cells: Cell[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    for (let hour = 0; hour < 24; hour++) {
      if (weekday === 6 && hour === 3) continue;
      cells.push({ ...base, weekday, hour, ...(weekday === 0 ? special[hour] : {}) });
    }
  }
  const tage = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    ...base,
    n: 29000,
    weekday,
    puenktlich: weekday === 0 ? 0.81 : 0.75,
  }));
  return { von: "2026-09", bis: "2026-09", n: 203000, cells, tage };
}

export const EMPTY_HEATMAP: Heatmap = { von: "", bis: "", n: 0, cells: [], tage: [] };

/**
 * Waits until Inter has replaced the fallback font. Text is laid out in the fallback first and
 * moves when Inter swaps in, so a test that measures text in more than one step waits for it. On
 * a scrolled page the swap also scrolls (scroll anchoring), which clears an open tooltip.
 */
export const fontsReady = (page: Page) =>
  page.evaluate(async () => {
    await document.fonts.ready;
  });

/** The query string of a request as a plain object. */
export function queryOf(url?: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url?.searchParams.forEach((value, key) => (query[key] = value));
  return query;
}

/** Ten stations or lines per column; the worst has 50 % punctuality, the best 99 %. */
export function rankingFixture(typ: string, metrik: string, minN: number): Rangliste {
  const stations = ["Problemhausen", "Spätdorf", "Wartenau", "Verzugen", "Knotenhausen"];
  const lines = [
    "RE 1",
    "RB 48",
    "S 6",
    "RE 7",
    "ICE 599",
    "S 1",
    "RB 23",
    "IC 2005",
    "RE 9",
    "S 3",
  ];
  const entry = (i: number, worst: boolean) => {
    const name =
      typ === "linien"
        ? lines[i]
        : `${stations[i % stations.length]} ${worst ? "Nord" : "Süd"} ${i}`;
    return {
      id: typ === "linien" ? `${name}:8000207` : `80005${worst ? 5 : 6}${i}`,
      name,
      typ: typ === "linien" ? name.split(" ")[0] : null,
      n: 20000 - i * 1000,
      ausfallquote: worst ? 0.08 - i * 0.002 : 0.004,
      median: worst ? 9 - i * 0.4 : 0.4,
      p90: worst ? 34 - i : 4,
      puenktlich: worst ? 0.5 + i * 0.02 : 0.99 - i * 0.01,
    };
  };
  const ten = (worst: boolean) => Array.from({ length: 10 }, (_, i) => entry(i, worst));
  return {
    typ: typ as Rangliste["typ"],
    metrik: metrik as Rangliste["metrik"],
    min_n: minN,
    von: "2025-11",
    bis: "2026-09",
    anzahl: 2445,
    schlechteste: ten(true),
    beste: ten(false),
  };
}

export const emptyRangliste = (typ: string, metrik: string, minN: number): Rangliste => ({
  ...rankingFixture(typ, metrik, minN),
  von: "",
  bis: "",
  anzahl: 0,
  schlechteste: [],
  beste: [],
});

/**
 * Twelve lines at a station in the API's order: ten with a value, worst first; RE 11, whose stops
 * were all cancelled; RE 12, with only 9 stops.
 */
export function linienFixture(): StationLinie[] {
  return Array.from({ length: 12 }, (_, i) => {
    const line = {
      linie: `RE ${i + 1}:8000207`,
      name: `RE ${i + 1} · Köln Hbf`,
      typ: "RE",
    };
    if (i === 10)
      return { ...line, n: 700, ausfallquote: 1, median: null, p90: null, puenktlich: null };
    return {
      ...line,
      n: i === 11 ? 9 : 1500 - i * 100,
      ausfallquote: 0.02 + i * 0.001,
      median: 2,
      p90: 8,
      puenktlich: 0.5 + i * 0.03,
    };
  });
}

/**
 * 27 months from 2024-07 to 2026-09. 2024-10 has no stops, 2025-02 only 9, and 2025-06 is the
 * month /datenstand reports 12 missing hours for. 2026-03 reads 78 % of 1,240 stops.
 */
export function zeitverlaufFixture(eva: string | null, linie: string | null): Zeitverlauf {
  const monate: Monat[] = Array.from({ length: 27 }, (_, i) => {
    const monat = `${2024 + Math.floor((i + 6) / 12)}-${String(((i + 6) % 12) + 1).padStart(2, "0")}`;
    const month: Monat = {
      monat,
      n: 20000 + i * 100,
      ausfallquote: 0.02 + (i % 4) * 0.005,
      median: 2 + (i % 3) * 0.5,
      p90: 8 + (i % 4),
      puenktlich: 0.7 + (i % 5) * 0.02,
    };
    if (monat === "2024-10")
      return { monat, n: 0, ausfallquote: null, median: null, p90: null, puenktlich: null };
    if (monat === "2025-02") return { ...month, n: 9 };
    if (monat === "2026-03") return { ...month, n: 1240, puenktlich: 0.78 };
    return month;
  });
  const titel = linie
    ? `${linie.split(":")[0]} · Köln Hbf`
    : (STATIONS.find((s) => s.eva === eva)?.name ?? null);
  return { titel, monate };
}

/**
 * 822 days from 2024-07-01 to 2026-09-30 with a slow wave as the trend (none in the first and last
 * 13 days, like the API). 2025-01-10 has no stops, 2026-03-10 (a Tuesday) reads 78 % of 1,240 stops
 * against a trend of 80 %, 2026-03-14 has 6 missing hours and 2026-03-20 only 9 stops.
 */
export function tagesverlaufFixture(eva: string | null): Tagesverlauf {
  const first = Date.UTC(2024, 6, 1);
  const tage: Tag[] = Array.from({ length: 822 }, (_, i) => {
    const tag = new Date(first + i * 86400000).toISOString().slice(0, 10);
    const edge = i < 13 || i > 822 - 14;
    const wave = Math.sin(i / 60);
    const day: Tag = {
      tag,
      n: 1000 + (i % 7) * 10,
      ausfallquote: 0.02 + (i % 4) * 0.005,
      median: 2 + (i % 3) * 0.5,
      p90: 8 + (i % 4),
      puenktlich: 0.7 + (i % 5) * 0.02,
      fehlende_stunden: 0,
      trend: edge
        ? { puenktlich: null, ausfallquote: null, median: null, p90: null }
        : {
            puenktlich: 0.72 + 0.06 * wave,
            ausfallquote: 0.03 + 0.01 * wave,
            median: 2.5 + wave,
            p90: 9.5 + 2 * wave,
          },
    };
    if (tag === "2025-01-10")
      return { ...day, n: 0, ausfallquote: null, median: null, p90: null, puenktlich: null };
    if (tag === "2026-03-10")
      return {
        ...day,
        n: 1240,
        puenktlich: 0.78,
        trend: { ...day.trend, puenktlich: 0.8 },
      };
    if (tag === "2026-03-14") return { ...day, fehlende_stunden: 6 };
    if (tag === "2026-03-20") return { ...day, n: 9 };
    return day;
  });
  return { titel: STATIONS.find((s) => s.eva === eva)?.name ?? null, tage };
}

const NO_NORMAL: Normal = { puenktlich: null, ausfallquote: null, median: null, p90: null };
const USUAL: Normal = { puenktlich: 0.8, ausfallquote: 0.03, median: 3, p90: 12 };
const NO_CLASS: Klasse = { puenktlich: null, ausfallquote: null, median: null, p90: null };

/**
 * The day map of `tag`, against the usual 80 % punctuality, 3 % cancellations, 3 min median and
 * 12 min P90. Six stations with the classes the API would give (1 much better … 5 much worse):
 * Köln in the worse classes, Frankfurt in the better ones, Problemhausen worse again, Üblingen as
 * usual, Ohnevergleich without a normal and Kleinstadt with 9 stops, both without a class.
 * Germany reads 78.9 % against 83.3 %, Fern 44.6 % against 43.0 % and Regional 76.9 % against
 * 79.0 %. Special days: 2026-03-14 has 6 missing hours and so no class for Germany and the
 * states, 2026-03-01 has no stops at all and 2026-04-04 too few reference days for any normal or
 * class.
 */
export function tageskarteFixture(tag: string): Tageskarte {
  const gap = { "2026-03-14": 6, "2026-03-01": 24 }[tag] ?? 0;
  const week = 7 * 86400000;
  const refs = Array.from({ length: 12 }, (_, i) =>
    new Date(Date.parse(`${tag}T00:00:00Z`) - (i + 1) * week).toISOString().slice(0, 10),
  );
  if (tag === "2026-03-01")
    return {
      tag,
      referenztage: [],
      fehlende_stunden: gap,
      deutschland: null,
      deutschland_fern: null,
      deutschland_regional: null,
      n: 0,
      laender: [],
      ohne_koordinaten: 0,
      stationen: [],
    };
  const normal = tag === "2026-04-04" ? NO_NORMAL : USUAL;
  const station = (
    eva: string,
    name: string,
    land: string,
    lat: number,
    lon: number,
    n: number,
    puenktlich: number,
    ausfallquote: number,
    median: number,
    p90: number,
    // Punctuality, cancellations, median, P90; none for a station without a normal or a value.
    cls?: [number, number, number, number],
    own: Normal = normal,
  ) => ({
    eva,
    name,
    land,
    lat,
    lon,
    live: false,
    n,
    puenktlich,
    ausfallquote,
    median,
    p90,
    normal: own,
    klasse:
      cls && tag !== "2026-04-04"
        ? { puenktlich: cls[0], ausfallquote: cls[1], median: cls[2], p90: cls[3] }
        : NO_CLASS,
  });
  // Germany, one category of it or a state: no normal and no class on a day without enough
  // reference days, no class on a day with missing hours.
  const germany = (
    n: number,
    puenktlich: number,
    ausfallquote: number,
    median: number,
    p90: number,
    usual: [number, number, number, number],
    cls: [number, number, number, number],
  ) => ({
    n,
    puenktlich,
    ausfallquote,
    median,
    p90,
    normal:
      tag === "2026-04-04"
        ? NO_NORMAL
        : { puenktlich: usual[0], ausfallquote: usual[1], median: usual[2], p90: usual[3] },
    klasse:
      tag === "2026-04-04" || gap > 0
        ? NO_CLASS
        : { puenktlich: cls[0], ausfallquote: cls[1], median: cls[2], p90: cls[3] },
  });
  return {
    tag,
    referenztage: tag === "2026-04-04" ? refs.slice(0, 5) : refs,
    fehlende_stunden: gap,
    deutschland: germany(120000, 0.789, 0.059, 1, 11, [0.833, 0.042, 1, 9], [5, 5, 3, 5]),
    // Fern and Regional add up to the stops of Germany.
    deutschland_fern: germany(20000, 0.446, 0.08, 4, 20, [0.43, 0.07, 4, 18], [2, 3, 3, 2]),
    deutschland_regional: germany(100000, 0.769, 0.054, 1, 10, [0.79, 0.04, 1, 9], [4, 5, 3, 4]),
    n: 120000,
    // The states of the stations: Köln alone is Nordrhein-Westfalen (with Fern and Regional lines),
    // Üblingen and Kleinstadt are Niedersachsen, and Bayern has no class.
    laender: [
      {
        land: "nw",
        bahnhoefe: 1,
        alle: germany(3000, 0.5, 0.035, 4, 12, [0.8, 0.03, 3, 12], [5, 3, 4, 3]),
        fern: germany(500, 0.4, 0.05, 6, 20, [0.6, 0.04, 4, 15], [4, 4, 4, 4]),
        regional: germany(2500, 0.52, 0.032, 3, 11, [0.82, 0.03, 3, 11], [5, 3, 4, 3]),
      },
      {
        land: "he",
        bahnhoefe: 1,
        alle: germany(2500, 0.9, 0.01, 1, 4, [0.8, 0.03, 3, 12], [1, 2, 2, 1]),
        fern: null,
        regional: null,
      },
      {
        land: "ni",
        bahnhoefe: 2,
        alle: germany(1209, 0.81, 0.03, 3, 12, [0.8, 0.03, 3, 12], [3, 3, 3, 3]),
        fern: null,
        regional: null,
      },
      {
        land: "mv",
        bahnhoefe: 1,
        alle: germany(1500, 0.74, 0.08, 3, 20, [0.8, 0.03, 3, 12], [4, 5, 3, 5]),
        fern: null,
        regional: null,
      },
      {
        land: "by",
        bahnhoefe: 1,
        alle: {
          ...germany(900, 0.7, 0.03, 3, 12, [0.8, 0.03, 3, 12], [3, 3, 3, 3]),
          klasse: NO_CLASS,
        },
        fern: null,
        regional: null,
      },
    ],
    ohne_koordinaten: 2,
    stationen: [
      station("8000207", "Köln Hbf", "nw", 50.943, 6.959, 3000, 0.5, 0.035, 4, 12, [5, 3, 4, 3]),
      station(
        "8000105",
        "Frankfurt (Main) Hbf",
        "he",
        50.107,
        8.663,
        2500,
        0.9,
        0.01,
        1,
        4,
        [1, 2, 2, 1],
      ),
      station("8000555", "Problemhausen", "mv", 53.0, 12.0, 1500, 0.74, 0.08, 3, 20, [4, 5, 3, 5]),
      station("8000600", "Üblingen", "ni", 51.5, 9.5, 1200, 0.81, 0.03, 3, 12, [3, 3, 3, 3]),
      station(
        "8000700",
        "Ohnevergleich",
        "by",
        49.0,
        11.0,
        900,
        0.7,
        0.03,
        3,
        12,
        undefined,
        NO_NORMAL,
      ),
      station("8000999", "Kleinstadt", "ni", 52.0, 10.0, 9, 0.89, 0, 1, 3),
    ],
  };
}

/**
 * The day map of `TODAY` from `sources`, built on the 2026-09-15 stations. "live": the collector
 * covers Köln and Frankfurt (cut 14); the rest of the stations have no stops yet. "rest": piebro's
 * partial day covers all but Ohnevergleich and Kleinstadt (cut 9), and Germany counts those
 * stations. "both": Köln and Frankfurt live, Problemhausen and Üblingen from the rest.
 */
export function heuteKarte(sources: Sources): Tageskarte {
  const day = tageskarteFixture("2026-09-15");
  const live = sources === "rest" ? [] : ["8000207", "8000105"];
  const rest =
    sources === "live"
      ? []
      : sources === "rest"
        ? ["8000207", "8000105", "8000555", "8000600"]
        : ["8000555", "8000600"];
  const week = 7 * 86400000;
  return {
    ...day,
    tag: TODAY,
    referenztage: Array.from({ length: 12 }, (_, i) =>
      new Date(Date.parse(`${TODAY}T00:00:00Z`) - (i + 1) * week).toISOString().slice(0, 10),
    ),
    stand: live.length ? LIVE_STAND : null,
    bis_stunde: live.length ? 14 : null,
    stand_rest: rest.length ? REST_STAND : null,
    bis_stunde_rest: rest.length ? 9 : null,
    deutschland_live: live.length > 0,
    // The API lists a located station without stops with n = 0 and no values, normal or class.
    stationen: day.stationen.map((s) =>
      live.includes(s.eva) || rest.includes(s.eva)
        ? { ...s, live: live.includes(s.eva) }
        : {
            ...s,
            n: 0,
            ausfallquote: 0,
            median: null,
            p90: null,
            puenktlich: null,
            normal: NO_NORMAL,
            klasse: NO_CLASS,
          },
    ),
  };
}

export const LINE_ID = "RE57:08000080";
export const LINE_PATH = "/linie/RE57%3A08000080";

/**
 * A line with four stations on its axis (Dortmund to Warburg), one branch station with
 * coordinates (Werl) and one without (Haltepunkt). The values differ per station, so each
 * punctuality class and the thin and the empty cases occur: Dortmund 90 % (class 1), Hamm 72 %
 * (3), Soest only 10 stops (too few), Warburg 55 % (5), Werl 85 % (2).
 */
export function lineFixture(): Linie {
  const stop = (
    eva: string,
    name: string,
    pos: number | null,
    at: [number, number] | null,
    n: number,
    puenktlich: number,
    median: number,
  ) => ({
    eva,
    name,
    lat: at && at[0],
    lon: at && at[1],
    pos,
    n,
    ausfallquote: 0.02,
    median,
    p90: median * 4,
    puenktlich,
  });
  const bahnhoefe = [
    stop("08000080", "Dortmund Hbf", 0, [51.518, 7.459], 9000, 0.9, 1),
    stop("08000149", "Hamm (Westf) Hbf", 1, [51.678, 7.808], 8000, 0.72, 3),
    stop("08000367", "Soest", 2, [51.571, 8.108], 10, 0.8, 2),
    stop("08000718", "Warburg (Westf)", 3, [51.49, 9.14], 7000, 0.55, 9),
    stop("08000774", "Werl", null, [51.554, 7.911], 3000, 0.85, 2),
    stop("08000999", "Haltepunkt ohne Karte", null, null, 200, 0.95, 1),
  ];
  return {
    linie: LINE_ID,
    name: "RE57",
    label: "RE57 Dortmund Hbf – Warburg (Westf)",
    typ: "RE",
    zug: false,
    ohne_echtzeit: false,
    // The whole line pooled: 78 % on time, median 3 min, worst tenth 12 min, 2 % cancelled.
    gesamt: { n: 27210, ausfallquote: 0.02, median: 3, p90: 12, puenktlich: 0.78 },
    achse: bahnhoefe.filter((s) => s.pos !== null).map((s) => s.eva),
    bahnhoefe,
    // The days of the trip table: 2026-09-15 (a day of the other specs) lies before them.
    fahrplan_von: FAHRPLAN_VON,
    fahrplan_bis: FAHRPLAN_BIS,
  };
}

export const FAHRPLAN_VON = "2026-09-17";
export const FAHRPLAN_BIS = "2026-09-30";

/** A stop at minutes since midnight: planned arrival and departure, and the delay of each. */
const halt = (
  eva: string,
  an: number | null,
  ab: number | null,
  delay: [number, number] = [0, 0],
  cancelled = false,
): Halt => ({
  eva,
  an_plan: an,
  an_ist: an === null || cancelled ? null : an + delay[0],
  ab_plan: ab,
  ab_ist: ab === null || cancelled ? null : ab + delay[1],
  ausfall_an: cancelled && an !== null,
  ausfall_ab: cancelled && ab !== null,
});

/**
 * The line's trips of one day, in the order of their first departure. RE 10101 runs Dortmund to
 * Warburg from 06:00, losing time (+1, +1, +3, +3, +8 min at its event ends). RE 10102 runs back from
 * 07:00 on time, but its stop at Hamm is cancelled. RE 10150 runs on the branch: Hamm and Werl, one
 * stop on the axis. RE 10199 leaves Dortmund at 23:40 and reaches Soest at 00:30 the next night,
 * +2 and +5 min late.
 */
export function fahrplanFixture(_id: string, tag: string): Fahrplan {
  const [D, H, S, W, WERL] = ["08000080", "08000149", "08000367", "08000718", "08000774"];
  return {
    tag,
    fahrten: [
      {
        zug: "RE 10101",
        halte: [
          halt(D, null, 360),
          halt(H, 380, 381, [1, 1]),
          halt(S, 400, 401, [3, 3]),
          halt(W, 450, null, [8, 0]),
        ],
      },
      {
        zug: "RE 10102",
        halte: [
          halt(W, null, 420),
          halt(S, 460, 461),
          halt(H, 480, 481, [0, 0], true),
          halt(D, 500, null),
        ],
      },
      { zug: "RE 10150", halte: [halt(H, null, 600), halt(WERL, 615, null)] },
      {
        zug: "RE 10199",
        halte: [halt(D, null, 1420), halt(H, 1445, 1446, [2, 2]), halt(S, 1470, null, [5, 0])],
      },
    ],
  };
}

/**
 * The line's sections. Direction 1 (towards Warburg): -0.8 (class 1, 12,345 trips), +0.1 (3) and
 * +1.8 (5), summing to +1.1. Direction 2: +0.6 (4), -0.3 (2) and +0.4 with only 30 trips (thin),
 * summing to +0.7. Four others: two touching the branch station, one skipping Hamm, one to the
 * station without coordinates.
 */
export function abschnitteFixture(): Abschnitt[] {
  const s = (von_eva: string, nach_eva: string, minuten: number, n: number) => ({
    von_eva,
    nach_eva,
    minuten,
    n,
  });
  return [
    s("08000080", "08000149", -0.8, 12345),
    s("08000149", "08000367", 0.1, 8000),
    s("08000367", "08000718", 1.8, 6000),
    s("08000718", "08000367", 0.6, 5800),
    s("08000367", "08000149", -0.3, 7900),
    s("08000149", "08000080", 0.4, 30),
    s("08000149", "08000774", 0.3, 500),
    s("08000774", "08000367", 0.2, 300),
    s("08000080", "08000367", -0.1, 700),
    s("08000367", "08000999", 0.5, 100),
  ];
}

const hit = (linie: string, label: string, typ: string): SuchLinie => ({
  linie,
  label,
  typ,
  zug: false,
  richtung: null,
  ziel: null,
});
const RE57 = hit(LINE_ID, "RE57 Dortmund Hbf – Warburg (Westf)", "RE");
const S6 = hit("S6:08000082", "S6 Essen Hbf – Köln-Worringen", "S");
const S60 = hit("S60:08000096", "S60 Leonberg – Stuttgart Schwabstr.", "S");

/**
 * What /suche answers to each term the specs type (the search rules are proven by the API tests):
 * the lines and which group leads. The stations are the /stationen stand-in; any other term finds
 * no line.
 */
const SUCHE: Record<string, Pick<Suche, "linien" | "zuerst">> = {
  s: { linien: [S6, S60], zuerst: "bahnhoefe" },
  "S 6": { linien: [S6, S60], zuerst: "linien" },
  "s 60": { linien: [S60], zuerst: "linien" },
  re57: { linien: [RE57], zuerst: "linien" },
  "re57 dortmund": { linien: [{ ...RE57, richtung: 2, ziel: "Dortmund Hbf" }], zuerst: "linien" },
  "re57 warburg": { linien: [{ ...RE57, richtung: 1, ziel: "Warburg (Westf)" }], zuerst: "linien" },
};

export const sucheFixture = (q: string): Suche => ({
  bahnhoefe: STATIONS.filter((s) => s.name.toLowerCase().includes(q.toLowerCase())),
  ...(SUCHE[q] ?? { linien: [], zuerst: "bahnhoefe" }),
});

/** What a `zeitverlauf` or `tagesverlauf` callback returns for an unknown selection (a 404). */
export const NOT_FOUND = "not-found";

/** Serves the API and the base map style from fixtures. `heatmap`, `karte`, `statistik`,
 * `rankings`, `linien`, `zeitverlauf`, `tagesverlauf`, `tageskarte`, `linie`, `abschnitte` and
 * `fahrplan` return the body, or null for a server error; an unknown EVA is a 404, and so is
 * `NOT_FOUND` from `zeitverlauf`, `tagesverlauf`, `tageskarte`, `linie`, `abschnitte` or `fahrplan`.
 * Returns the list of requested API URLs.
 */
export async function mockApi(
  page: Page,
  heatmap: () => Heatmap | null = heatmapFixture,
  karte: () => Karte | null = karteFixture,
  statistik: (station: Station, gattung: string) => Statistik | null = statistikFixture,
  rankings: (typ: string, metrik: string, minN: number) => Rangliste | null = rankingFixture,
  linien: () => StationLinie[] | null = linienFixture,
  zeitverlauf: (
    eva: string | null,
    linie: string | null,
    gattung: string,
  ) => Zeitverlauf | typeof NOT_FOUND | null = zeitverlaufFixture,
  tagesverlauf: (
    eva: string | null,
    gattung: string,
  ) => Tagesverlauf | typeof NOT_FOUND | null = tagesverlaufFixture,
  tageskarte: (tag: string) => Tageskarte | typeof NOT_FOUND | null = tageskarteFixture,
  datenstand: () => Datenstand = () => DATENSTAND,
  linie: (id: string) => Linie | typeof NOT_FOUND | null = lineFixture,
  abschnitte: (id: string) => Abschnitt[] | typeof NOT_FOUND | null = abschnitteFixture,
  fahrplan: (id: string, tag: string) => Fahrplan | typeof NOT_FOUND | null = fahrplanFixture,
): Promise<URL[]> {
  const requests: URL[] = [];
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.fulfill({
      headers: CORS,
      json: route.request().url().endsWith("/styles/dark") ? DARK_STYLE : BASE_STYLE,
    }),
  );
  await page.route(
    (url) => API_PATH.test(url.pathname),
    async (route) => {
      // The page /karte shares its path with the API route; only API calls are faked.
      if (route.request().isNavigationRequest()) return route.fallback();
      const url = new URL(route.request().url());
      requests.push(url);
      const [, name, eva, detail] = API_PATH.exec(url.pathname)!;
      let body: unknown;
      if (name === "heatmap") body = heatmap();
      else if (name === "karte") body = karte();
      else if (name === "tageskarte") {
        const q = url.searchParams;
        body = tageskarte(q.get("tag") ?? "");
      } else if (name === "datenstand") body = datenstand();
      else if (name === "linie") {
        // The page /linie/<id> shares its prefix with the API; /linie/abschnitte is the sections,
        // /linie/fahrplan the trips of a day.
        const id = url.searchParams.get("linie") ?? "";
        body =
          eva === "abschnitte"
            ? abschnitte(id)
            : eva === "fahrplan"
              ? fahrplan(id, url.searchParams.get("tag") ?? "")
              : linie(id);
      } else if (name === "rankings") {
        const q = url.searchParams;
        body = rankings(q.get("typ") ?? "", q.get("metrik") ?? "", Number(q.get("min_n")));
      } else if (name === "zeitverlauf") {
        const q = url.searchParams;
        body = zeitverlauf(q.get("eva"), q.get("linie"), q.get("gattung") ?? "alle");
      } else if (name === "tagesverlauf") {
        const q = url.searchParams;
        body = tagesverlauf(q.get("eva"), q.get("gattung") ?? "alle");
      } else if (name === "suche") {
        const q = url.searchParams;
        body = sucheFixture(q.get("q") ?? "");
      } else if (eva) {
        body = STATIONS.find((s) => s.eva === eva) ?? null;
        if (body === null) return route.fulfill({ status: 404, headers: CORS, json: {} });
        if (detail === "/linien") body = linien();
        else if (detail) {
          body = statistik(body as Station, url.searchParams.get("gattung") ?? "alle");
        }
      } else {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        body = STATIONS.filter((s) => s.name.toLowerCase().includes(q));
      }
      if (body === NOT_FOUND) return route.fulfill({ status: 404, headers: CORS, json: {} });
      if (body === null) return route.fulfill({ status: 500, headers: CORS, body: "" });
      return route.fulfill({ headers: CORS, json: body });
    },
  );
  return requests;
}

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

// Routed by path, so a set VITE_API_URL can never send a test to a real server.
const API_PATH =
  /^\/(heatmap|datenstand|stationen|karte|rankings|zeitverlauf)(?:\/([^/]+)(\/statistik|\/linien)?)?$/;
const CORS = { "access-control-allow-origin": "*" };

/** Stands in for the OpenFreeMap style, so map tests never touch the network. */
const BASE_STYLE = {
  version: 8,
  sources: {},
  layers: [{ id: "background", type: "background", paint: { "background-color": "#eef0f3" } }],
};

export const STATIONS: Station[] = [
  { eva: "8000207", name: "Köln Hbf", land: "Nordrhein-Westfalen", n: 90000 },
  { eva: "8000105", name: "Frankfurt (Main) Hbf", land: "Hessen", n: 80000 },
  // Known station without map data (no coordinates).
  { eva: "8002549", name: "Hamburg Hbf", land: "Hamburg", n: 70000 },
  // Two stations with the same name, one with no federal state and very little data.
  { eva: "8000300", name: "Neustadt", land: "Bayern", n: 5000 },
  { eva: "8000301", name: "Neustadt", land: "Hessen", n: 4000 },
  { eva: "8000999", name: "Kleinstadt", land: null, n: 9 },
];

/** Four stations: a typical one, a good one, one with little data and a bad one. */
export function karteFixture(): Karte {
  const at = (lat: number, lon: number) => ({ lat, lon });
  return {
    von: "2026-09",
    bis: "2026-09",
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
};

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

/** Twelve lines at a station, worst first; the fourth has only 9 stops. */
export function linienFixture(): StationLinie[] {
  return Array.from({ length: 12 }, (_, i) => {
    const low = i === 3;
    return {
      linie: `RE ${i + 1}:8000207`,
      name: `RE ${i + 1} · Köln Hbf`,
      typ: "RE",
      n: low ? 9 : 1500 - i * 100,
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

/** What a `zeitverlauf` callback returns for a selection the API does not know (a 404). */
export const NOT_FOUND = "not-found";

/** Serves the API and the base map style from fixtures. `heatmap`, `karte`, `statistik`,
 * `rankings`, `linien` and `zeitverlauf` return the body, or null for a server error; an unknown
 * EVA is a 404, and so is `NOT_FOUND` from `zeitverlauf`. Returns the list of requested API URLs.
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
): Promise<URL[]> {
  const requests: URL[] = [];
  await page.route("https://tiles.openfreemap.org/**", (route) =>
    route.fulfill({ headers: CORS, json: BASE_STYLE }),
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
      else if (name === "datenstand") body = DATENSTAND;
      else if (name === "rankings") {
        const q = url.searchParams;
        body = rankings(q.get("typ") ?? "", q.get("metrik") ?? "", Number(q.get("min_n")));
      } else if (name === "zeitverlauf") {
        const q = url.searchParams;
        body = zeitverlauf(q.get("eva"), q.get("linie"), q.get("gattung") ?? "alle");
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

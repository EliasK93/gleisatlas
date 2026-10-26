import type { Page } from "@playwright/test";
import type { components } from "../src/schema";

type Heatmap = components["schemas"]["Heatmap"];
type Cell = components["schemas"]["Cell"];
type Station = components["schemas"]["Station"];
type Datenstand = components["schemas"]["Datenstand"];
type Karte = components["schemas"]["Karte"];
type Statistik = components["schemas"]["Statistik"];

// Routed by path, so a set VITE_API_URL can never send a test to a real server.
const API_PATH = /^\/(heatmap|datenstand|stationen|karte)(?:\/([^/]+)(\/statistik)?)?$/;
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

const DATENSTAND: Datenstand = { monate: ["2026-09"], bahnhoefe: 5219 };

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
 * Serves the API and the base map style from fixtures. `heatmap`, `karte` and `statistik` return
 * the body, or null for a server error; an unknown EVA is a 404. Returns the list of requested
 * API URLs.
 */
export async function mockApi(
  page: Page,
  heatmap: () => Heatmap | null = heatmapFixture,
  karte: () => Karte | null = karteFixture,
  statistik: (station: Station, gattung: string) => Statistik | null = statistikFixture,
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
      else if (eva) {
        body = STATIONS.find((s) => s.eva === eva) ?? null;
        if (body === null) return route.fulfill({ status: 404, headers: CORS, json: {} });
        if (detail) body = statistik(body as Station, url.searchParams.get("gattung") ?? "alle");
      } else {
        const q = (url.searchParams.get("q") ?? "").toLowerCase();
        body = STATIONS.filter((s) => s.name.toLowerCase().includes(q));
      }
      if (body === null) return route.fulfill({ status: 500, headers: CORS, body: "" });
      return route.fulfill({ headers: CORS, json: body });
    },
  );
  return requests;
}

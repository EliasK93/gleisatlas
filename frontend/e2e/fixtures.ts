import type { Page } from "@playwright/test";
import type { components } from "../src/schema";

type Heatmap = components["schemas"]["Heatmap"];
type Cell = components["schemas"]["Cell"];
type Station = components["schemas"]["Station"];
type Datenstand = components["schemas"]["Datenstand"];

// Routed by path, so a set VITE_API_URL can never send a test to a real server.
const API_PATH = /^\/(heatmap|datenstand|stationen)(?:\/([^/]+))?$/;
const CORS = { "access-control-allow-origin": "*" };

export const STATIONS: Station[] = [
  { eva: "8000207", name: "Köln Hbf" },
  { eva: "8000105", name: "Frankfurt (Main) Hbf" },
];

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
 * Serves the API from fixtures. `heatmap` returns the body, or null for a server error.
 * Returns the list of requested URLs.
 */
export async function mockApi(
  page: Page,
  heatmap: () => Heatmap | null = heatmapFixture,
): Promise<URL[]> {
  const requests: URL[] = [];
  await page.route(
    (url) => API_PATH.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const [, name, eva] = API_PATH.exec(url.pathname)!;
      let body: unknown;
      if (name === "heatmap") body = heatmap();
      else if (name === "datenstand") body = DATENSTAND;
      else if (eva) {
        body = STATIONS.find((s) => s.eva === eva) ?? null;
        if (body === null) return route.fulfill({ status: 404, headers: CORS, json: {} });
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

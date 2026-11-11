import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import { useEffect, useState } from "react";
import { monthsOf } from "./metrics";
import type { components, paths } from "./schema";

type Datenstand = components["schemas"]["Datenstand"];

export const api = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:8317",
});

/** Unwraps an openapi-fetch result; any non-2xx answer becomes a query error. */
export function must<T>({ data, response }: { data?: T; response: Response }): T {
  if (!response.ok || data === undefined) throw new Error(`${response.status} ${response.url}`);
  return data;
}

/** How long a view of the live day stays fresh; the collector runs every 15 minutes. */
export const LIVE_REFRESH = 5 * 60_000;

/** Refreshes without an interaction after which Live-Lage stops asking, so an idle tab lets the server sleep. */
const IDLE_POLLS = 2;
const INTERACTIONS = ["pointerdown", "keydown", "wheel"] as const;

/**
 * True while Live-Lage's polling may run: until `IDLE_POLLS` refresh periods pass without an
 * interaction (or the tab becoming visible again). The next interaction resumes it and, when the
 * data is older than one period, asks for it at once.
 */
export function useLiveActive(on: boolean) {
  const client = useQueryClient();
  const [active, setActive] = useState(true);
  useEffect(() => {
    if (!on) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      // The extra half minute lets the last poll go out first, even a late one.
      timer = setTimeout(
        () => {
          live = false;
          setActive(false);
        },
        IDLE_POLLS * LIVE_REFRESH + 30_000,
      );
    };
    const touch = () => {
      if (!live) {
        live = true;
        setActive(true);
        for (const queryKey of [["tageskarte"], ["datenstand"]])
          void client.refetchQueries(
            {
              queryKey,
              type: "active",
              predicate: (q) => Date.now() - q.state.dataUpdatedAt > LIVE_REFRESH,
            },
            { cancelRefetch: false },
          );
      }
      arm();
    };
    const seen = () => document.visibilityState === "visible" && touch();
    for (const e of INTERACTIONS) window.addEventListener(e, touch, { passive: true });
    document.addEventListener("visibilitychange", seen);
    arm();
    return () => {
      for (const e of INTERACTIONS) window.removeEventListener(e, touch);
      document.removeEventListener("visibilitychange", seen);
      clearTimeout(timer);
      setActive(true);
    };
  }, [on, client]);
  return active;
}

/**
 * What the data covers. One request shared by the shell, the filter bar and the series. Only a
 * caller that passes `refetchInterval` polls it: Live-Lage while it shows today, so an open tab
 * notices the end of "today"; any other open tab lets the server scale to zero. Live-Lage also asks
 * (`onFocus`) when its tab is shown again, as long as the data is stale, since its day chips come
 * from the client's clock and /datenstand says which days exist.
 */
export const useDatenstand = (
  refetchInterval: number | false = false,
  onFocus = refetchInterval !== false,
) =>
  useQuery({
    queryKey: ["datenstand"],
    queryFn: () => api.GET("/datenstand").then(must),
    staleTime: LIVE_REFRESH,
    refetchInterval,
    refetchOnWindowFocus: onFocus,
  });

/** One station by EVA, for the name and the state; it never changes, so it is fetched once per session. */
export const useStation = (eva: string | undefined, enabled: boolean) =>
  useQuery({
    queryKey: ["station", eva],
    queryFn: () => api.GET("/stationen/{eva}", { params: { path: { eva: eva! } } }).then(must),
    enabled,
    staleTime: Infinity,
  });

/**
 * The days Live-Lage can show: the complete days, the collector's finished days after them (not
 * on the Karte, which stops at `letzter_tag`) and today. `newest` is the default one.
 */
export function lageDays(d: Datenstand) {
  const newest = d.heute ?? d.live_tage.at(-1) ?? d.letzter_tag;
  return {
    newest,
    has: (day: string) =>
      day === d.heute || (day >= d.erster_tag && day <= d.letzter_tag) || d.live_tage.includes(day),
  };
}

/**
 * The period of the URL as the months a month page asks for (see `monthsOf`). `ready` is false
 * while /datenstand is still loading and the URL holds a period, so no request names months that
 * might lie outside the data. If /datenstand fails, the months go unclamped, so the page shows its
 * own result or error instead of loading forever.
 */
export function useMonthPeriod(f: { von?: string; bis?: string }) {
  const datenstand = useDatenstand();
  const months = datenstand.data?.monate;
  return {
    ...monthsOf(f, months ?? []),
    ready: !!months || datenstand.isError || !(f.von || f.bis),
  };
}

/**
 * The lines at a station for the category and the months of `f`. The map's station panel and the
 * station page ask for the same thing, so they share one query key and the cache.
 */
export function useStationLines(
  eva: string,
  f: { g?: "regional" | "fern"; von?: string; bis?: string },
) {
  const m = useMonthPeriod(f);
  return useQuery({
    queryKey: ["linien", eva, f.g, m.von, m.bis],
    queryFn: () =>
      api
        .GET("/stationen/{eva}/linien", {
          params: { path: { eva }, query: { gattung: f.g ?? "alle", von: m.von, bis: m.bis } },
        })
        .then(must),
    enabled: m.ready,
    placeholderData: keepPreviousData,
  });
}

import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
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

/**
 * What the data covers. One request shared by the shell, the filter bar and the series. While the
 * server has a live day it is asked again, so an open tab notices the end of "today".
 */
export const useDatenstand = () =>
  useQuery({
    queryKey: ["datenstand"],
    queryFn: () => api.GET("/datenstand").then(must),
    staleTime: LIVE_REFRESH,
    refetchInterval: (q) => (q.state.data?.heute ? LIVE_REFRESH : false),
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

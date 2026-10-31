import { useQuery } from "@tanstack/react-query";
import createClient from "openapi-fetch";
import type { paths } from "./schema";

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

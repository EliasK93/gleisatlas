import createClient from "openapi-fetch";
import type { paths } from "./schema";

export const api = createClient<paths>({
  baseUrl: import.meta.env.VITE_API_URL ?? "http://localhost:8000",
});

/** Unwraps an openapi-fetch result; any non-2xx answer becomes a query error. */
export function must<T>({ data, response }: { data?: T; response: Response }): T {
  if (!response.ok || data === undefined) throw new Error(`${response.status} ${response.url}`);
  return data;
}

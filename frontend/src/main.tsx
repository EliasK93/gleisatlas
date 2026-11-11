import "@fontsource-variable/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import App from "./App";
import "./index.css";

// No automatic retries: failed views show an error banner with "Erneut versuchen". The data
// changes once a day, so a page shown again within the hour comes from the cache, and returning
// to a tab asks for nothing, which lets the server sleep; the next page after an hour asks again.
// Live-Lage's polling queries set their own refresh.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, staleTime: 60 * 60_000, refetchOnWindowFocus: false },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

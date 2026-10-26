import { useCallback } from "react";
import { useNavigate } from "react-router";

/**
 * Writes the URL filters. The updater gets the URL as it is now: react-router's own
 * `setSearchParams` hands it the params of the last render, and the router renders a navigation
 * in a transition, so a second change right after the first would overwrite it.
 */
export function useSetParams() {
  const navigate = useNavigate();
  return useCallback(
    (update: (p: URLSearchParams) => URLSearchParams) =>
      navigate(`?${update(new URLSearchParams(window.location.search))}`),
    [navigate],
  );
}

/** Updater for "reset": drops every filter. */
export const clearParams = () => new URLSearchParams();

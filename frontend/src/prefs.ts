/** Display preferences, kept in localStorage and shared with React through useSyncExternalStore. */
import { useSyncExternalStore } from "react";
import { LANG, LANG_KEY, type Lang } from "./i18n";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

const KEY = "gleisatlas-theme";
const system = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function stored(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

let pref = stored();

const resolve = (): Theme => (pref === "system" ? (system.matches ? "dark" : "light") : pref);

function apply() {
  document.documentElement.dataset.theme = resolve();
  listeners.forEach((l) => l());
}

// This module is the authority; the inline script in index.html only avoids a flash before it runs.
apply();

system.addEventListener("change", () => {
  if (pref === "system") apply();
});

function setPref(next: ThemePref) {
  pref = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Private mode or blocked storage: the pick holds until the page closes.
  }
  apply();
}

/** The language is read once per page load, so a pick is stored and the page reloads (filters live in the URL). */
export function setLang(next: Lang) {
  if (next === LANG) return;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {
    // Blocked storage: the reload falls back to the browser language.
  }
  location.reload();
}

const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export function useTheme() {
  return {
    pref: useSyncExternalStore(subscribe, () => pref),
    resolved: useSyncExternalStore(subscribe, resolve),
    setPref,
  };
}

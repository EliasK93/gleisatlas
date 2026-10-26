import { createElement, Fragment, type ReactNode } from "react";
import { de } from "./de";
import { en } from "./en";

export type MessageKey = keyof typeof de;
export type Lang = "de" | "en";

export const LANG_KEY = "gleisatlas-lang";

/** The stored pick, else English for an English browser, else German. Decided once per page load. */
function resolveLang(): Lang {
  // Outside a browser (a spec importing metrics.ts under Node) the language is always German.
  if (typeof document === "undefined") return "de";
  try {
    const v = localStorage.getItem(LANG_KEY);
    if (v === "de" || v === "en") return v;
  } catch {
    // Blocked storage: fall through to the browser language.
  }
  return navigator.language.toLowerCase().startsWith("en") ? "en" : "de";
}

export const LANG = resolveLang();
export const LOCALE = LANG === "en" ? "en-GB" : "de-DE";
if (typeof document !== "undefined") document.documentElement.lang = LANG;

const catalog: Record<MessageKey, string> = LANG === "en" ? en : de;

/** Looks up a message and fills `{name}` placeholders from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return catalog[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
}

/** Like `t`, but placeholders may be React nodes, e.g. a bold value. */
export function tx(key: MessageKey, vars: Record<string, ReactNode>): ReactNode {
  const parts = catalog[key].split(/\{(\w+)\}/).map((part, i) => (i % 2 ? vars[part] : part));
  return createElement(Fragment, null, ...parts);
}

import { createElement, Fragment, type ReactNode } from "react";
import { de } from "./de";

export type MessageKey = keyof typeof de;

export const LOCALE = "de-DE";

// A later `en` catalog is typed `Record<MessageKey, string>`, so its keys must match exactly.
const catalog: Record<MessageKey, string> = de;

/** Looks up a message and fills `{name}` placeholders from `vars`. */
export function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  return catalog[key].replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name]));
}

/** Like `t`, but placeholders may be React nodes, e.g. a bold value. */
export function tx(key: MessageKey, vars: Record<string, ReactNode>): ReactNode {
  const parts = catalog[key].split(/\{(\w+)\}/).map((part, i) => (i % 2 ? vars[part] : part));
  return createElement(Fragment, null, ...parts);
}

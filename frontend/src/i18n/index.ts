import { de } from "./de";

export type MessageKey = keyof typeof de;

// A later `en` catalog is typed `Record<MessageKey, string>`, so its keys must match exactly.
const catalog: Record<MessageKey, string> = de;

export function t(key: MessageKey): string {
  return catalog[key];
}

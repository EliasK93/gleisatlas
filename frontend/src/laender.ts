import { t, type MessageKey } from "./i18n";

/**
 * Where each federal state's card sits on the Live-Lage map, as [lon, lat]: near the state's
 * centre, but moved so that no two cards overlap at the overview on a phone (375 × 812) or a
 * desktop. Brandenburg sits south-east of Berlin, Niedersachsen south-east of Bremen and
 * Schleswig-Holstein north of Hamburg, Rheinland-Pfalz north of the Saarland.
 */
export const ANCHORS: Record<string, [number, number]> = {
  bw: [9.0, 48.6],
  by: [11.8, 48.8],
  be: [13.4, 52.52],
  bb: [14.2, 51.8],
  hb: [8.8, 53.08],
  hh: [10.0, 53.55],
  he: [9.0, 50.6],
  mv: [12.6, 53.75],
  ni: [9.7, 52.4],
  nw: [7.5, 51.45],
  rp: [7.5, 50.05],
  sl: [6.85, 49.3],
  sn: [13.2, 51.0],
  st: [11.6, 51.95],
  sh: [9.6, 54.35],
  th: [11.0, 50.85],
};

/** The state's name in the UI language. */
export const landName = (code: string) => t(`land.${code}` as MessageKey);

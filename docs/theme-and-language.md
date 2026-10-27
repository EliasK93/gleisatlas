# Theme and language

## 1 Overview

The viewer chooses the look (System, Hell, Dunkel) and the UI language (Deutsch, English). Both are display preferences kept in the browser; neither is part of the URL. Visual targets for the tokens are in [design.md](design.md) §3.1 and §8; the switches sit in the frame described in [app-shell.md](app-shell.md).

## 2 Spec

**Theme**

- Three levels: System (default, follows the operating system and reacts to a change while the page is open), Hell and Dunkel. A pick wins over the system and is remembered.
- The switch "Darstellung" is a `Segmented` in the sidebar footer (from 768 px) and a card on `/mehr`, which is the only place on mobile.
- `<html data-theme="light|dark">` always holds the resolved theme, never `system`. `theme.css` has one `:root[data-theme="dark"]` block with every colour token and `color-scheme: dark`; spacing, radii and fonts do not change.
- Text meets 4.5:1 for `--text`, `--text-2` and `--text-3` on `--bg`, `--surface` and `--surface-2`, in both themes.
- The map uses the OpenFreeMap "positron" style in light and "dark" in dark. The station dots, their outline and the selection ring take the colours of the tokens of the current theme.

**Language**

- Two catalogs, `de.ts` and `en.ts`. The English one is typed `Record<MessageKey, string>`, so a missing or extra key fails type-checking.
- The language is the stored pick, else English when the browser language starts with `en`, else German. The switch ("Sprache" in German, "Language" in English) sits next to the theme switch (sidebar footer and `/mehr`). Its two options are written in their own language ("Deutsch", "English"), so the switch can be found from either UI.
- Short months read "Sep 26" in German and "Sep '26" in English; a percent value reads "87 %" in German and "87%" in English. Both patterns are catalog keys (`format.monthShort`, `format.pct`).
- Picking a language stores it and reloads the page. Filters survive because they live in the URL.
- `<html lang>` follows the language. Numbers, dates and weekdays come from `Intl` with `de-DE` or `en-GB`; the base-map labels follow through `localLabel`.
- The CC BY 4.0 link points to the German or the English deed, through the catalog key `data.licenceUrl`.
- Routes, query keys and API names stay German (the public contract); see [app-shell.md](app-shell.md) §2.

## 3 Decisions

- **Three levels with System as default.** Reason: a viewer who never touches the switch gets the look of their device; a pick covers the case where the site and the device disagree.
- **A segmented control in the sidebar footer and on `/mehr`.** Reason: design.md §1.2 and §8 put the switch there, and the existing `Segmented` already has the 44 px hit areas.
- **`data-theme` holds the resolved theme, plus an inline script in `<head>`.** Reason: CSS then needs one selector instead of a media query and an override, and the script sets the attribute before the first paint, so a dark viewer never sees a light flash.
- **Dark token values come from the mockup, except `--text-3`, which is lightened to `#838b99`.** Reason: the mockup's `#6f7888` is about 3.6:1 on the dark `--surface-2`; `#838b99` reaches at least 4.5:1 on all three surfaces. This is the same reason light `--text-3` was darkened.
- **Light `--text-3` is `#656d7e`, darker than M1's `#697182`.** Reason: `#697182` measures 4.29:1 on `--surface-2`, where hover rows, the search field and its placeholder sit. `#656d7e` reaches 4.80:1 on `--bg`, 5.20:1 on `--surface` and 4.55:1 on `--surface-2`, so `theme.spec.ts` checks all 18 pairs without an exemption.
- **The language switch's label is translated ("Sprache" / "Language").** Reason: the group name is its accessible name, and a name in the page's language reads naturally to a screen reader; the options carry their own language, which is what makes the switch findable from either UI. The specs address the group by this name.
- **Month and percent patterns live in the catalog.** Reason: "Sep 26" reads as 26 September to an English reader, so English writes "Sep '26" (`format.monthShort`); British style sets the percent sign without a space ("87%"), German with a no-break space ("87 %") (`format.pct`). Each language decides its own pattern instead of the code hard-coding one.
- **The dark base map is OpenFreeMap "dark".** Reason: no new provider, no API key, and the style is checked to exist.
- **The map adds its source and layers on `style.load` and switches with a full `setStyle`.** Reason: a new base style drops the station layers; `style.load` fires for every style, so the layers come back with the latest data and selection. A diffing `setStyle` would try to diff those layers away.
- **Language from the stored pick, else the browser (`en*`), else German.** Reason: German is the product's default audience, English is for visitors whose browser asks for it, and a manual pick must win over both.
- **The language is a viewer preference, not a URL key.** Reason: a shared link should open in the reader's language, not the sender's.
- **A language pick reloads the page.** Reason: about fifteen places fix texts and formatters when their module loads (metric labels, number and date formats, the MapLibre locale). Reloading keeps them plain constants instead of making each reactive.
- **German avoids direct address (neither "Sie" nor "du").** Reason: the product owner's tone choice; hints read as statements ("Die Filter bleiben erhalten").
- **`en-GB` for English formats.** Reason: 24-hour time, day-month order and "1,240" suit the German travel context better than `en-US`.
- **The licence link follows the language.** Reason: the deed exists in both languages and the link should match the page.
- **Route and API names stay German.** Reason: they are the public contract; code and docs are English, UI text is in the catalogs.

## 4 Architecture and data keys

| Key (localStorage) | Values | Fallback |
|---|---|---|
| `gleisatlas-theme` | `system`, `light`, `dark` | System (any other value, also a blocked storage) |
| `gleisatlas-lang` | `de`, `en` | the browser language, else `de` |

- `frontend/index.html`: the inline script that sets `data-theme` before the first paint.
- `frontend/src/prefs.ts`: the theme store read with `useSyncExternalStore` (`useTheme()` returns the pick, the resolved theme and a setter; it listens to `prefers-color-scheme` while on System) and `setLang`, which stores the language and reloads.
- `frontend/src/theme.css`: the light tokens under `:root` and the dark set under `:root[data-theme="dark"]`.
- `frontend/src/i18n/index.ts`: resolves `LANG` once per page load and exports `LANG`, `LOCALE` and `LANG_KEY`; sets `<html lang>`. `de.ts` and `en.ts` are the catalogs.
- `frontend/src/App.tsx`: `ThemeSwitch` and `LangSwitch` over one `PrefSwitch`.
- `frontend/src/MapPage.tsx`: `STYLE` per theme, the `style.load` setup and the `setStyle` effect; the station colours are read from the tokens once per theme.
- Every localStorage read and write sits in try/catch; a blocked storage keeps the pick until the page closes (theme) or falls back to the browser language (language).
- Tests: `frontend/e2e/theme.spec.ts` and `frontend/e2e/i18n.spec.ts`. `playwright.config.ts` sets `locale: "de-DE"` for both projects, because Playwright's default would switch every other spec to English.

## 5 Milestones

- [x] Dark theme. Re-check: `npm.cmd --prefix frontend run test:e2e`, `frontend/e2e/theme.spec.ts` ("System is the default and follows the OS", "Hell wins over the OS and survives a reload", "System after a pick follows the OS again", "Dunkel wins over the OS and survives a reload", "a stored value that is not a theme falls back to System", "text colours reach 4.5:1 on every surface in both themes", "the base map and the stations follow the theme", "a station picked while the new base style loads does not crash the page", "the switch on Mehr has 44 px hit areas").
- [x] English catalog and language switch. Re-check: `npm.cmd --prefix frontend run test:e2e`, `frontend/e2e/i18n.spec.ts` ("the first visit is English", "Deutsch reloads into German and the pick is remembered", "the filters survive the switch", "short months carry an apostrophe, so they cannot read as a day", "a stored value that is not a language falls back to the browser", "the first visit is German", "English wins over the browser and survives a reload", "the switch on Mehr has 44 px hit areas"); `npm.cmd --prefix frontend run typecheck` fails when the catalogs' keys differ.

## 6 Platform checks

- [ ] The wordmark (`logo.svg`) shows dark text on light and light text on dark in Firefox and Safari, also under a forced theme that differs from the operating system (Hell on a dark system, Dunkel on a light one). Chromium follows the page's `color-scheme`.
- [ ] No light flash on the deployed site when a viewer with a dark system opens a page. Verify on Azure.
- [ ] The strict Content-Security-Policy allows the inline script in `index.html` on the deployed site. The hash is in place in `frontend/public/staticwebapp.config.json` and checked locally against the production build by `frontend/e2e/csp.spec.ts`; the tick waits for the deployed site ([deployment.md](deployment.md) §6, no CSP violation).

## 7 Open decisions

- The English wording. The terms are set (Punctuality, Typical delay, Bad days (P90), Cancellations, Regional, Long-distance); the product owner reviews the rest in the test round.

## 8 Known shortcuts

- No plural forms in either catalog: a count of one reads "1 stops" in English and "1 Halte" in German. Add a plural key when a page shows small counts.
- The theme rule exists twice, in the inline script in `index.html` and in `prefs.ts`. Reason: the script has to run before the bundle to avoid the flash. A change to the key or the rule goes into both; `prefs.ts` sets `data-theme` again when it loads, so it stays the authority if they drift, and `theme.spec.ts` covers the stored value and the system fallback after a reload.
- A language switch reloads the page, so an open tooltip or a typed search term is lost. Module-level texts and formatters stay plain constants.
- `<html lang>` is set when the bundle loads; the HTML says `de` until then.
- Outside a browser (a spec importing `metrics.ts` under Node) the language is always German.
- A theme switch reloads the whole base map style, so the map flickers once. The station colours are read from the tokens once per theme.
- `--cat2` in dark (`#6f7888`) is a series colour and is not checked against the contrast rule; look at it when the charts get a dark review.
- On desktop `/mehr` shows the two switches twice, in the sidebar and in their cards, like the data note.

import {
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useMatch,
  type To,
} from "react-router";
import { useDatenstand } from "./api";
import HeatmapPage from "./HeatmapPage";
import LinePage from "./LinePage";
// shortcut: MapLibre ships in the main bundle (about 400 kB gzip); lazy-load MapPage if other pages' first load matters
import MapPage from "./MapPage";
import { LANG, t, tx, type Lang, type MessageKey } from "./i18n";
import { Icon, type IconName } from "./Icon";
import {
  DATENSCHUTZ,
  IMPRESSUM,
  ImpressumPage,
  LegalLinks,
  DatasetLink,
  LicenceLink,
  PrivacyPage,
} from "./LegalPages";
import { formatPeriod, int } from "./metrics";
import { setLang, useTheme, type ThemePref } from "./prefs";
import RankingsPage from "./RankingsPage";
import StationPage from "./StationPage";
import { GlobalSearch, useSearchShortcut } from "./StationSearch";
import {
  HEATMAP,
  LAGE,
  MAP,
  Page,
  PageTitle,
  RANKINGS,
  Segmented,
  SoonTag,
  stationPath,
  ZEITVERLAUF,
} from "./ui";
import ZeitverlaufPage from "./ZeitverlaufPage";

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Redirect to={MAP} />} />
        {/* Keyed, so switching between the two maps starts a fresh map with fresh zoom state. */}
        <Route path={MAP} element={<MapPage key="karte" />} />
        <Route path={LAGE} element={<MapPage key="lage" day />} />
        <Route path={stationPath(":eva")} element={<StationPage />} />
        <Route path="/linie/:id" element={<LinePage />} />
        <Route path="/muster" element={<Redirect to={HEATMAP} />} />
        <Route path={HEATMAP} element={<HeatmapPage />} />
        <Route path={RANKINGS} element={<RankingsPage />} />
        <Route path={ZEITVERLAUF} element={<ZeitverlaufPage />} />
        <Route path="/mehr" element={<MorePage />} />
        <Route path={IMPRESSUM} element={<ImpressumPage />} />
        <Route path={DATENSCHUTZ} element={<PrivacyPage />} />
        <Route path="*" element={<Redirect to={MAP} />} />
      </Route>
    </Routes>
  );
}

/** Redirect that keeps the query string, so filters survive. */
function Redirect({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={{ pathname: to, search }} replace />;
}

function Shell() {
  // Links carry the query string, so filters persist across pages.
  const { search } = useLocation();
  useSearchShortcut();
  // The maps are full-bleed and fill the viewport without a footer or page scroll.
  const onMap = useMatch(MAP) !== null;
  const onLage = useMatch(LAGE) !== null;
  const full = onMap || onLage;
  // A link to Live-Lage opens live; `tag` elsewhere is another page's day (the Bildfahrplan's).
  const lage = new URLSearchParams(search);
  if (!onLage) lage.delete("tag");
  const lageTo = { pathname: LAGE, search: lage.toString() };
  return (
    <div
      className={`md:grid md:grid-cols-[248px_1fr] ${full ? "flex h-dvh flex-col overflow-hidden" : "min-h-screen"}`}
    >
      <div className="md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-1 md:overflow-y-auto md:border-r md:border-border md:bg-surface md:px-3 md:py-4">
        <header className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5 md:block md:border-0 md:bg-transparent md:p-0">
          <h2>
            <Link to={{ pathname: "/", search }} className="hit flex md:px-2 md:pt-1 md:pb-3.5">
              {/* Wordmark with the name as outlines; the mobile top bar shows the mark only. */}
              <picture>
                <source media="(min-width: 768px)" srcSet="/logo.svg" />
                <img src="/favicon.svg" alt={t("app.title")} className="h-7 w-auto" />
              </picture>
            </Link>
          </h2>
          <div className="min-w-0 flex-1 md:hidden">
            <GlobalSearch />
          </div>
        </header>
        <div className="mb-1.5 hidden md:block">
          <GlobalSearch />
        </div>
        <nav aria-label={t("nav.label")} className="hidden md:flex md:flex-1 md:flex-col md:gap-1">
          <Group label="nav.discover" />
          <SideLink icon="map" label="nav.map" to={{ pathname: MAP, search }} />
          <SideLink icon="clock" label="nav.live" to={lageTo} />
          <SideLink icon="grid" label="nav.heatmap" to={{ pathname: HEATMAP, search }} />
          <SideLink icon="list" label="nav.rankings" to={{ pathname: RANKINGS, search }} />
          <SideLink icon="trend" label="nav.timeline" to={{ pathname: ZEITVERLAUF, search }} />
          <Group label="nav.plan" />
          <Soon icon="route" label="nav.connection" />
          <Soon icon="xfer" label="nav.transfer" />
          <Group label="nav.later" />
          <Soon icon="star" label="nav.saved" />
          <div className="mt-auto border-t border-border pt-3 text-[13px]">
            <Soon icon="info" label="nav.method" />
          </div>
        </nav>
        <ThemeSwitch className="hidden px-2.5 pt-2 md:block" />
        <LangSwitch className="hidden px-2.5 pt-2 md:block" />
        <DataNote className="hidden px-2.5 pt-2 text-xs text-text-3 md:block" />
        <LegalLinks className="hidden px-2.5 pt-2 text-xs text-text-3 md:block" />
      </div>

      <div className={`flex min-w-0 flex-col ${full ? "min-h-0 flex-1" : "pb-20 md:pb-0"}`}>
        <main className={full ? "relative min-h-0 flex-1" : "flex-1"}>
          <Outlet />
        </main>
        {!full && (
          <footer className="mx-auto mt-8 flex w-full max-w-[1200px] flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 pt-4 pb-7 text-xs text-text-3 md:px-8">
            <b className="font-semibold text-text-2">
              {t("footer.disclaimer")} {t("legal.notDb")}
            </b>
            <span>
              {tx("data.attribution", { dataset: <DatasetLink />, licence: <LicenceLink /> })}
            </span>
            <LegalLinks />
          </footer>
        )}
      </div>

      {/* On the map the tab bar sits in the column flow, so the map ends right above it. */}
      <nav
        aria-label={t("nav.label")}
        className={`z-10 grid grid-cols-4 border-t border-border bg-surface px-1 pt-1 pb-2 md:hidden ${full ? "shrink-0" : "fixed inset-x-0 bottom-0"}`}
      >
        <Tab icon="map" label="nav.map" to={{ pathname: MAP, search }} />
        <Tab icon="clock" label="nav.live" to={lageTo} />
        {/* /muster redirects to the heatmap; the tab stays current on every pattern page. */}
        <Tab icon="grid" label="nav.patterns" to={{ pathname: "/muster", search }} />
        <Tab icon="more" label="nav.more" to={{ pathname: "/mehr", search }} />
      </nav>
    </div>
  );
}

function Group({ label }: { label: MessageKey }) {
  return (
    <div className="px-2.5 pt-3.5 pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-text-3 uppercase">
      {t(label)}
    </div>
  );
}

function SideLink({ icon, label, to }: { icon: IconName; label: MessageKey; to: To }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `nav-item ${isActive ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text"}`
      }
    >
      <Icon name={icon} />
      {t(label)}
    </NavLink>
  );
}

/** A page that is not built yet: dimmed, tagged "bald", not a link. */
function Soon({ icon, label }: { icon: IconName; label: MessageKey }) {
  return (
    <span className="nav-item text-text-2 opacity-55">
      <Icon name={icon} />
      <span>{t(label)}</span>
      <SoonTag className="ml-auto" />
    </span>
  );
}

function Tab({ icon, label, to }: { icon: IconName; label: MessageKey; to: To }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[11px] font-[550] ${isActive ? "text-accent" : "text-text-3"}`
      }
    >
      <Icon name={icon} className="size-[22px]" />
      {t(label)}
    </NavLink>
  );
}

const THEMES: ThemePref[] = ["system", "light", "dark"];
const THEME_OPTIONS = THEMES.map((value) => ({ value, label: t(`theme.${value}`) }));

const LANGS: Lang[] = ["de", "en"];
const LANG_OPTIONS = LANGS.map((value) => ({ value, label: t(`lang.${value}`) }));

/** A labelled segmented preference switch. */
function PrefSwitch<T extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className: string;
}) {
  return (
    <div className={className}>
      <div className="pb-1.5 text-[11px] font-semibold tracking-[0.06em] text-text-3 uppercase">
        {label}
      </div>
      <Segmented
        label={label}
        options={options}
        value={value}
        onChange={onChange}
        className="-my-2 py-2 md:m-0 md:p-0"
      />
    </div>
  );
}

/** System, Light or Dark; System follows the device. */
function ThemeSwitch({ className }: { className: string }) {
  const { pref, setPref } = useTheme();
  return (
    <PrefSwitch
      label={t("theme.label")}
      options={THEME_OPTIONS}
      value={pref}
      onChange={setPref}
      className={className}
    />
  );
}

/** Each language is named in itself, so it can be found from either UI. */
function LangSwitch({ className }: { className: string }) {
  return (
    <PrefSwitch
      label={t("lang.label")}
      options={LANG_OPTIONS}
      value={LANG}
      onChange={setLang}
      className={className}
    />
  );
}

function DataNote({ className }: { className: string }) {
  const { data } = useDatenstand();
  const month = data?.monate.at(-1);
  return (
    <div className={className} data-testid="data-note">
      {data && month && (
        <p>{t("data.status", { month: formatPeriod(month), stations: int(data.bahnhoefe) })}</p>
      )}
      <p>{t("legal.notDb")}</p>
    </div>
  );
}

function MorePage() {
  return (
    <Page>
      <PageTitle className="mb-3">{t("nav.more")}</PageTitle>
      <div className="card flex flex-col gap-0.5 p-2">
        <Soon icon="xfer" label="nav.transfer" />
        <Soon icon="info" label="nav.method" />
        <Soon icon="route" label="nav.plan" />
        <Soon icon="star" label="nav.saved" />
      </div>
      <ThemeSwitch className="card mt-4" />
      <LangSwitch className="card mt-4" />
      <DataNote className="card mt-4 flex flex-col gap-1 text-xs text-text-3" />
    </Page>
  );
}

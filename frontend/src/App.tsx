import { useQuery } from "@tanstack/react-query";
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
import { api, must } from "./api";
import HeatmapPage from "./HeatmapPage";
// ponytail: MapLibre ships in the main bundle (about 400 kB gzip); lazy-load MapPage if other pages' first load matters
import MapPage from "./MapPage";
import { t, type MessageKey } from "./i18n";
import { Icon, type IconName } from "./Icon";
import { formatPeriod, int } from "./metrics";
import StationPage from "./StationPage";
import { GlobalSearch, useSearchShortcut } from "./StationSearch";
import { SoonTag } from "./ui";

const HEATMAP = "/muster/heatmap";
const MAP = "/karte";
const LICENCE = "https://creativecommons.org/licenses/by/4.0/deed.de";

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<ToMap />} />
        <Route path={MAP} element={<MapPage />} />
        <Route path="/bahnhof/:eva" element={<StationPage />} />
        <Route path={HEATMAP} element={<HeatmapPage />} />
        <Route path="/mehr" element={<MorePage />} />
        <Route path="*" element={<ToMap />} />
      </Route>
    </Routes>
  );
}

/** Redirect that keeps the query string, so filters survive. */
function ToMap() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: MAP, search }} replace />;
}

function Shell() {
  // Links carry the query string, so filters persist across pages.
  const { search } = useLocation();
  useSearchShortcut();
  // The map is full-bleed and fills the viewport without a footer or page scroll.
  const full = useMatch(MAP) !== null;
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
          <SideLink icon="grid" label="nav.heatmap" to={{ pathname: HEATMAP, search }} />
          <Soon icon="list" label="nav.rankings" />
          <Soon icon="trend" label="nav.timeline" />
          <Group label="nav.plan" />
          <Soon icon="route" label="nav.connection" />
          <Soon icon="xfer" label="nav.transfer" />
          <Group label="nav.later" />
          <Soon icon="clock" label="nav.live" />
          <Soon icon="trend" label="nav.chains" />
          <Soon icon="star" label="nav.saved" />
          <div className="mt-auto border-t border-border pt-3 text-[13px]">
            <Soon icon="info" label="nav.method" />
          </div>
        </nav>
        <DataNote className="hidden px-2.5 pt-2 text-xs text-text-3 md:block" />
      </div>

      <div className={`flex min-w-0 flex-col ${full ? "min-h-0 flex-1" : "pb-20 md:pb-0"}`}>
        <main className={full ? "relative min-h-0 flex-1" : "flex-1"}>
          <Outlet />
        </main>
        {!full && (
          <footer className="mx-auto mt-8 flex w-full max-w-[1200px] flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 pt-4 pb-7 text-xs text-text-3 md:px-8">
            <b className="font-semibold text-text-2">{t("footer.disclaimer")}</b>
            <span>{t("footer.attribution")}</span>
          </footer>
        )}
      </div>

      {/* On the map the tab bar sits in the column flow, so the map ends right above it. */}
      <nav
        aria-label={t("nav.label")}
        className={`z-10 grid grid-cols-4 border-t border-border bg-surface px-1 pt-1 pb-2 md:hidden ${full ? "shrink-0" : "fixed inset-x-0 bottom-0"}`}
      >
        <Tab icon="map" label="nav.map" to={{ pathname: MAP, search }} />
        <Tab icon="grid" label="nav.patterns" to={{ pathname: HEATMAP, search }} />
        <Tab icon="route" label="nav.plan" />
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

function Tab({ icon, label, to }: { icon: IconName; label: MessageKey; to?: To }) {
  const base =
    "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg py-1.5 text-[11px] font-[550]";
  if (!to)
    return (
      <span className={`${base} text-text-3 opacity-55`}>
        <Icon name={icon} className="size-[22px]" />
        <span>{t("nav.soonTab", { label: t(label), soon: t("nav.soon") })}</span>
      </span>
    );
  return (
    <NavLink
      to={to}
      className={({ isActive }) => `${base} ${isActive ? "text-accent" : "text-text-3"}`}
    >
      <Icon name={icon} className="size-[22px]" />
      {t(label)}
    </NavLink>
  );
}

function DataNote({ className }: { className: string }) {
  const { data } = useQuery({
    queryKey: ["datenstand"],
    queryFn: () => api.GET("/datenstand").then(must),
    staleTime: Infinity,
  });
  const month = data?.monate.at(-1);
  return (
    <div className={className}>
      {data && month && (
        <p>{t("data.status", { month: formatPeriod(month), stations: int(data.bahnhoefe) })}</p>
      )}
      <p>
        {t("data.source")}{" "}
        <a href={LICENCE} target="_blank" rel="noopener" className="underline">
          {t("data.licence")}
        </a>
      </p>
    </div>
  );
}

function MorePage() {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">
      <h1 className="mb-3 text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
        {t("nav.more")}
      </h1>
      <div className="card flex flex-col gap-0.5 p-2">
        <Soon icon="xfer" label="nav.transfer" />
        <Soon icon="info" label="nav.method" />
        <Soon icon="clock" label="nav.live" />
        <Soon icon="star" label="nav.saved" />
      </div>
      <DataNote className="card mt-4 flex flex-col gap-1 text-xs text-text-3" />
    </div>
  );
}

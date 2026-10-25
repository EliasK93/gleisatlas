import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, NavLink, Outlet, Route, Routes, useLocation, type To } from "react-router";
import { api, must } from "./api";
import HeatmapPage from "./HeatmapPage";
import { t, type MessageKey } from "./i18n";
import { Icon, type IconName } from "./Icon";
import { formatPeriod, int } from "./metrics";

const HEATMAP = "/muster/heatmap";
const LICENCE = "https://creativecommons.org/licenses/by/4.0/deed.de";

export default function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        {/* Until the map page exists, the heatmap is the start page. */}
        <Route index element={<ToHeatmap />} />
        <Route path={HEATMAP} element={<HeatmapPage />} />
        <Route path="/mehr" element={<MorePage />} />
        <Route path="*" element={<ToHeatmap />} />
      </Route>
    </Routes>
  );
}

/** Redirect that keeps the query string, so filters survive. */
function ToHeatmap() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: HEATMAP, search }} replace />;
}

function Shell() {
  // Links carry the query string, so filters persist across pages.
  const { search } = useLocation();
  return (
    <div className="min-h-screen md:grid md:grid-cols-[248px_1fr]">
      <div className="md:sticky md:top-0 md:flex md:h-screen md:flex-col md:gap-1 md:overflow-y-auto md:border-r md:border-border md:bg-surface md:px-3 md:py-4">
        <header className="border-b border-border bg-surface px-4 py-2.5 md:border-0 md:bg-transparent md:p-0">
          <h2>
            <Link
              to={{ pathname: "/", search }}
              className="flex items-center gap-2.5 text-base font-[650] tracking-[-0.01em] md:px-2 md:pt-1 md:pb-3.5 md:text-[17px]"
            >
              <span className="grid size-7 place-items-center rounded-lg bg-linear-135 from-r1 to-accent text-on-accent">
                <Icon name="check" className="size-4" strokeWidth={2.4} />
              </span>
              {t("app.title")}
            </Link>
          </h2>
        </header>
        <nav aria-label={t("nav.label")} className="hidden md:flex md:flex-1 md:flex-col md:gap-1">
          <Group label="nav.discover" />
          <Soon icon="map" label="nav.map" />
          <NavLink
            to={{ pathname: HEATMAP, search }}
            className={({ isActive }) =>
              `nav-item ${isActive ? "bg-accent-soft text-accent" : "text-text-2 hover:bg-surface-2 hover:text-text"}`
            }
          >
            <Icon name="grid" />
            {t("nav.heatmap")}
          </NavLink>
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

      <div className="flex min-w-0 flex-col pb-20 md:pb-0">
        <main className="flex-1">
          <Outlet />
        </main>
        <footer className="mx-auto mt-8 flex w-full max-w-[1200px] flex-wrap gap-x-6 gap-y-2 border-t border-border px-4 pt-4 pb-7 text-xs text-text-3 md:px-8">
          <b className="font-semibold text-text-2">{t("footer.disclaimer")}</b>
          <span>{t("footer.attribution")}</span>
        </footer>
      </div>

      <nav
        aria-label={t("nav.label")}
        className="fixed inset-x-0 bottom-0 z-10 grid grid-cols-4 border-t border-border bg-surface px-1 pt-1 pb-2 md:hidden"
      >
        <Tab icon="map" label="nav.map" />
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

/** A page that is not built yet: dimmed, tagged "bald", not a link. */
function Soon({ icon, label }: { icon: IconName; label: MessageKey }) {
  return (
    <span className="nav-item text-text-2 opacity-55">
      <Icon name={icon} />
      <span>{t(label)}</span>
      <span className="ml-auto rounded-full border border-border px-1.5 text-[10.5px] text-text-3">
        {t("nav.soon")}
      </span>
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

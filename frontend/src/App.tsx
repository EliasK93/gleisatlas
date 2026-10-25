import { t } from "./i18n";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-border bg-surface px-4 py-6">
        <h1 className="text-2xl font-semibold">{t("app.title")}</h1>
        <p className="mt-1 text-text-2">{t("app.subtitle")}</p>
      </header>
      <main className="flex-1 px-4 py-6" />
      <footer className="border-t border-border px-4 py-4 text-xs text-text-3">
        <p>{t("footer.disclaimer")}</p>
        <p>{t("footer.attribution")}</p>
      </footer>
    </div>
  );
}

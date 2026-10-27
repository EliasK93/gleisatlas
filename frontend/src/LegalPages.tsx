import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { t, tx } from "./i18n";

export const IMPRESSUM = "/impressum";
export const DATENSCHUTZ = "/datenschutz";

const SECTIONS = ["controller", "hosting", "logs", "map", "storage", "rights"] as const;

/** The two legal links, shared by the sidebar and the footer. They keep the query string like the other shell links. */
export function LegalLinks({ className }: { className?: string }) {
  const { search } = useLocation();
  return (
    <div className={className}>
      <div className="flex gap-x-4">
        <Link to={{ pathname: IMPRESSUM, search }} className="hit underline">
          {t("legal.impressum")}
        </Link>
        <Link to={{ pathname: DATENSCHUTZ, search }} className="hit underline">
          {t("legal.privacy")}
        </Link>
      </div>
    </div>
  );
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1200px] px-4 pt-4 md:px-8 md:pt-6">
      <h1 className="mb-3 text-[21px] leading-tight font-[650] tracking-[-0.015em] md:text-[26px]">
        {title}
      </h1>
      <div className="flex max-w-[68ch] flex-col gap-3 text-text-2">{children}</div>
    </div>
  );
}

export function ImpressumPage() {
  const { VITE_IMPRESSUM_NAME, VITE_IMPRESSUM_STREET, VITE_IMPRESSUM_CITY, VITE_IMPRESSUM_EMAIL } =
    import.meta.env;
  return (
    <Page title={t("legal.impressum")}>
      <p>{t("legal.impressum.lead")}</p>
      <address className="not-italic">
        {VITE_IMPRESSUM_NAME}
        <br />
        {VITE_IMPRESSUM_STREET}
        <br />
        {VITE_IMPRESSUM_CITY}
      </address>
      <p>
        {t("legal.impressum.email")}:{" "}
        <a href={`mailto:${VITE_IMPRESSUM_EMAIL}`} className="underline">
          {VITE_IMPRESSUM_EMAIL}
        </a>
      </p>
    </Page>
  );
}

export function PrivacyPage() {
  const { search } = useLocation();
  const vars = {
    impressum: (
      <Link to={{ pathname: IMPRESSUM, search }} className="underline">
        {t("legal.impressum")}
      </Link>
    ),
    openfreemap: (
      <a href="https://openfreemap.org" target="_blank" rel="noopener" className="underline">
        OpenFreeMap
      </a>
    ),
  };
  return (
    <Page title={t("legal.privacy")}>
      <p>{t("legal.privacy.note")}</p>
      {SECTIONS.map((s) => (
        <section key={s}>
          <h2 className="mb-1 font-semibold text-text">{t(`legal.p.${s}.title`)}</h2>
          <p>{tx(`legal.p.${s}.text`, vars)}</p>
        </section>
      ))}
    </Page>
  );
}

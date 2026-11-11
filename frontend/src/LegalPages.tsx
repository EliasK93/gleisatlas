import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";
import { t, tx } from "./i18n";
import { Page, PageTitle } from "./ui";

export const IMPRESSUM = "/impressum";
export const DATENSCHUTZ = "/datenschutz";
/** The repository, whose README and LICENSE name the licences of the app, data and map. */
const SOURCE = "https://github.com/EliasK93/gleisatlas";

/** The data licence, named and linked; the placeholder value of the footer attribution. */
export function LicenceLink() {
  return (
    <a href={t("data.licenceUrl")} target="_blank" rel="noopener" className="underline">
      {t("data.licence")}
    </a>
  );
}

/** The source dataset, named and linked; a placeholder value of the footer attribution. */
export function DatasetLink() {
  return (
    <a href={t("data.datasetUrl")} target="_blank" rel="noopener" className="underline">
      {t("data.dataset")}
    </a>
  );
}

const SECTIONS = ["controller", "hosting", "logs", "map", "storage", "rights"] as const;

/** The two legal links, shared by the sidebar and the footer. They keep the query string like the other shell links. */
export function LegalLinks({ className }: { className?: string }) {
  const { search } = useLocation();
  return (
    <div className={className}>
      <div className="flex flex-wrap gap-x-4">
        <Link to={{ pathname: IMPRESSUM, search }} className="hit underline">
          {t("legal.impressum")}
        </Link>
        <Link to={{ pathname: DATENSCHUTZ, search }} className="hit underline">
          {t("legal.privacy")}
        </Link>
        <a href={SOURCE} target="_blank" rel="noopener" className="hit underline">
          {t("legal.source")}
        </a>
      </div>
    </div>
  );
}

function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Page>
      <PageTitle className="mb-3">{title}</PageTitle>
      <div className="flex max-w-[68ch] flex-col gap-3 text-text-2">{children}</div>
    </Page>
  );
}

/** The provider's details from the build environment; until all four are set, a placeholder line. */
export function ImpressumPage() {
  const { VITE_IMPRESSUM_NAME, VITE_IMPRESSUM_STREET, VITE_IMPRESSUM_CITY, VITE_IMPRESSUM_EMAIL } =
    import.meta.env;
  const complete =
    VITE_IMPRESSUM_NAME && VITE_IMPRESSUM_STREET && VITE_IMPRESSUM_CITY && VITE_IMPRESSUM_EMAIL;
  return (
    <LegalPage title={t("legal.impressum")}>
      <p>{t("legal.impressum.lead")}</p>
      {complete ? (
        <>
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
        </>
      ) : (
        <p>{t("legal.impressum.pending")}</p>
      )}
    </LegalPage>
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
    openfreemapPrivacy: (
      <a
        href="https://openfreemap.org/privacy/"
        target="_blank"
        rel="noopener"
        className="underline"
      >
        {t("legal.p.map.link")}
      </a>
    ),
  };
  return (
    <LegalPage title={t("legal.privacy")}>
      <p>{t("legal.privacy.note")}</p>
      {SECTIONS.map((s) => (
        <section key={s}>
          <h2 className="mb-1 font-semibold text-text">{t(`legal.p.${s}.title`)}</h2>
          <p>{tx(`legal.p.${s}.text`, vars)}</p>
        </section>
      ))}
    </LegalPage>
  );
}

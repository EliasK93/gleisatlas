import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
// `vite preview` sends the headers the deployed site sends, so the CSP is testable end to end.
import swa from "./public/staticwebapp.config.json" with { type: "json" };

/** Without these a build would ship a site with no API address or an empty Impressum. */
const REQUIRED = [
  "VITE_API_URL",
  "VITE_IMPRESSUM_NAME",
  "VITE_IMPRESSUM_STREET",
  "VITE_IMPRESSUM_CITY",
  "VITE_IMPRESSUM_EMAIL",
];

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const env = loadEnv(mode, ".", "VITE_");
    const missing = REQUIRED.filter((key) => !env[key]);
    if (missing.length)
      throw new Error(
        `Set ${missing.join(", ")} (frontend/.env.production.local or the environment) before building.`,
      );
  }
  return { plugins: [react(), tailwindcss()], preview: { headers: swa.globalHeaders } };
});

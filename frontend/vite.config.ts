import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
// `vite preview` sends the headers the deployed site sends, so the CSP is testable end to end.
import swa from "./public/staticwebapp.config.json" with { type: "json" };

/** Without these a build would ship a site with no API address. The Impressum shows a placeholder until its keys are set. */
const REQUIRED = ["VITE_API_URL"];

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    const env = loadEnv(mode, ".", "VITE_");
    const missing = REQUIRED.filter((key) => !env[key]);
    if (missing.length)
      throw new Error(
        `Set ${missing.join(", ")} (frontend/.env.production.local or the environment) before building.`,
      );
  }
  // Uncommon ports, so other dev servers rarely collide; strict, because the API's CORS
  // allows only this origin.
  return {
    plugins: [react(), tailwindcss()],
    server: { port: 5317, strictPort: true },
    preview: { port: 4317, strictPort: true, headers: swa.globalHeaders },
  };
});

declare global {
  interface ImportMetaEnv {
    readonly VITE_API_URL?: string;
    readonly VITE_IMPRESSUM_NAME?: string;
    readonly VITE_IMPRESSUM_STREET?: string;
    readonly VITE_IMPRESSUM_CITY?: string;
    readonly VITE_IMPRESSUM_EMAIL?: string;
  }
}

export {};

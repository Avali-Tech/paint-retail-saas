/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Where the browser reaches the API; defaults to "/api" (proxied by Vite and in production). */
  readonly VITE_API_BASE_URL?: string;
}

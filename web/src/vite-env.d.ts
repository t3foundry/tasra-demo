/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Package version injected by `web/vite.config.ts` at build time. */
  readonly VITE_APP_VERSION: string
}
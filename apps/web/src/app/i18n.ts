import type { BackendModule } from "i18next";
import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { storageKey } from "@/shared/lib/branding";

// Lazy-load each namespace as its own chunk via Vite's `import.meta.glob`.
// The static-import version previously bundled all 16 (2 locales × 8 ns)
// JSON files into the main entry, ~30 kB raw of inactive-language strings
// included on every cold start. Now each namespace ships as a separate JS
// chunk that the i18next backend fetches on demand — Vite resolves the
// pattern at build time so the dynamic-import path is statically known and
// gets a deterministic chunk per file.
//
// The previous comment about avoiding `i18next-http-backend` still holds:
// we don't pay an HTTP round trip per namespace because Vite serves the
// chunks via the same code-split path as the rest of the SPA (HTTP/2
// multiplexed alongside route chunks).
type LocaleLoader = () => Promise<{ default: Record<string, unknown> }>;

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  "../locales/*/*.json",
);

async function loadNamespace(language: string, namespace: string): Promise<Record<string, unknown>> {
  const key = `../locales/${language}/${namespace}.json`;
  const loader = localeModules[key] as LocaleLoader | undefined;
  if (!loader)
    return {};
  const mod = await loader();
  return mod.default;
}

const lazyBackend: BackendModule = {
  type: "backend",
  init: () => {},
  read(language, namespace, callback) {
    loadNamespace(language, namespace)
      .then(data => callback(null, data))
      .catch((err: unknown) => callback(err as Error, false));
  },
};

// Map i18next language codes to BCP-47 codes for the document `lang` attribute.
// We currently support only EN and ZH; ZH is mapped to `zh-CN` by default.
function toBcp47(lng: string): string {
  if (lng.toLowerCase().startsWith("zh"))
    return "zh-CN";
  return "en";
}

function syncDocumentLang(lng: string): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = toBcp47(lng);
  }
}

/**
 * Promise that resolves once the active language's namespaces have loaded.
 * Importers should `await` this before mounting React so the first paint
 * already has translations and avoids a key-flash. Resolves immediately on
 * subsequent imports.
 */
export const i18nReady: Promise<unknown> = i18n
  .use(lazyBackend)
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: ["en", "zh"],
    defaultNS: "common",
    fallbackNS: "common",
    ns: ["common", "audit", "documents", "errors", "groups", "issues", "policies", "users"],
    // Disable suspense — we gate the React mount on `i18nReady` instead, so
    // `useTranslation` never sees the loading state.
    react: { useSuspense: false },
    // Re-load the fallback language too, so missing keys in the active
    // language fall through to English without a second round-trip.
    load: "languageOnly",
    partialBundledLanguages: false,
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: storageKey("lang"),
    },
    interpolation: {
      escapeValue: false,
    },
  })
  .then(() => syncDocumentLang(i18n.language));

i18n.on("languageChanged", (lng) => {
  syncDocumentLang(lng);
});

export default i18n;

import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";

// Bundle every locale namespace at build time. Vite resolves the JSON imports
// statically; the bundler then code-splits them per-locale chunk if the SPA
// is ever language-dynamic. Inlining drops i18next-http-backend (~10 KB) and
// the first-paint round-trip that previously fetched each namespace JSON.
import enAudit from "../../public/locales/en/audit.json";
import enCommon from "../../public/locales/en/common.json";
import enDocuments from "../../public/locales/en/documents.json";
import enGroups from "../../public/locales/en/groups.json";
import enPolicies from "../../public/locales/en/policies.json";
import enTodos from "../../public/locales/en/todos.json";
import enUsers from "../../public/locales/en/users.json";
import zhAudit from "../../public/locales/zh/audit.json";
import zhCommon from "../../public/locales/zh/common.json";
import zhDocuments from "../../public/locales/zh/documents.json";
import zhGroups from "../../public/locales/zh/groups.json";
import zhPolicies from "../../public/locales/zh/policies.json";
import zhTodos from "../../public/locales/zh/todos.json";
import zhUsers from "../../public/locales/zh/users.json";

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

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    fallbackLng: "en",
    supportedLngs: ["en", "zh"],
    defaultNS: "common",
    fallbackNS: "common",
    ns: ["common", "audit", "documents", "groups", "policies", "todos", "users"],
    resources: {
      en: {
        common: enCommon,
        audit: enAudit,
        documents: enDocuments,
        groups: enGroups,
        policies: enPolicies,
        todos: enTodos,
        users: enUsers,
      },
      zh: {
        common: zhCommon,
        audit: zhAudit,
        documents: zhDocuments,
        groups: zhGroups,
        policies: zhPolicies,
        todos: zhTodos,
        users: zhUsers,
      },
    },
    detection: {
      order: ["localStorage", "navigator"],
      caches: ["localStorage"],
      lookupLocalStorage: "app-lang",
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

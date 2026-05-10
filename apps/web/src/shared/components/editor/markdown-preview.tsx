// Read-only markdown renderer. Used by the editor's `readOnly` path so a
// document detail or comment view does not need to mount the heavy Lexical
// stack — react-markdown + remark-gfm renders directly, with Shiki for
// fenced code blocks. Output is sanitized via DOMPurify before
// dangerouslySetInnerHTML (Shiki's HTML is the only place we inject raw
// markup; react-markdown does not enable rehype-raw, so the markdown body
// itself never produces inline HTML).
/* eslint-disable react-dom/no-dangerously-set-innerhtml,react/set-state-in-effect,react/no-children-to-array */
import type { ReactNode } from "react";
import type { Components } from "react-markdown";
import type { HighlighterCore, LanguageInput } from "shiki/core";

import DOMPurify from "dompurify";
import { Children, isValidElement, useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/shared/lib/utils";

import "github-markdown-css/github-markdown.css";
import "./markdown-preview.css";

interface MarkdownPreviewProps {
  readonly value: string;
  readonly className?: string | undefined;
}

// ── Shiki support (lazy) ──

type MarkdownShikiLanguage
  = | "bash"
    | "css"
    | "html"
    | "js"
    | "json"
    | "jsx"
    | "md"
    | "sh"
    | "shell"
    | "ts"
    | "tsx"
    | "xml"
    | "yaml";

type MarkdownThemeMode = "dark" | "light";
type MarkdownShikiTheme = "github-dark" | "github-light";

const shikiLanguageAliases: Record<string, MarkdownShikiLanguage> = {
  bash: "bash",
  css: "css",
  html: "html",
  javascript: "js",
  js: "js",
  json: "json",
  jsx: "jsx",
  markdown: "md",
  md: "md",
  sh: "sh",
  shell: "shell",
  ts: "ts",
  tsx: "tsx",
  typescript: "ts",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
};

const highlightedCodeCache = new Map<string, string>();
let highlighterPromise: Promise<HighlighterCore> | undefined;
const loadedLanguages = new Set<MarkdownShikiLanguage>();
const langLoaderPromises = new Map<MarkdownShikiLanguage, Promise<void>>();
const loadedThemes = new Set<MarkdownShikiTheme>();

function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
  ]).then(([core, engine]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    langs: [],
    themes: [],
  }));
  return highlighterPromise;
}

async function ensureTheme(theme: MarkdownShikiTheme): Promise<void> {
  if (loadedThemes.has(theme))
    return;
  const highlighter = await getHighlighter();
  const themeModule = theme === "github-dark"
    ? await import("shiki/themes/github-dark.mjs")
    : await import("shiki/themes/github-light.mjs");
  await highlighter.loadTheme(themeModule.default);
  loadedThemes.add(theme);
}

function loadLang(lang: MarkdownShikiLanguage): Promise<void> {
  const existing = langLoaderPromises.get(lang);
  if (existing)
    return existing;
  const promise = (async () => {
    const highlighter = await getHighlighter();
    const fileMap: Record<MarkdownShikiLanguage, () => Promise<{ default: unknown }>> = {
      bash: () => import("shiki/langs/shellscript.mjs"),
      sh: () => import("shiki/langs/shellscript.mjs"),
      shell: () => import("shiki/langs/shellscript.mjs"),
      css: () => import("shiki/langs/css.mjs"),
      html: () => import("shiki/langs/html.mjs"),
      js: () => import("shiki/langs/javascript.mjs"),
      json: () => import("shiki/langs/json.mjs"),
      jsx: () => import("shiki/langs/jsx.mjs"),
      md: () => import("shiki/langs/markdown.mjs"),
      ts: () => import("shiki/langs/typescript.mjs"),
      tsx: () => import("shiki/langs/tsx.mjs"),
      xml: () => import("shiki/langs/xml.mjs"),
      yaml: () => import("shiki/langs/yaml.mjs"),
    };
    const mod = await fileMap[lang]();
    await highlighter.loadLanguage(mod.default as LanguageInput);
    loadedLanguages.add(lang);
  })();
  langLoaderPromises.set(lang, promise);
  return promise;
}

function getThemeMode(): MarkdownThemeMode {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark"))
    return "dark";
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches)
    return "dark";
  return "light";
}

function useThemeMode(): MarkdownThemeMode {
  const [themeMode, setThemeMode] = useState<MarkdownThemeMode>(getThemeMode);
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined")
      return undefined;
    const update = () => setThemeMode(getThemeMode());
    const observer = new MutationObserver(update);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    observer.observe(document.documentElement, { attributeFilter: ["class"], attributes: true });
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, []);
  return themeMode;
}

// Shiki ships HTML wrapping a <pre><code> with inline-styled <span>s. Allow
// exactly that surface — no <script>, no `on*` event handlers.
function purifyShikiHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["pre", "code", "span", "br"],
    ALLOWED_ATTR: ["class", "style"],
    ALLOW_DATA_ATTR: false,
  });
}

const RE_SHIKI_LANGUAGE = /language-(\S+)/;
const RE_TRAILING_NEWLINE = /\n$/;

function getShikiLanguage(className: string | undefined): MarkdownShikiLanguage | undefined {
  const match = RE_SHIKI_LANGUAGE.exec(className ?? "");
  if (!match?.[1])
    return undefined;
  return shikiLanguageAliases[match[1].toLowerCase()];
}

function reactNodeToText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number")
    return String(node);
  if (Array.isArray(node))
    return node.map(reactNodeToText).join("");
  if (isValidElement<{ children?: ReactNode }>(node))
    return reactNodeToText(node.props.children);
  return "";
}

function ShikiCodeBlock({
  code,
  language,
}: {
  readonly code: string;
  readonly language: MarkdownShikiLanguage;
}) {
  const themeMode = useThemeMode();
  const theme: MarkdownShikiTheme = themeMode === "dark" ? "github-dark" : "github-light";
  const cacheKey = `${theme}:${language}:${code}`;
  const [html, setHtml] = useState(() => highlightedCodeCache.get(cacheKey) ?? "");

  useEffect(() => {
    const cached = highlightedCodeCache.get(cacheKey);
    if (cached) {
      setHtml(cached);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (!loadedLanguages.has(language))
          await loadLang(language);
        const highlighter = await getHighlighter();
        await ensureTheme(theme);
        const nextHtml = highlighter.codeToHtml(code, { lang: language, theme });
        highlightedCodeCache.set(cacheKey, nextHtml);
        if (!cancelled)
          setHtml(nextHtml);
      }
      catch {
        if (!cancelled)
          setHtml("");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, language, theme]);

  if (!html) {
    return (
      <pre className="md-preview-code-fallback">
        <code>{code}</code>
      </pre>
    );
  }
  return <div className="md-preview-shiki" dangerouslySetInnerHTML={{ __html: purifyShikiHtml(html) }} />;
}

const markdownComponents: Components = {
  pre({ children }) {
    const child = Children.toArray(children)[0];
    if (!isValidElement<{ className?: string; children?: ReactNode }>(child))
      return <pre>{children}</pre>;
    const code = reactNodeToText(child.props.children).replace(RE_TRAILING_NEWLINE, "");
    const language = getShikiLanguage(child.props.className);
    if (!language) {
      return (
        <pre>
          <code className={child.props.className}>{code}</code>
        </pre>
      );
    }
    return <ShikiCodeBlock code={code} language={language} />;
  },
};

export function MarkdownPreview({ value, className }: MarkdownPreviewProps) {
  const themeMode = useThemeMode();
  return (
    <div className={cn("md-preview markdown-body", className)} data-theme={themeMode}>
      <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
        {value || ""}
      </Markdown>
    </div>
  );
}

// Default export so React.lazy can resolve a default-exported component.
export default MarkdownPreview;

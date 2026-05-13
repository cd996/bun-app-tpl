#!/usr/bin/env bun
/* eslint-disable no-console */
/**
 * Verify EN/ZH translation files are in sync. For every locale namespace,
 * compare the set of dot-paths between en/<ns>.json and zh/<ns>.json. Any
 * mismatch (missing on either side) is reported and fails the script.
 *
 * Usage:  bun scripts/check-i18n.ts
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const ROOT = resolve(import.meta.dir, "..");
const LOCALES_DIR = resolve(ROOT, "apps/web/src/locales");

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value)) {
    const next = prefix ? `${prefix}.${k}` : k;
    out.push(...flattenKeys(v, next));
  }
  return out;
}

function loadKeys(lang: string, ns: string): Set<string> {
  const path = resolve(LOCALES_DIR, lang, `${ns}.json`);
  const raw = readFileSync(path, "utf-8");
  return new Set(flattenKeys(JSON.parse(raw)));
}

const langs = readdirSync(LOCALES_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

if (langs.length < 2) {
  console.log("[check-i18n] only one locale present, nothing to compare");
  process.exit(0);
}

const [reference, ...rest] = langs;
const namespaces = readdirSync(resolve(LOCALES_DIR, reference!))
  .filter(f => f.endsWith(".json"))
  .map(f => f.replace(/\.json$/, ""));

let failed = 0;

for (const ns of namespaces) {
  const refKeys = loadKeys(reference!, ns);
  for (const lang of rest) {
    let otherKeys: Set<string>;
    try {
      otherKeys = loadKeys(lang, ns);
    }
    catch {
      console.error(`[check-i18n] ${lang}/${ns}.json missing (vs ${reference})`);
      failed++;
      continue;
    }
    const missingInOther = [...refKeys].filter(k => !otherKeys.has(k));
    const missingInRef = [...otherKeys].filter(k => !refKeys.has(k));
    if (missingInOther.length || missingInRef.length) {
      console.error(`[check-i18n] ${ns}: ${reference} ↔ ${lang} mismatch`);
      if (missingInOther.length) {
        console.error(`  missing in ${lang}/${ns}.json:`);
        for (const k of missingInOther)
          console.error(`    - ${k}`);
      }
      if (missingInRef.length) {
        console.error(`  missing in ${reference}/${ns}.json:`);
        for (const k of missingInRef)
          console.error(`    - ${k}`);
      }
      failed++;
    }
  }
}

if (failed > 0) {
  console.error(`[check-i18n] ${failed} namespace(s) out of sync`);
  process.exit(1);
}

console.log(`[check-i18n] all ${namespaces.length} namespace(s) in sync across ${langs.length} locales`);

#!/usr/bin/env bun
// Scaffold a new content sub-type module on top of `item` + `file`. Generates
// the module dir, the locale shard, the e2e dir, and patches the aggregate
// files (`db/schema.ts`, `routes/protected.ts`, `tests/e2e/run.ts`) with one
// line each. Refuses if the module dir already exists.
//
// Usage:
//   bun scripts/module-new.ts <name> [--area portal|admin] [--title-key key]
/* eslint-disable no-console */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const { values: cli, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    area: { type: "string", default: "portal" },
    "title-key": { type: "string" },
    help: { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: true,
});

if (cli.help || positionals.length !== 1) {
  console.log("Usage: bun scripts/module-new.ts <name> [--area portal|admin] [--title-key key]");
  process.exit(cli.help ? 0 : 1);
}

const NAME = positionals[0]!;
const AREA = cli.area === "admin" ? "admin" : "portal";

if (!/^[a-z][a-z0-9-]*$/.test(NAME)) {
  console.error(`module name must match /^[a-z][a-z0-9-]*/, got "${NAME}"`);
  process.exit(1);
}

const ROOT = resolve(import.meta.dir, "..");
const MODULE_DIR = resolve(ROOT, `apps/api/src/modules/${NAME}`);
const E2E_DIR = resolve(ROOT, `tests/e2e/modules/${NAME}`);
const WEB_ROUTE_DIR = resolve(ROOT, `apps/web/src/app/routes/_app/${AREA}`);
const LOCALE_EN = resolve(ROOT, `apps/web/src/locales/en/${NAME}.json`);
const LOCALE_ZH = resolve(ROOT, `apps/web/src/locales/zh/${NAME}.json`);

if (existsSync(MODULE_DIR)) {
  console.error(`refusing to overwrite existing module: ${MODULE_DIR}`);
  process.exit(1);
}

mkdirSync(MODULE_DIR, { recursive: true });
mkdirSync(E2E_DIR, { recursive: true });

const TitleCase = NAME[0]!.toUpperCase() + NAME.slice(1).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

const tables = `${NAME.replace(/-/g, "_")}_details`;
const detailsConst = `${NAME.replace(/-/g, "")}Details`;

// ─── apps/api/src/modules/<name>/schema.ts ───
writeFileSync(resolve(MODULE_DIR, "schema.ts"), `import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items } from "@/modules/item/schema";

// '${NAME}' is a sub-type of the \`item\` base. The base owns the universal
// columns (id / short_id / title / status / creator / version / timestamps /
// soft-delete) and the comments / attachments machinery; this table holds
// only ${NAME}-specific business fields.
//
// Run \`bun run --filter @app/api db:generate\` after editing this file to
// mint the migration; commit it together with the schema change.
export const ${detailsConst} = sqliteTable("${tables}", {
  itemId: text("item_id").primaryKey().references(() => items.id, { onDelete: "cascade" }),
  // TODO: add your business columns here.
});
`);

// ─── apps/api/src/modules/<name>/<name>.backup.ts ───
writeFileSync(resolve(MODULE_DIR, `${NAME}.backup.ts`), `import type { BackupContribution } from "@/modules/backup/registry";
import { ${detailsConst} } from "./schema";

export const ${detailsConst}BackupContribution: BackupContribution = {
  name: "${NAME}",
  tables: [${detailsConst}],
  // Base \`items\` + \`policies\` ship the universal rows; declare the
  // dependency so topo-sorted restore preserves FKs.
  deps: ["items", "policies"],
};
`);

// ─── apps/api/src/modules/<name>/<name>.service.ts ───
writeFileSync(resolve(MODULE_DIR, `${NAME}.service.ts`), `import type { AppDatabase } from "@/db";

// Compose \`items\` (via @/modules/item/item.service) + this module's
// details table. Keep cross-module DB access behind the other module's
// service interface — do not import another module's drizzle tables
// directly into business code (see docs/module-standards.md §2.6).

export async function placeholder(_db: AppDatabase): Promise<void> {
  // TODO: replace with real service methods.
}
`);

// ─── apps/api/src/modules/<name>/<name>.routes.ts ───
writeFileSync(resolve(MODULE_DIR, `${NAME}.routes.ts`), `import type { AppEnv } from "@/shared/lib/types";
import { Hono } from "hono";
import { authRequired } from "@/shared/middleware/auth";

export function ${TitleCase}Routes() {
  const router = new Hono<AppEnv>();

  router.use("*", authRequired);

  // GET /api/${NAME} — list. Replace with the real handler.
  router.get("/${NAME}", c => c.json({ success: true, data: [] }));

  return router;
}
`);

// ─── apps/api/src/modules/<name>/index.ts ───
writeFileSync(resolve(MODULE_DIR, "index.ts"), `import { registerBackupContribution } from "@/modules/backup/registry";
import { ${detailsConst}BackupContribution } from "./${NAME}.backup";

export { ${TitleCase}Routes as ${NAME.replace(/-/g, "")}Routes } from "./${NAME}.routes";

registerBackupContribution(${detailsConst}BackupContribution);
`);

// ─── apps/api/src/modules/<name>/<name>.test.ts ───
writeFileSync(resolve(MODULE_DIR, `${NAME}.test.ts`), `import { describe, expect, test } from "bun:test";

// Unit tests for the ${NAME} module. Pair with the e2e suite at
// tests/e2e/modules/${NAME}/ to satisfy the "unit + e2e together = 100%"
// rule in docs/module-standards.md §5.0.

describe("${NAME}", () => {
  test("scaffold compiles", () => {
    expect(true).toBe(true);
  });
});
`);

// ─── locales ───
writeFileSync(LOCALE_EN, `{
  "title": "${TitleCase}"
}
`);
writeFileSync(LOCALE_ZH, `{
  "title": "${TitleCase}"
}
`);

// ─── e2e stub ───
writeFileSync(resolve(E2E_DIR, `${NAME}.test.ts`), `import { describe, expect, test } from "bun:test";
import { getClient } from "../../lib/oidc";

// Live e2e for the ${NAME} module. Drives the API through the dev stack
// (dex + libsql + encrypted DB). At minimum cover: happy path, permission
// matrix (unauth → 401, non-admin → 403 where applicable, admin → 200),
// cross-user behaviour, multipart uploads if any, and audit landing.

describe("${NAME} routes", () => {
  test("GET /api/${NAME} returns 200 for an authenticated caller", async () => {
    const client = await getClient("user@example.com");
    const res = await client.fetch("/api/${NAME}");
    expect(res.status).toBe(200);
  });
});
`);

// ─── web route file (just the layout shell) ───
const ROUTE_PATH = resolve(WEB_ROUTE_DIR, `${NAME}.tsx`);
if (!existsSync(ROUTE_PATH)) {
  mkdirSync(WEB_ROUTE_DIR, { recursive: true });
  const titleKey = cli["title-key"] ?? `page.${NAME}.title`;
  writeFileSync(ROUTE_PATH, `/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/${AREA}/${NAME}")({
  staticData: { titleKey: "${titleKey}" },
  component: ${TitleCase}Layout,
});

function ${TitleCase}Layout() {
  return <Outlet />;
}
`);
}

// ─── aggregate-file patches ───
//
// Each aggregate file gets exactly one new line (see module-standards
// §"Core principle"). The patches are idempotent: re-running the script
// for an already-registered module reports "skipped".

function patchOnce(file: string, marker: RegExp, snippet: string, label: string): void {
  const path = resolve(ROOT, file);
  const text = readFileSync(path, "utf-8");
  if (text.includes(snippet.trim())) {
    console.log(`  ${file} — already contains ${label}`);
    return;
  }
  const m = marker.exec(text);
  if (!m) {
    console.warn(`  ${file} — could not find anchor for ${label}, please add manually:\n    ${snippet.trim()}`);
    return;
  }
  const insertAt = m.index + m[0].length;
  const next = `${text.slice(0, insertAt)}${snippet}${text.slice(insertAt)}`;
  writeFileSync(path, next);
  console.log(`  ${file} — added ${label}`);
}

// db/schema.ts: append a re-export line at the bottom.
patchOnce(
  "apps/api/src/db/schema.ts",
  /export \* from "@\/modules\/[^"]+\/schema";\n(?![\s\S]*export \* from)/,
  `export * from "@/modules/${NAME}/schema";\n`,
  "schema re-export",
);

// routes/protected.ts: add import + mount.
patchOnce(
  "apps/api/src/routes/protected.ts",
  /import { issueRoutes } from "@\/modules\/issue";\n/,
  `import { ${NAME.replace(/-/g, "")}Routes } from "@/modules/${NAME}";\n`,
  "route import",
);
patchOnce(
  "apps/api/src/routes/protected.ts",
  /app\.route\("\/", issueRoutes\(\)\);\n/,
  `  app.route("/", ${NAME.replace(/-/g, "")}Routes());\n`,
  "route mount",
);

// tests/e2e/run.ts: add MODULE_DIRS entry. The array literal is a
// well-known location; match the first array containing `"system"`.
patchOnce(
  "tests/e2e/run.ts",
  /"system",\n/,
  `  "${NAME}",\n`,
  "MODULE_DIRS entry",
);

console.log(`\n[module-new] scaffolded "${NAME}" — manual follow-up:`);
console.log(`  - Fill in business fields in apps/api/src/modules/${NAME}/schema.ts`);
console.log("  - bun run --filter @app/api db:generate  # mint the migration");
console.log("  - Add real route + service logic");
console.log(`  - Optional: add ${WEB_ROUTE_DIR.replace(ROOT, "")}/-${NAME}.nav.ts + register it in sidebar/registry.ts to surface the page`);
console.log("  - bun run check");

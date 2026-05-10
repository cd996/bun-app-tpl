# Module Standards

This document defines the hard requirements for adding a new business module under `apps/api/src/modules/` or `apps/web/src/app/routes/`. It covers workflow, file layout, code, documentation, testing, and commits. **Every clause below must be satisfied before a new module is merged to main.**

Reference modules in this repo: `account` ([account.md](modules/account.md)), `document` ([document.md](modules/document.md)), `todo` ([todo.md](modules/todo.md)), `policy` ([policy.md](modules/policy.md)).

---

## Core principle: module autonomy / minimal aggregate files

> **If it can be split out, split it out — do not modify shared aggregate files.**

A module owns all of its code, schema, i18n, menu data, and documentation fragments under `modules/<name>/`. Shared aggregate files act **as a registry only**: each new module is allowed **at most one import line / one index line** per aggregate file. Direct writes of business fields, table definitions, or translation values are not accepted.

**Aggregate-file inventory + corresponding module-owned shard**:

| Aggregate file | Allowed change | Module-owned shard |
|---|---|---|
| `apps/api/src/db/schema.ts` | One `export * from "@/modules/<name>/schema"` line | `modules/<name>/schema.ts` |
| `apps/api/src/routes/protected.ts` | One import + one `app.route("/", <name>Routes())` line | `modules/<name>/<name>.routes.ts` + `index.ts` export |
| `apps/web/public/locales/{en,zh}/common.json` | **No new module keys**; new modules use i18next namespace shards | `routes/.../<module>/locales/{en,zh}.json` |
| `apps/web/src/shared/components/sidebar/registry.ts` | One import + one array entry (2 lines total) | Module exports `<name>.nav.ts` (NavItem instance) |
| `docs/architecture.md` / `api.md` / `database.md` | One table row | Full content lives in `docs/modules/<name>.md` |
| `docs/changelog.md` | One dated entry at the top | — |
| `tests/e2e/run.ts` | One string entry in the `MODULE_DIRS` array | `tests/e2e/modules/<name>/*.test.ts` |
| `apps/web/src/app/routeTree.gen.ts` | Auto-generated; **never hand-edit** (rebuild via `bun run --filter @app/web build`) | File-based routes |

**Things that violate the principle (PR will be rejected)**:

- Defining a new module's tables directly in `db/schema.ts` (they must live in the module's `schema.ts`).
- Appending `"<module>.…"` keys to `common.json` (use namespace sharding instead).
- Writing middleware or business conditionals inside `protected.ts` (mount them inside the module's own routes file).
- Hardcoding the module's i18n key / route path / icon in `app-sidebar.tsx` (the module exports a NavItem via `<name>.nav.ts`; the registry collects it).

**Legacy exception**: any module whose tables / keys / mounts still live in aggregate files is treated as legacy code and is not forced to migrate; when refactoring a legacy module, migrate it to the principle as part of the refactor.

---

## 1. Workflow

For non-trivial modules, capture the design intent in the PR description before writing code: file layout, schema, routes, dependencies, risks, and explicit out-of-scope items. Land the change as the commit chain that implements the design (squash or split as makes sense). The repository does not maintain a separate plan/task tracker — git history + the PR is the record.

---

## 2. Backend module conventions

### 2.1 File layout

```text
apps/api/src/modules/<name>/
  <name>.routes.ts          # OpenAPIHono route definitions; admin routes
  <name>.service.ts         # Business logic + DB queries (single file for small modules)
  <feature>.service.ts      # Sub-domain split for large modules
  <name>.test.ts            # bun:test integration tests (routes + service)
  <feature>.test.ts         # Sub-domain unit tests (as needed)
  index.ts                  # Re-exports routes + necessary types only
```

**Hard rules**:

- Module directory name: `kebab-case`, singular; file names: `kebab-case.ts`.
- `index.ts` may contain only `export { … }` statements; no logic.
- A single file must stay ≤ 800 lines; anything larger has to be split by sub-domain.
- The service layer must not read `Bun.env` directly; use `c.get("config")`.

**Meta-module exception** (parent folder hosting tightly-coupled sub-modules — see `account/{auth,groups,users}/`):

- Each sub-module owns its own `schema.ts`, so `db/schema.ts` lists one `export *` line **per sub-module** (not per meta-module).
- The meta-module's `index.ts` exports a single aggregator (`accountRoutes()`) that mounts each sub-module's routes; `routes/protected.ts` mounts the aggregator once.
- All other rules apply per sub-module (audit, schema sharding, namespace isolation, etc.). Avoid this pattern unless the sub-modules genuinely co-evolve (e.g. account = auth + sessions + users + groups all bound to the same identity story).

### 2.2 Naming and IDs

- Business entity IDs: **8-character lowercase nanoid** (`nanoid()` from `apps/api/src/shared/lib/id.ts`).
- Audit logs and other append-only tables that need monotonic ordering: **ULID** (e.g. `audit_events.id`).
- Route prefix: `/api/<module-name>/...`; sub-resources are plural (`/accounts`, `/transactions`).
- Audit action naming: `<module>.<resource>.<verb>` (lowercase with underscores), e.g. `document.created` / `todo.attachment_uploaded`.

### 2.3 Database

- Table names: `<module>_<resource>` (snake_case plural), e.g. `document_attachments`, `todo_comments`.
- Columns: snake_case; time fields are ISO 8601 strings; booleans use SQLite integer; monetary amounts use TEXT + `decimal.js`.
- After modifying `apps/api/src/db/schema.ts`, you must run `bun run db:generate` to produce a migration; commit the migration file together with `meta/_journal.json`.
- Deletes: default to soft delete (`is_deleted` flag or a `status` column) to preserve foreign-key referential integrity.
- **Forbidden**: hand-written migration SQL; skipping `db:generate`.

### 2.4 Route mounting

Three route groups exist under `apps/api/src/routes/`:

| Group | File | Mounted in | Use case |
|---|---|---|---|
| public | `public.ts` | locked + unlocked | Reachable in both states (health, encryption status) |
| setup | `setup.ts` | locked only | Reachable only while the DB is locked (encryption init / unlock) |
| protected | `protected.ts` | unlocked only (`requireUnlocked` defense-in-depth) | Business routes; modules apply their own `authRequired` / `adminRequired` |

A new module's routes default to `protected.ts`. Use `public.ts` only when the route legitimately must answer in both states. Use `setup.ts` only when the route exists exclusively to recover the system from a locked state.

- `protected.ts` applies `requireUnlocked` by default; the module itself wraps `authRequired` / `adminRequired` explicitly inside its `<name>.routes.ts`.
- Inbound validation failures: defer to `OpenAPIHono`'s `defaultHook`, which returns a uniform 422 `VALIDATION_ERROR`.
- Error response shape: `{ success: false, error: { code, message } }`. Success response shape: `{ success: true, data, meta? }`.
- Webhook / Bearer-token routes: create a separate `<name>.external.routes.ts`; the CSRF guard automatically lets `Authorization: Bearer …` requests through.

### 2.5 Middleware and context

- Do not add new global middleware; module-specific needs go into route-level `app.use(...)` inside `<name>.routes.ts`.
- Cross-module reusable middleware lives under `apps/api/src/shared/middleware/`.
- Read context via `c.get("db" | "config" | "logger" | "user")`; do not inject new singletons inside the service layer.

### 2.6 Schema sharding (mandatory)

A module that owns persistent state **must** carry its own schema file; `db/schema.ts` is only a re-export aggregator. Schemaless modules (e.g. `system`, `encryption`, `backup`) own no tables and therefore add no entry to `db/schema.ts`.

```text
apps/api/src/modules/<name>/
  schema.ts                # All tables + indexes + relations for this module

apps/api/src/db/schema.ts  # Only allowed: export * from "@/modules/<name>/schema"
```

- The module's `schema.ts` lives next to its `service` / `routes` files for easy review and removal (deleting a module is `rm -rf modules/<name>` plus deleting one export line).
- `db/schema.ts` may **not** contain table definitions; only import / export lines are allowed.
- `bun run db:generate` follows the import chain to produce migrations — no extra configuration needed; migration files continue to land under `apps/api/drizzle/`.
- Module `schema.ts` files **may** import each other (drizzle foreign keys via `references()` must hold a real table reference, e.g. `todos.creatorId.references(() => users.id)`).
- However, the **service / business layer must not** bypass module boundaries by reading another module's drizzle table objects directly; cross-module queries go through the other module's service interface.

### 2.7 Auditing

**Every write operation** (POST / PATCH / DELETE / trigger-style actions) must call `audit(db, …)`:

```ts
await audit(db, {
  actorId: user.id,
  actorName: user.name,
  action: "<module>.<resource>.<verb>",
  resourceType: "<resource>",
  resourceId,
  detail: { … },         // Only non-sensitive fields
  ip, userAgent,
  result: "success",     // Failures must be recorded too
});
```

Non-human actors (webhook / system): `actorId=client:<id>`, `actorName=client:<name>`.

### 2.8 Backup contribution (mandatory for modules that own tables)

Any module that owns persistent tables **must** register a `BackupContribution` so its rows participate in `/api/backup/export` and `/api/backup/import`. Modules without tables (e.g. `system`, `encryption`) skip this section.

**Files**:

```text
apps/api/src/modules/<name>/
  <name>.backup.ts      # exports `<name>BackupContribution: BackupContribution`
  index.ts              # imports it and calls registerBackupContribution(...)
```

**Contribution shape** (`apps/api/src/modules/backup/registry.ts`):

```ts
export interface BackupContribution {
  readonly name: string;             // stable identifier in backup files
  readonly tables: readonly SQLiteTable[];
  readonly deps: readonly string[];  // names of other modules that must restore first
}
```

**Pattern** (example: a module that depends on `users`):

```ts
// apps/api/src/modules/<name>/<name>.backup.ts
import type { BackupContribution } from "@/modules/backup/registry";
import { myThings } from "@/modules/<name>/schema";

export const myBackupContribution: BackupContribution = {
  name: "<name>",
  tables: [myThings],   // parents first within a module
  deps: ["users"],      // string-only — no module imports → no cycles
};
```

```ts
// apps/api/src/modules/<name>/index.ts
import { registerBackupContribution } from "@/modules/backup/registry";
import { myBackupContribution } from "./<name>.backup";

export { myRoutes } from "./<name>.routes";

registerBackupContribution(myBackupContribution);
```

The registration is a top-level side effect; `routes/protected.ts` already imports every module's `index.ts` to mount its routes, so by the time `/api/backup/modules` is reachable, every contribution is on file. `backup/registry.ts` deliberately knows nothing about specific modules — adding a new data module never edits any file inside `modules/backup/`.

**Hard rules**:

- One `BackupContribution` per logical module. If a meta-module (e.g. `account`) lumps several sub-modules together, **the meta-module owns the contribution**; sub-modules do not register separately. This keeps the backup file's `modules` array stable across template versions.
- Within `tables`, list parent tables before their children (so per-module insert order alone satisfies foreign keys).
- `deps` is string-typed and topologically resolved — a module declares only its first-degree dependencies; the registry walks the rest.
- Renaming an existing `name` is a breaking change to the backup file format — bump the file `version` in `apps/api/src/modules/backup/export.service.ts` if you must.

**Tests** (e2e, in `tests/e2e/modules/backup/`):

- `/api/backup/modules` includes the new module's `name`.
- `/api/backup/export` round-trips at least one row of the new module's tables.
- `/api/backup/import` restores the round-tripped data on a fresh DB.

---

## 3. Frontend module conventions

### 3.1 Routing

- File-based routing: `apps/web/src/app/routes/_app/admin/<module>.tsx` (admin) / `_app/portal/<module>.tsx` (regular users).
- Every time a route is added, run `bun run --filter @app/web build` to regenerate `routeTree.gen.ts` and commit the result (CI does not regenerate it).
- Non-route helpers (component fragments, NavItem exports, util tests) co-located inside `routes/` MUST start with the `-` prefix (e.g. `-todo-panel.tsx`, `-attachment-upload.ts`, `-<name>.nav.ts`). TanStack Router's default `routeFileIgnorePrefix: "-"` keeps them out of the route tree; without the prefix the file is registered as a route and the build warns or breaks.
- State: server data goes through TanStack Query; UI state goes through Zustand or local `useState` — do not mix the two.
- HTTP: use the client in `apps/web/src/shared/lib/http.ts`; never call `fetch` directly (CSRF and lock detection both flow through the client).

### 3.2 i18n

- New module strings go into the module's own namespace file (see §3.4); the global `common.json` only retains the layout / button / error keys listed there.
- The English and Chinese files must stay in sync; lint will not flag a missing key, but it is treated as a bug.

### 3.3 Sidebar

- Entry point is `apps/web/src/shared/components/app-sidebar.tsx`; grouped by admin / portal.

### 3.4 i18n sharding (mandatory)

A module **must** load via i18next namespaces; **do not** append new module keys to `common.json`.

**Namespaces are already enabled** (`apps/web/src/app/i18n.ts` currently sets `ns: ["common", "audit", "documents", "groups", "policies", "todos", "users"]`, `fallbackNS: "common"`, `loadPath: locales/{{lng}}/{{ns}}.json`):

- A new module author only needs to: append `"<module>"` to the `ns` array in `i18n.ts`, and place a `<module>.json` under both `public/locales/en/` and `public/locales/zh/`.
- Module components use `useTranslation("<module>")`; keys do **not** carry the `<module>.` prefix (the namespace already isolates them).
- Global keys such as `common.*` / `nav.*` / `page.*` resolve automatically via `fallbackNS: "common"` — no need to write a `common:` prefix on every `t()` call.
- When a module needs another namespace, use `useTranslation(["<module>", "<other>"])` and access the other namespace as `t("<other>:key")` (see `settings-dialog.tsx`, which mounts `common + users`).
- `common.json` only retains global keys (layout, buttons, error messages): app / theme / auth / totp / profile / common / nav / page / portal / login / denied / encryption / settings; new module keys are no longer accepted.

**Module-owned locale shards (recommended target pattern, not yet enabled)**:

```text
apps/web/src/app/routes/_app/<area>/<module>/
  locales/
    en.json
    zh.json
```

These would be copied to `public/locales/<lng>/<module>.json` at build time. Until that build step is added, new modules drop their files directly into `public/locales/`.

---

## 4. Documentation sync

Every new module must update the following documents before merging (**all in the same PR**):

| Document | Update |
|---|---|
| `docs/modules/<name>.md` | New file with the full module description (see existing modules for examples) |
| `docs/architecture.md` | Add one row to the module table + any necessary runtime notes |
| `docs/api.md` | List every new route (method, path, access level, description) |
| `docs/database.md` | List new tables + key columns |
| `docs/changelog.md` | Prepend a `## YYYY-MM-DD [progress]` entry with the change items |
| `docs/README.md` | Only update if you are adding a whole new section; pure module additions leave it alone |

`docs/modules/<name>.md` must include sections for: file layout, lifecycle (when applicable, e.g. schedulers / middleware initialization), database, routes, auditing, **end-to-end coverage** (which `tests/e2e/modules/<name>/*.test.ts` files exist + what each one asserts), and out-of-scope (known limitations / v2 plans).

---

## 5. Testing

### 5.0 Coverage philosophy (read this first)

Two **non-negotiable** rules drive every test the module ships:

1. **Unit + e2e together MUST cover 100% of every line in the module.** Each line of source belongs to exactly one of the two test layers — there is no third bucket. If a line is not reachable from a unit test (because it depends on a real OAuth IdP, libsql encryption, browser cookies, or the live Bun.serve fetch pipeline), then it MUST be reached by an e2e test. "Covered by neither" is rejected at review.

2. **Every user-facing endpoint MUST have 100% e2e coverage.** A "user-facing endpoint" is any HTTP route exposed to the SPA, mobile clients, or external integrators (i.e. anything mounted under `routes/protected.ts` or `routes/public.ts`). Each such route must have at least one e2e case that drives it through the live API process — no exceptions for "internal" or "rarely used" routes. If an admin can call it, an attacker can call it, and the e2e suite is the regression net.

Concretely:

| Layer | Where it lives | What it covers |
|---|---|---|
| Unit | `*.test.ts` next to the source under `apps/api/src/**` | Pure logic: services, helpers, middleware, registries, schema validators, state machines, error envelopes. Aim for 100% on every file the unit-test runner can reach. |
| Live e2e | `tests/e2e/modules/<module>/*.test.ts` | Every HTTP path under `*.routes.ts`, every permission branch, every multipart / streaming / encrypted flow, every audit landing. The user-facing surface is owned here. |

How the two add up to 100%:

- Unit tests own logic that can be exercised in-process without faking infrastructure (DB schema is real via a temp SQLite; libsql encryption / OAuth / fs uploads are NOT faked).
- e2e owns everything that requires the live stack: HTTP wire behaviour, OAuth token exchange against dex, libsql encryption rewrap, ECIES handshakes, TOTP lifecycle, file-system attachment uploads, CSRF + Origin guards under a real `Bun.serve` pipeline, encryption-state restart cycles.
- Anything in between (e.g. a service function that walks the DB but is also called from a route) is allowed to be covered by either or both — but the line MUST be hit by at least one.

The coverage report enforces the unit half via `apps/api/bunfig.toml` thresholds (≥ 85% lines / ≥ 70% functions on the unit-testable surface, with `*.routes.ts` and process-level helpers excluded). The e2e half is enforced by review: every new route file MUST land with a matching `tests/e2e/modules/<module>/*.test.ts` that exercises it.

### 5.1 Backend (unit half of §5.0)

- Framework: `bun:test`; test files (`*.test.ts`) live next to the source.
- Isolation: each test uses a temporary SQLite DB (see `apps/api/src/modules/todo/todo.test.ts` for the setup pattern) and is discarded afterwards.
- Required for the unit layer:
  - **Pure logic and helpers**: 100% lines on every service / middleware / lib utility / registry / schema validator the unit-test runner can reach. The bunfig threshold (≥ 85% lines / ≥ 70% functions aggregate) is the **floor**, not the goal — individual files SHOULD hit 100% unless the residual lines genuinely depend on the live stack and are owned by e2e per §5.0.
  - **Business invariants**: each core constraint the module promises (transaction atomicity, idempotency keys, illegal state-machine transitions, scope checks, etc.) must have a failing-case test in the unit layer.
  - **Auditing**: at least one unit test verifies the `audit_events` row lands with the correct action / actor / resource fields.
- The unit-testable surface excludes route files (`*.routes.ts`), the app composer (`app.ts`), entry points, build artefacts, and process-level helpers — these are owned by §5.3.
- **Forbidden**: mocking the DB; mocking internal service functions; changing the implementation to dodge an assertion.

### 5.2 Frontend

- Framework: vitest (`bun run test` inside `apps/web`).
- Test files (`*.test.ts`) live next to the component (see `attachment-upload.test.ts`).
- Required coverage: pure functions (validation, formatting), key Zustand store actions, form schema parsing.
- React component-render tests are added once `@testing-library/react` is introduced; until then prioritize pure-logic coverage.

### 5.3 End-to-end (e2e — owns the user-facing 100%)

**Hard rule**: every HTTP route mounted to a user (the SPA, mobile clients, external integrators) MUST have e2e coverage. There is no "internal route" exemption; every entry registered under `routes/protected.ts` or `routes/public.ts` is reachable from outside the process and therefore is in the e2e contract. A new route landing in a PR without a matching `tests/e2e/modules/<module>/*.test.ts` case is rejected at review.

The single live e2e suite is the system-of-record for HTTP behaviour: `tests/e2e/modules/<name>/*.test.ts`, run via `bun run test:e2e`. The orchestrator boots dex (auto-extracted from the official OCI image — no docker required), starts the API with `DB_ENCRYPTION=true` against a temp DB under `tests/e2e/.cache/data/<run-id>/`, performs the encryption setup, then runs every module's tests against the live stack, and finally restarts to verify the rate-limit and unlock cycles. JUnit XML + a JSON summary land in `tests/e2e/.cache/reports/<run-ts>/` (with a `latest/` symlink for CI).

In-process integration tests under `apps/api/tests/` were removed deliberately — they overlapped with the live e2e and the duplication created drift. Cross-cutting security guards (CSRF / Origin) live in `tests/e2e/modules/system/security.test.ts`; the encryption rate-limit case lives in its own phase under `tests/e2e/modules/encryption/rate-limit.test.ts`.

#### What every new module must add to the live e2e suite

For each new module **\<module\>**:

- Create the directory `tests/e2e/modules/<module>/` and add at least one `*.test.ts` per top-level resource (e.g. `documents.test.ts`, `attachments.test.ts`).
- Wire the directory into the orchestrator: append `<module>` to `MODULE_DIRS` in `tests/e2e/run.ts`. This is **the only line** the orchestrator should grow per module — everything else lives inside the module's test directory.
- Use the shared helpers — never re-implement them:
  - `getClient(email)` from `tests/e2e/lib/oidc.ts` returns a cached, logged-in `ApiClient` (and self-heals on 401). Use `loginAs(email)` only when the test exercises the login flow itself.
  - `ApiClient` from `tests/e2e/lib/api.ts` carries the cookie jar and supports JSON + multipart (`formData`).
  - For ECIES dance (challenge/unlock/rotate-dek/backup-export), import the same helpers the SPA uses from `packages/shared/src/index` via a relative path — `tests/e2e/` is not a workspace member, so the workspace symlink is not reachable.
- Two pre-seeded dex users are available; both have password `admin`:
  - `admin@example.com` (matches `DEFAULT_ADMIN`, becomes admin on first login).
  - `user@example.com` (regular user).
- Cover the same matrix the integration tests cover, plus what only an HTTP client can hit:
  - **Happy path** for every public route (CRUD, listing, filtering, pagination boundaries).
  - **Permission matrix**: unauthenticated → 401; non-admin hits an admin route → 403; admin → 200.
  - **Cross-user behaviour**: when the module exposes sharing / membership / cross-account access, prove it by acting as the second user and asserting the visible state changes.
  - **Multipart / streaming endpoints**: upload + download round-trips, plus the size cap (assert the > limit case is rejected).
  - **Audit landing**: drive an audited write, then read `/api/audit` as admin and assert the new event row.
- Cleanup: every test that creates persistent state (groups, documents, settings keys, TOTP devices) must delete what it created. The orchestrator wipes the data dir at the end of the run, but tests that share state across files (cached sessions, DEFAULT_ADMIN-style fixtures) need to leave the system in the state the next file expects.
- If the module flips encryption, locks the system, or otherwise mutates global state across processes, document the requirement in the PR and add a fresh phase to `run.ts` rather than leaking state into Phase B (`encryption/init.test.ts` and `encryption/unlock.test.ts` are the worked examples).

Browser-level e2e (Playwright) is intentionally not integrated: every cross-page flow currently in scope is reachable via HTTP without DOM. Add Playwright if and when a module ships behaviour that genuinely requires a browser (rich-text collab, file preview, etc.); add `bunx playwright test` to the root `package.json` at the same time.

---

## 6. Quality gate

Everything must be **green** before merge — no exceptions:

```bash
bun run lint        # ESLint, 0 errors and 0 warnings
bun run typecheck   # tsc --noEmit
bun run test        # All tests pass; new modules ≥ 80% coverage
bun run build       # Both vite build and bun build succeed
```

`bun run check` chains the four; CI runs the same. They must pass locally before a PR is opened.

---

## 7. Commit rules

### 7.1 Commit message

- Format: `<type>: <description>`; types: `feat | fix | refactor | docs | test | chore | perf | ci`.
- Always **English**; description ≤ 72 characters on a single line; body lines (optional) ≤ 100 characters.
- **Forbidden** content: AI / agent names such as `Codex` / `Claude` / `ChatGPT` / `OpenAI` / `Anthropic`; `Co-authored-by` / `Generated by`; emoji; Chinese.
- A new module is usually a single `feat` commit (schema + routes + service + tests + docs); when too large, split in the order "schema → service → routes → frontend → docs".

### 7.2 PR

- Title follows the same rules as the commit message (English, `<type>: <desc>`, ≤ 70 characters).
- Description must include: Summary (1–3 bullets), Test plan (checklist), and the related PLAN / task numbers.
- The diff must match the task description; do **not** mix in unrelated refactors / formatting changes ("surgical changes" principle).

### 7.3 Adding files

- `git add` only the files relevant to the task; **do not use `git add -A` / `git add .`** (parallel multi-agent scenarios will pollute other agents' changes).
- `git stash` is not allowed (same reason).
- `.env` / secrets / `data/` / `dist/` must never be committed (already in .gitignore, but spot-check before commit).

### 7.4 Parallel multi-agent conflict handling

**Primary goal — zero aggregate-file changes**: each new module's `git diff --name-only` should contain **only `modules/<name>/*` and the new migration file**. Aggregate-file changes get audited against the "core principle" checklist above; each file may not exceed one line. If a constant can be exported as a NavItem, do not hardcode it in the sidebar; if a namespace can be used, do not append to `common.json`; if a schema re-export will do, do not write into `db/schema.ts`. **The cure for conflicts is to eliminate the conflict surface, not to resolve them gracefully.**

**Two-phase commit** — even when each aggregate file only touches one line, still split into a "module" commit and an "aggregate" commit:

1. **Phase one (own module)**: contains only `modules/<name>/*`, the module schema shard, the module locale shard, and the new migration file. Owned exclusively by the agent and will always push successfully.
2. **Phase two (one-line aggregate additions)**: `db/schema.ts` re-export, `protected.ts` route mount, `app-sidebar.tsx` NavItems wiring, **`tests/e2e/run.ts` MODULE_DIRS entry**, doc table rows, changelog entry, plan / task index status flips. Before pushing, `git pull --rebase origin main`; on conflict, **keep both sides' content** — never drop another agent's change — and re-run `bun run check` until green before pushing again.

**Conflict-deferral fallback** — if phase two still has unresolvable rebase conflicts:

- It is acceptable to **defer the aggregate-file commit** and merge the phase-one PR first.
- Save the local aggregate diff with `git diff <file> > /tmp/<agent>-aggregate.patch`; once all parallel agents have landed, open a follow-up PR to fold the patches back in. **Do not use `git stash`** (memory: parallel agents would overwrite each other's changes).
- Follow-up commit type: `chore: integrate <module> into aggregate files`; the title must not reference the specific feature.

Multi-agent parallelism only approaches conflict-free when "zero aggregate changes" is honored; the two-phase split and deferral are only fallbacks.

---

## 8. Pre-merge acceptance checklist

When opening the PR, the module author must check off every item in the PR description:

- [ ] PR description states the design (file layout, schema, routes, dependencies, risks, out-of-scope).
- [ ] Schema lives in `modules/<name>/schema.ts`; `db/schema.ts` only adds one `export *` line (**no table definitions**).
- [ ] Routes mounted under `routes/protected.ts` (or `routes/public.ts` for routes that must work while the system is locked); the module-own code and aggregate-file additions are split per the two-phase commit rule (see 7.4).
- [ ] Aggregate files each receive at most one line of change (schema re-export / route mount / sidebar NavItems / docs table row / changelog entry); `common.json` has **no new module keys**.
- [ ] Every write route calls `audit(db, …)`.
- [ ] If the module owns tables, a `<name>.backup.ts` exports a `BackupContribution` and the module's `index.ts` calls `registerBackupContribution(...)` (see §2.8). E2E covers the export / import round-trip.
- [ ] **Unit + e2e together cover 100% of the module's source** (§5.0). Every changed line traces to at least one `*.test.ts` (unit) or `tests/e2e/modules/<module>/*.test.ts` (e2e); no line is in neither bucket.
- [ ] **Every user-facing HTTP route in this module has at least one e2e case** (§5.3). New routes without matching e2e fixtures are rejected.
- [ ] Unit-half thresholds green: `bun test --coverage` ≥ 85% lines / 70% funcs aggregate; touched logic files at 100% unless the residual lines genuinely require the live stack and are claimed by e2e.
- [ ] **Live e2e**: `tests/e2e/modules/<name>/*.test.ts` exists (covers happy path, permission matrix, cross-user behaviour, multipart endpoints, audit landing); `<name>` is added to `MODULE_DIRS` in `tests/e2e/run.ts`; `bun run test:e2e` is fully green locally and the JUnit XML lands at `tests/e2e/.cache/reports/latest/`.
- [ ] `docs/modules/<name>.md` is created (including the `## End-to-end coverage` section listing each `*.test.ts`); `architecture.md` / `api.md` / `database.md` / `changelog.md` are updated.
- [ ] i18n English and Chinese files are in sync (when there is a frontend change).
- [ ] `bun run check` is fully green locally.
- [ ] Commit messages are English with no AI markers; `git status` carries no leftover unrelated changes.

A PR cannot enter review until every box is checked.

# Product Audit — 2026-05-12

Deep audit of the template from a *product* lens: usability as a fork starting
point, long-term maintainability for downstream projects, and consistency
between docs and code. Reference modules (`issue`, `document`, …) are kept
in-tree as first-class shipped surface — they are common, strongly-needed
features for the internal-workspace target. The audit therefore focuses on
defects in how the template is *presented and customised*, not on whether
particular modules should exist.

Issues are ranked by impact on a typical fork's onboarding and upgrade path.

---

## P0 — Defects to fix immediately

### P0-1. README quick-start credential disagrees with `dev:dex` output

- `README.md:23` tells users to log in as `admin@example.com` / `admin`.
- `scripts/dev-dex.ts:171` prints `${DEFAULT_ADMIN} / zzci` — a stale
  literal left over from the original author's environment. The actual
  bcrypt hash in the dex config (`scripts/dev-dex.ts:117-128`) is for
  `"admin"`, so the README is correct and the script print line is wrong.

A fork follower will copy from one or the other and get inconsistent
results. Fix the script's log line.

### P0-2. Stale plan / task tracker still in the repo

`docs/changelog.md:54` declares `docs/task/` as **Removed** in `Unreleased`,
but `docs/task/index.md` is still on disk. Likewise `docs/plan/` retains
three historical PMA plans (`file-module.md`, `item-module.md`,
`item-doc-rewrite.md`) whose tasks (T01–T05) are all marked `completed`
in `task/index.md` and whose deliverables are already landed
(`apps/api/src/modules/{item,file}/`, `docs/modules/item.md`).

These files are no longer reference material for using the template — they
are historical breadcrumbs for the work that produced it. Delete them so
new readers don't have to triage their relevance.

### P0-3. Author identity baked into every package manifest

Five `package.json` files plus `bun.lock` carry
`https://github.com/zzci/bun-app-tpl` as `homepage` / `repository.url`.
`docs/rebranding.md` doesn't list these surfaces, so a fork inherits the
upstream owner's identity until somebody notices.

Two-part fix:

- Add the manifest fields to the rebranding checklist.
- Better: include a `scripts/rebrand.ts` that rewrites
  `package.json` (homepage / repository / name scope), prints a
  `git remote set-url` reminder, and stamps the `.env` defaults. The
  whole point of the template is to be forkable cheaply; the rebrand
  step is one of the highest-leverage surfaces to automate.

---

## P1 — Onboarding friction

### P1-1. First-run experience requires two terminals + `.env` editing

`README.md:10-21` walks the user through:

1. `cp .env.example .env`
2. Uncomment the bundled-dex block
3. Open terminal 1, run `bun run dev:dex`
4. Open terminal 2, run `bun run dev`

For a *template*, that's a lot of activation energy before anything moves.
Combine the two into a single `bun run dev:all` (or have `bun run dev`
auto-launch dex when no `OAUTH_*` is set and `OAUTH_ISSUER` defaults to
the bundled IdP). Reading and writing `.env` should not be a prerequisite
for "let me see if this thing runs."

### P1-2. Setup flow is unconditional in docs but skipped at runtime

The README's "First-run setup" lists five steps that depend on
`DB_ENCRYPTION=true`. Because the API default is `false`, the encryption
init / unlock dance is *skipped* in development. The doc doesn't say so;
the reader walks through steps that won't fire.

Add a note: "These steps run only when `DB_ENCRYPTION=true`. Local dev
defaults to `false` and goes straight to login."

### P1-3. No starter scaffold / 5-minute demo

`docs/module-standards.md` is 469 lines of rules; `docs/modules/item.md`
plus the existing `issue` and `document` modules are the only concrete
examples a fork can study. There is no `bun run module:new <name>` that
emits the skeleton (schema shard, routes file, service, backup
contribution, sidebar nav, locales, e2e directory, `MODULE_DIRS` entry).

A scaffold script would convert "read 500 lines, then start typing" into
"run command, fill in fields." This is the single biggest lever for
making the template feel like a template rather than a finished app.

---

## P2 — Customisation surface

### P2-1. Module visibility is all-or-nothing

`apps/web/src/shared/components/sidebar/registry.ts` ships every module's
nav entry permanently enabled. Forks that want to hide (say) the audit
log from non-admin sidebars, or roll out `issues` to a subset of tenants,
have to fork the registry directly — which becomes a permanent merge
conflict against upstream.

Two improvements:

- Per-NavItem `enabled: (ctx) => boolean` or a `MODULES=...` allow-list
  env var that filters the registry at boot.
- Document the "I want sidebar X but not Y" path. Today the answer is
  "edit `registry.ts` and accept the upstream merge conflicts."

### P2-2. Reference modules grow beyond the template's own size standard

`docs/module-standards.md` §2.1: "single file must stay ≤ 800 lines."
Current reality:

| File | Lines |
|---|---|
| `apps/web/src/app/routes/_app/admin/settings.lazy.tsx` | 1264 |
| `apps/web/src/app/routes/_app/portal/documents.lazy.tsx` | 1227 |
| `apps/web/src/app/routes/_app/admin/policies.lazy.tsx` | 1046 |
| `apps/api/src/modules/document/document.service.ts` | 726 |
| `apps/api/src/modules/document/document.routes.ts` | 638 |
| `apps/api/src/modules/encryption/encryption.routes.ts` | 566 |

The template asks contributors to keep modules small; its own reference
modules don't. Either relax the limit (and admit that 1200-line `lazy.tsx`
files are normal) or split these — anything else is the worst form of
"do as I say."

### P2-3. `@app/*` package scope clashes between forks

Default scope is `@app/*`. Two forks installed on the same machine /
shared dev container will collide on `node_modules/@app/...`. The
rebranding doc says scope is internal-only, but VS Code IntelliSense,
tsconfig paths, and `bun add @app/*` failures will surface it.

Derive scope from `APP_NAME` (or document this as a required rename),
and have `scripts/rebrand.ts` rewrite it.

---

## P3 — Configuration and security defaults

### P3-1. `DB_ENCRYPTION` default disagrees between layers

| Layer | Default |
|---|---|
| `apps/api/src/config.ts` zod schema | `false` |
| `examples/compose/compose.yml` | `${DB_ENCRYPTION:-true}` |
| `examples/compose/.env.example` | `DB_ENCRYPTION=true` (explicit) |

A fork that promotes the compose stack to production gets encryption; a
fork that ships its own deployment without copying compose ships
plaintext. The README/docs don't flag the divergence.

Fix path: keep the API default at `false`, but make
`NODE_ENV=production && DB_ENCRYPTION` unset a fail-fast (mirroring the
existing `OAUTH_CLIENT_SECRET=app-secret` refusal at `config.ts:224`).
Production deployments then have to make an explicit choice.

### P3-2. `.env.example` vs `docs/deployment.md` env table drift

`apps/api/src/config.ts` is the source of truth (zod schema with
defaults), but `.env.example` and `docs/deployment.md`'s "Required
environment" table are hand-maintained. They have already drifted:
`SERVICE_TOKEN`, `LOG_TO_STDOUT`, `TRUST_PROXY`,
`ENABLE_EXPERIMENTAL_DEK_ROTATION`, every `FILE_*` variable, etc., are
absent or only partially documented in the table.

Generate the env reference from the zod schema at docs-build time (a
short script can walk `configSchema.shape`, pull `.describe()` text, and
emit a markdown table). Documentation drift becomes structurally
impossible.

### P3-3. `SERVICE_TOKEN` scope is too wide

One bearer gates both `/api/metrics` (read-only, low-sensitivity) and
`/api/backup/export-via-token` (full DB JSON dump, including session
tokens when `DB_ENCRYPTION=false`). A leaked metrics scraper credential
becomes a database exfiltration credential.

`docs/operations.md` mentions "Treat like an OAuth client secret" but
doesn't warn about the conjoined scope. Two improvements:

- Document the blast radius prominently.
- Split into `SERVICE_TOKEN_METRICS` and `SERVICE_TOKEN_BACKUP` (both
  optional, independently rotatable). Forks that need both today set the
  same value; forks that need only metrics get a properly scoped token.

### P3-4. `OAUTH_CLIENT_ID=app` + `DEFAULT_ADMIN=admin@example.com` defaults aren't checked

`config.ts:224` refuses to boot in production with the example
`OAUTH_CLIENT_SECRET`. Good. But the example `OAUTH_CLIENT_ID=app` and
`DEFAULT_ADMIN=admin@example.com` pass the check — a deploy that copies
`.env.example`, rotates the secret, but forgets the other two is still
running with a globally-known client id and a default-admin email any
attacker can register at the IdP.

Extend the production guard to refuse `OAUTH_CLIENT_ID=app` and
`DEFAULT_ADMIN=admin@example.com` (treat them as example sentinels, same
class as `app-secret`).

---

## P4 — Documentation health

### P4-1. `docs/api.md` is hand-maintained and will keep drifting

The doc opens by saying it's "hand-maintained in lockstep with the route
handlers." The route handlers already emit OpenAPI via `OpenAPIHono`;
`/api/openapi.json` is the source of truth. At build time, dump a
trimmed markdown table from the OpenAPI document and have `docs/api.md`
either link to it or include it as a generated section. The current
approach guarantees the doc is wrong for any change that doesn't also
touch `api.md` — and CI doesn't enforce that.

### P4-2. `docs/module-standards.md` is too long for its job

At 469 lines, it's not a quick reference; it's a textbook. New
contributors have to read most of it before they can start. Split into:

- A 60-line **playbook** (the steps to add a module, in order, with file
  paths and one-liner commands).
- A long-form **reference** that the playbook links to for the
  decisions / rationale.

The playbook is what a fork's contributors will actually read each time;
the reference is what review uses to enforce the rules.

### P4-3. Changelog never cuts a release

Everything sits under `Unreleased`. `docs/upgrading-from-template.md`
recommends forks tag themselves as `v<upstream>+<suffix>`, but upstream
has no tags. Cut `v0.1.0` now and roll the changelog forward on each PR.
Forks then have a real version to anchor against.

### P4-4. README undersells the testing investment

200+ unit tests, a full live e2e suite with auto-extracted dex, and
admin-encryption / rate-limit / unlock cycle phases — all buried in
`module-standards.md` §5. For a template, "the testing harness is
already wired up" is one of the most valuable things to inherit. Surface
it in the top-level README as a feature.

---

## P5 — Build, deploy, deps

### P5-1. No CI workflow shipped

`module-standards.md` §6 says "CI runs the same `bun run check`," but
there is no `.github/workflows/`. Every fork has to write this from
scratch.

Ship `.github/workflows/check.yml` (lint + typecheck + test + build +
check:i18n) and an opt-in `e2e.yml` (longer, may need a runner with
docker / network). One file the template-fork starts with passes CI on
day zero.

### P5-2. Container build is fragile around libsql

`Dockerfile:29-39` `exit 1`s if more than one libsql version is hoisted.
This is correct defensive coding, but the *failure mode* is silent until
you bump deps. Forks that haven't seen this fail won't know what to do
when it does. Add a `docs/deployment.md` paragraph: "If the Dockerfile
fails with `Expected exactly one libsql install, found N`, run
`bun install` to deduplicate; this happens when two deps in your fork
pin different `@libsql/client` versions."

### P5-3. Two logging libraries — `pino` + `consola`

`apps/api/package.json` lists both. `pino` is the production logger;
`consola` shows up in scripts and prettier dev output. Pick one. Two
logging libraries is a smell forks will copy and never resolve.

### P5-4. Frontend deps lean toward "latest" rather than "stable"

`react@^19.2`, `vite@^8`, `tailwind@^4.3`, `@base-ui/react@^1.4`,
`@milkdown/kit@^7.16` — all current. A template's pin choice cascades
into every fork for years. Decide and document:

- Which deps are **core, opinionated, expensive to swap** (React,
  TanStack Router, Tailwind, Drizzle, libsql)? Pin minor.
- Which are **swappable** (`sonner`, `milkdown`, `shiki`, `lucide`)?
  Document them as such so forks know they can substitute.

Without this annotation, every dep looks load-bearing.

### P5-5. i18n hard-codes EN + ZH

`apps/web/src/app/i18n.ts:73` literally enumerates the eight namespaces
and `supportedLngs: ["en", "zh"]`. Adding a third language touches: the
ns array, the `supportedLngs`, `scripts/check-i18n.ts`, the
`load: "languageOnly"` policy, and the `toBcp47` mapper.

Derive `supportedLngs` and `ns` from the filesystem layout
(`apps/web/src/locales/<lng>/<ns>.json` already exists). One source of
truth for both build and runtime.

---

## What this audit deliberately leaves alone

- **Module selection** (`issue`, `document`, etc. staying in core) — kept as
  shipped surface per product owner direction.
- **The `item` + `file` base + sub-type pattern** — sound design; the
  template's strongest piece of architecture.
- **Encryption / Zanzibar / audit / backup architecture** — these are the
  template's real moat and are well-implemented.
- **The testing rules in `module-standards.md` §5** — the policy is
  correct; only its presentation (§ P4-2) needs work.

---

## Prioritised action list

| # | Item | Where |
|---|---|---|
| 1 | Fix `zzci` literal in `scripts/dev-dex.ts:171` | P0-1 |
| 2 | Delete `docs/plan/` and `docs/task/`; reconcile changelog | P0-2 |
| 3 | Add `scripts/rebrand.ts` + extend `docs/rebranding.md` with manifest fields | P0-3 |
| 4 | Unify `bun run dev` so dex starts automatically when bundled IdP is selected | P1-1 |
| 5 | Add scaffold `bun run module:new <name>` | P1-3 |
| 6 | Generate env reference and API reference from zod / OpenAPI | P3-2, P4-1 |
| 7 | Tighten production fail-fasts (sentinel `OAUTH_CLIENT_ID`, `DEFAULT_ADMIN`) | P3-4 |
| 8 | Split `SERVICE_TOKEN` into metrics / backup | P3-3 |
| 9 | Ship `.github/workflows/check.yml` | P5-1 |
| 10 | Split oversized reference files (`*.lazy.tsx`, `document.*.ts`) or relax the 800-line rule | P2-2 |
| 11 | Cut `v0.1.0` and roll changelog forward | P4-3 |
| 12 | Pick `pino` *or* `consola`, not both | P5-3 |

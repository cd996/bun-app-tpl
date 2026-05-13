# Upgrading from the template

This repo is a **template**: you fork it, rename it, and grow your application inside it. Long after the fork, you may want to pull improvements from upstream — security fixes, new shared infrastructure, refreshed dependencies. This document describes how to keep that pipeline open.

## Template surface vs your application

The repository splits along a clear boundary. **Template surface** is owned by upstream and should be merged forward; **your application** is everything you add or significantly customise.

| Layer | Template surface (merge from upstream) | Your application (do not merge from upstream) |
|---|---|---|
| Build / runtime | `Dockerfile`, `bun.lock` (regenerate), `bunfig.toml`, `package.json` (top-level scripts), `scripts/compile.ts`, `scripts/clean.ts`, `scripts/check-i18n.ts`, `scripts/dev-dex.ts` | New scripts you add under `scripts/` |
| Shared infra | `apps/api/src/shared/`, `apps/api/src/routes/`, `apps/api/src/app.ts`, `apps/api/src/db/index.ts`, `apps/api/src/config.ts`, `apps/api/src/pid-lock.ts`, `apps/api/src/dev.ts` | New shared utilities you add (still reviewed for upstream-friendly placement) |
| Reference modules | `apps/api/src/modules/{account,audit,backup,encryption,policy,settings,system}/` | `apps/api/src/modules/{document,issue}/` once you start adding business fields, your own new modules under `apps/api/src/modules/<your-module>/` |
| Frontend infra | `apps/web/index.html`, `apps/web/vite.config.ts`, `apps/web/src/shared/`, `apps/web/src/app/main.tsx`, `apps/web/src/app/root.tsx`, route shells under `apps/web/src/app/routes/_app/` | Module routes under `apps/web/src/app/routes/_app/<your-module>/`, your nav entries, your locale shards |
| Aggregate files | `apps/api/src/db/schema.ts`, `apps/api/src/routes/protected.ts`, `apps/web/src/shared/components/sidebar/registry.ts`, `apps/web/src/locales/{en,zh}/common.json` | Your one-line registry entries inside those files (see [`module-standards.md`](module-standards.md)) |
| Docs | `docs/architecture.md`, `docs/api.md`, `docs/database.md`, `docs/module-standards.md`, `docs/rebranding.md`, `docs/deployment.md`, `docs/operations.md`, `docs/upgrading-from-template.md` | `docs/modules/<your-module>.md`, `docs/changelog.md` |
| Tests | `tests/e2e/run.ts`, `tests/e2e/lib/`, `tests/e2e/modules/{account,audit,backup,encryption,policy,settings,system}/` | Your `tests/e2e/modules/<your-module>/` |
| Branding | `.env.example` keys, `docs/rebranding.md`'s catalogue of surfaces | `.env` (your actual values), `apps/web/src/shared/components/logo.tsx`, `apps/web/public/logo.svg` |

The boundary is enforced architecturally by the **module-standards aggregate-file rule** (see [`module-standards.md`](module-standards.md) "Core principle: module autonomy / minimal aggregate files"). Aggregate files only accept one-line registry entries from each module; everything else lives in the module's own directory. That keeps merges from upstream collision-free: when upstream changes the body of an aggregate file, your one-line entries stay neatly out of the way.

## Setting up the upstream remote

Inside your fork:

```bash
git remote add template https://github.com/<upstream-owner>/<upstream-repo>.git
git fetch template
```

(Replace the URL with the real upstream you forked from.)

Confirm:

```bash
git remote -v
# origin    git@github.com:<you>/<your-app>.git (fetch)
# origin    git@github.com:<you>/<your-app>.git (push)
# template  https://github.com/<upstream-owner>/<upstream-repo>.git (fetch)
# template  https://github.com/<upstream-owner>/<upstream-repo>.git (push)
```

## Pulling upstream changes

The recommended workflow is **merge, not rebase** — your branch has its own history and you want a clear "merged from template" commit on the timeline.

```bash
git fetch template
git checkout -b merge/template-$(date +%Y%m%d)
git merge --no-ff template/main
```

Resolve conflicts (most will be in aggregate files where upstream added a row and you also added a row — accept both). Run the smoke checks:

```bash
bun install
bun run check        # lint + typecheck + test + build
bun run test:e2e     # live e2e (longer)
```

Open a PR against your `main` branch from the merge branch.

### What conflicts you should expect

- **Aggregate files** (`db/schema.ts`, `protected.ts`, `sidebar/registry.ts`, `tests/e2e/run.ts`, `common.json`): conflict-free if both sides only added one-line registry entries. Resolve by keeping both.
- **Config schemas** (`apps/api/src/config.ts`): if you added env vars, you'll see merge conflicts when upstream also added env vars. Accept both blocks.
- **`bun.lock`**: regenerate (`bun install`) rather than hand-merging.

### What conflicts mean you have drifted

- Conflicts inside `modules/account/`, `modules/encryption/`, `modules/backup/`, etc. — you have edited a reference module in place. Either revert your edits and rebuild your changes as a new module that wraps the reference one, or accept that this module is now permanently forked from upstream and stop merging it.
- Conflicts inside `apps/api/src/shared/middleware/` — you have customised middleware. Same advice: prefer composing a new middleware in your application code rather than editing shared infra.

## Versioning

The template itself does not ship a release history — `git log` is the
record. Your fork should keep its own `docs/changelog.md` (the file ships
empty for that purpose) and pick a tag scheme that lets readers identify
the upstream baseline, e.g. `v<your-version>+tpl.<upstream-short-sha>`.

# Documentation

This is a Bun monorepo template that ships an OAuth-backed full-stack workspace: Hono API, React 19 SPA, SQLite via Drizzle, single-binary build.

## Map

| Topic | File |
|---|---|
| Runtime shape, modules, request flow | [architecture.md](architecture.md) |
| HTTP API surface | [api.md](api.md) |
| Flat per-route index (auto-generated) | [api-routes.md](api-routes.md) |
| Environment variables (auto-generated) | [env-reference.md](env-reference.md) |
| Database tables and conventions | [database.md](database.md) |
| Module deep dives | [modules/](modules/) |
| Module spec | [module-standards.md](module-standards.md) |

The repository top-level [`README.md`](../README.md) is the canonical quick-start for commands and architecture.

## Using This Template

When forking this template, customize the following before you start adding features. Most identity is now driven by env vars — see [rebranding.md](rebranding.md) for the full checklist.

### 1. Identity

- Set `APP_NAME` (slug, e.g. `myapp`) and `APP_DISPLAY_NAME` (e.g. `My App`) in `.env`. The HTML `<title>`, TOTP issuer, backup filename, and unlock-challenge `sessionStorage` key all derive from these. `BASE_PATH` is unset by default (app mounts at root); set it to serve under a URL prefix.
- Logo and favicon: replace `apps/web/public/logo.svg` and the inline `<Logo>` in `apps/web/src/shared/components/logo.tsx`.
- Package scope is `@app/*` by convention. Rename only if you need a different scope (it does not appear in any user-visible surface).

### 2. Environment

Copy `.env.example` to `.env` and configure:

- `PORT`, `HOST`, `BASE_PATH`, `DB_PATH`, `LOG_FILE`
- `DB_ENCRYPTION` (false by default — turn on for production). The bootstrap token gating `/api/encryption/init` is auto-generated at every boot; pick it up from stderr or `<data dir>/bootstrap-token.txt` while in setup mode
- OAuth provider (`OAUTH_*`); the bundled dex IdP block in `.env.example` is enough for local dev
- `DEFAULT_ADMIN` for first-user bootstrap
- `CORS_ORIGIN` in production

The complete env reference (every variable, type, default) is generated as [`env-reference.md`](env-reference.md).

OAuth/OIDC is read from environment at runtime — not from the settings DB — so a bad DB row cannot break login.

### 3. Domain Modules

| Module | Folder | What it owns |
|---|---|---|
| `account` | `apps/api/src/modules/account` | OAuth login, sessions, users, groups, TOTP. Required infrastructure. |
| `audit` | `apps/api/src/modules/audit` | Persisted audit events + retention sweep. |
| `backup` | `apps/api/src/modules/backup` | JSON export/import (admin + service-token surfaces). |
| `document` | `apps/api/src/modules/document` | Documents, attachments, comments, shares; sub-type of `item`. |
| `encryption` | `apps/api/src/modules/encryption` | DB-at-rest encryption + locked/unlocked bootstrap. |
| `file` | `apps/api/src/modules/file` | Content-addressable blob storage with pluggable drivers and ref counting. |
| `issue` | `apps/api/src/modules/issue` | Issues, attachments, comments; sub-type of `item`. |
| `item` | `apps/api/src/modules/item` | Base primitive for content sub-types (common metadata + comments + permission edges). |
| `policy` | `apps/api/src/modules/policy` | Zanzibar-style relation tuples and resource groups. |
| `settings` | `apps/api/src/modules/settings` | Runtime key/value settings store. |
| `system` | `apps/api/src/modules/system` | Health probes, build version, Prometheus metrics, upload limits. Required infrastructure. |

To remove a module (e.g. you don't want issues):

1. Delete the module folder.
2. Remove its mount from `apps/api/src/routes/protected.ts` and its re-export from `apps/api/src/db/schema.ts`.
3. Run `bun run --filter @app/api db:generate` to regenerate the migration.
4. Remove the matching frontend routes under `apps/web/src/app/routes/_app/` and the sidebar nav entry in `apps/web/src/shared/components/sidebar/registry.ts`.
5. Remove the locale shards `apps/web/src/locales/{en,zh}/<module>.json` and drop the `<module>` entry from the `ns:` array in `apps/web/src/app/i18n.ts`.
6. Drop the module's `tests/e2e/modules/<name>/` directory and remove its entry from `MODULE_DIRS` in `tests/e2e/run.ts`.
7. Update `docs/architecture.md` / `docs/api.md` / `docs/database.md` / `docs/modules/`.

## Build and Run

See the top-level [`README.md`](../README.md) for the complete command list. The short version:

```bash
bun install
bun run dev:all      # dex + Vite + API on the same port
bun run check        # lint + typecheck + test + build + check:i18n + check:env-docs + check:api-docs
bun run compile      # single-binary build under dist/
```

Docker:

```bash
docker build -t my-app .
docker run -p 3000:3000 -v $(pwd)/data:/app/data my-app
```

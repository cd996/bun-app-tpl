# Documentation

This is a Bun monorepo template that ships an OAuth-backed full-stack workspace: Hono API, React 19 SPA, SQLite via Drizzle, single-binary build.

## Map

| Topic | File |
|---|---|
| Runtime shape, modules, request flow | [architecture.md](architecture.md) |
| HTTP API surface | [api.md](api.md) |
| Database tables and conventions | [database.md](database.md) |
| Module deep dives | [modules/](modules/) |
| Module spec | [module-standards.md](module-standards.md) |
| Project changelog | [changelog.md](changelog.md) |

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
- OAuth provider (`OAUTH_*`), or disable auth-bound features in development
- `DEFAULT_ADMIN` for first-user bootstrap
- `CORS_ORIGIN` in production

OAuth/OIDC is read from environment at runtime — not from the settings DB — so a bad DB row cannot break login.

### 3. Domain Modules

The shipped modules are example surface area, not requirements. Keep what you need, drop the rest:

| Module | Folder | Drop if you don't need… |
|---|---|---|
| `account` | `apps/api/src/modules/account` | Required (auth, sessions, users, groups, TOTP). |
| `policy` | `apps/api/src/modules/policy` | Zanzibar-style relation tuples and resource groups. |
| `audit` | `apps/api/src/modules/audit` | Persisted audit events. |
| `encryption` | `apps/api/src/modules/encryption` | DB-at-rest encryption + locked/unlocked bootstrap. |
| `settings` | `apps/api/src/modules/settings` | Runtime key/value settings UI. |
| `backup` | `apps/api/src/modules/backup` | JSON export/import. |
| `document` | `apps/api/src/modules/document` | Example document feature. |
| `todo` | `apps/api/src/modules/todo` | Example todo feature. |
| `system` | `apps/api/src/modules/system` | Required (health, OpenAPI). |

When you remove a module:

1. Delete the module folder.
2. Remove its mount from `apps/api/src/routes/protected.ts`.
3. Drop its tables from `apps/api/src/db/schema.ts` and regenerate migrations (`bun run db:generate`).
4. Remove the matching frontend routes under `apps/web/src/app/routes/_app/`.
5. Drop the module reference from `architecture.md`, `api.md`, `database.md`.

## Build and Run

See the top-level [`README.md`](../README.md) for the complete command list. The short version:

```bash
bun install
bun run dev          # Vite + API on the same port
bun run check        # lint + typecheck + test + build
bun run compile      # single-binary build under dist/
```

Docker:

```bash
docker build -t my-app .
docker run -p 3000:3000 -v $(pwd)/data:/app/data my-app
```

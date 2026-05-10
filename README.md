# App Template

A Bun monorepo template for OAuth-backed internal workspaces. Ships with:

- **API** — Hono + OpenAPI on Bun, SQLite via Drizzle, optional ECIES at-rest encryption.
- **Web** — React 19 + TanStack Router + Tailwind v4, file-based routes, dual EN/ZH i18n.
- **Modules** — account/auth (OAuth + TOTP), groups, Zanzibar relation tuples, documents, todos, settings, audit logs, encryption admin, JSON backup.
- **Build** — single Bun executable via `scripts/compile.ts`.

## Quick start

```bash
bun install
cp .env.example .env
bun run dev:dex     # starts the dev server + a bundled dex IdP
```

Open http://localhost:3000 — you'll be redirected to the setup flow, then to login. Use `admin@example.com` / `admin` to sign in (configured in the bundled dex). The first matching login becomes admin per `DEFAULT_ADMIN`.

If you have your own OAuth/OIDC provider, set `OAUTH_*` in `.env` and run `bun run dev` instead. The bundled dex runs on `:5567` and can be left disabled.

### First-run setup

1. Visit the URL above; you'll land on `/<base>/setup`.
2. Paste the bootstrap token. It is auto-generated at every boot and surfaced via stderr / `<data dir>/bootstrap-token.txt` while the system is in setup mode; both go away once init succeeds.
3. Choose a master password — this derives the master keypair that wraps the data-encryption key (DEK).
4. Save the recovery key file (`<APP_NAME>-master-key.txt`).
5. Sign in via OAuth. The first user matching `DEFAULT_ADMIN` becomes admin.

## Customize

- **Identity** — set `APP_NAME` (slug) and `APP_DISPLAY_NAME` in `.env`. HTML title, TOTP issuer, backup filename, sessionStorage namespace, and `BASE_PATH` all derive from these. See [`docs/rebranding.md`](docs/rebranding.md).
- **Modules** — keep what you need, drop the rest. See [`docs/README.md`](docs/README.md) §3.
- **Logo** — replace `apps/web/public/logo.svg` and the inline SVG in `apps/web/src/shared/components/logo.tsx`.

## Commands

```bash
bun run dev          # Vite dev server (web + API via @hono/vite-dev-server)
bun run dev:dex      # Same, but with a bundled dex IdP wired up automatically
bun run build        # Build all packages
bun run lint         # ESLint
bun run typecheck    # tsc --noEmit
bun run test         # Unit tests (bun:test + vitest)
bun run test:e2e     # Live e2e: dex + API + encrypted DB + every module
bun run check        # lint + typecheck + test + build
bun run compile      # Single-binary build (Bun executable)
bun run clean        # Remove build artifacts
```

## Layout

```text
apps/api/        Hono API with OpenAPI; Drizzle schema lives per-module
apps/web/        React 19 SPA (TanStack Router file-based)
packages/shared/ ECIES utilities used by both api and web
packages/config/ Shared TS config
docs/            Architecture, module standards, deployment, rebranding
tests/e2e/       Live e2e harness (dex + API)
scripts/         compile / clean / check-i18n / dev-dex
```

## Documentation

- [`docs/README.md`](docs/README.md) — using the template
- [`docs/architecture.md`](docs/architecture.md) — runtime shape
- [`docs/module-standards.md`](docs/module-standards.md) — adding a module
- [`docs/rebranding.md`](docs/rebranding.md) — full rebranding checklist
- [`docs/deployment.md`](docs/deployment.md) — production deployment + upgrade
- [`docs/modules/`](docs/modules) — per-module deep dives
- [`docs/changelog.md`](docs/changelog.md) — release notes

# Architecture

> Examples assume the default `BASE_PATH=/app`; substitute your own `BASE_PATH` if you have changed it.

This is a Bun monorepo template that provides an OAuth-backed internal workspace for account management, policy tuples, documents, todos, settings, audit logs, encryption administration, and database backup.

This document describes the implemented architecture in the current codebase. Planned integrations should live in separate roadmap or planning documents, not in current-state architecture docs.

In examples below, `${BASE_PATH}` is the configured URL prefix (default `/app`, derived from `APP_NAME`).

## Runtime Shape

```text
Browser
  |
  | ${BASE_PATH}/*
  v
App server
  |
  | ${BASE_PATH}/api/*
  v
Hono API
  |
  +-- public routes (always on: /health, /encryption/status)
  +-- setup routes (locked-only: /encryption/init, /unlock, /unlock-challenge)
  +-- protected routes guarded by requireUnlocked (unlocked-only business + admin)
  +-- SQLite via Drizzle ORM
```

The outer app serves:

| Mount | Purpose |
|---|---|
| `/` | HTML meta refresh to `${BASE_PATH}/`. |
| `${BASE_PATH}/api` | Hono API. |
| `${BASE_PATH}/*` | Embedded SPA assets when production assets are present. |

## Technology Stack

| Layer | Technology |
|---|---|
| Runtime | Bun |
| API | Hono with `OpenAPIHono` |
| Database | SQLite through Drizzle ORM |
| Web | React, Vite, TanStack Router, TanStack Query |
| Styling | Tailwind CSS |
| Build | `scripts/compile.ts` single-binary build |
| Authentication | External OAuth/OIDC provider with authorization code + PKCE |
| Authorization | Local Zanzibar-style relation tuples |

## Repository Layout

```text
apps/
  api/
    src/
      app.ts
      config.ts
      db/
      modules/
      routes/
      shared/
  web/
    src/
      app/
      shared/
packages/
  config/
  shared/
scripts/
docs/
```

## API Module Layout

```text
apps/api/src/modules/
  account/
    auth/
    users/
    groups/
  audit/
  backup/
  document/
  encryption/
  policy/
  settings/
  system/
  todo/
```

| Module | Responsibility | Details |
|---|---|---|
| `account` | OAuth login, sessions, current user, users, groups, and TOTP. | [account.md](modules/account.md) |
| `audit` | Querying persisted audit events. | [audit.md](modules/audit.md) |
| `backup` | JSON backup export and import. | See [api.md](api.md). |
| `document` | Documents, folders, attachments, comments, and shares. | See [api.md](api.md). |
| `encryption` | Database encryption setup, unlock, metadata, and key rotation. | See [api.md](api.md). |
| `policy` | Relation tuple management, check, expand, and resource groups. | [policy.md](modules/policy.md) |
| `settings` | Runtime settings storage and masking. | See [api.md](api.md). |
| `system` | Health and OpenAPI docs. | [system.md](modules/system.md) |
| `todo` | Todos, attachments, and comments. | See [api.md](api.md). |

## Request Flow

```text
Request
  -> CORS
  -> request ID
  -> app context injection
  -> request logging
  -> CSRF guard
  -> route group
  -> requireUnlocked for protected routes
  -> authRequired where the module requires a session
  -> adminRequired where the module requires admin privileges
  -> handler
  -> shared error handler
```

## Authentication Flow

```text
Unauthenticated user
  -> GET /app/api/account/auth/login
  -> OAuth authorization endpoint
  -> GET /app/api/account/auth/callback
  -> token exchange with PKCE verifier
  -> local user create/update
  -> session cookie
  -> redirect back to requested page
```

Sessions are stored in SQLite. The browser stores only the HTTP-only session cookie.

OAuth/OIDC provider configuration is read from environment variables at runtime. The admin settings UI does not own these values, which prevents a bad database setting from breaking login. `DEFAULT_ADMIN` is a one-time bootstrap input: when no users exist, the first login matching that configured username or email becomes admin.

## Authorization Model

The policy module stores relation tuples in `relation_tuples` and exposes check and expand operations. Admin users bypass policy checks where the route explicitly uses `adminRequired`.

Tuple example:

```text
document:abc123#viewer@group:dev-team#member
group:dev-team#member@user:user123
```

## Encryption Lifecycle

The app can start in a locked mode. Setup and unlock routes are available before the full protected app is mounted. After unlock, protected routes are mounted and guarded by `requireUnlocked`.

## Data Storage

Runtime data is stored below `ROOT_DIR`:

| Path | Purpose |
|---|---|
| `data/db/app.db` | SQLite database. |
| `data/db/app.pid` | PID lock file. |
| `data/logs/app.log` | Structured JSON logs. |

## Current Non-Goals

The current codebase does not implement application inventory, domain management, host management, Headscale proxying, PowerDNS sync, API key management, or Traefik ForwardAuth routes. Do not document those as current behavior unless the corresponding code is added.

# Changelog

Template release notes. Format adapted from [Keep a Changelog](https://keepachangelog.com/) — group entries under **Added / Changed / Removed / Fixed / Security**. The `Unreleased` block tracks work since the last tag.

## Unreleased

### Added

- `APP_NAME` (slug) and `APP_DISPLAY_NAME` env vars drive HTML title, TOTP issuer, backup filename, and sessionStorage namespace. Frontend reads via `apps/web/src/shared/lib/branding.ts`; API reads `Bun.env`.
- `scripts/dev-dex.ts` and `bun run dev:dex` — starts a bundled dex IdP and the dev server with matching `OAUTH_*` env in one command.
- `examples/compose/` reference stack: `compose.yml`, `Caddyfile`, `dex.yaml`, `.env.example` — local-development / smoke-test grade docker-compose stack.
- `docs/rebranding.md` cataloguing every env-driven and manual rebranding surface.
- `docs/deployment.md` covering env, volumes, healthchecks, reverse-proxy snippets, backup/restore, and the schema-upgrade playbook.
- `docs/operations.md` runbook (master-password rotation, lost-password recovery, snapshot restore, audit-log investigation).
- `docs/upgrading-from-template.md` describing the template-vs-application file boundary and the `git remote add template` merge recipe.
- `docs/module-standards.md` codifying file layout, schema sharding, route mounting, audit hooks, backup contribution (§2.8), i18n namespacing, and the testing matrix (§5: unit + e2e together cover 100%; every user-facing route ships with at least one e2e case).
- Per-module schema sharding under `modules/<name>/schema.ts`; `db/schema.ts` is now a pure re-export aggregator.
- Self-registering backup contributions (`<name>.backup.ts` + `registerBackupContribution()` from `index.ts`); `backup/registry.ts` owns the read API only.
- Per-module sidebar `<name>.nav.ts`; `app-sidebar.tsx` aggregates via the registry.
- Per-module i18n namespace shards; `common.json` keeps only global keys. `scripts/check-i18n.ts` gates en/zh parity in `bun run check`.
- Persisted `audit_events` with actor / action / resource / IP / UA / result / detail; admin list + filter API. `AUDIT_RETENTION_DAYS` env + hourly sweep prune.
- TOTP step-up flow (device add / confirm / login challenge) with per-IP rate limit; admin device CRUD audited.
- `/api/encryption/unlock-challenge` — per-IP rate-limited challenge bundle for the SPA's unlock attempt.
- `/api/system/upload-limits` and the `useUploadLimits()` frontend hook for surfacing `MAX_UPLOAD_BYTES` / `MAX_ATTACHMENTS_PER_RESOURCE` / `UPLOADS_TOTAL_BYTES` to the UI.
- Per-IP `rateLimit()` middleware factory.
- Live e2e suite under `tests/e2e/modules/`: dex auto-extracted from the official OCI image; orchestrator runs phase A (init), phase B (modules + admin encryption ops + cross-cutting security guards), phase C-rate-limit (locked, fresh limiter), phase C-unlock. JUnit XML + `summary.json` land in `tests/e2e/.cache/reports/<run>/`.
- 200+ unit tests across shared lib, middleware, services, the zanzibar engine, and frontend stores / http client / validators / sidebar registry.

### Changed

- `BASE_PATH` is now unset by default — the app mounts at root (`/`) with the API at `/api`. Previously it derived from `APP_NAME` (`/app`). Set `BASE_PATH` explicitly to serve under a URL prefix; `app`, `/app`, and `/app/` all normalise to `/app`.
- Workspace scope renamed `@access/*` → `@app/*`; `bun.lock` regenerated.
- Locked / unlocked app split: `routes/setup.ts` owns init/unlock/challenge while locked; `routes/protected.ts` mounts business + admin only when unlocked. `/api/health` returns 503 while locked so orchestrators detect stuck instances.
- `/encryption/status` payload trimmed to `{initialized, locked, status, dbError}` (no `kdfSalt` / `encryptedDek` / challenge leak).
- `DB_ENCRYPTION` default flipped to `false` for dev friction; production must set it explicitly.
- `BOOTSTRAP_TOKEN` is auto-generated at every boot and only published while the system is in setup mode (no `meta.db`). Surfaced via stderr and `<data dir>/bootstrap-token.txt`; both are removed on `/encryption/init` success. The env-var path is removed; the token cannot be reused.
- `ACCESS_URL` required in production so OAuth callback origin can never be derived from forwarded headers.
- Backup export keyed by table name; `/api/backup/modules` returns `{name, deps}[]` so the settings page no longer hardcodes the module list.
- `/api/openapi.json` and `/api/docs` are admin-only; Scalar UI replaced with a custom HTML wrapper that injects `X-Requested-With` so try-it-out works under the CSRF guard. `@scalar/hono-api-reference` dependency dropped.
- Dockerfile hardened: non-root user (uid 1000), `HEALTHCHECK` against `/api/health`, `VOLUME /app/data`. `FROM zzci/ubase` preserved.
- `scripts/clean.ts --all` now wipes `data/uploads/` and `tests/e2e/.cache/` too.

### Removed

- `CLAUDE.md` and `docs/task/` (PMA tracker) — `README.md` is the single quick-start.
- `apps/api/tests/integration/` — routes are e2e-only by policy.
- Dead denied-page reasons that the backend never emitted.
- Internal-network gate / "applications" inventory legacy code (removed during audit passes).
- Locale keys `app.title` / `app.name` (replaced by branding consts).
- Hardcoded `DATA_MODULES` table (replaced by self-registering backup contributions).

### Fixed

- `rotate-dek` and `change-master` serialised via `beginOperation()`; both consume DEK via challenge-response so plaintext DEK never crosses the wire. `rotate-dek` flagged **EXPERIMENTAL** pending libsql `SQLITE_IOERR` fix; e2e suite asserts the current 500 / `ROTATE_FAILED` contract so a future fix is detected automatically.
- Refresh-token rotation through the provider's `/token` endpoint; revoke is best-effort on logout.

### Security

- `csrfGuard` enforces `X-Requested-With` + Origin/Referer match against `CORS_ORIGIN` (when set); Bearer tokens are exempt.
- Cookie sessions enforce `SameSite=Lax` + `X-Requested-With` + Origin (when `CORS_ORIGIN` set).
- Every write route emits an audit row (account / TOTP / policy / document / todo / settings / encryption / backup).
- `examples/compose/dex.yaml` issuer aligned with the docker-network hostname (`http://dex:5556/dex`) so server-to-server discovery matches what dex publishes; `examples/compose/.env.example` no longer ships a placeholder `BOOTSTRAP_TOKEN` value.

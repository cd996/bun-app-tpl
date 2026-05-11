# Operations Runbook

Day-2 procedures for operators. Examples assume `BASE_PATH=/app`. The app is mounted at root (`/`) by default; drop the `/app` prefix from the paths below if you have not set `BASE_PATH`. Endpoints are described in [`api.md`](api.md); deployment context in [`deployment.md`](deployment.md).

---

## Master password rotation

Rotate the master password (re-wraps the DEK with a new master keypair; ciphertext is untouched).

### Procedure

1. Sign in as admin to the running, **unlocked** instance.
2. Mint a challenge:
   ```http
   POST /app/api/encryption/challenge
   ```
3. Call `POST /app/api/encryption/change-master` with the current and new master passwords (proving DEK ownership against the challenge). The exact request body shape is documented in the OpenAPI doc at `/app/api/docs`.
4. Save the new recovery key file the API returns. Store it in your password manager / sealed envelope process — **do not** keep it on the application server.

### Verification

- Lock the instance (restart the container) and unlock with the **new** password. If unlock fails, revert by restoring the latest snapshot (see "Restore from snapshot").
- Verify `GET /app/api/encryption/status` returns `{initialized: true, locked: false, status: "unlocked"}`.
- Verify any sensitive admin endpoint (e.g. `GET /app/api/encryption/meta`) still returns 200.

### Storage rules for the new recovery key

- One copy in your secrets vault (1Password, Vault, sealed Bitwarden item, etc.).
- One offline copy (printed and stored in a safe) for break-glass.
- **Never** commit it to git, paste it into chat, or email it.

---

## Lost master password / recovery key

This is a destructive scenario. The current implementation does **not** support unlocking with the recovery key alone once the master password is lost — the recovery key file you saved at setup is the master keypair, but unlock requires deriving the wrap key from a password the operator types in. If you lose the password and the key file, the database ciphertext is unrecoverable.

The only recovery path is **restore from a JSON backup** taken with `/api/backup/export` while the system was unlocked.

### Procedure

1. Stop the container.
2. Take a forensic copy of the existing `data/db/` directory (`app.db`, `app.db-wal`, `app.db-shm`, `meta.db`). You will not be using it, but keep it until you have verified the restore.
3. Move the existing DB files aside so the next start sees an empty database.
4. Start the container. Read the auto-generated bootstrap token off stderr (`docker compose logs app | grep BOOTSTRAP_TOKEN`) or `<data dir>/bootstrap-token.txt`. Visit `/app/setup`, paste the token, and initialise with a **new** master password. Save the new recovery key. The token and file are removed once init succeeds.
5. Sign in as admin and `POST /app/api/backup/import` with the most recent JSON backup. Import is schema-version-locked — the old binary used to take the export and the new binary used to import must be schema-compatible.
6. Verify row counts and a representative document / todo / settings entry.
7. Once verified, delete the forensic copy from step 2.

If you do not have a JSON backup, the data is unrecoverable. This is the strongest possible argument for the snapshot sidecar described in `deployment.md`.

---

## Restore from snapshot

When the database has been corrupted, accidentally truncated, or you need to roll back to a known-good state.

### Procedure

1. **Stop the container.** Do not attempt a hot copy.
   ```bash
   docker compose stop app
   ```
2. Identify the snapshot you want to restore. The snapshot sidecar (see `deployment.md`) writes timestamped `app-YYYYMMDDTHHMMSSZ.db` files.
3. Replace the four DB files in the data volume:
   - `app.db`
   - `app.db-wal`
   - `app.db-shm`
   - `meta.db`

   The simplest safe sequence:
   ```bash
   # working in the host-side mount of the data volume
   mv data/db/app.db data/db/app.db.broken
   rm -f data/db/app.db-wal data/db/app.db-shm
   cp /snapshots/app-20260510T120000Z.db data/db/app.db
   # meta.db is unencrypted and rarely changes; restore from the same window
   cp /snapshots/meta-20260510T120000Z.db data/db/meta.db
   ```

   If your snapshot only captured `app.db` (the SQLite online backup API merges WAL into the file), removing the stale `-wal` / `-shm` is correct — SQLite recreates them on next open.
4. **Start the container.**
   ```bash
   docker compose up -d app
   ```
5. Visit `/app/unlock` and enter the master password that was active **at the time of the snapshot**. If you have rotated the master password since, you must restore both `app.db` *and* `meta.db` from the same snapshot window — they are coupled.
6. Verify:
   - `GET /app/api/encryption/status` → `unlocked`.
   - Spot-check the most recently created document/todo from before the incident.
   - `GET /app/api/audit?limit=20` shows recent entries.
7. Once verified, retain `app.db.broken` for at least 24 hours, then delete.

---

## Audit log investigation

Use during an incident response — abnormal logins, suspected privilege escalation, attachment exfiltration, etc. All endpoints below require admin access.

### Endpoints

- `GET /app/api/audit` — paginated list. Supports filters:
  - `actor` — username or user id
  - `action` — e.g. `auth.login`, `auth.logout`, `totp.verify`, `users.update`, `groups.add_member`, `tuples.create`, `documents.update`, `documents.share.add`, `attachments.upload`, `attachments.download`, `attachments.delete`, `settings.update`, `encryption.change_master`, `encryption.rotate_dek`, `backup.export`, `backup.import`
  - `resource` — `documents:<id>`, `todos:<id>`, `users:<id>`, etc.
  - `result` — `success` | `failure`
  - `from`, `to` — ISO timestamps
  - `ip` — exact client IP
- `GET /app/api/audit/:id` — full event detail (includes the JSON `detail` payload).

### Suggested incident playbook

1. **Scope by time.** Start with `from=<incident_start_minus_1h>&to=<incident_end_plus_1h>`.
2. **Pivot on actor.** If a user account is suspect, filter by `actor=<id>` and review **every** action in the window — not just the suspicious one.
3. **Pivot on IP.** Use the IP from a suspicious entry to find every other action from the same IP across all actors. Look for credential-stuffing patterns (many `auth.login` `failure` rows then a `success`).
4. **Check encryption / backup events.** `encryption.change_master`, `encryption.rotate_dek`, `backup.export`, and `backup.import` are the highest-leverage actions; any unexplained occurrence is a hard incident.
5. **Cross-reference with the application log** (`LOG_FILE` or stdout). The audit table records intent and outcome; the application log records request-level detail (request id, headers, latency).

### Retention

`AUDIT_RETENTION_DAYS` defaults to `0` (keep forever). Long-lived deployments should set a finite value (e.g. `90` or `365`) so `audit_events` does not grow unbounded. The retention sweep runs hourly.

---

## Service-token automation

Two endpoints accept a long-lived bearer instead of an interactive admin session, both gated by the **same** `SERVICE_TOKEN` env var (≥ 32 chars):

- `POST /app/api/backup/export-via-token` — streams the JSON backup. No DEK challenge, no master password. Used by `examples/compose/backup-sidecar.yml`.
- `GET /app/api/metrics` — Prometheus exposition (HTTP request counter + duration histogram, encryption_locked gauge). Configure the Prometheus scrape job to send `Authorization: Bearer ${SERVICE_TOKEN}`.

Operators that don't need either surface should leave `SERVICE_TOKEN` unset; both endpoints then return `503 SERVICE_TOKEN_DISABLED`. Rotate by changing the env var on both the API and any caller, then restarting the API. Constant-time comparison; no length oracle.

Treat `SERVICE_TOKEN` like an OAuth client secret: store in your secrets manager, never commit to git. The audit row for `backup.export-via-token` records `actor:"system"` / `actorName:"system:backup-sidecar"` so you can distinguish automated dumps from operator-driven ones.

---

## Log handling

- Container deployments: keep `LOG_TO_STDOUT=true` (the Dockerfile default). Logs go to docker / journald / k8s and survive container churn. No on-host rotation needed.
- Bare-metal deployments: write to `LOG_FILE` and rotate externally. The example config at `examples/logrotate.d/app` ships a daily rotation with 14-day retention. The `postrotate` hook sends `SIGHUP`; the API responds by reopening the log fd in place (`apps/api/src/index.ts`'s SIGHUP handler), so the next write goes to the freshly-rotated file without process restart.

---

## OIDC discovery cache

`bootstrap` calls the IdP's `/.well-known/openid-configuration` once at startup and persists a copy as `<DB_PATH minus .db>-oidc.json` (e.g. `data/db/app-oidc.json`). On subsequent boots, if the IdP is unreachable we fall back to the cached endpoints — the API still serves traffic with last-known-good URLs. A successful refresh updates the cache; switching `OAUTH_ISSUER` invalidates by issuer mismatch.

Operationally: this cache file contains URLs only (no secrets). It is safe to back up alongside the DB. Delete it to force a fresh discovery on next boot.

---

## Half-encrypted state recovery

If a DEK rotation crashes mid-flight and leaves both `data/db/app.db` (plaintext side) and `data/db/app.db.enc.tmp` (the partially-rotated copy) on disk:

1. Stop the service.
2. Inspect both files; `.enc.tmp` is the in-progress rotation that did not finish the rename swap. The pre-rotation DEK is still authoritative.
3. Delete the `.enc.tmp` file. The original `app.db` and `meta.db` remain valid under the previous DEK.
4. Restart. The boot path detects the existing meta and proceeds with the previous DEK.
5. Re-run rotation once the system is verified healthy.

When in doubt, restore from the most recent snapshot (see "Restore from snapshot") rather than guessing which file is canonical.

# Backup Module

Database export / restore in JSON form, scoped to selected data modules with dependency resolution.

## File layout

```text
apps/api/src/modules/backup/
  backup.routes.ts      # aggregator: mounts export + restore
  registry.ts           # self-registration API (BackupContribution, registerBackupContribution, ...)
  export.routes.ts
  export.service.ts     # generateJsonBackup / verifyDek
  restore.routes.ts
  restore.service.ts    # validateBackupData / validateFileSize / importJsonBackup
  index.ts
```

## Database

No own tables. Each data-bearing module declares a `BackupContribution` from its own `<module>.backup.ts` and registers it from its `index.ts`. The backup module never imports module schemas — it only enumerates whatever modules have registered themselves at boot.

See [`module-standards.md §2.8 — Backup contribution`](../module-standards.md) for the rule new modules must follow.

## Routes

Mounted under `protectedRoutes`. All routes require admin.

| Method | Path | Access | Description |
|---|---|---|---|
| GET | `/api/backup/modules` | Admin | Lists data-module names available for backup. |
| POST | `/api/backup/export` | Admin | Streams a JSON backup of selected modules. Requires DEK challenge when DB encryption is enabled. |
| POST | `/api/backup/import` | Admin | Validates and applies a JSON backup. Requires DEK challenge when DB encryption is enabled. |

Encryption verification flow: client first calls `POST /api/encryption/challenge` to get an ephemeral pubkey, ECIES-encrypts the DEK with it, and submits both `challengeId` and `encryptedDek` in the export/import body.

## Audit

`backup.export`, `backup.import`.

## Out of scope

- Incremental / differential backups.
- Scheduled / off-site backups.
- Cross-version migration of backup files (only matching schema versions are accepted).

# System Module

Cross-cutting health and OpenAPI documentation routes.

## File layout

```text
apps/api/src/modules/system/
  system.routes.ts        # health + OpenAPI docs
  index.ts
```

## Database

No tables.

## Routes

| Method | Path | Group | Access | Description |
|---|---|---|---|---|
| GET | `/api/health` | public | Public | Liveness probe; reports encryption state. |
| GET | `/api/docs` | public | Public | Renders the OpenAPI Swagger / Scalar reference at `/api/openapi.json`. |

## Audit

None — system routes do not perform writes.

## Out of scope

- Readiness probe (only liveness is exposed today).
- Metrics / tracing endpoints.

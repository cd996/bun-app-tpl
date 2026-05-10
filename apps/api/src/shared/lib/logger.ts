import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createConsola } from "consola";
import pino from "pino";

const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);
const CONSOLA_LEVEL_MAP: Record<string, number> = { debug: 4, info: 3, warn: 2, error: 1, fatal: 0 };

interface LoggerConfig {
  readonly LOG_LEVEL: string;
  readonly LOG_FILE: string;
  readonly LOG_TO_STDOUT: boolean;
  readonly NODE_ENV: "development" | "production" | "test";
}

type ConsolaInstance = ReturnType<typeof createConsola>;

interface DestState {
  failed: boolean;
}

function createMethod(
  consola: ConsolaInstance | null,
  file: pino.Logger,
  destState: DestState,
  name: "debug" | "info" | "warn" | "error" | "fatal",
) {
  return (objOrMsg: unknown, msg?: string) => {
    // When the pino destination has signalled an error (disk full, fd
    // closed) async writes silently buffer to a dead stream — pretending
    // logs land. Tee to console as a degraded fallback so operators still
    // see what's happening; consola is also tee'd in dev/test.
    if (destState.failed) {
      const out = typeof objOrMsg === "string"
        ? objOrMsg
        : `${msg ?? ""} ${JSON.stringify(objOrMsg)}`;
      const stream = name === "error" || name === "fatal" ? "error" : "log";
      // eslint-disable-next-line no-console
      console[stream](`[${name}]`, out);
      consola?.[name](out);
      return;
    }
    if (typeof objOrMsg === "string") {
      consola?.[name](objOrMsg);
      file[name](objOrMsg);
    }
    else {
      consola?.[name](msg ?? "", objOrMsg);
      file[name](objOrMsg as object, msg ?? "");
    }
  };
}

/**
 * Pino redact paths. Wildcards (`*.foo`) match any object key one level
 * below the root; deeper or differently-shaped occurrences (e.g.
 * `req.headers.authorization`) need explicit paths.
 */
const REDACT_PATHS = [
  "*.password",
  "*.token",
  "*.secret",
  "*.access_token",
  "*.refresh_token",
  "*.client_secret",
  "*.encryptedDek",
  "*.privateKey",
  "*.dek",
  "*.errorBody",
  "req.headers.authorization",
  "req.headers.cookie",
];

export function createLogger(config: LoggerConfig) {
  const level = VALID_LEVELS.has(config.LOG_LEVEL) ? config.LOG_LEVEL : "info";

  // In production we go pino-only (file or stdout); in dev/test we also tee
  // to consola for friendlier terminal output.
  const consola: ConsolaInstance | null
    = config.NODE_ENV === "production"
      ? null
      : createConsola({
          level: CONSOLA_LEVEL_MAP[level] ?? 3,
          formatOptions: { date: true, colors: true },
        });

  if (!config.LOG_TO_STDOUT)
    mkdirSync(dirname(config.LOG_FILE), { recursive: true });

  const dest = pino.destination(
    config.LOG_TO_STDOUT
      ? { dest: 1, sync: false, minLength: 4096 }
      : { dest: config.LOG_FILE, sync: false, minLength: 4096 },
  );

  // If the destination errors (disk full, fd closed, etc.) flip a flag so
  // every subsequent log method tees to console instead of buffering to a
  // dead stream.
  const destState: DestState = { failed: false };
  dest.on("error", (err: unknown) => {
    destState.failed = true;

    console.error("[logger] destination error, falling back to console-only:", err);
  });

  const fileLogger = pino(
    {
      level,
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    dest,
  );

  return {
    debug: createMethod(consola, fileLogger, destState, "debug"),
    info: createMethod(consola, fileLogger, destState, "info"),
    warn: createMethod(consola, fileLogger, destState, "warn"),
    error: createMethod(consola, fileLogger, destState, "error"),
    fatal: createMethod(consola, fileLogger, destState, "fatal"),
    // Backend logger flush; calls pino-destination's flushSync, unrelated to
    // React DOM's flushSync API.
    flush: () => {
      if (destState.failed)
        return;
      try {
        // eslint-disable-next-line react-dom/no-flush-sync
        dest.flushSync();
      }
      catch {
        // Destination already failed/closed — nothing to flush.
      }
    },
    /**
     * Reopen the file destination — used by the SIGHUP handler in `index.ts`
     * to integrate with logrotate-style external rotators. Flushes the
     * current handle and reopens. No-op when piped to stdout (the runtime
     * owns fd 1) or already failed.
     */
    reopen: () => {
      if (config.LOG_TO_STDOUT || destState.failed)
        return;
      try {
        // eslint-disable-next-line react-dom/no-flush-sync
        dest.flushSync();
      }
      catch {}
      try {
        // pino's SonicBoom destination exposes `reopen()` for this exact
        // purpose. Cast through unknown because the public typings do not
        // expose it.
        const reopenable = dest as unknown as { reopen?: () => void };
        reopenable.reopen?.();
      }
      catch (err) {
        destState.failed = true;
        console.error("[logger] reopen failed:", err);
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;

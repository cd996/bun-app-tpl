import process from "node:process";
import { bootstrap } from "./app";
import { BUILD_INFO } from "./build-info";
import { stopAuditRetentionSweep } from "./modules/audit";
import { acquirePidLock, releasePidLock } from "./pid-lock";

// `--version` (or `-v`) prints the build identifiers and exits before any
// side effects. Useful for `app --version` provenance checks in CI / ops.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  // eslint-disable-next-line no-console
  console.log(`${BUILD_INFO.version} (${BUILD_INFO.commit}) built ${BUILD_INFO.buildTime}`);
  process.exit(0);
}

(async () => {
  const { fetch, config, logger, closeDb } = await bootstrap();
  logger.info({ ...BUILD_INFO }, "build info");

  await acquirePidLock(config.DB_PATH, config.PORT, config.BASE_PATH);

  const server = Bun.serve({
    port: config.PORT,
    hostname: config.HOST,
    // Cap raw request bodies a hair above the per-file upload ceiling so
    // multipart framing overhead doesn't reject otherwise-valid uploads.
    maxRequestBodySize: config.MAX_UPLOAD_BYTES + 64 * 1024,
    fetch: (req, srv) => fetch(req, { IP: srv.requestIP(req) }),
  });

  logger.info({ port: config.PORT, host: config.HOST }, "server started");

  let shuttingDown = false;

  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      logger.debug({ signal }, "shutdown already in progress, ignoring reentrant signal");
      return;
    }
    shuttingDown = true;
    logger.info({ signal }, "shutting down");

    // Order matters:
    //   1. Stop accepting new requests and drain in-flight ones (bounded).
    //   2. Stop background timers (audit retention sweep) so they don't fire
    //      while the DB is closing.
    //   3. Flush the logger before any process termination.
    //   4. Close the DB.
    //   5. Release the PID lock.
    try {
      // Bound the drain: a long backup export should not pin the process past
      // the orchestrator's grace period (typically 30 s). After 25 s, force
      // a hard stop so the DB still closes cleanly before SIGKILL.
      await Promise.race([
        server.stop(true),
        new Promise<void>(resolve => setTimeout(resolve, 25_000).unref?.()),
      ]);
      // If the soft stop did not finish in time, hard-stop to release the port.
      try {
        server.stop(false);
      }
      catch {}
    }
    catch (err) {
      logger.error({ err }, "server.stop failed");
    }

    try {
      await stopAuditRetentionSweep();
    }
    catch (err) {
      logger.error({ err }, "stopAuditRetentionSweep failed");
    }

    try {
      logger.flush();
    }
    catch {
      // Logger flush is best-effort; the destination may already be closed.
    }

    try {
      closeDb();
    }
    catch (err) {
      // Logger may have flushed; emit through stderr as a last resort.

      console.error("closeDb failed:", err);
    }

    releasePidLock();
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  // Logrotate / monit-driven external rotation: re-open the log fd in place
  // so the next write goes to the freshly-rotated file. No-op when logs are
  // streamed to stdout (the runtime owns fd 1).
  process.on("SIGHUP", () => {
    logger.info("received SIGHUP — reopening log file");
    logger.reopen();
  });

  async function fatalCleanup(): Promise<void> {
    try {
      await server.stop(true);
    }
    catch {}
    try {
      await stopAuditRetentionSweep();
    }
    catch {}
    try {
      logger.flush();
    }
    catch {}
    try {
      closeDb();
    }
    catch {}
    releasePidLock();
    process.exit(1);
  }

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    void fatalCleanup();
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ reason }, "unhandled rejection");
    void fatalCleanup();
  });
})();

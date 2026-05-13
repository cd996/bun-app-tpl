import type { Config } from "@/config";
import { registerBackupContribution } from "@/modules/backup/registry";
import { fileBackupContribution } from "./file.backup";
import { setGcMode, setPresignConfig } from "./file.service";
import { initLocalDriver } from "./storage/local";
import { setActiveDriver } from "./storage/registry";

export { fileRoutes } from "./file.routes";
export {
  addReference,
  buildDownloadResponse,
  getFileById,
  getReferenceById,
  listAttachmentsByOwner,
  listReferencesByOwner,
  makeAttachmentView,
  releaseAllByOwner,
  releaseReference,
  totalStoredBytes,
  uploadAndReference,
} from "./file.service";
export { startFileGcSweep, stopFileGcSweep } from "./gc";
export type { FilePermissionHook } from "./permission";
export { registerFilePermissionHook } from "./permission";

registerBackupContribution(fileBackupContribution);

/**
 * Select the active storage driver and push GC / presign settings into the
 * service. Called once from `app.ts::buildFullApp`.
 *
 * Driver registration is itself side-effect-free at module load
 * (`storage/local.ts` only registers when `initLocalDriver` runs).
 */
export function initFileModule(config: Config): void {
  if (config.FILE_STORAGE_DRIVER === "local") {
    initLocalDriver(config.FILE_STORAGE_LOCAL_ROOT);
  }
  setActiveDriver(config.FILE_STORAGE_DRIVER);

  setGcMode(config.FILE_GC_MODE);
  setPresignConfig({
    enabled: config.FILE_PRESIGN_ENABLED,
    ttlSeconds: config.FILE_PRESIGN_TTL_SECONDS,
  });
}

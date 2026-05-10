import { registerBackupContribution } from "@/modules/backup/registry";
import { settingsBackupContribution } from "./settings.backup";

export { settingsRoutes } from "./settings.routes";
export {
  deleteSetting,
  getSetting,
  getSettings,
  setSetting,
} from "./settings.service";
export type { SettingRow } from "./settings.service";

registerBackupContribution(settingsBackupContribution);

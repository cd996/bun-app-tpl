import { registerBackupContribution } from "@/modules/backup/registry";
import { documentBackupContribution } from "./document.backup";

export { documentRoutes } from "./document.routes";

registerBackupContribution(documentBackupContribution);

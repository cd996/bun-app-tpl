import { registerBackupContribution } from "@/modules/backup/registry";
import { policyBackupContribution } from "./policy.backup";

export { policyRoutes } from "./policy.routes";

registerBackupContribution(policyBackupContribution);

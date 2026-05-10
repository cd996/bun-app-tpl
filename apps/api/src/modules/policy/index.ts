import { registerBackupContribution } from "@/modules/backup/registry";
import { policyBackupContribution } from "./policy.backup";

export { loadNamespaces } from "./namespace-config";
export { policyRoutes } from "./policy.routes";
export { check, expand, listUserResources } from "./zanzibar.engine";

registerBackupContribution(policyBackupContribution);

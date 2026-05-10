import { registerBackupContribution } from "@/modules/backup/registry";
import { todoBackupContribution } from "./todo.backup";

export { todoRoutes } from "./todo.routes";

registerBackupContribution(todoBackupContribution);

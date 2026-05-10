import type { BackupContribution } from "@/modules/backup/registry";
import { groups } from "@/modules/account/groups/schema";
import { userPreferences, users } from "@/modules/account/users/schema";

/**
 * Backup contribution for the account meta-module (users + groups +
 * per-user preferences). Lumped under `users` for backward compatibility
 * with backup files written by previous versions of the template.
 */
export const accountBackupContribution: BackupContribution = {
  name: "users",
  tables: [users, groups, userPreferences],
  deps: [],
};

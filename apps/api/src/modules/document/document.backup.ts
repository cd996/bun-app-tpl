import type { BackupContribution } from "@/modules/backup/registry";
import { documentAttachments, documentComments, documentFolders, documents, documentShares } from "@/modules/document/schema";

export const documentBackupContribution: BackupContribution = {
  name: "documents",
  // Order matters within a module: parents first so per-table inserts
  // satisfy foreign keys without extra reorder logic.
  tables: [documentFolders, documents, documentAttachments, documentComments, documentShares],
  deps: ["users"],
};

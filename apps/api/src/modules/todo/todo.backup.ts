import type { BackupContribution } from "@/modules/backup/registry";
import { todoAttachments, todoComments, todos } from "@/modules/todo/schema";

export const todoBackupContribution: BackupContribution = {
  name: "todos",
  tables: [todos, todoAttachments, todoComments],
  deps: ["users"],
};

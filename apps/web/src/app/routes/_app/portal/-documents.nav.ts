import type { NavItem } from "@/shared/components/sidebar/types";
import { FileText } from "lucide-react";

export const documentsNav: NavItem = {
  area: "portal",
  key: "documents",
  path: "/portal/documents",
  icon: FileText,
  order: 30,
};

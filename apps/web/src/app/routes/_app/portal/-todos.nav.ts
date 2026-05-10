import type { NavItem } from "@/shared/components/sidebar/types";
import { CheckSquare } from "lucide-react";

export const todosNav: NavItem = {
  area: "portal",
  key: "myTodos",
  path: "/portal/todos",
  icon: CheckSquare,
  order: 20,
};

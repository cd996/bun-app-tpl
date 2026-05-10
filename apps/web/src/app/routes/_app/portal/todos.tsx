/* eslint-disable react-refresh/only-export-components */
import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/portal/todos")({
  staticData: { titleKey: "page.myTodos.title" },
  component: TodosLayout,
});

function TodosLayout() {
  return <Outlet />;
}

/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { TodoPanel } from "./-todo-panel";

export const Route = createLazyFileRoute("/_app/portal/todos/$todoId")({
  component: TodoFullscreenPage,
});

function TodoFullscreenPage() {
  const { todoId } = useParams({ from: "/_app/portal/todos/$todoId" });
  const navigate = useNavigate();
  const goBack = () => {
    void navigate({ to: "/portal/todos" });
  };
  return (
    <div className="h-full overflow-hidden rounded-lg border">
      <TodoPanel todoId={todoId} variant="fullscreen" onClose={goBack} />
    </div>
  );
}

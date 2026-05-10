/* eslint-disable react-refresh/only-export-components */
import type { CSSProperties, PointerEvent } from "react";
import type { SimpleUser, Todo } from "./-todo-panel";
import { createLazyFileRoute, useNavigate } from "@tanstack/react-router";
import { Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Textarea } from "@/shared/components/ui/textarea";
import { useDebounce } from "@/shared/hooks/use-debounce";
import { http } from "@/shared/lib/http";
import { useAuthStore } from "@/shared/stores/auth";
import {
  priorityKey,
  priorityVariants,

  statusKey,
  statusVariants,

  TodoPanel,
} from "./-todo-panel";

export const Route = createLazyFileRoute("/_app/portal/todos/")({
  component: TodosListPage,
});

interface ListResponse { success: boolean; data: Todo[]; meta: { total: number; page: number; limit: number } }
interface UsersResponse { success: boolean; data: SimpleUser[]; meta: { total: number } }

const DEFAULT_DRAWER_WIDTH = 672;
const MIN_DRAWER_WIDTH = 360;
const MAX_DRAWER_VIEWPORT_RATIO = 0.92;

function clampDrawerWidth(width: number): number {
  if (typeof window === "undefined")
    return width;
  const maxWidth = Math.max(MIN_DRAWER_WIDTH, Math.floor(window.innerWidth * MAX_DRAWER_VIEWPORT_RATIO));
  return Math.min(Math.max(width, MIN_DRAWER_WIDTH), maxWidth);
}

function TodosListPage() {
  const { t } = useTranslation("todos");
  const { user } = useAuthStore();
  const navigate = useNavigate();
  const isAdmin = user?.role === "admin";

  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("__all__");
  const [priorityFilter, setPriorityFilter] = useState("__all__");
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 20 });
  const debouncedSearch = useDebounce(search, 300);

  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [drawerTodoId, setDrawerTodoId] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [deleteConfirm, setDeleteConfirm] = useState<Todo | null>(null);

  const fetchTodos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch)
        params.set("q", debouncedSearch);
      if (statusFilter !== "__all__")
        params.set("status", statusFilter);
      if (priorityFilter !== "__all__")
        params.set("priority", priorityFilter);
      params.set("page", String(page));
      params.set("limit", "20");
      const res = await http<ListResponse>(`/todos?${params}`);
      setTodos(res.data);
      setMeta(res.meta);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter, priorityFilter, page, t]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await http<UsersResponse>("/account/users/active");
      setUsers(res.data);
    }
    catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchTodos();
  }, [fetchTodos]);
  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    const handleResize = () => setDrawerWidth(width => clampDrawerWidth(width));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const confirmDelete = async () => {
    if (!deleteConfirm)
      return;
    try {
      await http(`/todos/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      if (drawerTodoId === deleteConfirm.id)
        setDrawerTodoId(null);
      void fetchTodos();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteConfirm(null);
    }
  };

  const userMap = new Map(users.map(u => [u.id, u]));
  const totalPages = Math.ceil(meta.total / meta.limit);
  const canDelete = (todo: Todo) => isAdmin || todo.creatorId === user?.id;

  const closeDrawer = (opts?: { deleted?: boolean }) => {
    setDrawerTodoId(null);
    if (opts?.deleted)
      void fetchTodos();
  };

  const openFullscreen = (id: string) => {
    void navigate({ to: "/portal/todos/$todoId", params: { todoId: id } });
  };

  const handleDrawerResizeStart = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0)
      return;

    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startWidth = drawerWidth;
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      setDrawerWidth(clampDrawerWidth(startWidth + startX - moveEvent.clientX));
    };

    const handlePointerUp = () => {
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
  }, [drawerWidth]);

  const drawerStyle = {
    "--todo-drawer-width": `${drawerWidth}px`,
  } as CSSProperties;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("page.myTodos.title")}</h1>
          <p className="mt-1 text-muted-foreground">{t("page.myTodos.description")}</p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger render={(
            <Button>
              <Plus className="mr-1 size-4" />
              {t("create")}
            </Button>
          )}
          />
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <CreateTodoForm
              users={users}
              onCreated={(id) => {
                setCreateOpen(false);
                void fetchTodos();
                setDrawerTodoId(id);
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="flex gap-2">
        <Input
          placeholder={t("searchPlaceholder")}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setStatusFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(v: string) => ({
                __all__: t("allStatuses"),
                open: t("statusOpen"),
                in_progress: t("statusInProgress"),
                done: t("statusDone"),
                cancelled: t("statusCancelled"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allStatuses")}</SelectItem>
            <SelectItem value="open">{t("statusOpen")}</SelectItem>
            <SelectItem value="in_progress">{t("statusInProgress")}</SelectItem>
            <SelectItem value="done">{t("statusDone")}</SelectItem>
            <SelectItem value="cancelled">{t("statusCancelled")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={priorityFilter}
          onValueChange={(v) => {
            if (v === null)
              return;
            setPriorityFilter(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue>
              {(v: string) => ({
                __all__: t("allPriorities"),
                low: t("priorityLow"),
                medium: t("priorityMedium"),
                high: t("priorityHigh"),
                urgent: t("priorityUrgent"),
              }[v])}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t("allPriorities")}</SelectItem>
            <SelectItem value="low">{t("priorityLow")}</SelectItem>
            <SelectItem value="medium">{t("priorityMedium")}</SelectItem>
            <SelectItem value="high">{t("priorityHigh")}</SelectItem>
            <SelectItem value="urgent">{t("priorityUrgent")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Delete confirm dialog */}
      <Dialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirm", { title: deleteConfirm?.title })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void confirmDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Table */}
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("col.title")}</TableHead>
              <TableHead>{t("col.status")}</TableHead>
              <TableHead>{t("col.priority")}</TableHead>
              <TableHead>{t("col.assignee")}</TableHead>
              {isAdmin && <TableHead>{t("col.creator")}</TableHead>}
              <TableHead>{t("col.dueDate")}</TableHead>
              <TableHead>{t("col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading
              ? <TableRow><TableCell colSpan={isAdmin ? 7 : 6} className="h-24 text-center text-muted-foreground">{t("common.loading")}</TableCell></TableRow>
              : todos.length === 0
                ? <TableRow><TableCell colSpan={isAdmin ? 7 : 6} className="h-24 text-center text-muted-foreground">{t("noResults")}</TableCell></TableRow>
                : todos.map(todo => (
                    <TableRow
                      key={todo.id}
                      className={`cursor-pointer ${drawerTodoId === todo.id ? "bg-muted/60" : ""}`}
                      onClick={() => setDrawerTodoId(todo.id)}
                    >
                      <TableCell>
                        <div className="font-medium">{todo.title}</div>
                        {todo.description && <div className="text-xs text-muted-foreground line-clamp-1 break-all">{todo.description}</div>}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariants[todo.status]} className="text-xs">
                          {t(`status${statusKey(todo.status)}`)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={priorityVariants[todo.priority]}>
                          {t(`priority${priorityKey(todo.priority)}`)}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {todo.assigneeId ? (userMap.get(todo.assigneeId)?.name ?? todo.assigneeId) : <span className="text-muted-foreground">{t("unassigned")}</span>}
                      </TableCell>
                      {isAdmin && (
                        <TableCell className="text-sm">
                          {userMap.get(todo.creatorId)?.name ?? todo.creatorId}
                        </TableCell>
                      )}
                      <TableCell className="text-sm">{todo.dueDate ?? "—"}</TableCell>
                      <TableCell>
                        <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                          {canDelete(todo) && (
                            <Button variant="ghost" size="icon-sm" onClick={() => setDeleteConfirm(todo)}>
                              <Trash2 className="size-4 text-destructive" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-2">
            <span className="text-xs text-muted-foreground">{t("totalCount", { count: meta.total })}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t("common.prev")}</Button>
              <Button size="sm" variant="outline" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t("common.next")}</Button>
            </div>
          </div>
        )}
      </div>

      {/* Drawer */}
      {drawerTodoId && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]"
            onClick={() => closeDrawer()}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-y-0 right-0 z-50 w-full border-l bg-background shadow-xl sm:w-[min(var(--todo-drawer-width),92vw)]"
            style={drawerStyle}
          >
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={t("resizeDrawer")}
              className="group absolute inset-y-0 left-0 hidden w-3 -translate-x-1/2 cursor-col-resize touch-none items-center justify-center sm:flex"
              onPointerDown={handleDrawerResizeStart}
            >
              <div className="h-full w-px bg-border transition-colors group-hover:bg-primary group-active:bg-primary" />
            </div>
            <TodoPanel
              key={drawerTodoId}
              todoId={drawerTodoId}
              variant="drawer"
              onClose={closeDrawer}
              onMaximize={() => {
                const id = drawerTodoId;
                setDrawerTodoId(null);
                openFullscreen(id);
              }}
              onMutated={() => void fetchTodos()}
            />
          </div>
        </>
      )}
    </div>
  );
}

// ── Create Todo Form ──

function CreateTodoForm({
  users,
  onCreated,
}: {
  readonly users: SimpleUser[];
  readonly onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("todos");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("medium");
  const [assigneeId, setAssigneeId] = useState("__none__");
  const [dueDate, setDueDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim())
      return;
    setSubmitting(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        title: title.trim(),
        priority,
      };
      if (description.trim())
        body.description = description.trim();
      if (assigneeId !== "__none__")
        body.assigneeId = assigneeId;
      if (dueDate)
        body.dueDate = dueDate;
      const res = await http<{ success: boolean; data: Todo }>("/todos", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onCreated(res.data.id);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={e => void handleSubmit(e)}>
      <DialogHeader>
        <DialogTitle>{t("createTitle")}</DialogTitle>
        <DialogDescription>{t("createDescription")}</DialogDescription>
      </DialogHeader>
      <div className="space-y-4 py-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}
        <div className="space-y-2">
          <Label htmlFor="todo-title">{t("field.title")}</Label>
          <Input id="todo-title" value={title} onChange={e => setTitle(e.target.value)} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="todo-desc">{t("field.description")}</Label>
          <Textarea
            id="todo-desc"
            value={description}
            onChange={e => setDescription(e.target.value)}
            rows={3}
            className="max-h-60 overflow-y-auto"
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-2">
            <Label>{t("field.priority")}</Label>
            <Select value={priority} onValueChange={v => v !== null && setPriority(v)}>
              <SelectTrigger className="w-full">
                <SelectValue>
                  {(v: string) => ({
                    low: t("priorityLow"),
                    medium: t("priorityMedium"),
                    high: t("priorityHigh"),
                    urgent: t("priorityUrgent"),
                  }[v])}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="low">{t("priorityLow")}</SelectItem>
                <SelectItem value="medium">{t("priorityMedium")}</SelectItem>
                <SelectItem value="high">{t("priorityHigh")}</SelectItem>
                <SelectItem value="urgent">{t("priorityUrgent")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="todo-due">{t("field.dueDate")}</Label>
            <Input id="todo-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} />
          </div>
        </div>
        <div className="space-y-2">
          <Label>{t("field.assignee")}</Label>
          <Select value={assigneeId} onValueChange={v => v !== null && setAssigneeId(v)}>
            <SelectTrigger className="w-full">
              <SelectValue>
                {(v: string) => {
                  if (v === "__none__")
                    return t("unassigned");
                  const u = users.find(u => u.id === v);
                  return u ? `${u.name} (${u.username})` : v;
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("unassigned")}</SelectItem>
              {users.map(u => (
                <SelectItem key={u.id} value={u.id}>{`${u.name} (${u.username})`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
        <Button type="submit" disabled={submitting || !title.trim()}>{t("create")}</Button>
      </DialogFooter>
    </form>
  );
}

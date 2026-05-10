/* eslint-disable react-refresh/only-export-components */
import {
  ArrowLeft,
  Download,
  FileUp,
  Maximize2,
  MessageSquare,
  Paperclip,
  Pencil,
  Send,
  Trash2,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MarkdownEditor } from "@/shared/components/editor";
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
} from "@/shared/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { useUploadLimits } from "@/shared/hooks/use-upload-limits";
import { formatDate, formatDateTime } from "@/shared/lib/format";
import { BASE_PATH, http } from "@/shared/lib/http";
import { useAuthStore } from "@/shared/stores/auth";
import { validateAttachmentSelection } from "./-attachment-upload";

// ── Types ──

export interface Todo {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: "open" | "in_progress" | "done" | "cancelled";
  readonly priority: "low" | "medium" | "high" | "urgent";
  readonly creatorId: string;
  readonly assigneeId: string | null;
  readonly dueDate: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SimpleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

export interface Attachment {
  readonly id: string;
  readonly todoId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export interface Comment {
  readonly id: string;
  readonly todoId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Helpers ──

export const statusVariants: Record<string, "default" | "outline" | "secondary"> = {
  open: "outline",
  in_progress: "default",
  done: "secondary",
  cancelled: "secondary",
};

export const priorityVariants: Record<string, "default" | "outline" | "secondary" | "destructive"> = {
  low: "secondary",
  medium: "outline",
  high: "default",
  urgent: "destructive",
};

export function statusKey(s: string) {
  const map: Record<string, string> = { open: "Open", in_progress: "InProgress", done: "Done", cancelled: "Cancelled" };
  return map[s] ?? s;
}

export function priorityKey(p: string) {
  const map: Record<string, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };
  return map[p] ?? p;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUSES = ["open", "in_progress", "done", "cancelled"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

// ── TodoPanel ──

interface TodoPanelProps {
  readonly todoId: string;
  readonly variant: "drawer" | "fullscreen";
  readonly onClose: (opts?: { deleted?: boolean }) => void;
  readonly onMaximize?: () => void;
  readonly onMutated?: () => void;
}

export function TodoPanel({ todoId, variant, onClose, onMaximize, onMutated }: TodoPanelProps) {
  const { t } = useTranslation("todos");
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const [todo, setTodo] = useState<Todo | null>(null);
  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const [editingDesc, setEditingDesc] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchTodo = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Todo }>(`/todos/${todoId}`);
      setTodo(res.data);
      setTitleDraft(res.data.title);
      setDescDraft(res.data.description ?? "");
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [todoId, t]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: SimpleUser[] }>("/account/users/active");
      setUsers(res.data);
    }
    catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchTodo();
  }, [fetchTodo]);

  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  const patch = useCallback(async (body: Record<string, unknown>) => {
    try {
      const res = await http<{ success: boolean; data: Todo }>(`/todos/${todoId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setTodo(res.data);
      onMutated?.();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  }, [todoId, t, onMutated]);

  const confirmDelete = async () => {
    try {
      await http(`/todos/${todoId}`, { method: "DELETE" });
      setDeleteOpen(false);
      onClose({ deleted: true });
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteOpen(false);
    }
  };

  const permissions = useMemo(() => {
    if (!todo || !user)
      return { canEditAll: false, canEditStatus: false, canDelete: false };
    const isCreator = todo.creatorId === user.id;
    const isAssignee = todo.assigneeId === user.id;
    const canEditAll = isAdmin || isCreator;
    return {
      canEditAll,
      canEditStatus: canEditAll || isAssignee,
      canDelete: canEditAll,
    };
  }, [todo, user, isAdmin]);

  const userMap = useMemo(() => new Map(users.map(u => [u.id, u])), [users]);

  const saveTitle = () => {
    const trimmed = titleDraft.trim();
    if (todo && trimmed && trimmed !== todo.title) {
      void patch({ title: trimmed });
    }
    else if (todo) {
      setTitleDraft(todo.title);
    }
    setEditingTitle(false);
  };

  const saveDesc = () => {
    if (!todo)
      return;
    const next = descDraft;
    const current = todo.description ?? "";
    if (next !== current) {
      void patch(next.trim() ? { description: next } : { description: null });
    }
    setEditingDesc(false);
  };

  const cancelDesc = () => {
    setDescDraft(todo?.description ?? "");
    setEditingDesc(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      const target = e.target as HTMLElement;
      const isEditable = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (isEditable) {
        target.blur();
        e.stopPropagation();
      }
      else if (variant === "drawer") {
        onClose();
      }
    }
  };

  if (loading && !todo) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (!todo) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-destructive">
        {error ?? t("common.error.loadFailed")}
      </div>
    );
  }

  const creatorName = userMap.get(todo.creatorId)?.name ?? todo.creatorId;

  return (
    <div
      ref={panelRef}
      className="flex h-full flex-col bg-background outline-none"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2 shrink-0">
        {variant === "fullscreen" && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => onClose()}
            title={t("common.back")}
          >
            <ArrowLeft className="size-4" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          {editingTitle && permissions.canEditAll
            ? (
                <input
                  className="w-full bg-transparent text-base font-semibold tracking-tight outline-none border-b-2 border-primary"
                  value={titleDraft}
                  autoFocus
                  onChange={e => setTitleDraft(e.target.value)}
                  onBlur={saveTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      saveTitle();
                    }
                    else if (e.key === "Escape") {
                      setTitleDraft(todo.title);
                      setEditingTitle(false);
                    }
                  }}
                />
              )
            : (
                <h1
                  className={`truncate text-base font-semibold tracking-tight ${permissions.canEditAll ? "cursor-pointer hover:text-primary" : ""}`}
                  onClick={() => permissions.canEditAll && setEditingTitle(true)}
                  title={permissions.canEditAll ? t("clickToEditTitle") : todo.title}
                >
                  {todo.title}
                </h1>
              )}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {permissions.canDelete && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setDeleteOpen(true)}
              title={t("common.delete")}
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
          {variant === "drawer" && onMaximize && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onMaximize}
              title={t("openFullPage")}
            >
              <Maximize2 className="size-4" />
            </Button>
          )}
          {variant === "drawer" && (
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => onClose()}
              title={t("common.close")}
            >
              <X className="size-4" />
            </Button>
          )}
        </div>
      </div>

      {/* Body — scrollable */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          {/* Status */}
          {permissions.canEditStatus
            ? (
                <Select value={todo.status} onValueChange={v => v !== null && void patch({ status: v })}>
                  <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 [&>svg:last-child]:size-3">
                    <Badge variant={statusVariants[todo.status]} className="cursor-pointer">
                      {t(`status${statusKey(todo.status)}`)}
                    </Badge>
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map(s => (
                      <SelectItem key={s} value={s}>{t(`status${statusKey(s)}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            : <Badge variant={statusVariants[todo.status]}>{t(`status${statusKey(todo.status)}`)}</Badge>}

          {/* Priority */}
          {permissions.canEditAll
            ? (
                <Select value={todo.priority} onValueChange={v => v !== null && void patch({ priority: v })}>
                  <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 [&>svg:last-child]:size-3">
                    <Badge variant={priorityVariants[todo.priority]} className="cursor-pointer">
                      {t(`priority${priorityKey(todo.priority)}`)}
                    </Badge>
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map(p => (
                      <SelectItem key={p} value={p}>{t(`priority${priorityKey(p)}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )
            : <Badge variant={priorityVariants[todo.priority]}>{t(`priority${priorityKey(todo.priority)}`)}</Badge>}

          <span className="text-muted-foreground/50">·</span>

          {/* Assignee */}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>
              {t("field.assignee")}
              :
            </span>
            {permissions.canEditAll
              ? (
                  <Select
                    value={todo.assigneeId ?? "__none__"}
                    onValueChange={(v) => {
                      if (v === null)
                        return;
                      void patch({ assigneeId: v === "__none__" ? null : v });
                    }}
                  >
                    <SelectTrigger className="h-auto border-0 bg-transparent p-0 shadow-none gap-1 text-foreground hover:text-primary [&>svg:last-child]:size-3">
                      <SelectValue>
                        {(v: string) => {
                          if (v === "__none__")
                            return <span className="text-muted-foreground italic">{t("unassigned")}</span>;
                          return userMap.get(v)?.name ?? v;
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
                )
              : (
                  <span className="text-foreground">
                    {todo.assigneeId ? (userMap.get(todo.assigneeId)?.name ?? todo.assigneeId) : <span className="italic">{t("unassigned")}</span>}
                  </span>
                )}
          </span>

          <span className="text-muted-foreground/50">·</span>

          {/* Due date */}
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <span>
              {t("field.dueDate")}
              :
            </span>
            {permissions.canEditAll
              ? (
                  <input
                    type="date"
                    className="bg-transparent text-foreground hover:text-primary outline-none text-xs"
                    value={todo.dueDate ?? ""}
                    onChange={e => void patch({ dueDate: e.target.value || null })}
                  />
                )
              : <span className="text-foreground">{todo.dueDate ?? "—"}</span>}
          </span>

          <span className="text-muted-foreground/50">·</span>

          <span className="text-muted-foreground">
            {t("col.creator")}
            :
            <span className="text-foreground">{creatorName}</span>
          </span>
        </div>

        {/* Description */}
        <div>
          <div className="mb-1 flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">{t("field.description")}</div>
            {permissions.canEditAll && !editingDesc && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                onClick={() => setEditingDesc(true)}
              >
                <Pencil className="size-3" />
                {t("common.edit")}
              </button>
            )}
          </div>
          {editingDesc && permissions.canEditAll
            ? (
                <div key="description-edit" className="space-y-2">
                  <MarkdownEditor
                    value={descDraft}
                    onChange={setDescDraft}
                    placeholder={t("field.descriptionPlaceholder")}
                    minHeight={160}
                  />
                  <div className="flex items-center justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={cancelDesc}>
                      {t("common.cancel")}
                    </Button>
                    <Button size="sm" onClick={saveDesc}>
                      {t("common.save")}
                    </Button>
                  </div>
                </div>
              )
            : todo.description
              ? (
                  <div key="description-readonly" className="px-3 py-2">
                    <MarkdownEditor value={todo.description} readOnly />
                  </div>
                )
              : (
                  <div className="min-h-16 rounded-md border border-dashed px-3 py-2 text-sm italic text-muted-foreground leading-relaxed">
                    {t("field.noDescription")}
                  </div>
                )}
        </div>

        {/* Tabs: Comments + Attachments */}
        <Tabs defaultValue="comments">
          <TabsList variant="line">
            <TabsTrigger value="comments">
              <MessageSquare className="size-4" />
              {t("comments.title")}
            </TabsTrigger>
            <TabsTrigger value="attachments">
              <Paperclip className="size-4" />
              {t("attachments.title")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="comments" className="pt-3">
            <CommentSection
              todoId={todo.id}
              userMap={userMap}
              currentUserId={user?.id ?? ""}
              isAdmin={!!isAdmin}
            />
          </TabsContent>
          <TabsContent value="attachments" className="pt-3">
            <AttachmentSection
              todoId={todo.id}
              canUpload={permissions.canEditAll || todo.assigneeId === user?.id}
              isCreator={todo.creatorId === user?.id}
              isAdmin={!!isAdmin}
            />
          </TabsContent>
        </Tabs>

        {/* Timestamps */}
        <div className="flex flex-wrap gap-3 border-t pt-3 text-xs text-muted-foreground">
          <span>
            {t("col.createdAt")}
            :
            {formatDateTime(todo.createdAt)}
          </span>
          <span>
            {t("updatedAt")}
            :
            {formatDateTime(todo.updatedAt)}
          </span>
        </div>
      </div>

      {/* Delete confirm dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirm", { title: todo.title })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void confirmDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Comment Section ──

function CommentSection({
  todoId,
  userMap,
  currentUserId,
  isAdmin,
}: {
  readonly todoId: string;
  readonly userMap: Map<string, SimpleUser>;
  readonly currentUserId: string;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation("todos");
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Comment | null>(null);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Comment[] }>(`/todos/${todoId}/comments`);
      setComments(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [todoId, t]);

  useEffect(() => {
    void fetchComments();
  }, [fetchComments]);

  const handleSubmit = async () => {
    if (!newComment.trim())
      return;
    setSubmitting(true);
    setError(null);
    try {
      await http(`/todos/${todoId}/comments`, { method: "POST", body: JSON.stringify({ content: newComment.trim() }) });
      setNewComment("");
      void fetchComments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget)
      return;
    try {
      await http(`/todos/${deleteTarget.todoId}/comments/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void fetchComments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteTarget(null);
    }
  };

  const canDelete = (c: Comment) => isAdmin || c.authorId === currentUserId;

  const formatTimeAgo = (dateStr: string): string => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1)
      return t("comments.justNow");
    if (minutes < 60)
      return t("comments.minutesAgo", { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
      return t("comments.hoursAgo", { count: hours });
    const days = Math.floor(hours / 24);
    return t("comments.daysAgo", { count: days });
  };

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="mb-3 space-y-2">
        <MarkdownEditor
          key={`new-${comments.length}`}
          defaultValue=""
          onChange={setNewComment}
          placeholder={t("comments.placeholder")}
          compact
          minHeight={80}
        />
        <div className="flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            disabled={submitting || !newComment.trim()}
            onClick={() => void handleSubmit()}
          >
            <Send className="size-3.5" />
            {t("comments.send")}
          </Button>
        </div>
      </div>

      <div className="divide-y">
        {loading
          ? <div className="text-xs text-muted-foreground text-center py-3">{t("common.loading")}</div>
          : comments.length === 0
            ? <div className="text-xs text-muted-foreground text-center py-3">{t("comments.noComments")}</div>
            : comments.map(c => (
                <div key={c.id} className="group py-2.5 first:pt-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs font-medium">{userMap.get(c.authorId)?.name ?? c.authorId}</span>
                      <span className="text-xs text-muted-foreground">{formatTimeAgo(c.createdAt)}</span>
                    </div>
                    {canDelete(c) && (
                      <button
                        type="button"
                        className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center justify-center size-5 rounded hover:bg-accent"
                        onClick={() => setDeleteTarget(c)}
                      >
                        <X className="size-3 text-muted-foreground" />
                      </button>
                    )}
                  </div>
                  <div className="mt-0.5 text-sm">
                    <MarkdownEditor value={c.content} readOnly />
                  </div>
                </div>
              ))}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("comments.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("comments.deleteConfirm")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void handleDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Attachment Section ──

function AttachmentSection({
  todoId,
  canUpload,
  isCreator,
  isAdmin,
}: {
  readonly todoId: string;
  readonly canUpload: boolean;
  readonly isCreator: boolean;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation("todos");
  const { user } = useAuthStore();
  const limits = useUploadLimits();
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAttachments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Attachment[] }>(`/todos/${todoId}/attachments`);
      setAttachments(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [todoId, t]);

  useEffect(() => {
    void fetchAttachments();
  }, [fetchAttachments]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0)
      return;

    if (uploading)
      return;

    setError(null);
    const selectedFiles = Array.from(files);
    const validation = validateAttachmentSelection(selectedFiles, attachments.length, limits.maxFileSize, limits.maxAttachmentsPerResource);

    if (validation === "limit") {
      setError(t("attachments.limitReached"));
      if (fileInputRef.current)
        fileInputRef.current.value = "";
      return;
    }

    if (validation === "size") {
      setError(t("attachments.fileTooLarge"));
      if (fileInputRef.current)
        fileInputRef.current.value = "";
      return;
    }

    let shouldRefresh = false;
    setUploading(true);
    try {
      for (const file of selectedFiles) {
        const formData = new FormData();
        formData.append("file", file);
        await http(`/todos/${todoId}/attachments`, { method: "POST", body: formData });
        shouldRefresh = true;
      }
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.uploadFailed"));
      shouldRefresh = true;
    }
    finally {
      setUploading(false);
      if (fileInputRef.current)
        fileInputRef.current.value = "";
      if (shouldRefresh)
        void fetchAttachments();
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget)
      return;
    try {
      await http(`/todos/${deleteTarget.todoId}/attachments/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void fetchAttachments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteTarget(null);
    }
  };

  const handleDownload = (att: Attachment) => {
    const a = document.createElement("a");
    a.href = `${BASE_PATH}/api/todos/${att.todoId}/attachments/${att.id}`;
    a.download = att.filename;
    a.click();
  };

  const canDeleteAtt = (att: Attachment) => isAdmin || isCreator || att.uploadedBy === user?.id;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {attachments.length}
          /
          {limits.maxAttachmentsPerResource}
        </span>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      {canUpload && (
        <div
          className="rounded-md border-2 border-dashed p-3 text-center text-sm text-muted-foreground cursor-pointer hover:border-primary/50 transition-colors"
          onClick={() => fileInputRef.current?.click()}
          onDrop={(e) => {
            e.preventDefault();
            void handleUpload(e.dataTransfer.files);
          }}
          onDragOver={e => e.preventDefault()}
        >
          <FileUp className="mx-auto mb-1 size-5" />
          {uploading ? t("attachments.uploading") : t("attachments.dragHint")}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => void handleUpload(e.target.files)}
          />
        </div>
      )}

      <div className="mt-3 space-y-2">
        {loading
          ? <div className="text-sm text-muted-foreground text-center py-3">{t("common.loading")}</div>
          : attachments.length === 0
            ? <div className="text-sm text-muted-foreground text-center py-3">{t("attachments.noAttachments")}</div>
            : attachments.map(att => (
                <div key={att.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  {att.mimetype.startsWith("image/") && (
                    <img
                      src={`${BASE_PATH}/api/todos/${att.todoId}/attachments/${att.id}`}
                      alt={att.filename}
                      className="size-10 rounded object-cover shrink-0"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{att.filename}</div>
                    <div className="text-xs text-muted-foreground">
                      {formatFileSize(att.size)}
                      {" · "}
                      {formatDate(att.createdAt)}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => handleDownload(att)}>
                    <Download className="size-4" />
                  </Button>
                  {canDeleteAtt(att) && (
                    <Button variant="ghost" size="icon-sm" onClick={() => setDeleteTarget(att)}>
                      <X className="size-4 text-destructive" />
                    </Button>
                  )}
                </div>
              ))}
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("attachments.deleteTitle")}</DialogTitle>
            <DialogDescription>{t("attachments.deleteConfirm", { filename: deleteTarget?.filename })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void handleDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

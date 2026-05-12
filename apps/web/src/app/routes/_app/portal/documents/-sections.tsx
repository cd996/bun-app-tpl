// Comment / attachment / share sections, lifted out of the legacy
// documents.lazy.tsx and rewired to TanStack Query. Each section owns its
// own queries so the immersive detail page can mount them independently
// (the comments tab still works even if the detail query is stale).

import type {
  Attachment,
  Document,
  DocumentComment,
  DocumentShare,
  SimpleGroup,
  SimpleUser,
} from "@/shared/lib/api/documents";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FileUp, Lock, Send, X } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownEditor } from "@/shared/components/editor";
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
import { useUploadLimits } from "@/shared/hooks/use-upload-limits";
import { documentsKeys } from "@/shared/lib/api/documents";
import { formatDate } from "@/shared/lib/format";
import { BASE_PATH, http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";

const MAX_SIZE_FALLBACK = 10 * 1024 * 1024;

function formatFileSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function useFormatTimeAgo() {
  const { t } = useTranslation("documents");
  return (dateStr: string): string => {
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
}

// ── Comment Section ──

export function CommentSection({
  documentId,
  userMap,
  currentUserId,
  isAdmin,
}: {
  readonly documentId: string;
  readonly userMap: Map<string, SimpleUser>;
  readonly currentUserId: string;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation("documents");
  const qc = useQueryClient();
  const formatTimeAgo = useFormatTimeAgo();
  const [newComment, setNewComment] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<DocumentComment | null>(null);
  const [error, setError] = useState<string | null>(null);

  const commentsQuery = useQuery({
    queryKey: documentsKeys.comments(documentId),
    queryFn: () => http<{ data: DocumentComment[] }>(`/documents/${documentId}/comments`).then(r => r.data),
  });

  const submit = useMutation({
    mutationFn: async (content: string) => {
      await http(`/documents/${documentId}/comments`, {
        method: "POST",
        body: JSON.stringify({ content }),
      });
    },
    onSuccess: () => {
      setNewComment("");
      setEditorKey(k => k + 1);
      void qc.invalidateQueries({ queryKey: documentsKeys.comments(documentId) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("common.error.operationFailed")),
  });

  const remove = useMutation({
    mutationFn: async (comment: DocumentComment) => {
      await http(`/documents/${comment.documentId}/comments/${comment.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: documentsKeys.comments(documentId) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("common.error.deleteFailed")),
  });

  const canDeleteComment = (c: DocumentComment) => isAdmin || c.authorId === currentUserId;

  return (
    <div>
      {error && (
        <div className="mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div className="mb-4 space-y-2">
        <MarkdownEditor
          key={editorKey}
          onChange={md => setNewComment(md)}
          compact
          placeholder={t("comments.placeholder")}
          minHeight={60}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            disabled={submit.isPending || !newComment.trim()}
            onClick={() => submit.mutate(newComment.trim())}
          >
            <Send className="size-3.5 mr-1.5" />
            {t("comments.send")}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {commentsQuery.isLoading
          ? <div className="text-sm text-muted-foreground text-center py-4">{t("common.loading")}</div>
          : (commentsQuery.data ?? []).length === 0
              ? <div className="text-sm text-muted-foreground text-center py-4">{t("comments.noComments")}</div>
              : (commentsQuery.data ?? []).map(comment => (
                  <div key={comment.id} className="group rounded-lg border px-4 py-3">
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {userMap.get(comment.authorId)?.name ?? comment.authorId}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatTimeAgo(comment.createdAt)}
                        </span>
                      </div>
                      {canDeleteComment(comment) && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-0 group-hover:opacity-100 transition-opacity"
                          onClick={() => setDeleteTarget(comment)}
                        >
                          <X className="size-3.5 text-muted-foreground" />
                        </Button>
                      )}
                    </div>
                    <MarkdownEditor
                      defaultValue={comment.content}
                      readOnly
                      className="text-sm"
                    />
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
            <Button variant="destructive" onClick={() => deleteTarget && remove.mutate(deleteTarget)}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Attachment Section ──

export function AttachmentSection({
  documentId,
  isCreator,
  isAdmin,
  currentUserId,
}: {
  readonly documentId: string;
  readonly isCreator: boolean;
  readonly isAdmin: boolean;
  readonly currentUserId: string;
}) {
  const { t } = useTranslation("documents");
  const qc = useQueryClient();
  const limits = useUploadLimits();
  const maxSize = limits.maxFileSize > 0 ? limits.maxFileSize : MAX_SIZE_FALLBACK;
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const attachmentsQuery = useQuery({
    queryKey: documentsKeys.attachments(documentId),
    queryFn: () => http<{ data: Attachment[] }>(`/documents/${documentId}/attachments`).then(r => r.data),
  });

  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file);
        await http(`/documents/${documentId}/attachments`, { method: "POST", body: fd });
      }
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentsKeys.attachments(documentId) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("attachments.uploadFailed", { defaultValue: t("common.error.operationFailed") })),
  });

  const remove = useMutation({
    mutationFn: async (att: Attachment) => {
      await http(`/documents/${att.documentId}/attachments/${att.id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setDeleteTarget(null);
      void qc.invalidateQueries({ queryKey: documentsKeys.attachments(documentId) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("common.error.deleteFailed")),
  });

  const handleUpload = useCallback((files: FileList | null) => {
    if (!files || files.length === 0)
      return;
    setError(null);
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > maxSize)
        rejected.push(file.name);
      else
        accepted.push(file);
    }
    if (rejected.length > 0) {
      setError(t("attachments.fileTooLargeNamed", { names: rejected.join(", "), defaultValue: t("attachments.fileTooLarge") }));
      if (accepted.length === 0)
        return;
    }
    upload.mutate(accepted, {
      onSettled: () => {
        if (fileInputRef.current)
          fileInputRef.current.value = "";
      },
    });
  }, [maxSize, t, upload]);

  const handleDownload = (att: Attachment) => {
    const a = document.createElement("a");
    a.href = `${BASE_PATH}/api/documents/${att.documentId}/attachments/${att.id}`;
    a.download = att.filename;
    a.click();
  };

  const canDeleteAtt = (att: Attachment) => isAdmin || isCreator || att.uploadedBy === currentUserId;
  const attachments = attachmentsQuery.data ?? [];

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground">
          {attachments.length}
          /20
        </span>
      </div>

      {error && (
        <div className="mb-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
      )}

      <div
        className="rounded-md border-2 border-dashed p-3 text-center text-sm text-muted-foreground cursor-pointer hover:border-primary/50 transition-colors"
        onClick={() => fileInputRef.current?.click()}
        onDrop={(e) => {
          e.preventDefault();
          handleUpload(e.dataTransfer.files);
        }}
        onDragOver={e => e.preventDefault()}
      >
        <FileUp className="mx-auto mb-1 size-5" />
        {upload.isPending ? t("attachments.uploading") : t("attachments.dragHint")}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={e => handleUpload(e.target.files)}
        />
      </div>

      <div className="mt-3 space-y-2">
        {attachmentsQuery.isLoading
          ? <div className="text-sm text-muted-foreground text-center py-3">{t("common.loading")}</div>
          : attachments.length === 0
            ? <div className="text-sm text-muted-foreground text-center py-3">{t("attachments.noAttachments")}</div>
            : attachments.map(att => (
                <div key={att.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                  {att.mimetype.startsWith("image/") && (
                    <img
                      src={`${BASE_PATH}/api/documents/${att.documentId}/attachments/${att.id}`}
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
            <Button variant="destructive" onClick={() => deleteTarget && remove.mutate(deleteTarget)}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Share Dialog ──

export function ShareDialog({
  doc,
  users,
  groups,
  userMap,
  onClose,
}: {
  readonly doc: Document;
  readonly users: readonly SimpleUser[];
  readonly groups: readonly SimpleGroup[];
  readonly userMap: Map<string, SimpleUser>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  const qc = useQueryClient();
  const [targetType, setTargetType] = useState<"user" | "group">("user");
  const [targetId, setTargetId] = useState("");
  const [permission, setPermission] = useState<"viewer" | "editor">("viewer");
  const [error, setError] = useState<string | null>(null);

  const sharesQuery = useQuery({
    queryKey: documentsKeys.shares(doc.id),
    queryFn: () => http<{ data: DocumentShare[] }>(`/documents/${doc.id}/shares`).then(r => r.data),
  });

  const addShare = useMutation({
    mutationFn: async () => {
      await http(`/documents/${doc.id}/shares`, {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, permission }),
      });
    },
    onSuccess: () => {
      setTargetId("");
      void qc.invalidateQueries({ queryKey: documentsKeys.shares(doc.id) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("common.error.operationFailed")),
  });

  const removeShare = useMutation({
    mutationFn: async (shareId: string) => {
      await http(`/documents/${doc.id}/shares/${shareId}`, { method: "DELETE" });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentsKeys.shares(doc.id) });
    },
    onError: err => setError(err instanceof Error ? err.message : t("common.error.deleteFailed")),
  });

  const groupMap = new Map(groups.map(g => [g.id, g]));
  const shares = sharesQuery.data ?? [];
  const targetName = (share: DocumentShare) => {
    if (share.targetType === "user")
      return userMap.get(share.targetId)?.name ?? share.targetId;
    return groupMap.get(share.targetId)?.name ?? share.targetId;
  };

  // Filter out targets that already have a *direct* (non-inherited) grant
  // on this doc. Targets that hold only an inherited grant remain
  // selectable so the user can escalate (e.g. inherited viewer → editor).
  const availableTargets = targetType === "user"
    ? users.filter(u => u.id !== doc.creatorId && !shares.some(s => s.targetType === "user" && s.targetId === u.id && s.inheritedFrom === null))
    : groups.filter(g => !shares.some(s => s.targetType === "group" && s.targetId === g.id && s.inheritedFrom === null));

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open)
          onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shareTitle")}</DialogTitle>
          <DialogDescription>{t("shareDescription")}</DialogDescription>
        </DialogHeader>

        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        <div className="space-y-3">
          <div className="flex gap-2">
            <Select
              value={targetType}
              onValueChange={(v) => {
                setTargetType(v as "user" | "group");
                setTargetId("");
              }}
            >
              <SelectTrigger size="sm" className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="user">{t("targetUser")}</SelectItem>
                <SelectItem value="group">{t("targetGroup")}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={targetId || "__none__"} onValueChange={v => setTargetId(!v || v === "__none__" ? "" : v)}>
              <SelectTrigger size="sm" className="flex-1">
                <SelectValue>
                  {(v: string) => {
                    if (v === "__none__")
                      return targetType === "user" ? t("targetUser") : t("targetGroup");
                    if (targetType === "user")
                      return userMap.get(v)?.name ?? v;
                    return groupMap.get(v)?.name ?? v;
                  }}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__" disabled>--</SelectItem>
                {availableTargets.map(item => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Select value={permission} onValueChange={v => setPermission(v as "viewer" | "editor")}>
              <SelectTrigger size="sm" className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">{t("viewer")}</SelectItem>
                <SelectItem value="editor">{t("editor")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" disabled={!targetId || addShare.isPending} onClick={() => addShare.mutate()}>
              {t("addShare")}
            </Button>
          </div>
        </div>

        <div className="space-y-2 mt-2">
          {sharesQuery.isLoading
            ? <div className="text-sm text-muted-foreground text-center py-3">{t("common.loading")}</div>
            : shares.length === 0
              ? <div className="text-sm text-muted-foreground text-center py-3">{t("noShares")}</div>
              : shares.map(share => (
                  <div
                    key={share.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md border px-3 py-2",
                      share.inheritedFrom && "bg-muted/40",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{targetName(share)}</div>
                      <div className="text-xs text-muted-foreground">
                        {share.targetType === "user" ? t("targetUser") : t("targetGroup")}
                        {" · "}
                        {share.permission === "editor" ? t("editor") : t("viewer")}
                        {share.inheritedFrom && (
                          <>
                            {" · "}
                            <span className="italic">{t("inheritedFrom", { title: share.inheritedFrom.title })}</span>
                          </>
                        )}
                      </div>
                    </div>
                    {share.inheritedFrom
                      ? (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            disabled
                            title={t("inheritedNotRemovable")}
                            className="opacity-50 cursor-not-allowed"
                          >
                            <Lock className="size-4 text-muted-foreground" />
                          </Button>
                        )
                      : (
                          <Button variant="ghost" size="icon-sm" onClick={() => removeShare.mutate(share.id)}>
                            <X className="size-4 text-destructive" />
                          </Button>
                        )}
                  </div>
                ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

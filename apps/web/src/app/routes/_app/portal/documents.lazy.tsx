/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute } from "@tanstack/react-router";
import { Check, ChevronDown, ChevronRight, Download, FileText, FileUp, FolderClosed, FolderOpen, FolderPlus, MessageSquare, Paperclip, Pencil, Plus, Search, Send, Share2, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
import { Input } from "@/shared/components/ui/input";
import { Label } from "@/shared/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/shared/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { useDebounce } from "@/shared/hooks/use-debounce";
import { useUploadLimits } from "@/shared/hooks/use-upload-limits";
import { formatDate } from "@/shared/lib/format";
import { BASE_PATH, http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";
import { useAuthStore } from "@/shared/stores/auth";

export const Route = createLazyFileRoute("/_app/portal/documents")({
  component: DocumentsPage,
});

// ── Types ──

interface Document {
  readonly id: string;
  readonly title: string;
  readonly content: string | null;
  readonly tags: string;
  readonly folderId: string | null;
  readonly creatorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface SimpleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

interface Attachment {
  readonly id: string;
  readonly documentId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

interface Comment {
  readonly id: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface DocumentShare {
  readonly id: string;
  readonly documentId: string;
  readonly targetType: "user" | "group";
  readonly targetId: string;
  readonly permission: "viewer" | "editor";
  readonly createdAt: string;
}

interface SimpleGroup {
  readonly id: string;
  readonly name: string;
}

interface Folder {
  readonly id: string;
  readonly name: string;
  readonly creatorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface ListResponse { success: boolean; data: Document[]; meta: { total: number; page: number; limit: number } }
interface UsersResponse { success: boolean; data: SimpleUser[]; meta: { total: number } }

// ── Helpers ──

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  }
  catch {
    return [];
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Hardcoded fallback retained for the rare path where useUploadLimits
// hasn't resolved yet (network partial / first paint). Real cap comes from
// the API's `/system/upload-limits` endpoint via the hook.
const MAX_SIZE_FALLBACK = 10 * 1024 * 1024;

// ── Main Page: Standard Notes style sidebar layout ──

function DocumentsPage() {
  const { t } = useTranslation("documents");
  const { user } = useAuthStore();
  const isAdmin = user?.role === "admin";

  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [allTags, setAllTags] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, page: 1, limit: 50 });
  const debouncedSearch = useDebounce(search, 300);

  const [users, setUsers] = useState<SimpleUser[]>([]);
  const [groups, setGroups] = useState<SimpleGroup[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set(["__unfiled__"]));
  const [newFolderName, setNewFolderName] = useState("");
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderDialogError, setFolderDialogError] = useState<string | null>(null);
  const [editingFolder, setEditingFolder] = useState<string | null>(null);
  const [editFolderName, setEditFolderName] = useState("");
  const [deleteFolderConfirm, setDeleteFolderConfirm] = useState<Folder | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<Document | null>(null);
  const [mode, setMode] = useState<"view" | "create" | "edit">("view");
  const [deleteConfirm, setDeleteConfirm] = useState<Document | null>(null);
  const [shareDoc, setShareDoc] = useState<Document | null>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (debouncedSearch)
        params.set("q", debouncedSearch);
      if (tagFilter)
        params.set("tag", tagFilter);
      params.set("page", String(page));
      params.set("limit", "200");
      const res = await http<ListResponse>(`/documents?${params}`);
      setDocuments(res.data);
      setMeta(res.meta);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [debouncedSearch, tagFilter, page, t]);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await http<UsersResponse>("/account/users/active");
      setUsers(res.data);
    }
    catch { /* ignore */ }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: SimpleGroup[] }>("/documents/groups");
      setGroups(res.data);
    }
    catch { /* ignore */ }
  }, []);

  const fetchTags = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: string[] }>("/documents/tags");
      setAllTags(res.data);
    }
    catch { /* ignore */ }
  }, []);

  const fetchFolders = useCallback(async () => {
    try {
      const res = await http<{ success: boolean; data: Folder[] }>("/documents/folders");
      setFolders(res.data);
    }
    catch { /* ignore */ }
  }, []);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);
  useEffect(() => {
    void fetchUsers();
  }, [fetchUsers]);
  useEffect(() => {
    void fetchGroups();
  }, [fetchGroups]);
  useEffect(() => {
    void fetchTags();
  }, [fetchTags]);
  useEffect(() => {
    void fetchFolders();
  }, [fetchFolders]);

  const refreshSelected = useCallback(async (id: string) => {
    try {
      const res = await http<{ success: boolean; data: Document }>(`/documents/${id}`);
      setSelectedDoc(res.data);
    }
    catch { /* ignore */ }
  }, []);

  const confirmDelete = async () => {
    if (!deleteConfirm)
      return;
    try {
      await http(`/documents/${deleteConfirm.id}`, { method: "DELETE" });
      setDeleteConfirm(null);
      if (selectedDoc?.id === deleteConfirm.id) {
        setSelectedDoc(null);
        setMode("view");
      }
      void fetchDocuments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteConfirm(null);
    }
  };

  const handleCreateFolder = async () => {
    if (!newFolderName.trim())
      return;
    setFolderDialogError(null);
    try {
      await http("/documents/folders", { method: "POST", body: JSON.stringify({ name: newFolderName.trim() }) });
      setNewFolderName("");
      setCreatingFolder(false);
      void fetchFolders();
    }
    catch (err) {
      setFolderDialogError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const handleRenameFolder = async (fid: string) => {
    if (!editFolderName.trim())
      return;
    try {
      await http(`/documents/folders/${fid}`, { method: "PATCH", body: JSON.stringify({ name: editFolderName.trim() }) });
      setEditingFolder(null);
      void fetchFolders();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
  };

  const confirmDeleteFolder = async () => {
    if (!deleteFolderConfirm)
      return;
    try {
      await http(`/documents/folders/${deleteFolderConfirm.id}`, { method: "DELETE" });
      setDeleteFolderConfirm(null);
      void fetchFolders();
      void fetchDocuments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteFolderConfirm(null);
    }
  };

  const toggleFolder = (fid: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(fid))
        next.delete(fid);
      else next.add(fid);
      return next;
    });
  };

  const userMap = new Map(users.map(u => [u.id, u]));
  const folderMap = new Map(folders.map(f => [f.id, f]));
  const totalPages = Math.ceil(meta.total / meta.limit);
  const isOwner = (doc: Document) => isAdmin || doc.creatorId === user?.id;

  // Group documents by folder for tree view
  const docsByFolder = new Map<string | null, Document[]>();
  for (const doc of documents) {
    const key = doc.folderId;
    const list = docsByFolder.get(key);
    if (list)
      list.push(doc);
    else docsByFolder.set(key, [doc]);
  }
  const unfiledDocs = docsByFolder.get(null) ?? [];

  return (
    <div className="flex flex-col md:flex-row h-[calc(100svh-60px)] md:h-[calc(100svh-28px)] -mx-4 -my-3 md:-mx-6 md:-my-4">
      {/* ── Left sidebar: document list ── */}
      <div className="flex w-full md:w-72 shrink-0 flex-col border-r bg-muted/30 lg:w-80">
        {/* Sidebar header */}
        <div className="flex items-center justify-between border-b px-3 py-2">
          <h2 className="text-sm font-semibold">{t("page.myDocuments.title")}</h2>
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setSelectedDoc(null);
                setMode("create");
              }}
              title={t("create")}
            >
              <Plus className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              onClick={() => {
                setNewFolderName("");
                setCreatingFolder(true);
              }}
              title={t("newFolder")}
            >
              <FolderPlus className="size-4" />
            </Button>
          </div>
        </div>

        {/* Search + filters */}
        <div className="space-y-1.5 border-b px-3 py-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder={t("searchPlaceholder")}
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="h-7 pl-7 text-xs"
            />
          </div>
          {allTags.length > 0 && (
            <Select
              value={tagFilter || "__all__"}
              onValueChange={(v) => {
                if (v === null)
                  return;
                setTagFilter(v === "__all__" ? "" : v);
                setPage(1);
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue>
                  {(v: string) => v === "__all__" ? t("allTags") : v}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">{t("allTags")}</SelectItem>
                {allTags.map(tag => (
                  <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Tree view: folders + documents */}
        <div className="flex-1 overflow-y-auto">
          {loading
            ? <div className="py-8 text-center text-xs text-muted-foreground">{t("common.loading")}</div>
            : error
              ? <div className="px-3 py-4 text-xs text-destructive">{error}</div>
              : (
                  <div className="py-1">
                    {/* Default (unfiled) folder — always first */}
                    <div>
                      <button
                        type="button"
                        onClick={() => toggleFolder("__unfiled__")}
                        className="w-full flex items-center gap-1 px-2 py-1.5 text-xs font-medium hover:bg-accent/50 transition-colors text-left"
                      >
                        {expandedFolders.has("__unfiled__")
                          ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                          : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                        {expandedFolders.has("__unfiled__")
                          ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
                          : <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" />}
                        <span className="truncate">{t("defaultFolder")}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{unfiledDocs.length}</span>
                      </button>
                      {expandedFolders.has("__unfiled__") && (
                        unfiledDocs.length > 0
                          ? unfiledDocs.map(doc => (
                              <DocTreeItem
                                key={doc.id}
                                doc={doc}
                                selected={selectedDoc?.id === doc.id && mode === "view"}
                                indent
                                onSelect={() => {
                                  setSelectedDoc(doc);
                                  setMode("view");
                                }}
                              />
                            ))
                          : (
                              <div className="pl-10 py-1.5 text-[10px] text-muted-foreground italic">{t("noResults")}</div>
                            )
                      )}
                    </div>
                    {/* Folder nodes */}
                    {folders.map((folder) => {
                      const folderDocs = docsByFolder.get(folder.id) ?? [];
                      const expanded = expandedFolders.has(folder.id);
                      const canManage = isAdmin || folder.creatorId === user?.id;

                      return (
                        <div key={folder.id}>
                          {/* Folder header */}
                          <div className="group flex items-center">
                            {editingFolder === folder.id
                              ? (
                                  <form
                                    className="flex-1 flex items-center gap-1 px-2 py-0.5"
                                    onSubmit={(e) => {
                                      e.preventDefault();
                                      void handleRenameFolder(folder.id);
                                    }}
                                  >
                                    <Input
                                      value={editFolderName}
                                      onChange={e => setEditFolderName(e.target.value)}
                                      className="h-6 text-xs flex-1"
                                      autoFocus
                                      onBlur={() => setEditingFolder(null)}
                                      onKeyDown={e => e.key === "Escape" && setEditingFolder(null)}
                                    />
                                    <Button type="submit" size="icon-sm" variant="ghost" className="size-5" onMouseDown={e => e.preventDefault()}>
                                      <Check className="size-3" />
                                    </Button>
                                  </form>
                                )
                              : (
                                  <button
                                    type="button"
                                    onClick={() => toggleFolder(folder.id)}
                                    className="flex-1 flex items-center gap-1 px-2 py-1.5 text-xs font-medium hover:bg-accent/50 transition-colors text-left"
                                  >
                                    {expanded
                                      ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                                      : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                                    {expanded
                                      ? <FolderOpen className="size-3.5 shrink-0 text-amber-500" />
                                      : <FolderClosed className="size-3.5 shrink-0 text-amber-500" />}
                                    <span className="truncate">{folder.name}</span>
                                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{folderDocs.length}</span>
                                  </button>
                                )}
                            {editingFolder !== folder.id && canManage && (
                              <div className="flex pr-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="size-5"
                                  onClick={() => {
                                    setEditingFolder(folder.id);
                                    setEditFolderName(folder.name);
                                  }}
                                >
                                  <Pencil className="size-2.5" />
                                </Button>
                                <Button
                                  size="icon-sm"
                                  variant="ghost"
                                  className="size-5"
                                  onClick={() => setDeleteFolderConfirm(folder)}
                                >
                                  <Trash2 className="size-2.5 text-destructive" />
                                </Button>
                              </div>
                            )}
                          </div>
                          {/* Folder children */}
                          {expanded && folderDocs.map(doc => (
                            <DocTreeItem
                              key={doc.id}
                              doc={doc}
                              selected={selectedDoc?.id === doc.id && mode === "view"}
                              indent
                              onSelect={() => {
                                setSelectedDoc(doc);
                                setMode("view");
                              }}
                            />
                          ))}
                          {expanded && folderDocs.length === 0 && (
                            <div className="pl-10 py-1.5 text-[10px] text-muted-foreground italic">{t("noResults")}</div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t px-3 py-1.5">
            <span className="text-[10px] text-muted-foreground">{meta.total}</span>
            <div className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-6 px-2 text-xs">{t("common.prev")}</Button>
              <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="h-6 px-2 text-xs">{t("common.next")}</Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Right content area ── */}
      <div className="flex-1 overflow-y-auto">
        {mode === "create"
          ? (
              <div className="p-4 md:p-6">
                <DocInlineForm
                  folders={folders}
                  onSubmit={async (data) => {
                    const res = await http<{ success: boolean; data: Document }>("/documents", { method: "POST", body: JSON.stringify(data) });
                    void fetchDocuments();
                    setSelectedDoc(res.data);
                    setMode("view");
                    return res.data.id;
                  }}
                  onCancel={() => {
                    setMode("view");
                  }}
                  title={t("createTitle")}
                  submitLabel={t("create")}
                />
              </div>
            )
          : mode === "edit" && selectedDoc
            ? (
                <div className="p-4 md:p-6">
                  <DocInlineForm
                    key={selectedDoc.id}
                    initial={selectedDoc}
                    folders={folders}
                    onSubmit={async (data) => {
                      await http(`/documents/${selectedDoc.id}`, { method: "PATCH", body: JSON.stringify(data) });
                      void fetchDocuments();
                      await refreshSelected(selectedDoc.id);
                      setMode("view");
                    }}
                    onCancel={() => setMode("view")}
                    title={t("editTitle")}
                    submitLabel={t("common.save")}
                  />
                </div>
              )
            : selectedDoc
              ? (
                  <div className="p-4 md:p-6">
                    <DocContentArea
                      key={`${selectedDoc.id}-${selectedDoc.updatedAt}`}
                      doc={selectedDoc}
                      userMap={userMap}
                      folderMap={folderMap}
                      isAdmin={!!isAdmin}
                      currentUserId={user?.id ?? ""}
                      isOwner={isOwner(selectedDoc)}
                      onEdit={() => setMode("edit")}
                      onDelete={() => setDeleteConfirm(selectedDoc)}
                      onShare={() => setShareDoc(selectedDoc)}
                    />
                  </div>
                )
              : (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <div className="text-center">
                      <FileText className="mx-auto mb-3 size-10 opacity-30" />
                      <p className="text-sm">{t("selectToView")}</p>
                    </div>
                  </div>
                )}
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

      {/* Folder create dialog */}
      <Dialog
        open={creatingFolder}
        onOpenChange={(open) => {
          if (!open) {
            setCreatingFolder(false);
            setNewFolderName("");
            setFolderDialogError(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("newFolder")}</DialogTitle>
          </DialogHeader>
          <form
            id="create-folder-form"
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void handleCreateFolder();
            }}
          >
            <Label htmlFor="new-folder-name">{t("folderName")}</Label>
            <Input
              id="new-folder-name"
              value={newFolderName}
              onChange={(e) => {
                setNewFolderName(e.target.value);
                setFolderDialogError(null);
              }}
              placeholder={t("folderName")}
              autoFocus
              maxLength={200}
            />
            {folderDialogError && (
              <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{folderDialogError}</div>
            )}
          </form>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button type="submit" form="create-folder-form" disabled={!newFolderName.trim()}>
              {t("common.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Folder delete confirm dialog */}
      <Dialog
        open={deleteFolderConfirm !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteFolderConfirm(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteFolderTitle")}</DialogTitle>
            <DialogDescription>{t("deleteFolderConfirm", { name: deleteFolderConfirm?.name })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={() => void confirmDeleteFolder()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share dialog */}
      {shareDoc && (
        <ShareDialog
          doc={shareDoc}
          users={users}
          groups={groups}
          userMap={userMap}
          onClose={() => setShareDoc(null)}
        />
      )}
    </div>
  );
}

// ── Tree Item (sidebar) ──

function DocTreeItem({
  doc,
  selected,
  indent,
  onSelect,
}: {
  readonly doc: Document;
  readonly selected: boolean;
  readonly indent?: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-1.5 text-left px-2 py-1.5 text-xs transition-colors hover:bg-accent/50",
        indent && "pl-8",
        selected && "bg-accent",
      )}
    >
      <FileText className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="truncate flex-1">{doc.title}</span>
      <span className="text-[10px] text-muted-foreground shrink-0 tabular-nums">
        {formatDate(doc.updatedAt)}
      </span>
    </button>
  );
}

// ── Content Area (right pane) ──

function DocContentArea({
  doc,
  userMap,
  folderMap,
  isAdmin,
  currentUserId,
  isOwner,
  onEdit,
  onDelete,
  onShare,
}: {
  readonly doc: Document;
  readonly userMap: Map<string, SimpleUser>;
  readonly folderMap: Map<string, Folder>;
  readonly isAdmin: boolean;
  readonly currentUserId: string;
  readonly isOwner: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onShare: () => void;
}) {
  const { t } = useTranslation("documents");
  const creatorName = userMap.get(doc.creatorId);
  const folderName = doc.folderId ? folderMap.get(doc.folderId)?.name : null;

  return (
    <div className="space-y-4">
      {/* Title + actions */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{doc.title}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{creatorName ? creatorName.name : doc.creatorId}</span>
            <span>·</span>
            <span>{formatDate(doc.updatedAt)}</span>
            {folderName && (
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 gap-1">
                <FolderClosed className="size-2.5" />
                {folderName}
              </Badge>
            )}
            {parseTags(doc.tags).map(tag => (
              <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                {tag}
              </Badge>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {isOwner && (
            <Button size="icon-sm" variant="ghost" onClick={onShare} title={t("share")}>
              <Share2 className="size-4" />
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={onEdit} title={t("common.edit")}>
            <Pencil className="size-4" />
          </Button>
          {isOwner && (
            <Button size="icon-sm" variant="ghost" onClick={onDelete} title={t("common.delete")}>
              <Trash2 className="size-4 text-destructive" />
            </Button>
          )}
        </div>
      </div>

      {/* Document content */}
      {doc.content && (
        <MarkdownEditor
          defaultValue={doc.content}
          readOnly
        />
      )}

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
        <TabsContent value="comments" className="pt-4">
          <CommentSection
            documentId={doc.id}
            userMap={userMap}
            currentUserId={currentUserId}
            isAdmin={isAdmin}
          />
        </TabsContent>
        <TabsContent value="attachments" className="pt-4">
          <AttachmentSection
            documentId={doc.id}
            isCreator={doc.creatorId === currentUserId}
            isAdmin={isAdmin}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Inline Form (right pane) ──

const RE_TAG_UNSAFE = /[^\w-]/g;

function DocInlineForm({
  initial,
  folders,
  defaultFolderId,
  onSubmit,
  onCancel,
  title,
  submitLabel,
}: {
  readonly initial?: Document | undefined;
  readonly folders?: Folder[] | undefined;
  readonly defaultFolderId?: string | undefined;
  readonly onSubmit: (data: Record<string, unknown>) => Promise<string | void>;
  readonly onCancel: () => void;
  readonly title: string;
  readonly submitLabel: string;
}) {
  const { t } = useTranslation("documents");
  const limits = useUploadLimits();
  const maxSize = limits.maxFileSize > 0 ? limits.maxFileSize : MAX_SIZE_FALLBACK;
  const maxAttachments = limits.maxAttachmentsPerResource > 0 ? limits.maxAttachmentsPerResource : 20;
  const [titleVal, setTitleVal] = useState(initial?.title ?? "");
  const [editorContent, setEditorContent] = useState(initial?.content ?? "");
  const [folderId, setFolderId] = useState<string | null>(initial?.folderId ?? defaultFolderId ?? null);
  const [tags, setTags] = useState<string[]>(() => (initial ? parseTags(initial.tags) : []));
  const [tagInput, setTagInput] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files)
      return;
    // Partition rather than bail on the first oversize file — surfacing
    // both lists tells the user exactly which selections were dropped
    // instead of silently truncating multi-file drag-drop.
    const accepted: File[] = [];
    const rejected: File[] = [];
    for (const file of Array.from(files)) {
      (file.size > maxSize ? rejected : accepted).push(file);
    }
    if (rejected.length > 0)
      setFormError(t("attachments.fileTooLargeNamed", { names: rejected.map(f => f.name).join(", "), defaultValue: t("attachments.fileTooLarge") }));
    setPendingFiles(prev => [...prev, ...accepted].slice(0, maxAttachments));
    if (fileInputRef.current)
      fileInputRef.current.value = "";
  };

  const removeFile = (index: number) => {
    setPendingFiles(prev => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!titleVal.trim())
      return;
    setSubmitting(true);
    setFormError(null);
    try {
      const data: Record<string, unknown> = {
        title: titleVal.trim(),
        content: editorContent,
        tags,
        folderId,
      };
      const docId = await onSubmit(data);

      const targetId = docId ?? initial?.id;
      if (targetId && pendingFiles.length > 0) {
        for (const file of pendingFiles) {
          const formData = new FormData();
          formData.append("file", file);
          await http(`/documents/${targetId}/attachments`, { method: "POST", body: formData });
        }
      }
    }
    catch (err) {
      setFormError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={e => void handleSubmit(e)} className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{title}</h1>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>{t("common.cancel")}</Button>
          <Button type="submit" size="sm" disabled={submitting || !titleVal.trim()}>
            {submitting ? t("attachments.uploading") : submitLabel}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {formError && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{formError}</div>
        )}
        {folders && folders.length > 0
          ? (
              <div className="grid grid-cols-[11rem_1fr] gap-x-3 gap-y-2">
                <Label>{t("folder")}</Label>
                <Label htmlFor="doc-title">{t("field.title")}</Label>
                <Select value={folderId ?? "__none__"} onValueChange={v => setFolderId(v === "__none__" ? null : v)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>
                      {(v: string) => v === "__none__" ? t("unfiled") : folders.find(f => f.id === v)?.name ?? v}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent side="bottom" align="start" alignItemWithTrigger={false}>
                    <SelectItem value="__none__">{t("unfiled")}</SelectItem>
                    {folders.map(f => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input id="doc-title" value={titleVal} onChange={e => setTitleVal(e.target.value)} required autoFocus />
              </div>
            )
          : (
              <div className="space-y-2">
                <Label htmlFor="doc-title">{t("field.title")}</Label>
                <Input id="doc-title" value={titleVal} onChange={e => setTitleVal(e.target.value)} required autoFocus />
              </div>
            )}

        <div className="space-y-2">
          <Label>{t("field.content")}</Label>
          <MarkdownEditor
            defaultValue={initial?.content ?? ""}
            onChange={md => setEditorContent(md)}
            placeholder={t("field.contentPlaceholder")}
            minHeight={320}
          />
        </div>

        {/* Tags */}
        <div className="space-y-2">
          <Label htmlFor="doc-tags">{t("field.tags")}</Label>
          <div className="flex items-center gap-1 flex-wrap rounded-md border px-2 py-1.5">
            {tags.map(tag => (
              <Badge key={tag} variant="secondary" className="gap-1 text-xs">
                {tag}
                <button
                  type="button"
                  onClick={() => setTags(prev => prev.filter(t2 => t2 !== tag))}
                  className="ml-0.5 hover:text-destructive"
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Input
              id="doc-tags"
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
                  e.preventDefault();
                  const newTag = tagInput.trim().toLowerCase().replace(RE_TAG_UNSAFE, "");
                  if (newTag && !tags.includes(newTag)) {
                    setTags(prev => [...prev, newTag]);
                  }
                  setTagInput("");
                }
              }}
              placeholder={t("tagsPlaceholder")}
              className="h-7 w-32 min-w-0 flex-1 border-0 shadow-none text-xs focus-visible:ring-0"
            />
          </div>
        </div>

        {/* Attachment upload area */}
        <div className="space-y-2">
          <Label>{t("attachments.title")}</Label>
          <div
            className="rounded-md border-2 border-dashed p-3 text-center text-sm text-muted-foreground cursor-pointer hover:border-primary/50 transition-colors"
            onClick={() => fileInputRef.current?.click()}
            onDrop={(e) => {
              e.preventDefault();
              addFiles(e.dataTransfer.files);
            }}
            onDragOver={e => e.preventDefault()}
          >
            <FileUp className="mx-auto mb-1 size-5" />
            {t("attachments.dragHint")}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*,application/pdf,text/*,application/zip,application/x-7z-compressed"
              className="hidden"
              onChange={e => addFiles(e.target.files)}
            />
          </div>
          {pendingFiles.length > 0 && (
            <div className="space-y-1.5">
              {pendingFiles.map((file, i) => (
                <div key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm">
                  <span className="truncate flex-1">{file.name}</span>
                  <span className="text-xs text-muted-foreground shrink-0">{formatFileSize(file.size)}</span>
                  <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeFile(i)}>
                    <X className="size-3.5 text-muted-foreground" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </form>
  );
}

// ── Comment Section ──

function CommentSection({
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
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [newComment, setNewComment] = useState("");
  const [editorKey, setEditorKey] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Comment | null>(null);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Comment[] }>(`/documents/${documentId}/comments`);
      setComments(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [documentId, t]);

  useEffect(() => {
    void fetchComments();
  }, [fetchComments]);

  const handleSubmit = async () => {
    if (!newComment.trim())
      return;
    setSubmitting(true);
    setError(null);
    try {
      await http(`/documents/${documentId}/comments`, { method: "POST", body: JSON.stringify({ content: newComment.trim() }) });
      setNewComment("");
      setEditorKey(k => k + 1);
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
      await http(`/documents/${deleteTarget.documentId}/comments/${deleteTarget.id}`, { method: "DELETE" });
      setDeleteTarget(null);
      void fetchComments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
      setDeleteTarget(null);
    }
  };

  const canDeleteComment = (comment: Comment) => isAdmin || comment.authorId === currentUserId;

  function formatTimeAgo(dateStr: string): string {
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
  }

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
            disabled={submitting || !newComment.trim()}
            onClick={() => void handleSubmit()}
          >
            <Send className="size-3.5 mr-1.5" />
            {t("comments.send")}
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {loading
          ? <div className="text-sm text-muted-foreground text-center py-4">{t("common.loading")}</div>
          : comments.length === 0
            ? <div className="text-sm text-muted-foreground text-center py-4">{t("comments.noComments")}</div>
            : comments.map(comment => (
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
            <Button variant="destructive" onClick={() => void handleDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Attachment Section ──

function AttachmentSection({
  documentId,
  isCreator,
  isAdmin,
}: {
  readonly documentId: string;
  readonly isCreator: boolean;
  readonly isAdmin: boolean;
}) {
  const { t } = useTranslation("documents");
  const { user } = useAuthStore();
  const limits = useUploadLimits();
  const maxSize = limits.maxFileSize > 0 ? limits.maxFileSize : MAX_SIZE_FALLBACK;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Attachment | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchAttachments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: Attachment[] }>(`/documents/${documentId}/attachments`);
      setAttachments(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [documentId, t]);

  useEffect(() => {
    void fetchAttachments();
  }, [fetchAttachments]);

  const handleUpload = async (files: FileList | null) => {
    if (!files || files.length === 0)
      return;
    setError(null);
    const oversized: string[] = [];
    for (const file of Array.from(files)) {
      if (file.size > maxSize)
        oversized.push(file.name);
    }
    if (oversized.length > 0) {
      setError(t("attachments.fileTooLargeNamed", { names: oversized.join(", "), defaultValue: t("attachments.fileTooLarge") }));
      return;
    }
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const formData = new FormData();
        formData.append("file", file);
        await http(`/documents/${documentId}/attachments`, { method: "POST", body: formData });
      }
      void fetchAttachments();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.uploadFailed"));
    }
    finally {
      setUploading(false);
      if (fileInputRef.current)
        fileInputRef.current.value = "";
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget)
      return;
    try {
      await http(`/documents/${deleteTarget.documentId}/attachments/${deleteTarget.id}`, { method: "DELETE" });
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
    a.href = `${BASE_PATH}/api/documents/${att.documentId}/attachments/${att.id}`;
    a.download = att.filename;
    a.click();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    void handleUpload(e.dataTransfer.files);
  };

  const canDeleteAtt = (att: Attachment) => isAdmin || isCreator || att.uploadedBy === user?.id;

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
        onDrop={handleDrop}
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

      <div className="mt-3 space-y-2">
        {loading
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
            <Button variant="destructive" onClick={() => void handleDelete()}>{t("common.delete")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Share Dialog ──

function ShareDialog({
  doc,
  users,
  groups,
  userMap,
  onClose,
}: {
  readonly doc: Document;
  readonly users: SimpleUser[];
  readonly groups: SimpleGroup[];
  readonly userMap: Map<string, SimpleUser>;
  readonly onClose: () => void;
}) {
  const { t } = useTranslation("documents");
  const [shares, setShares] = useState<DocumentShare[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetType, setTargetType] = useState<"user" | "group">("user");
  const [targetId, setTargetId] = useState("");
  const [permission, setPermission] = useState<"viewer" | "editor">("viewer");
  const [submitting, setSubmitting] = useState(false);

  const groupMap = new Map(groups.map(g => [g.id, g]));

  const fetchShares = useCallback(async () => {
    setLoading(true);
    try {
      const res = await http<{ success: boolean; data: DocumentShare[] }>(`/documents/${doc.id}/shares`);
      setShares(res.data);
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.loadFailed"));
    }
    finally {
      setLoading(false);
    }
  }, [doc.id, t]);

  useEffect(() => {
    void fetchShares();
  }, [fetchShares]);

  const handleAdd = async () => {
    if (!targetId)
      return;
    setSubmitting(true);
    setError(null);
    try {
      await http(`/documents/${doc.id}/shares`, {
        method: "POST",
        body: JSON.stringify({ targetType, targetId, permission }),
      });
      setTargetId("");
      void fetchShares();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    }
    finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (shareId: string) => {
    try {
      await http(`/documents/${doc.id}/shares/${shareId}`, { method: "DELETE" });
      void fetchShares();
    }
    catch (err) {
      setError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
    }
  };

  const targetName = (share: DocumentShare) => {
    if (share.targetType === "user") {
      return userMap.get(share.targetId)?.name ?? share.targetId;
    }
    return groupMap.get(share.targetId)?.name ?? share.targetId;
  };

  // Filter out already-shared targets
  const availableTargets = targetType === "user"
    ? users.filter(u => u.id !== doc.creatorId && !shares.some(s => s.targetType === "user" && s.targetId === u.id))
    : groups.filter(g => !shares.some(s => s.targetType === "group" && s.targetId === g.id));

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

        {/* Add share form */}
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
            <Button size="sm" disabled={!targetId || submitting} onClick={() => void handleAdd()}>
              {t("addShare")}
            </Button>
          </div>
        </div>

        {/* Current shares */}
        <div className="space-y-2 mt-2">
          {loading
            ? <div className="text-sm text-muted-foreground text-center py-3">{t("common.loading")}</div>
            : shares.length === 0
              ? <div className="text-sm text-muted-foreground text-center py-3">{t("noShares")}</div>
              : shares.map(share => (
                  <div key={share.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{targetName(share)}</div>
                      <div className="text-xs text-muted-foreground">
                        {share.targetType === "user" ? t("targetUser") : t("targetGroup")}
                        {" · "}
                        {share.permission === "editor" ? t("editor") : t("viewer")}
                      </div>
                    </div>
                    <Button variant="ghost" size="icon-sm" onClick={() => void handleRemove(share.id)}>
                      <X className="size-4 text-destructive" />
                    </Button>
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

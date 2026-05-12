// Immersive document editor.
//
// Layout: a centered max-w-[760px] reading column (Bear-style) inside the
// `documents.tsx` sidebar layout. Saving is autosave-only: any title /
// content / tag mutation runs through {@link useUpdateDocument} after an
// 800ms debounce, sending the current `version` so the server can reject
// concurrent edits with 409 (handled in the mutation hook).
//
// Header bar is sticky at the top of the scrollable content area and
// carries breadcrumb + save status + actions (TOC toggle, view/edit
// toggle, share, delete). The Milkdown editor's own toolbar fades in on
// focus (driven by data-doc-detail CSS in milkdown-editor.css).

/* eslint-disable react-refresh/only-export-components */
import { useQuery } from "@tanstack/react-query";
import { createLazyFileRoute, Link, useNavigate, useParams } from "@tanstack/react-router";
import { Eye, FileText, MessageSquare, MoreHorizontal, PanelRightOpen, Paperclip, Pencil, Share2, Trash2, X } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MarkdownEditor } from "@/shared/components/editor";
import { TableOfContents, useHeadingAnchors } from "@/shared/components/editor/toc";
import { scanMarkdownHeadings } from "@/shared/components/editor/toc-scanner";
import { Badge } from "@/shared/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/components/ui/breadcrumb";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { Input } from "@/shared/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/shared/components/ui/sheet";
import {
  buildAncestorChain,
  documentsKeys,
  DocumentVersionConflictError,
  parseTags,
  useDeleteDocument,
  useDocument,
  useDocumentGroups,
  useDocumentTree,
  useDocumentUsers,
  useUpdateDocument,
} from "@/shared/lib/api/documents";
import { http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";
import { useAuthStore } from "@/shared/stores/auth";

import { AttachmentSection, CommentSection, ShareDialog } from "./-sections";

export const Route = createLazyFileRoute("/_app/portal/documents/$docId")({
  component: DocumentDetailPage,
});

const VIEW_MODE_KEY = "documents:viewMode";
const AUTOSAVE_DEBOUNCE_MS = 800;
const SAVED_FLASH_MS = 2_000;

type ViewMode = "edit" | "preview";

function readPersistedViewMode(): ViewMode {
  if (typeof window === "undefined")
    return "edit";
  const raw = window.localStorage.getItem(VIEW_MODE_KEY);
  return raw === "preview" ? "preview" : "edit";
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

function DocumentDetailPage() {
  const { docId } = useParams({ from: "/_app/portal/documents/$docId" });
  // Keying the inner component on docId remounts state when the route
  // params change — cleaner than reconciling draft/dirty against an
  // unrelated document.
  return <DocumentEditor key={docId} docId={docId} />;
}

function DocumentEditor({ docId }: { readonly docId: string }) {
  const { t } = useTranslation("documents");
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === "admin";

  const docQuery = useDocument(docId);
  const treeQuery = useDocumentTree();
  const usersQuery = useDocumentUsers();
  const groupsQuery = useDocumentGroups();
  const updateMutation = useUpdateDocument();
  const deleteMutation = useDeleteDocument();

  const [viewMode, setViewMode] = useState<ViewMode>(readPersistedViewMode);
  const [showToc, setShowToc] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  const [attachmentDrawerOpen, setAttachmentDrawerOpen] = useState(false);
  const [tagInput, setTagInput] = useState("");

  // Pre-fetch the lists so the footer can show a count affordance and the
  // drawers open as a cache hit. The drawer sections reuse the same query
  // keys, so we share fetches and storage.
  const commentsQuery = useQuery({
    queryKey: documentsKeys.comments(docId),
    queryFn: () => http<{ data: unknown[] }>(`/documents/${docId}/comments`).then(r => r.data),
    staleTime: 10_000,
  });
  const attachmentsQuery = useQuery({
    queryKey: documentsKeys.attachments(docId),
    queryFn: () => http<{ data: unknown[] }>(`/documents/${docId}/attachments`).then(r => r.data),
    staleTime: 10_000,
  });
  const commentCount = commentsQuery.data?.length ?? 0;
  const attachmentCount = attachmentsQuery.data?.length ?? 0;

  const [draft, setDraft] = useState<{ title: string; content: string; tags: string[] } | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const editorContainerRef = useRef<HTMLDivElement>(null);
  const saveTimeoutRef = useRef<number | undefined>(undefined);

  // Seed the draft from server data on first load. If the remote row updates
  // while we have no in-flight local edits (dirty=false), re-seed so other
  // editors' changes appear. If we DO have local edits, leave the draft alone
  // — version conflicts are handled separately so the next save still wins.
  useEffect(() => {
    if (!docQuery.data)
      return;
    if (draft === null || !dirty) {
      // eslint-disable-next-line react/set-state-in-effect -- syncing server data into a local controlled draft is the canonical use of useEffect here.
      setDraft({
        title: docQuery.data.title,
        content: docQuery.data.content ?? "",
        tags: parseTags(docQuery.data.tags),
      });
    }
  }, [docQuery.data, draft, dirty]);

  // Persist view mode across reloads — Bear-style single-doc UI gets noisy
  // if the toggle resets on every navigation.
  useEffect(() => {
    if (typeof window === "undefined")
      return;
    window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
  }, [viewMode]);

  // Cmd/Ctrl+Shift+P — toggle preview. Matches the spec's keyboard shortcut.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        setViewMode(m => (m === "edit" ? "preview" : "edit"));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const flushSave = useCallback(async () => {
    const current = docQuery.data;
    if (!current || !draft)
      return;
    setSaveStatus("saving");
    try {
      await updateMutation.mutateAsync({
        id: current.id,
        version: current.version,
        title: draft.title,
        content: draft.content,
        tags: draft.tags,
      });
      setDirty(false);
      setSaveStatus("saved");
      setLastSavedAt(Date.now());
    }
    catch (err) {
      if (err instanceof DocumentVersionConflictError) {
        // The mutation hook installed the fresh row into cache; our next save
        // attempt will use the new version. Keep the draft so the user does
        // not lose their changes, just notify.
        setSaveStatus("saved");
        setLastSavedAt(Date.now());
        toast.warning(t("save.conflictReloaded", { defaultValue: "Document changed elsewhere — reloaded" }));
      }
      else {
        setSaveStatus("failed");
      }
    }
  }, [docQuery.data, draft, updateMutation, t]);

  // Debounce autosave. Any draft change while `dirty` is true (re)starts the
  // timer; settling at 800ms triggers a single PATCH.
  useEffect(() => {
    if (!dirty)
      return;
    if (saveTimeoutRef.current)
      window.clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = window.setTimeout(() => {
      void flushSave();
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimeoutRef.current)
        window.clearTimeout(saveTimeoutRef.current);
    };
  }, [draft, dirty, flushSave]);

  // After a successful save, drop the "Saved" flash back to idle so the
  // header stops claiming a fresh write.
  useEffect(() => {
    if (saveStatus !== "saved")
      return;
    const handle = window.setTimeout(setSaveStatus, SAVED_FLASH_MS, "idle");
    return () => window.clearTimeout(handle);
  }, [saveStatus, lastSavedAt]);

  useHeadingAnchors(editorContainerRef, draft?.content ?? "");

  const headings = useMemo(() => scanMarkdownHeadings(draft?.content ?? ""), [draft?.content]);

  const handleTitleChange = (next: string) => {
    setDraft(prev => prev ? { ...prev, title: next } : prev);
    setDirty(true);
  };
  const handleContentChange = (next: string) => {
    setDraft(prev => prev ? { ...prev, content: next } : prev);
    setDirty(true);
  };
  const handleAddTag = () => {
    const raw = tagInput.trim().toLowerCase().replace(/[^\w-]/g, "");
    if (!raw)
      return;
    setTagInput("");
    setDraft((prev) => {
      if (!prev || prev.tags.includes(raw))
        return prev;
      return { ...prev, tags: [...prev.tags, raw] };
    });
    setDirty(true);
  };
  const handleRemoveTag = (tag: string) => {
    setDraft(prev => prev ? { ...prev, tags: prev.tags.filter(t2 => t2 !== tag) } : prev);
    setDirty(true);
  };

  const handleDelete = () => {
    deleteMutation.mutate(docId, {
      onSuccess: () => {
        setDeleteOpen(false);
        void navigate({ to: "/portal/documents" });
      },
    });
  };

  if (docQuery.isLoading || draft === null) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        {t("common.loading")}
      </div>
    );
  }
  if (docQuery.error || !docQuery.data) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
        {docQuery.error instanceof Error ? docQuery.error.message : t("common.error.loadFailed")}
      </div>
    );
  }

  const doc = docQuery.data;
  const creator = usersQuery.data?.find(u => u.id === doc.creatorId);
  const isOwner = isAdmin || doc.creatorId === user?.id;
  const userMap = new Map((usersQuery.data ?? []).map(u => [u.id, u]));
  const ancestors = treeQuery.data ? buildAncestorChain(treeQuery.data, doc.id) : [];
  const ancestorPath = ancestors.slice(0, -1);

  return (
    <div data-doc-detail="true" className="md-editor-prose relative">
      <DetailHeader
        ancestors={ancestorPath}
        currentTitle={draft.title || t("untitledPlaceholder", { defaultValue: "Untitled" })}
        saveStatus={saveStatus}
        lastSavedAt={lastSavedAt}
        viewMode={viewMode}
        onToggleViewMode={() => setViewMode(m => (m === "edit" ? "preview" : "edit"))}
        showToc={showToc}
        onToggleToc={() => setShowToc(v => !v)}
        canShare={isOwner}
        onShare={() => setShareOpen(true)}
        canDelete={isOwner}
        onDelete={() => setDeleteOpen(true)}
        commentCount={commentCount}
        attachmentCount={attachmentCount}
        onOpenComments={() => setCommentDrawerOpen(true)}
        onOpenAttachments={() => setAttachmentDrawerOpen(true)}
      />

      <div className="flex">
        <div className="flex-1 min-w-0 px-4 sm:px-10 py-8">
          <div className="mx-auto max-w-[760px]">
            <TitleEditor
              value={draft.title}
              placeholder={t("untitledPlaceholder", { defaultValue: "Untitled" })}
              onChange={handleTitleChange}
              readOnly={viewMode === "preview"}
            />

            <Metadata
              creatorName={creator?.name ?? doc.creatorId}
              updatedAt={doc.updatedAt}
              tags={draft.tags}
              onRemoveTag={viewMode === "edit" ? handleRemoveTag : undefined}
              tagInput={tagInput}
              setTagInput={setTagInput}
              onAddTag={handleAddTag}
              showTagInput={viewMode === "edit"}
            />

            <div ref={editorContainerRef} className="mt-6">
              {viewMode === "edit"
                ? (
                    <MarkdownEditor
                      value={draft.content}
                      onChange={handleContentChange}
                      placeholder={t("field.contentPlaceholder")}
                      minHeight={320}
                    />
                  )
                : (
                    <MarkdownEditor value={draft.content} readOnly />
                  )}
            </div>

            <div className="mt-8 pt-4 border-t flex items-center gap-2 text-xs text-muted-foreground">
              <button
                type="button"
                onClick={() => setCommentDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <MessageSquare className="size-3.5" />
                <span>{t("comments.title")}</span>
                <span className="tabular-nums">{commentCount}</span>
              </button>
              <button
                type="button"
                onClick={() => setAttachmentDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-accent/50 hover:text-foreground transition-colors"
              >
                <Paperclip className="size-3.5" />
                <span>{t("attachments.title")}</span>
                <span className="tabular-nums">{attachmentCount}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Right TOC — sticky on xl+, drawer-style toggle below xl. */}
        <aside
          className={cn(
            "hidden xl:block w-52 shrink-0 pr-8 pt-12",
            !showToc && "xl:hidden",
            showToc && "xl:block",
          )}
        >
          <div className="sticky top-14">
            <TableOfContents
              headings={headings}
              label={t("toc.title", { defaultValue: "Contents" })}
              emptyMessage={t("toc.empty", { defaultValue: "No headings yet" })}
            />
          </div>
        </aside>
      </div>

      {/* Mobile TOC drawer surface */}
      {showToc && (
        <div className="xl:hidden fixed inset-y-0 right-0 z-30 w-64 bg-background border-l shadow-xl px-4 py-4 overflow-y-auto">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t("toc.title", { defaultValue: "Contents" })}
            </span>
            <Button size="icon-sm" variant="ghost" onClick={() => setShowToc(false)}>
              <X className="size-4" />
            </Button>
          </div>
          <TableOfContents
            headings={headings}
            label={t("toc.title", { defaultValue: "Contents" })}
            emptyMessage={t("toc.empty", { defaultValue: "No headings yet" })}
          />
        </div>
      )}

      {shareOpen && (
        <ShareDialog
          doc={doc}
          users={usersQuery.data ?? []}
          groups={groupsQuery.data ?? []}
          userMap={userMap}
          onClose={() => setShareOpen(false)}
        />
      )}

      <Dialog open={deleteOpen} onOpenChange={open => setDeleteOpen(open)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>{t("deleteConfirm", { title: doc.title })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button variant="destructive" onClick={handleDelete} disabled={deleteMutation.isPending}>
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/*
        Side drawers — `modal={false}` lets the user keep editing the doc
        while the drawer is open, which is the whole point of pulling
        comments and attachments out of the in-flow tabs. Width is fixed at
        ~400px per the spec.
      */}
      <Sheet open={commentDrawerOpen} onOpenChange={setCommentDrawerOpen} modal={false}>
        <SheetContent
          side="right"
          className="w-[400px] sm:max-w-[400px] flex flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t("comments.title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("comments.title")}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <CommentSection
              documentId={doc.id}
              userMap={userMap}
              currentUserId={user?.id ?? ""}
              isAdmin={isAdmin}
            />
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={attachmentDrawerOpen} onOpenChange={setAttachmentDrawerOpen} modal={false}>
        <SheetContent
          side="right"
          className="w-[400px] sm:max-w-[400px] flex flex-col"
        >
          <SheetHeader>
            <SheetTitle>{t("attachments.title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("attachments.title")}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            <AttachmentSection
              documentId={doc.id}
              isCreator={doc.creatorId === user?.id}
              isAdmin={isAdmin}
              currentUserId={user?.id ?? ""}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ── Header bar ──

function DetailHeader({
  ancestors,
  currentTitle,
  saveStatus,
  lastSavedAt,
  viewMode,
  onToggleViewMode,
  showToc,
  onToggleToc,
  canShare,
  onShare,
  canDelete,
  onDelete,
  commentCount,
  attachmentCount,
  onOpenComments,
  onOpenAttachments,
}: {
  readonly ancestors: readonly { id: string; title: string }[];
  readonly currentTitle: string;
  readonly saveStatus: SaveStatus;
  readonly lastSavedAt: number | null;
  readonly viewMode: ViewMode;
  readonly onToggleViewMode: () => void;
  readonly showToc: boolean;
  readonly onToggleToc: () => void;
  readonly canShare: boolean;
  readonly onShare: () => void;
  readonly canDelete: boolean;
  readonly onDelete: () => void;
  readonly commentCount: number;
  readonly attachmentCount: number;
  readonly onOpenComments: () => void;
  readonly onOpenAttachments: () => void;
}) {
  const { t } = useTranslation("documents");
  return (
    <div className="sticky top-0 z-20 h-10 px-4 sm:px-10 flex items-center justify-between gap-3 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/portal/documents" className="hover:text-foreground transition-colors">
              <FileText className="size-3.5 inline -mt-0.5 mr-1" />
              {t("page.myDocuments.title")}
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        {ancestors.map(ancestor => (
          <Fragment key={ancestor.id}>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link
                  to="/portal/documents/$docId"
                  params={{ docId: ancestor.id }}
                  className="hover:text-foreground transition-colors truncate"
                >
                  {ancestor.title}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{currentTitle}</BreadcrumbPage>
        </BreadcrumbItem>
      </Breadcrumb>

      <SaveStatusBadge status={saveStatus} lastSavedAt={lastSavedAt} />

      <div className="flex items-center gap-0.5 shrink-0">
        <Button size="icon-sm" variant="ghost" onClick={onOpenComments} title={t("comments.title")} className="relative">
          <MessageSquare className="size-4" />
          {commentCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[9px] leading-none flex items-center justify-center px-1 tabular-nums">
              {commentCount}
            </span>
          )}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onOpenAttachments} title={t("attachments.title")} className="relative">
          <Paperclip className="size-4" />
          {attachmentCount > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-3.5 h-3.5 rounded-full bg-primary text-primary-foreground text-[9px] leading-none flex items-center justify-center px-1 tabular-nums">
              {attachmentCount}
            </span>
          )}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onToggleViewMode} title={viewMode === "edit" ? t("viewMode.preview", { defaultValue: "Preview" }) : t("viewMode.edit", { defaultValue: "Edit" })}>
          {viewMode === "edit" ? <Eye className="size-4" /> : <Pencil className="size-4" />}
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={onToggleToc} title={showToc ? t("toc.hide", { defaultValue: "Hide TOC" }) : t("toc.show", { defaultValue: "Show TOC" })}>
          <PanelRightOpen className="size-4" />
        </Button>
        {canShare && (
          <Button size="icon-sm" variant="ghost" onClick={onShare} title={t("share")}>
            <Share2 className="size-4" />
          </Button>
        )}
        {canDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" title={t("common.more", { defaultValue: "More" })}><MoreHorizontal className="size-4" /></Button>} />
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onDelete}>
                <Trash2 className="size-4 text-destructive" />
                <span>{t("common.delete")}</span>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onToggleViewMode}>
                {viewMode === "edit"
                  ? (
                      <>
                        <Eye className="size-4" />
                        {t("viewMode.preview", { defaultValue: "Preview" })}
                      </>
                    )
                  : (
                      <>
                        <Pencil className="size-4" />
                        {t("viewMode.edit", { defaultValue: "Edit" })}
                      </>
                    )}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </div>
  );
}

function SaveStatusBadge({
  status,
  lastSavedAt,
}: {
  readonly status: SaveStatus;
  readonly lastSavedAt: number | null;
}) {
  const { t } = useTranslation("documents");
  if (status === "idle")
    return <span aria-hidden="true" className="hidden sm:inline w-32" />;
  let label: string;
  let tone = "text-muted-foreground";
  if (status === "saving") {
    label = t("save.saving", { defaultValue: "Saving…" });
  }
  else if (status === "saved") {
    label = lastSavedAt
      ? t("save.savedJustNow", { defaultValue: "Saved just now" })
      : t("save.saved", { defaultValue: "Saved" });
  }
  else {
    label = t("save.failed", { defaultValue: "Failed to save" });
    tone = "text-destructive";
  }
  return (
    <span className={cn("hidden sm:inline text-xs transition-opacity", tone)} role="status">
      {label}
    </span>
  );
}

// ── Title (oversized inline-editable h1) ──

function TitleEditor({
  value,
  placeholder,
  onChange,
  readOnly,
}: {
  readonly value: string;
  readonly placeholder: string;
  readonly onChange: (next: string) => void;
  readonly readOnly: boolean;
}) {
  if (readOnly) {
    return (
      <h1 className={cn("text-3xl font-bold leading-tight", !value && "text-muted-foreground/40")}>
        {value || placeholder}
      </h1>
    );
  }
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
      className="w-full bg-transparent text-3xl font-bold leading-tight border-0 outline-none placeholder:text-muted-foreground/40 px-0"
      aria-label="Document title"
    />
  );
}

// ── Metadata row (creator · updated · tags) ──

function Metadata({
  creatorName,
  updatedAt,
  tags,
  onRemoveTag,
  tagInput,
  setTagInput,
  onAddTag,
  showTagInput,
}: {
  readonly creatorName: string;
  readonly updatedAt: string;
  readonly tags: readonly string[];
  readonly onRemoveTag: ((tag: string) => void) | undefined;
  readonly tagInput: string;
  readonly setTagInput: (next: string) => void;
  readonly onAddTag: () => void;
  readonly showTagInput: boolean;
}) {
  const { t } = useTranslation("documents");
  const displayDate = useMemo(
    () => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(updatedAt)),
    [updatedAt],
  );
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>{creatorName}</span>
      <span>·</span>
      <span>{displayDate}</span>
      {tags.length > 0 && <span>·</span>}
      {tags.map(tag => (
        <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
          {tag}
          {onRemoveTag && (
            <button
              type="button"
              onClick={() => onRemoveTag(tag)}
              className="ml-0.5 hover:text-destructive"
              aria-label={t("common.delete")}
            >
              <X className="size-3" />
            </button>
          )}
        </Badge>
      ))}
      {showTagInput && (
        <Input
          value={tagInput}
          onChange={e => setTagInput(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
              e.preventDefault();
              onAddTag();
            }
          }}
          placeholder={t("tagsPlaceholder")}
          className="h-6 w-28 min-w-0 border-0 shadow-none text-xs focus-visible:ring-0 px-1"
        />
      )}
    </div>
  );
}

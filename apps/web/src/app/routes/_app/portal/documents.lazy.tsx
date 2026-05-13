// Documents page — folder-style tree sidebar (parent-id backed) + a
// detail/edit/create pane.
//
// Layout: a secondary tree sidebar on the left (folder-like icons for
// top-level nodes with children, hover-add to create sub-docs, search
// dialog opened from a header icon) + a right pane that renders one of
// three modes — empty placeholder, create form, or detail view (which
// internally toggles between read-only render and an explicit
// edit-with-save). Selection is local state, not URL — there are no
// child routes under this path.

/* eslint-disable react-refresh/only-export-components */
import type { DocumentTreeNode } from "@/shared/lib/api/documents";

import { createLazyFileRoute } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  FolderClosed,
  FolderOpen,
  Lock,
  Menu,
  Paperclip,
  Pencil,
  Plus,
  Search,
  Share2,
  Trash2,
  Unlock,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { MarkdownEditor } from "@/shared/components/editor";
import {
  ancestorIds,
  buildTreeIndex,
  toggleId,
} from "@/shared/components/portal/document-tree.utils";
import {
  partitionBySize,
  ResourceFooterSections,
  useResourceAttachmentUpload,
} from "@/shared/components/resource";
import { Button } from "@/shared/components/ui/button";
import { CenteredHint } from "@/shared/components/ui/centered-hint";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/shared/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/shared/components/ui/tooltip";
import {
  parseTags,
  useCreateDocument,
  useDeleteDocument,
  useDocument,
  useDocumentTree,
  useDocumentUsers,
  useUpdateDocument,
} from "@/shared/lib/api/documents";
import { errorMessage } from "@/shared/lib/errors";
import { displayName } from "@/shared/lib/users";
import { cn } from "@/shared/lib/utils";

import { useAuthStore } from "@/shared/stores/auth";

export const Route = createLazyFileRoute("/_app/portal/documents")({
  component: DocumentsPage,
});

type Mode = { type: "empty" } | { type: "new" } | { type: "detail"; docId: string };

interface DraftState {
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
}

const EMPTY_DRAFT: DraftState = { title: "", content: "", tags: [] };

// Sidebar resize — width persists across reloads via localStorage. Bounds
// keep the column usable: too narrow and titles vanish, too wide and the
// main column collapses.
const SIDEBAR_WIDTH_MIN = 200;
const SIDEBAR_WIDTH_MAX = 480;
const SIDEBAR_WIDTH_DEFAULT = 288;
const SIDEBAR_WIDTH_KEY = "documents.sidebarWidth";

function clampWidth(n: number) {
  if (!Number.isFinite(n))
    return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, n));
}

function useSidebarWidth() {
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined")
      return SIDEBAR_WIDTH_DEFAULT;
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return clampWidth(raw ? Number.parseInt(raw, 10) : SIDEBAR_WIDTH_DEFAULT);
  });
  const setAndPersist = useCallback((next: number) => {
    const v = clampWidth(next);
    setWidth(v);
    if (typeof window !== "undefined")
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(v));
  }, []);
  return [width, setAndPersist] as const;
}

function DocumentsPage() {
  const { t } = useTranslation("documents");
  const treeQuery = useDocumentTree();
  const tree = useMemo(() => treeQuery.data ?? [], [treeQuery.data]);
  const [mode, setMode] = useState<Mode>({ type: "empty" });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useSidebarWidth();

  // Drag handle attached to the right edge of the desktop sidebar. Tracks
  // the starting pointer x + initial width so the new width follows the
  // delta exactly. document-level listeners pick up drags that wander
  // outside the 4px handle strip.
  const startSidebarResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (mv: MouseEvent) => setSidebarWidth(startWidth + (mv.clientX - startX));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [sidebarWidth, setSidebarWidth]);

  // When a doc gets deleted (or selection becomes invalid for any other
  // reason), drop the mode back to empty so the right pane doesn't render
  // against a stale id.
  useEffect(() => {
    if (mode.type !== "detail")
      return;
    if (treeQuery.isLoading)
      return;
    if (!tree.some(n => n.id === mode.docId))
      // eslint-disable-next-line react/set-state-in-effect -- recover from external deletion.
      setMode({ type: "empty" });
  }, [mode, tree, treeQuery.isLoading]);

  // Selecting a doc / starting a new one on mobile also collapses the
  // sidebar sheet so the main pane becomes visible.
  const selectDoc = (id: string) => {
    setMode({ type: "detail", docId: id });
    setSidebarOpen(false);
  };
  const startCreate = () => {
    setMode({ type: "new" });
    setSidebarOpen(false);
  };

  const sidebarProps = {
    tree,
    loading: treeQuery.isLoading,
    error: treeQuery.error,
    selectedId: mode.type === "detail" ? mode.docId : null,
    onSelect: selectDoc,
    onCreate: startCreate,
  } as const;

  return (
    // delay=50ms keeps icon-action tooltips snappy compared to native
    // `title` (which has a ~700ms+ browser delay). Scoped to this page
    // so other routes are unaffected.
    <TooltipProvider delay={50}>
      {/* `overflow-hidden` here is the final clip — without it, a long
          word / inline-code / pre that escapes its column would bubble
          horizontal scroll up to the route-level `<main>` which has
          `overflow-auto`. `min-w-0` lets this container shrink inside
          the route flex column for the same reason. */}
      <div className="-mx-4 -my-3 flex h-[calc(100svh-3rem-1px)] min-w-0 flex-col overflow-hidden md:-mx-6 md:-my-4 md:h-svh md:flex-row">
        {/* Desktop sidebar — inline column at md+. `overflow-hidden`
          guarantees the (resizable-width) sidebar never lets its content
          visually escape into the main column or past the viewport, no
          matter how deep the tree nests or how long a title is.
          Width is inline-styled from localStorage-backed state so the
          drag handle below can update it live. */}
        <aside
          style={{ width: sidebarWidth }}
          className="hidden md:flex md:shrink-0 md:flex-col md:overflow-hidden md:border-r md:border-border md:bg-muted/30"
        >
          <DocumentsSidebar {...sidebarProps} />
        </aside>
        {/* Drag handle — a hair-thin invisible strip on the sidebar's
          right edge. Highlights on hover / active drag so it stays
          discoverable without taking visual weight when idle. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t("page.myDocuments.title")}
          onMouseDown={startSidebarResize}
          className="hidden cursor-col-resize bg-transparent transition-colors hover:bg-border md:block md:w-1 md:shrink-0 md:active:bg-border"
        />

        {/* Mobile sidebar — slide-in Sheet from the left, triggered by
          the menu button in the main sub-header below. */}
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" showCloseButton={false} className="flex w-[85vw] max-w-sm flex-col gap-0 bg-background p-0">
            <SheetTitle className="sr-only">{t("page.myDocuments.title")}</SheetTitle>
            <SheetDescription className="sr-only">{t("page.myDocuments.description")}</SheetDescription>
            <DocumentsSidebar {...sidebarProps} />
          </SheetContent>
        </Sheet>

        <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Mobile-only sub-header with sidebar toggle — md+ has the
            sidebar always visible so no toggle needed. */}
          <div className="flex h-[45px] shrink-0 items-center gap-2 border-b border-border px-3 md:hidden">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setSidebarOpen(true)}
              title={t("page.myDocuments.title")}
            >
              <Menu className="size-4" />
            </Button>
            <span className="truncate text-sm font-semibold tracking-tight">
              {t("page.myDocuments.title")}
            </span>
          </div>

          {/* `overflow-hidden` (instead of `md:overflow-visible`)
              closes the final crack — without it, a child whose own
              `overflow` lets content spill (a long inline `<code>` in a
              `<p>` for example) can extend the column visually past the
              sidebar's right edge. Each child here already manages its
              own scroll: view-mode body has `overflow-y-auto`, the
              editor's `.md-editor-shell` scrolls internally. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {mode.type === "empty" && <EmptyState onCreate={startCreate} />}
            {mode.type === "new" && (
              <CreateForm
                onCancel={() => setMode({ type: "empty" })}
                onCreated={id => setMode({ type: "detail", docId: id })}
              />
            )}
            {mode.type === "detail" && (
              <DocumentDetail
                key={mode.docId}
                docId={mode.docId}
                onDeleted={() => setMode({ type: "empty" })}
              />
            )}
          </div>
        </main>
      </div>
    </TooltipProvider>
  );
}

// ── Sidebar ──

function DocumentsSidebar({
  tree,
  loading,
  error,
  selectedId,
  onSelect,
  onCreate,
}: {
  readonly tree: readonly DocumentTreeNode[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreate: () => void;
}) {
  const { t } = useTranslation("documents");
  const createMutation = useCreateDocument();

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [searchOpen, setSearchOpen] = useState(false);

  const index = useMemo(() => buildTreeIndex(tree), [tree]);
  const roots = index.childrenOf.get("") ?? [];

  // Create a sub-document directly under the hovered row. Auto-expand
  // the parent and jump selection to the new doc so the user lands in
  // the edit form.
  const handleCreateChild = (parentId: string) => {
    createMutation.mutate(
      { title: t("untitledPlaceholder", { defaultValue: "Untitled" }), content: "", parentId },
      {
        onSuccess: (doc) => {
          setExpanded((prev) => {
            if (prev.has(parentId))
              return prev;
            const next = new Set(prev);
            next.add(parentId);
            return next;
          });
          onSelect(doc.id);
        },
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  const toggle = useCallback((id: string) => {
    setExpanded(prev => toggleId(prev, id));
  }, []);

  // Picking a result in the search dialog auto-expands the chosen doc's
  // ancestor chain so the row stays visible inside the tree.
  const handleSearchSelect = (id: string) => {
    const ancestors = ancestorIds(index, id);
    if (ancestors.length > 0) {
      setExpanded((prev) => {
        const next = new Set(prev);
        let changed = false;
        for (const a of ancestors) {
          if (!next.has(a)) {
            next.add(a);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }
    onSelect(id);
    setSearchOpen(false);
  };

  // Outer chrome (width / bg-muted / border-r) is owned by the wrapper
  // in DocumentsPage so the same content works inside both the inline
  // desktop column and the mobile slide-in Sheet. `min-w-0` +
  // `overflow-hidden` keep the sidebar's content (deep tree rows, long
  // titles) from spilling out horizontally into the main column.
  return (
    <div className="flex h-full w-full min-w-0 flex-col overflow-hidden">
      {/* Header — height matched to the app sidebar's logo block on the
          left: `collapsible="icon"` mode renders SidebarHeader with `p-1`
          (4px) around a `size-9` (36px) link plus a 1px separator —
          44 + 1 = 45 — so my border-b lands on the same Y as the
          separator under the shield. No `pt-*`; the title centers
          inside the fixed-height row. */}
      <div className="flex h-[45px] shrink-0 items-center gap-1 border-b border-border px-4">
        <h2 className="flex-1 truncate text-base font-semibold tracking-tight">{t("page.myDocuments.title")}</h2>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={() => setSearchOpen(true)}
          title={t("searchPlaceholder")}
        >
          <Search className="size-4" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onCreate}
          title={t("create")}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <SearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        tree={tree}
        onSelect={handleSearchSelect}
      />

      {/* Tree */}
      {/* `overflow-x-hidden` clips deep-indented or super-long tree rows
          at the sidebar's right edge instead of letting them visually
          extend into the main column / past the viewport. The button
          truncate handles short titles; this is the safety net for
          extreme cases. */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden py-2">
        {loading
          ? <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t("common.loading")}</div>
          : error
            ? <div className="px-4 py-4 text-xs text-destructive">{error instanceof Error ? error.message : t("common.error.loadFailed")}</div>
            : roots.length === 0
              ? <div className="px-4 py-6 text-center text-xs text-muted-foreground">{t("noResults")}</div>
              : (
                  <ul role="tree" aria-label={t("page.myDocuments.title")}>
                    {roots.map(node => (
                      <TreeRow
                        key={node.id}
                        node={node}
                        depth={0}
                        index={index}
                        expanded={expanded}
                        onToggle={toggle}
                        selectedId={selectedId}
                        onSelect={onSelect}
                        onCreateChild={handleCreateChild}
                        createPending={createMutation.isPending}
                      />
                    ))}
                  </ul>
                )}
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  index,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  onCreateChild,
  createPending,
}: {
  readonly node: DocumentTreeNode;
  readonly depth: number;
  readonly index: ReturnType<typeof buildTreeIndex>;
  readonly expanded: ReadonlySet<string>;
  readonly onToggle: (id: string) => void;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onCreateChild: (parentId: string) => void;
  readonly createPending: boolean;
}) {
  const { t } = useTranslation("documents");
  const children = index.childrenOf.get(node.id) ?? [];
  const hasChildren = children.length > 0;
  const isExpanded = expanded.has(node.id);
  const isSelected = selectedId === node.id;
  // Top-level nodes that *have* children render with a folder icon — they
  // act as folders since the backend dropped the dedicated folder concept.
  // Everything else is a file.
  const isFolder = depth === 0 && hasChildren;
  const indent = 8 + depth * 14;

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined} aria-selected={isSelected} aria-level={depth + 1}>
      <div
        className={cn(
          "group mx-1 flex items-center gap-1 rounded-md pr-1 text-xs transition-colors",
          isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/40",
        )}
        style={{ paddingLeft: `${indent}px` }}
      >
        {hasChildren
          ? (
              <button
                type="button"
                onClick={() => onToggle(node.id)}
                className="inline-flex size-4 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={isExpanded ? "Collapse" : "Expand"}
                tabIndex={-1}
              >
                {isExpanded
                  ? <ChevronDown className="size-3.5" />
                  : <ChevronRight className="size-3.5" />}
              </button>
            )
          : <span className="size-4 shrink-0" />}
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          className="flex min-w-0 flex-1 items-center gap-1.5 truncate py-1.5 text-left"
        >
          {isFolder
            ? (isExpanded
                ? <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                : <FolderClosed className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />)
            : <FileText className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />}
          <span className="flex-1 truncate">{node.title}</span>
        </button>
        {/* Hover-revealed "new child" affordance. No date / meta — the
            row stays minimal so the tree itself does the talking. */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onCreateChild(node.id);
          }}
          disabled={createPending}
          title={t("tree.newChild", { defaultValue: "新建子文档" })}
          className="hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground group-hover:inline-flex disabled:opacity-60"
        >
          <Plus className="size-3" strokeWidth={2.25} />
        </button>
      </div>

      {hasChildren && isExpanded && (
        <ul role="group">
          {children.map(child => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              index={index}
              expanded={expanded}
              onToggle={onToggle}
              selectedId={selectedId}
              onSelect={onSelect}
              onCreateChild={onCreateChild}
              createPending={createPending}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  // Compact "M月D日" form to fit the narrow sidebar column.
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ── Empty state ──

function EmptyState({ onCreate }: { readonly onCreate: () => void }) {
  const { t } = useTranslation("documents");
  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <FileText className="mb-3 size-10 text-muted-foreground/40" />
      <p className="text-sm text-muted-foreground">{t("selectToView")}</p>
      <Button size="sm" variant="ghost" className="mt-3 text-xs" onClick={onCreate}>
        <Plus className="size-3.5" />
        {t("create")}
      </Button>
    </div>
  );
}

// ── Create form ──

function CreateForm({
  onCancel,
  onCreated,
}: {
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const { t } = useTranslation("documents");
  const createMutation = useCreateDocument();
  const [draft, setDraft] = useState<DraftState>(EMPTY_DRAFT);

  const handleSave = () => {
    if (!draft.title.trim()) {
      toast.error(t("field.titleRequired", { defaultValue: "标题不能为空" }));
      return;
    }
    createMutation.mutate(
      { title: draft.title.trim(), content: draft.content, tags: draft.tags, parentId: null },
      {
        onSuccess: (doc) => { onCreated(doc.id); },
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  // Mirror the edit-mode layout in DocumentDetail: a 45px header bar
  // with the title input + Cancel / Create actions, and a full-height
  // immersive Markdown editor below. Tags / attachments / comments
  // become available after the doc is created (they need a docId).
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[45px] shrink-0 items-center gap-3 border-b border-border px-6">
        <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={draft.title}
          onChange={e => setDraft(prev => ({ ...prev, title: e.target.value }))}
          placeholder={t("untitledPlaceholder", { defaultValue: "Untitled" })}
          className="min-w-0 flex-1 truncate border-0 bg-transparent px-0 text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
          aria-label="Document title"
          autoFocus
        />
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={createMutation.isPending}
          >
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={handleSave}
            disabled={createMutation.isPending || !draft.title.trim()}
          >
            {t("createTitle")}
          </Button>
        </div>
      </div>

      <MarkdownEditor
        value={draft.content}
        onChange={next => setDraft(prev => ({ ...prev, content: next }))}
        placeholder={t("field.contentPlaceholder")}
        floatingToolbar
        className="mx-auto min-h-0 w-full max-w-[1100px] flex-1 rounded-none border-0 px-6 pt-2 pb-5"
      />
    </div>
  );
}

// ── Document detail (view ↔ edit) ──
//
// Defaults to read-only "view" mode (rendered Markdown). The pencil icon
// in the top-right toggles to edit mode (form-style title/content inputs
// with Cancel/Save). Tags live in a row below the title and are
// inline-editable in both view and edit modes — last slot is always the
// add affordance.

function DocumentDetail({
  docId,
  onDeleted,
}: {
  readonly docId: string;
  readonly onDeleted: () => void;
}) {
  const { t } = useTranslation("documents");
  const docQuery = useDocument(docId);
  const usersQuery = useDocumentUsers();
  const updateMutation = useUpdateDocument();
  const deleteMutation = useDeleteDocument();
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === "admin";

  // Upload flow lives in the page header so the entry stays accessible
  // even when there are no attachments yet (the section below hides
  // until the first upload lands).
  const { upload: uploadMutation, fileInputRef, limits, attachmentCount } = useResourceAttachmentUpload({
    resource: "documents",
    resourceId: docId,
    onError: err => toast.error(errorMessage(err, t("common.error.operationFailed"))),
  });
  const handleUploadFiles = useCallback((files: FileList | null) => {
    if (!files || files.length === 0)
      return;
    const selected = Array.from(files);
    const remainingSlots = limits.maxAttachmentsPerResource - attachmentCount;
    if (remainingSlots <= 0 || selected.length > remainingSlots) {
      toast.error(t("attachments.limitReached"));
      return;
    }
    const { accepted, rejected } = partitionBySize(selected, limits.maxFileSize);
    if (rejected.length > 0) {
      toast.error(t("attachments.fileTooLargeNamed", { names: rejected.map(f => f.name).join(", ") }));
      if (accepted.length === 0)
        return;
    }
    uploadMutation.mutate(accepted);
  }, [attachmentCount, limits, t, uploadMutation]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // When the in-body H1 scrolls out of view, surface a shrunken copy
  // in the header's left slot. The body div is the scroll root, so the
  // observer needs `root` set to it (not the viewport).
  const [titleInView, setTitleInView] = useState(true);
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const bodyTitleRef = useRef<HTMLHeadingElement>(null);
  // `draft` flips from null → set when the doc finishes loading; the
  // body H1 only mounts after that, so re-run this effect when the
  // draft becomes available to make sure both refs are populated.
  const hasDraft = draft != null;
  useEffect(() => {
    if (editing || !hasDraft)
      return undefined;
    const root = bodyScrollRef.current;
    const target = bodyTitleRef.current;
    if (!root || !target)
      return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setTitleInView(entry?.isIntersecting ?? true),
      { root, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [editing, hasDraft]);

  // Seed the draft once per fetched version so a remote update reseeds,
  // but only when the user has no in-flight edits.
  const seededVersionRef = useRef<number | null>(null);
  useEffect(() => {
    const data = docQuery.data;
    if (!data)
      return;
    if (seededVersionRef.current === data.version)
      return;
    seededVersionRef.current = data.version;
    // eslint-disable-next-line react/set-state-in-effect -- seed local draft from fetched server state.
    setDraft({
      title: data.title,
      content: data.content ?? "",
      tags: parseTags(data.tags),
    });
  }, [docQuery.data]);

  if (docQuery.isLoading || !draft)
    return <CenteredHint>{t("common.loading")}</CenteredHint>;
  if (docQuery.error || !docQuery.data)
    return <CenteredHint>{errorMessage(docQuery.error, t("common.error.loadFailed"))}</CenteredHint>;

  const doc = docQuery.data;
  const userMap = new Map((usersQuery.data ?? []).map(u => [u.id, u]));
  const creatorName = displayName(userMap, doc.creatorId);
  const isCreator = doc.creatorId === user?.id;

  const handleSaveTags = (next: readonly string[]) => {
    setDraft(prev => prev ? { ...prev, tags: next } : prev);
    // In view mode, persist immediately. In edit mode, defer to the
    // explicit Save button (handled in handleSave below).
    if (!editing) {
      updateMutation.mutate({ id: doc.id, version: doc.version, tags: next }, {
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      });
    }
  };

  const handleCancel = () => {
    setDraft({
      title: doc.title,
      content: doc.content ?? "",
      tags: parseTags(doc.tags),
    });
    setEditing(false);
  };

  const handleSave = () => {
    if (!draft.title.trim()) {
      toast.error(t("field.titleRequired", { defaultValue: "标题不能为空" }));
      return;
    }
    updateMutation.mutate(
      {
        id: doc.id,
        version: doc.version,
        title: draft.title.trim(),
        content: draft.content,
        tags: draft.tags,
      },
      {
        onSuccess: () => setEditing(false),
        onError: (err) => {
          toast.error(errorMessage(err, t("common.error.operationFailed")));
        },
      },
    );
  };

  const handleShare = () => {
    toast(`${t("share", { defaultValue: "分享" })} — placeholder`);
  };

  const handleDelete = () => {
    deleteMutation.mutate(doc.id, {
      onSuccess: () => {
        setDeleteOpen(false);
        onDeleted();
      },
      onError: (err) => {
        toast.error(errorMessage(err, t("common.error.deleteFailed")));
      },
    });
  };

  return (
    <div className="flex h-full min-w-0 flex-col">
      {/* Header zone — fixed 45px to align its bottom border with the
          sidebar header on the left. Holds only the title and the
          variant-specific action cluster; meta + tags moved to the
          content footer at the bottom of the body. */}
      <div
        className={cn(
          "flex h-[45px] shrink-0 items-center gap-3 px-6 transition-shadow duration-200",
          editing && "border-b border-border",
          // Drop shadow only when the body H1 has scrolled out of view —
          // gives the sticky h2 a clear separation from the scrolled
          // content underneath. Custom (instead of `shadow-md`) so the
          // gradient sits squarely below the header rather than fading
          // toward the sides, which kept it reading as a flat line.
          !editing && !titleInView && "shadow-[0_6px_12px_-4px_rgba(0,0,0,0.12)]",
        )}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {editing
            ? (
                <>
                  <FileText className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <input
                    value={draft.title}
                    onChange={e => setDraft(prev => prev ? { ...prev, title: e.target.value } : prev)}
                    placeholder={t("untitledPlaceholder", { defaultValue: "Untitled" })}
                    className="min-w-0 flex-1 border-0 bg-transparent px-0 text-lg font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40"
                    aria-label="Document title"
                  />
                </>
              )
            : (
                <h2
                  aria-hidden={titleInView}
                  className={cn(
                    "flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-foreground/70 transition-opacity duration-200",
                    titleInView ? "opacity-0" : "opacity-100",
                  )}
                >
                  <FileText className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {doc.title || t("untitledPlaceholder", { defaultValue: "Untitled" })}
                  </span>
                </h2>
              )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {editing
            ? (
                <>
                  <Button variant="outline" size="sm" onClick={handleCancel} disabled={updateMutation.isPending}>
                    {t("common.cancel")}
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={updateMutation.isPending}>
                    {t("common.save", { defaultValue: "保存" })}
                  </Button>
                </>
              )
            : (
                <>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => handleUploadFiles(e.target.files)}
                  />
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => fileInputRef.current?.click()}
                          disabled={uploadMutation.isPending}
                        />
                      )}
                    >
                      <Paperclip className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("attachments.upload", { defaultValue: "添加附件" })}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button variant="ghost" size="icon-sm" onClick={handleShare} />
                      )}
                    >
                      <Share2 className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("share")}</TooltipContent>
                  </Tooltip>
                  {(isAdmin || isCreator) && (
                    <Tooltip>
                      <TooltipTrigger
                        render={(
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              updateMutation.mutate(
                                { id: doc.id, version: doc.version, commentsLocked: !doc.commentsLocked },
                                {
                                  onError: (err) => {
                                    toast.error(errorMessage(err, t("common.error.operationFailed")));
                                  },
                                },
                              );
                            }}
                          />
                        )}
                      >
                        {doc.commentsLocked ? <Unlock className="size-4" /> : <Lock className="size-4" />}
                      </TooltipTrigger>
                      <TooltipContent>
                        {doc.commentsLocked
                          ? t("comments.unlock", { defaultValue: "解锁评论" })
                          : t("comments.lock", { defaultValue: "锁定评论" })}
                      </TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button variant="ghost" size="icon-sm" onClick={() => setEditing(true)} />
                      )}
                    >
                      <Pencil className="size-4" />
                    </TooltipTrigger>
                    <TooltipContent>{t("common.edit", { defaultValue: "编辑" })}</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger
                      render={(
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          onClick={() => setDeleteOpen(true)}
                        />
                      )}
                    >
                      <Trash2 className="size-4 text-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>{t("common.delete")}</TooltipContent>
                  </Tooltip>
                </>
              )}
        </div>
      </div>

      {/* Body — diverges by mode. Edit mode is an immersive writing
          surface (floating toolbar above the editor shell); view mode
          keeps the scrollable layout that contains H1 + byline +
          content + tags + attachments + comments. */}
      {editing
        ? (
            <MarkdownEditor
              value={draft.content}
              onChange={next => setDraft(prev => prev ? { ...prev, content: next } : prev)}
              placeholder={t("field.contentPlaceholder")}
              floatingToolbar
              className="mx-auto min-h-0 w-full max-w-[1100px] flex-1 rounded-none border-0 px-6 pt-2 pb-5"
            />
          )
        : (
            <div ref={bodyScrollRef} className="md-scroll-fade min-w-0 flex-1 overflow-x-hidden overflow-y-auto">
              <div className="mx-auto w-full max-w-[1100px] px-6 py-5">
                {/* Document-level title — distinct from prose H1s by the
                  leading icon affordance that the in-content H1s never
                  carry. */}
                <h1
                  ref={bodyTitleRef}
                  className="mb-2 flex items-center justify-center gap-2 text-xl font-semibold tracking-tight text-foreground/70"
                >
                  <FileText className="size-5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">
                    {doc.title || t("untitledPlaceholder", { defaultValue: "Untitled" })}
                  </span>
                </h1>
                {/* Byline — centered under the title, answers "who & when"
                  before the body. Tags live after the body (below). */}
                <p className="mb-6 text-center text-[11px] text-muted-foreground">
                  {creatorName}
                  <span className="mx-1 text-muted-foreground/50">·</span>
                  {formatLongDate(doc.updatedAt)}
                </p>
                {doc.content
                  ? <MarkdownEditor value={doc.content} readOnly />
                  : <p className="text-sm italic text-muted-foreground/70">{t("field.noContent", { defaultValue: "暂无内容。" })}</p>}

                {/* Tags — sits after the body, before attachments. */}
                <div className="mt-4">
                  <TagsRow tags={draft.tags} onChange={handleSaveTags} />
                </div>

                {/* Attachment upload entry lives in the page header
                  (Paperclip icon) so it stays reachable before the first
                  upload — the attachments section below hides until then. */}
                <ResourceFooterSections
                  resource="documents"
                  resourceId={doc.id}
                  i18nNs="documents"
                  userMap={userMap}
                  commentsLocked={doc.commentsLocked}
                  commentsEnableReply
                  canDeleteAttachment={att => isAdmin || isCreator || att.uploadedBy === user?.id}
                  canDeleteComment={c => isAdmin || c.authorId === user?.id}
                />
              </div>
            </div>
          )}

      <ConfirmDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("deleteTitle")}
        description={t("deleteConfirm", { title: doc.title })}
        pending={deleteMutation.isPending}
        onConfirm={handleDelete}
      />
    </div>
  );
}

function formatLongDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()))
    return "";
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

// ── Tags row ──
//
// Tags live as a single row below the title. With no tags, renders a
// solo "+ 添加标签" trigger; with one or more, renders chips and a
// trailing "+" chip as the add affordance. Add is always a chip-shaped
// inline input — committing on Enter / comma, cancelling on Esc / blur.

function TagsRow({
  tags,
  onChange,
}: {
  readonly tags: readonly string[];
  readonly onChange: (tags: readonly string[]) => void;
}) {
  const { t } = useTranslation("documents");
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing)
      inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    const raw = value.trim().toLowerCase().replace(/[^\w-]/g, "");
    setValue("");
    if (!raw) {
      setEditing(false);
      return;
    }
    if (!tags.includes(raw))
      onChange([...tags, raw]);
    setEditing(false);
  };

  const inlineInput = (
    <Input
      ref={inputRef}
      value={value}
      onChange={e => setValue(e.target.value)}
      onBlur={() => {
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === ",") {
          e.preventDefault();
          commit();
        }
        else if (e.key === "Escape") {
          e.preventDefault();
          setValue("");
          setEditing(false);
        }
      }}
      placeholder={t("tagsPlaceholder", { defaultValue: "添加标签..." })}
      className="h-6 w-28 rounded-full border-dashed bg-transparent px-2.5 text-[11px] font-medium placeholder:text-muted-foreground/60 focus-visible:bg-accent/40 focus-visible:ring-0"
    />
  );

  if (tags.length === 0) {
    if (editing)
      return <ul className="flex flex-wrap items-center gap-1.5"><li>{inlineInput}</li></ul>;
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
      >
        <Plus className="size-3" strokeWidth={2.25} />
        {t("tagsPlaceholder", { defaultValue: "添加标签..." })}
      </button>
    );
  }

  return (
    <ul className="flex flex-wrap items-center gap-1.5">
      {tags.map(tag => (
        <li key={tag}>
          <span className="inline-flex h-6 items-center gap-0.5 rounded-full border border-border bg-muted/40 px-2.5 text-[11px] font-medium text-muted-foreground">
            <span className="text-foreground/35">#</span>
            <span>{tag}</span>
            <button
              type="button"
              onClick={() => onChange(tags.filter(t2 => t2 !== tag))}
              className="ml-0.5 inline-flex size-3 items-center justify-center rounded-full text-muted-foreground/70 hover:bg-foreground/10 hover:text-foreground"
              aria-label="Remove tag"
            >
              <X className="size-2" />
            </button>
          </span>
        </li>
      ))}
      <li>
        {editing
          ? inlineInput
          : (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="inline-flex size-6 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground"
                aria-label={t("tagsPlaceholder", { defaultValue: "添加标签..." })}
              >
                <Plus className="size-3" strokeWidth={2.25} />
              </button>
            )}
      </li>
    </ul>
  );
}

// ── Search dialog ──
//
// Opened from the sidebar's search icon. A modal with an input and a
// scrollable list of title matches; picking a result selects the doc
// (which auto-expands its ancestors in the sidebar tree) and closes
// the dialog.

function SearchDialog({
  open,
  onOpenChange,
  tree,
  onSelect,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly tree: readonly DocumentTreeNode[];
  readonly onSelect: (id: string) => void;
}) {
  const { t } = useTranslation("documents");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query whenever the dialog reopens so the user starts fresh.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react/set-state-in-effect -- reset transient dialog state on open.
      setQuery("");
      // Defer focus until after the dialog mounts.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q)
      return [];
    return tree
      .filter(n => n.title.toLowerCase().includes(q))
      .slice(0, 50);
  }, [query, tree]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg gap-0 p-0">
        <DialogHeader className="sr-only">
          <DialogTitle>{t("searchPlaceholder")}</DialogTitle>
          <DialogDescription>{t("searchPlaceholder")}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-9 border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div className="max-h-[60vh] overflow-y-auto py-1">
          {query.trim().length === 0
            ? (
                <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                  {t("searchPlaceholder")}
                </div>
              )
            : results.length === 0
              ? <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("noResults")}</div>
              : (
                  <ul>
                    {results.map(node => (
                      <li key={node.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(node.id)}
                          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
                        >
                          <FileText className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                          <span className="flex-1 truncate">{node.title || t("untitledPlaceholder", { defaultValue: "Untitled" })}</span>
                          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
                            {formatShortDate(node.updatedAt)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

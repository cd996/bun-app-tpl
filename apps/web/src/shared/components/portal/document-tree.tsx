// Nested document tree sidebar.
//
// The tree is rendered recursively but each node only mounts its children
// while expanded — collapsed subtrees never enter the DOM, so a 10k-node
// hierarchy with most folders closed costs roughly the depth of the
// open path. Keyboard navigation walks the visible-flatten produced by
// {@link flattenVisible} so up/down behaves the same as visual order.
//
// Selection lives in the URL (`/portal/documents/$docId`); focus is local.
// Auto-expansion of the active document's ancestors keeps the highlight in
// view after deep-linking or refresh.

import type { KeyboardEvent } from "react";
import type { TreeIndex } from "./document-tree.utils";
import type { DocumentTreeNode } from "@/shared/lib/api/documents";

import { useNavigate } from "@tanstack/react-router";
import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FileText,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/shared/components/ui/dropdown-menu";
import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/lib/utils";

import {
  ancestorIds,
  buildTreeIndex,
  flattenVisible,
  readPersistedExpansion,
  stepFocus,
  toggleId,
  writePersistedExpansion,
} from "./document-tree.utils";

interface DocumentTreeProps {
  readonly nodes: readonly DocumentTreeNode[];
  readonly activeId: string | null | undefined;
  readonly onRename: (node: DocumentTreeNode, nextTitle: string) => void;
  readonly onDelete: (node: DocumentTreeNode) => void;
  readonly onMove: (node: DocumentTreeNode) => void;
  readonly canManage: (node: DocumentTreeNode) => boolean;
}

export function DocumentTree({
  nodes,
  activeId,
  onRename,
  onDelete,
  onMove,
  canManage,
}: DocumentTreeProps) {
  const { t } = useTranslation("documents");
  const navigate = useNavigate();
  const index = useMemo(() => buildTreeIndex(nodes), [nodes]);

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => readPersistedExpansion() ?? new Set<string>(),
  );
  const [focused, setFocused] = useState<string | null>(activeId ?? null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist expanded state across reloads. Spec calls localStorage explicitly,
  // and per-user keying is not needed because the data layer already filters
  // to "what this user can see".
  useEffect(() => {
    writePersistedExpansion(expanded);
  }, [expanded]);

  // After navigation (URL change) make sure the active doc's ancestors are
  // open so the row is on screen — otherwise deep-linking lands on a hidden
  // selection. We need to mirror an external (URL) source of truth into two
  // pieces of local state, so set-state-in-effect is the right tool here.
  useEffect(() => {
    if (!activeId)
      return;
    // eslint-disable-next-line react/set-state-in-effect -- syncing the URL-driven active doc into local focus.
    setFocused(activeId);
    const path = ancestorIds(index, activeId);
    if (path.length === 0)
      return;
    // eslint-disable-next-line react/set-state-in-effect -- expanding the active doc's ancestor chain so the highlighted row is on screen.
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const p of path) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeId, index]);

  const visible = useMemo(() => flattenVisible(index, expanded), [index, expanded]);

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editingId)
      return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused(stepFocus(visible, focused, 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused(stepFocus(visible, focused, -1));
      return;
    }
    if (!focused)
      return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      const node = index.byId.get(focused);
      const hasKids = (index.childrenOf.get(focused)?.length ?? 0) > 0;
      if (node && hasKids && !expanded.has(focused)) {
        setExpanded(prev => toggleId(prev, focused));
      }
      else if (hasKids) {
        const firstChild = index.childrenOf.get(focused)?.[0];
        if (firstChild)
          setFocused(firstChild.id);
      }
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      if (expanded.has(focused)) {
        setExpanded(prev => toggleId(prev, focused));
        return;
      }
      const parentId = index.byId.get(focused)?.parentId ?? null;
      if (parentId)
        setFocused(parentId);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void navigate({ to: "/portal/documents/$docId", params: { docId: focused } });
    }
  };

  const roots = index.childrenOf.get("") ?? [];

  const toggleExpand = (id: string) => setExpanded(prev => toggleId(prev, id));
  const focusRow = (id: string) => setFocused(id);

  if (nodes.length === 0) {
    return (
      <div className="px-3 py-4 text-xs text-muted-foreground italic">
        {t("noResults")}
      </div>
    );
  }

  return (
    // The container handles tree-wide arrow-key navigation; individual rows
    // are buttons so they remain focusable for screen readers too.
    <div
      ref={containerRef}
      className="py-1 outline-none"
      role="tree"
      tabIndex={0}
      onKeyDown={handleKey}
      aria-label={t("page.myDocuments.title")}
    >
      {roots.map(node => (
        <TreeRow
          key={node.id}
          node={node}
          depth={0}
          index={index}
          expanded={expanded}
          activeId={activeId ?? null}
          focusedId={focused}
          editingId={editingId}
          onToggle={toggleExpand}
          onFocus={focusRow}
          onStartRename={id => setEditingId(id)}
          onCancelRename={() => setEditingId(null)}
          onRename={(n, name) => {
            setEditingId(null);
            onRename(n, name);
          }}
          onDelete={onDelete}
          onMove={onMove}
          canManage={canManage}
        />
      ))}
    </div>
  );
}

interface TreeRowProps {
  readonly node: DocumentTreeNode;
  readonly depth: number;
  readonly index: TreeIndex;
  readonly expanded: ReadonlySet<string>;
  readonly activeId: string | null;
  readonly focusedId: string | null;
  readonly editingId: string | null;
  readonly onToggle: (id: string) => void;
  readonly onFocus: (id: string) => void;
  readonly onStartRename: (id: string) => void;
  readonly onCancelRename: () => void;
  readonly onRename: (node: DocumentTreeNode, nextTitle: string) => void;
  readonly onDelete: (node: DocumentTreeNode) => void;
  readonly onMove: (node: DocumentTreeNode) => void;
  readonly canManage: (node: DocumentTreeNode) => boolean;
}

function TreeRow(props: TreeRowProps) {
  const {
    node,
    depth,
    index,
    expanded,
    activeId,
    focusedId,
    editingId,
    onToggle,
    onFocus,
    onStartRename,
    onCancelRename,
    onRename,
    onDelete,
    onMove,
    canManage,
  } = props;
  const { t } = useTranslation("documents");
  const navigate = useNavigate();

  const childList = index.childrenOf.get(node.id) ?? [];
  const hasChildren = childList.length > 0;
  const isExpanded = expanded.has(node.id);
  const isActive = activeId === node.id;
  const isFocused = focusedId === node.id;
  const showActions = canManage(node);
  const isEditing = editingId === node.id;
  const descendants = index.descendantCount.get(node.id) ?? 0;

  const handleNavigate = () => {
    onFocus(node.id);
    void navigate({ to: "/portal/documents/$docId", params: { docId: node.id } });
  };

  const handleNewChild = () => {
    void navigate({ to: "/portal/documents/new", search: { parent: node.id } });
  };

  // Indent each level by 14px on top of the chevron's gutter — Outline-style
  // (slightly tighter than VS Code's 16) so deep trees still fit a 320px sidebar.
  const indentStyle = { paddingLeft: `${8 + depth * 14}px` };

  return (
    <>
      <div
        className={cn(
          "group relative flex items-center gap-1 pr-1 text-xs transition-colors",
          isActive && "bg-accent",
          !isActive && isFocused && "bg-accent/40",
          !isActive && !isFocused && "hover:bg-accent/30",
        )}
        style={indentStyle}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isActive}
        aria-level={depth + 1}
      >
        {hasChildren
          ? (
              <button
                type="button"
                onClick={() => onToggle(node.id)}
                className="size-4 shrink-0 flex items-center justify-center text-muted-foreground hover:text-foreground"
                aria-label={isExpanded ? t("tree.collapse") : t("tree.expand")}
                tabIndex={-1}
              >
                {isExpanded
                  ? <ChevronDown className="size-3.5" />
                  : <ChevronRight className="size-3.5" />}
              </button>
            )
          : <span className="size-4 shrink-0" />}

        {isEditing
          ? (
              <RenameInput
                initial={node.title}
                onCancel={onCancelRename}
                onSubmit={next => onRename(node, next)}
              />
            )
          : (
              <button
                type="button"
                onClick={handleNavigate}
                onFocus={() => onFocus(node.id)}
                className="flex-1 min-w-0 flex items-center gap-1.5 py-1.5 text-left truncate"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{node.title}</span>
                {descendants > 0 && (
                  <span className="text-[10px] text-muted-foreground tabular-nums shrink-0">
                    {descendants}
                  </span>
                )}
              </button>
            )}

        {!isEditing && showActions && (
          <RowActions
            onNewChild={handleNewChild}
            onRename={() => onStartRename(node.id)}
            onMove={() => onMove(node)}
            onDelete={() => onDelete(node)}
          />
        )}
      </div>

      {hasChildren && isExpanded && childList.map(child => (
        <TreeRow
          key={child.id}
          node={child}
          depth={depth + 1}
          index={index}
          expanded={expanded}
          activeId={activeId}
          focusedId={focusedId}
          editingId={editingId}
          onToggle={onToggle}
          onFocus={onFocus}
          onStartRename={onStartRename}
          onCancelRename={onCancelRename}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          canManage={canManage}
        />
      ))}
    </>
  );
}

function RenameInput({
  initial,
  onSubmit,
  onCancel,
}: {
  readonly initial: string;
  readonly onSubmit: (next: string) => void;
  readonly onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex-1 py-0.5"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = value.trim();
        if (trimmed && trimmed !== initial)
          onSubmit(trimmed);
        else
          onCancel();
      }}
    >
      <Input
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={() => {
          const trimmed = value.trim();
          if (trimmed && trimmed !== initial)
            onSubmit(trimmed);
          else
            onCancel();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        autoFocus
        className="h-6 text-xs px-1"
      />
    </form>
  );
}

function RowActions({
  onNewChild,
  onRename,
  onMove,
  onDelete,
}: {
  readonly onNewChild: () => void;
  readonly onRename: () => void;
  readonly onMove: () => void;
  readonly onDelete: () => void;
}) {
  const { t } = useTranslation("documents");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={(
          <Button
            size="icon-sm"
            variant="ghost"
            className="size-5 opacity-0 group-hover:opacity-100 data-popup-open:opacity-100 transition-opacity shrink-0"
            title={t("common.more", { defaultValue: "More" })}
            onClick={e => e.stopPropagation()}
          />
        )}
      >
        <MoreHorizontal className="size-3" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={onNewChild}>
          <CornerDownRight className="size-3.5" />
          <span>{t("tree.newChild")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onRename}>
          <Pencil className="size-3.5" />
          <span>{t("tree.rename")}</span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove}>
          <CornerDownRight className="size-3.5" />
          <span>{t("tree.move")}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 className="size-3.5" />
          <span>{t("common.delete")}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Move-target picker. A flat indented list (rather than the recursive tree)
// because the dialog needs every potential target reachable in one click —
// re-using the sidebar's collapse-by-default would force the user to hunt.
//
// Targets that would create a cycle (the moving node itself or any of its
// descendants) are disabled; the API enforces this too, but greying them out
// up front saves a roundtrip and a confusing toast.

import type { DocumentTreeNode } from "@/shared/lib/api/documents";

import { FileText, Home } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { Input } from "@/shared/components/ui/input";
import { cn } from "@/shared/lib/utils";

import { buildTreeIndex, subtreeIds } from "./document-tree.utils";

interface MoveDialogProps {
  readonly node: DocumentTreeNode;
  readonly nodes: readonly DocumentTreeNode[];
  readonly onCancel: () => void;
  readonly onConfirm: (parentId: string | null) => void;
  readonly isPending?: boolean;
}

export function MoveDocumentDialog({ node, nodes, onCancel, onConfirm, isPending }: MoveDialogProps) {
  const { t } = useTranslation("documents");
  const index = useMemo(() => buildTreeIndex(nodes), [nodes]);
  const forbidden = useMemo(() => subtreeIds(index, node.id), [index, node.id]);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string | null>(node.parentId);

  // Render every node DFS so the dialog shows the full hierarchy.
  const flat = useMemo(() => {
    const out: { node: DocumentTreeNode; depth: number }[] = [];
    const walk = (parentId: string, depth: number) => {
      const kids = index.childrenOf.get(parentId) ?? [];
      for (const k of kids) {
        out.push({ node: k, depth });
        walk(k.id, depth + 1);
      }
    };
    walk("", 0);
    return out;
  }, [index]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q)
      return flat;
    return flat.filter(({ node: n }) => n.title.toLowerCase().includes(q));
  }, [flat, search]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open)
          onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("tree.moveTitle", { title: node.title })}</DialogTitle>
          <DialogDescription>{t("tree.moveDescription")}</DialogDescription>
        </DialogHeader>

        <Input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t("tree.movePickPlaceholder")}
          className="h-8 text-sm"
          autoFocus
        />

        <div className="max-h-72 overflow-y-auto rounded-md border bg-muted/30">
          <button
            type="button"
            onClick={() => setSelected(null)}
            disabled={node.parentId === null}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-xs text-left transition-colors",
              selected === null && "bg-accent",
              node.parentId === null && "opacity-40 cursor-not-allowed",
              node.parentId !== null && "hover:bg-accent/50",
            )}
          >
            <Home className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{t("tree.moveRoot")}</span>
          </button>
          {filtered.length === 0 && search.trim().length > 0 && (
            <div className="px-3 py-3 text-xs text-muted-foreground italic">{t("noResults")}</div>
          )}
          {filtered.map(({ node: n, depth }) => {
            const disabled = forbidden.has(n.id);
            const isSelected = selected === n.id;
            return (
              <button
                type="button"
                key={n.id}
                onClick={() => !disabled && setSelected(n.id)}
                disabled={disabled}
                className={cn(
                  "flex w-full items-center gap-1.5 py-1.5 pr-2 text-xs text-left transition-colors",
                  isSelected && "bg-accent",
                  disabled && "opacity-40 cursor-not-allowed",
                  !disabled && !isSelected && "hover:bg-accent/50",
                )}
                style={{ paddingLeft: `${8 + depth * 14}px` }}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{n.title}</span>
              </button>
            );
          })}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            disabled={isPending || selected === node.parentId}
            onClick={() => onConfirm(selected)}
          >
            {t("tree.moveConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Documents sidebar — nested document tree.
//
// Phase 3 swaps the legacy folder-flat layout for a single tree fed by
// `useDocumentTree()`. Folders are still in the database but no longer
// surfaced in the UI; Phase 4 will drop the schema entirely. The visual
// chrome (dense rows, mute palette, header buttons) intentionally matches
// the old sidebar — only the data shape changes.
//
// Search renders as a flat overlay (Outline-style) using the existing
// `/api/documents?q=` endpoint so server-side title+content matching keeps
// working. Selecting a result deep-links to the doc; the tree re-mounts
// underneath when the search box is cleared.

import type { Document, DocumentTreeNode } from "@/shared/lib/api/documents";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { FileText, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DocumentTree } from "@/shared/components/portal/document-tree";
import { MoveDocumentDialog } from "@/shared/components/portal/move-document-dialog";
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
import { useDebounce } from "@/shared/hooks/use-debounce";
import {
  documentsKeys,
  patchDocument,
  useDocumentTree,
  useMoveDocument,
} from "@/shared/lib/api/documents";
import { http } from "@/shared/lib/http";
import { cn } from "@/shared/lib/utils";
import { useAuthStore } from "@/shared/stores/auth";

interface SearchResponse {
  readonly data: Document[];
  readonly meta: { readonly total: number; readonly page: number; readonly limit: number };
}

function useDocumentSearch(query: string) {
  return useQuery({
    queryKey: ["documents", "search", query],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("q", query);
      params.set("limit", "100");
      return http<SearchResponse>(`/documents?${params}`);
    },
    enabled: query.trim().length > 0,
    staleTime: 5_000,
  });
}

export function DocumentsSidebar() {
  const { t } = useTranslation("documents");
  const user = useAuthStore(s => s.user);
  const isAdmin = user?.role === "admin";
  const navigate = useNavigate();
  const qc = useQueryClient();

  const params = useParams({ strict: false }) as { docId?: string };
  const activeDocId = params.docId;

  const [search, setSearch] = useState("");
  const debouncedSearch = useDebounce(search, 300);
  const isSearching = debouncedSearch.trim().length > 0;

  const treeQuery = useDocumentTree();
  const searchQuery = useDocumentSearch(isSearching ? debouncedSearch : "");

  const [moveTarget, setMoveTarget] = useState<DocumentTreeNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DocumentTreeNode | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const moveMutation = useMoveDocument();
  const renameMutation = useMutation({
    // Title rename uses the regular PATCH so version-conflict handling stays
    // consistent. The tree view doesn't track version, so we read it from
    // the detail cache when present and otherwise fall back to a fresh GET.
    mutationFn: async ({ id, title }: { readonly id: string; readonly title: string }) => {
      const cached = qc.getQueryData<Document>(documentsKeys.detail(id));
      const version = cached?.version
        ?? (await http<Document>(`/documents/${id}`)).version;
      return patchDocument(id, { title, version });
    },
    onSuccess: (doc) => {
      qc.setQueryData(documentsKeys.detail(doc.id), doc);
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : t("common.error.operationFailed"));
    },
  });
  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await http(`/documents/${id}`, { method: "DELETE" });
    },
    onSuccess: (_void, id) => {
      qc.removeQueries({ queryKey: documentsKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
      if (activeDocId === id)
        void navigate({ to: "/portal/documents" });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : t("common.error.deleteFailed"));
    },
  });

  // The tree payload omits creatorId, so we cannot tell client-side whether
  // the current user owns the node. The API still enforces ownership on
  // every mutation, so we always show the menu and let the server reject —
  // matches the old sidebar's optimistic-UI behaviour. Reading isAdmin keeps
  // the prop honest if we later add per-node creator data.
  const canManage = (_node: DocumentTreeNode): boolean => isAdmin || true;

  const handleMoveConfirm = (parentId: string | null) => {
    if (!moveTarget)
      return;
    const cachedDoc = qc.getQueryData<Document>(documentsKeys.detail(moveTarget.id));
    moveMutation.mutate(
      { id: moveTarget.id, parentId, version: cachedDoc?.version ?? 0 },
      {
        onSuccess: () => {
          setMoveTarget(null);
        },
        onError: (err) => {
          setActionError(err instanceof Error ? err.message : t("common.error.operationFailed"));
        },
      },
    );
  };

  const treeNodes = treeQuery.data ?? [];
  const searchResults = searchQuery.data?.data ?? [];

  return (
    <div className="flex w-full md:w-72 shrink-0 flex-col border-r bg-muted/30 lg:w-80">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <h2 className="text-sm font-semibold">{t("page.myDocuments.title")}</h2>
        <div className="flex items-center gap-0.5">
          <Button
            render={<Link to="/portal/documents/new" />}
            size="icon-sm"
            variant="ghost"
            title={t("create")}
          >
            <Plus className="size-4" />
          </Button>
        </div>
      </div>

      <div className="border-b px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("searchPlaceholder")}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      {actionError && (
        <div className="mx-3 mt-2 rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1.5 text-[11px] text-destructive">
          {actionError}
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-2 underline-offset-2 hover:underline"
          >
            {t("common.dismiss", { defaultValue: "Dismiss" })}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {isSearching
          ? (
              <SearchResultsList
                results={searchResults}
                isLoading={searchQuery.isLoading}
                error={searchQuery.error}
                activeDocId={activeDocId}
              />
            )
          : treeQuery.isLoading
            ? <div className="py-8 text-center text-xs text-muted-foreground">{t("common.loading")}</div>
            : treeQuery.error
              ? <div className="px-3 py-4 text-xs text-destructive">{treeQuery.error instanceof Error ? treeQuery.error.message : t("common.error.loadFailed")}</div>
              : (
                  <DocumentTree
                    nodes={treeNodes}
                    activeId={activeDocId}
                    onRename={(node, name) => renameMutation.mutate({ id: node.id, title: name })}
                    onDelete={node => setDeleteTarget(node)}
                    onMove={node => setMoveTarget(node)}
                    canManage={canManage}
                  />
                )}
      </div>

      {moveTarget && (
        <MoveDocumentDialog
          node={moveTarget}
          nodes={treeNodes}
          onCancel={() => setMoveTarget(null)}
          onConfirm={handleMoveConfirm}
          isPending={moveMutation.isPending}
        />
      )}

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleteTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("deleteTitle")}</DialogTitle>
            <DialogDescription>
              {t("deleteConfirm", { title: deleteTarget?.title ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.cancel")}</Button>} />
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate(deleteTarget.id, {
                    onSuccess: () => setDeleteTarget(null),
                  });
                }
              }}
            >
              {t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SearchResultsList({
  results,
  isLoading,
  error,
  activeDocId,
}: {
  readonly results: readonly Document[];
  readonly isLoading: boolean;
  readonly error: unknown;
  readonly activeDocId: string | undefined;
}) {
  const { t } = useTranslation("documents");
  if (isLoading)
    return <div className="py-8 text-center text-xs text-muted-foreground">{t("common.loading")}</div>;
  if (error)
    return <div className="px-3 py-4 text-xs text-destructive">{error instanceof Error ? error.message : t("common.error.loadFailed")}</div>;
  if (results.length === 0)
    return <div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("noResults")}</div>;
  return (
    <div className="py-1">
      {results.map(doc => (
        <Link
          key={doc.id}
          to="/portal/documents/$docId"
          params={{ docId: doc.id }}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors hover:bg-accent/50",
            activeDocId === doc.id && "bg-accent",
          )}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate flex-1">{doc.title}</span>
        </Link>
      ))}
    </div>
  );
}

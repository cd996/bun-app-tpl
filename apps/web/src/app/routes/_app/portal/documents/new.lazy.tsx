// New-document page. Lives inside the same documents layout so the sidebar
// stays visible, and reuses the detail page's Bear-style chrome (header,
// max-w-[760px] column) for visual consistency. Unlike the detail page,
// saving is explicit — the doc has no id yet, so there is nothing to
// autosave against. Once created we replace history with the new
// `/portal/documents/$id` so back-button returns to the previous view.

/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { FileText, X } from "lucide-react";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";

import { MarkdownEditor } from "@/shared/components/editor";
import { Badge } from "@/shared/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/shared/components/ui/breadcrumb";
import { Button } from "@/shared/components/ui/button";
import { Input } from "@/shared/components/ui/input";
import { buildAncestorChain, useCreateDocument, useDocumentTree } from "@/shared/lib/api/documents";

export const Route = createLazyFileRoute("/_app/portal/documents/new")({
  component: NewDocumentPage,
});

function NewDocumentPage() {
  const { t } = useTranslation("documents");
  const navigate = useNavigate();
  const search = useSearch({ from: "/_app/portal/documents/new" });
  const createMutation = useCreateDocument();
  // The tree query is already pre-warmed by the sidebar, so this just reads
  // from cache when the user came in via "New child" — used to render the
  // intended-parent breadcrumb so the page makes the implicit nesting visible.
  const treeQuery = useDocumentTree();
  const parentChain = search.parent && treeQuery.data
    ? buildAncestorChain(treeQuery.data, search.parent)
    : [];

  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleAddTag = () => {
    const raw = tagInput.trim().toLowerCase().replace(/[^\w-]/g, "");
    setTagInput("");
    if (!raw || tags.includes(raw))
      return;
    setTags(prev => [...prev, raw]);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim())
      return;
    createMutation.mutate(
      { title: title.trim(), content, tags, parentId: search.parent ?? null },
      {
        onSuccess: (doc) => {
          void navigate({ to: "/portal/documents/$docId", params: { docId: doc.id }, replace: true });
        },
        onError: (err) => {
          setError(err instanceof Error ? err.message : t("common.error.operationFailed"));
        },
      },
    );
  };

  return (
    <div data-doc-detail="true" className="md-editor-prose">
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
          {parentChain.map(node => (
            <Fragment key={node.id}>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link
                    to="/portal/documents/$docId"
                    params={{ docId: node.id }}
                    className="hover:text-foreground transition-colors truncate"
                  >
                    {node.title}
                  </Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
            </Fragment>
          ))}
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t("createTitle")}</BreadcrumbPage>
          </BreadcrumbItem>
        </Breadcrumb>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="ghost" size="sm" onClick={() => void navigate({ to: "/portal/documents" })}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" form="new-document-form" size="sm" disabled={createMutation.isPending || !title.trim()}>
            {t("common.create")}
          </Button>
        </div>
      </div>

      <form id="new-document-form" onSubmit={handleSubmit} className="px-4 sm:px-10 py-8">
        <div className="mx-auto max-w-[760px]">
          {error && (
            <div className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          )}

          <input
            type="text"
            value={title}
            placeholder={t("untitledPlaceholder", { defaultValue: "Untitled" })}
            onChange={e => setTitle(e.target.value)}
            className="w-full bg-transparent text-3xl font-bold leading-tight border-0 outline-none placeholder:text-muted-foreground/40 px-0"
            autoFocus
            required
            aria-label="Document title"
          />

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {tags.map(tag => (
              <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                {tag}
                <button
                  type="button"
                  onClick={() => setTags(prev => prev.filter(t2 => t2 !== tag))}
                  className="ml-0.5 hover:text-destructive"
                  aria-label={t("common.delete")}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === "Enter" || e.key === ",") && tagInput.trim()) {
                  e.preventDefault();
                  handleAddTag();
                }
              }}
              placeholder={t("tagsPlaceholder")}
              className="h-6 w-28 min-w-0 border-0 shadow-none text-xs focus-visible:ring-0 px-1"
            />
          </div>

          <div className="mt-6">
            <MarkdownEditor
              value={content}
              onChange={setContent}
              placeholder={t("field.contentPlaceholder")}
              minHeight={320}
            />
          </div>
        </div>
      </form>
    </div>
  );
}

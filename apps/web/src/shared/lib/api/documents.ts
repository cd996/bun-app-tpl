// Documents data layer: types, raw clients, and TanStack Query hooks.
//
// 409 (VERSION_CONFLICT) is a load-bearing case for the immersive editor —
// the API returns the current row in `body.data` so the caller can rebase
// without losing the user's in-flight edits. The shared `http()` discards
// that payload, so the patch helper here uses fetch directly and surfaces
// the conflict row via `ConflictError`.

import type { UseMutationResult } from "@tanstack/react-query";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { BASE_PATH, HttpError } from "../http";

// ── Types ──

export interface Document {
  readonly id: string;
  readonly title: string;
  readonly content: string | null;
  readonly tags: string;
  readonly parentId: string | null;
  readonly version: number;
  readonly creatorId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DocumentTreeNode {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly updatedAt: string;
  readonly childCount: number;
}

export interface SimpleUser {
  readonly id: string;
  readonly name: string;
  readonly username: string;
}

export interface SimpleGroup {
  readonly id: string;
  readonly name: string;
}

export interface DocumentShare {
  readonly id: string;
  readonly documentId: string;
  readonly targetType: "user" | "group";
  readonly targetId: string;
  readonly permission: "viewer" | "editor";
  readonly createdAt: string;
  // null when the share is on this document directly; otherwise the
  // ancestor document this grant is inherited from. Inherited shares
  // cannot be removed from the current doc's share dialog — the user
  // must go to the source document instead.
  readonly inheritedFrom: { readonly id: string; readonly title: string } | null;
}

export interface Attachment {
  readonly id: string;
  readonly documentId: string;
  readonly filename: string;
  readonly mimetype: string;
  readonly size: number;
  readonly uploadedBy: string;
  readonly createdAt: string;
}

export interface DocumentComment {
  readonly id: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ── Helpers ──

export function parseTags(tagsJson: string | null | undefined): string[] {
  if (!tagsJson)
    return [];
  try {
    const parsed = JSON.parse(tagsJson);
    return Array.isArray(parsed) ? parsed : [];
  }
  catch {
    return [];
  }
}

/**
 * Walks `parentId` to produce the ancestor chain (root → … → leaf), inclusive
 * of the leaf itself. Cycle-safe via a seen-set so a malformed tree never
 * locks the breadcrumb.
 */
export function buildAncestorChain(
  tree: readonly DocumentTreeNode[],
  leafId: string,
): readonly DocumentTreeNode[] {
  const byId = new Map(tree.map(n => [n.id, n]));
  const chain: DocumentTreeNode[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node)
      break;
    chain.unshift(node);
    cursor = node.parentId;
  }
  return chain;
}

// ── Raw clients ──

const API_BASE = `${BASE_PATH}/api`;

interface ApiEnvelope<T> {
  readonly success: boolean;
  readonly data: T;
  readonly error?: { readonly code?: string; readonly message?: string };
  readonly meta?: { readonly total: number; readonly page: number; readonly limit: number };
}

async function rawJson<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body != null;
  const isFormData = init?.body instanceof FormData;
  const method = (init?.method ?? "GET").toUpperCase();
  const isMutating = method !== "GET" && method !== "HEAD";
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasBody && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...(isMutating ? { "X-Requested-With": "XMLHttpRequest" } : {}),
      ...init?.headers,
    },
  });
  const body = await res.json().catch(() => ({})) as ApiEnvelope<unknown>;
  if (!res.ok) {
    const message = body.error?.message ?? `HTTP ${res.status}`;
    throw new HttpError(message, res.status, body.error?.code);
  }
  return body as T;
}

/**
 * Thrown by {@link patchDocument} when the server reports VERSION_CONFLICT (409).
 * `.current` is the freshly-read row the caller should rebase on.
 */
export class DocumentVersionConflictError extends Error {
  readonly current: Document;
  constructor(current: Document) {
    super("Document version conflict");
    this.name = "DocumentVersionConflictError";
    this.current = current;
  }
}

interface UpdatePayload {
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
  readonly version: number;
}

export async function patchDocument(id: string, payload: UpdatePayload): Promise<Document> {
  const res = await fetch(`${API_BASE}/documents/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({})) as ApiEnvelope<Document>;
  if (res.status === 409 && body.error?.code === "VERSION_CONFLICT" && body.data) {
    throw new DocumentVersionConflictError(body.data);
  }
  if (!res.ok) {
    throw new HttpError(body.error?.message ?? `HTTP ${res.status}`, res.status, body.error?.code);
  }
  return body.data;
}

// ── Query keys ──

export const documentsKeys = {
  all: ["documents"] as const,
  tree: () => ["documents", "tree"] as const,
  detail: (id: string) => ["documents", "detail", id] as const,
  tags: () => ["documents", "tags"] as const,
  users: () => ["documents", "users"] as const,
  groups: () => ["documents", "groups"] as const,
  shares: (id: string) => ["documents", id, "shares"] as const,
  attachments: (id: string) => ["documents", id, "attachments"] as const,
  comments: (id: string) => ["documents", id, "comments"] as const,
};

// ── Query hooks ──

export function useDocumentTree() {
  return useQuery({
    queryKey: documentsKeys.tree(),
    queryFn: () => rawJson<ApiEnvelope<readonly DocumentTreeNode[]>>("/documents/tree").then(r => r.data),
    staleTime: 5_000,
  });
}

export function useDocument(id: string | undefined) {
  return useQuery({
    queryKey: documentsKeys.detail(id ?? ""),
    queryFn: () => rawJson<ApiEnvelope<Document>>(`/documents/${id}`).then(r => r.data),
    enabled: !!id,
    staleTime: 5_000,
  });
}

export function useDocumentTags() {
  return useQuery({
    queryKey: documentsKeys.tags(),
    queryFn: () => rawJson<ApiEnvelope<readonly string[]>>("/documents/tags").then(r => r.data),
    staleTime: 30_000,
  });
}

export function useDocumentUsers() {
  return useQuery({
    queryKey: documentsKeys.users(),
    queryFn: () => rawJson<ApiEnvelope<readonly SimpleUser[]>>("/documents/users").then(r => r.data),
    staleTime: 60_000,
  });
}

export function useDocumentGroups() {
  return useQuery({
    queryKey: documentsKeys.groups(),
    queryFn: () => rawJson<ApiEnvelope<readonly SimpleGroup[]>>("/documents/groups").then(r => r.data),
    staleTime: 60_000,
  });
}

// ── Mutation hooks ──

interface CreateDocumentInput {
  readonly title: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
}

export function useCreateDocument(): UseMutationResult<Document, Error, CreateDocumentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateDocumentInput) => {
      const res = await rawJson<ApiEnvelope<Document>>("/documents", {
        method: "POST",
        body: JSON.stringify(input),
      });
      return res.data;
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
    },
  });
}

export interface UpdateDocumentInput {
  readonly id: string;
  readonly version: number;
  readonly title?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly parentId?: string | null;
}

/**
 * Optimistic update with rollback on failure. On 409 the cache is replaced
 * with the server's freshly-read row (carried by DocumentVersionConflictError),
 * so the caller's next save will already have the correct `version`.
 */
export function useUpdateDocument(): UseMutationResult<Document, Error, UpdateDocumentInput> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...payload }: UpdateDocumentInput) => {
      return patchDocument(id, payload);
    },
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: documentsKeys.detail(input.id) });
      const previous = qc.getQueryData<Document>(documentsKeys.detail(input.id));
      if (previous) {
        qc.setQueryData<Document>(documentsKeys.detail(input.id), {
          ...previous,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
          ...(input.tags !== undefined ? { tags: JSON.stringify(input.tags) } : {}),
          ...(input.parentId !== undefined ? { parentId: input.parentId } : {}),
        });
      }
      return { previous };
    },
    onError: (err, input, ctx) => {
      // On VERSION_CONFLICT the API hands us the row that won — install it so
      // the next save uses the new version. Otherwise restore the snapshot we
      // took in onMutate.
      if (err instanceof DocumentVersionConflictError) {
        qc.setQueryData(documentsKeys.detail(input.id), err.current);
      }
      else if (ctx?.previous) {
        qc.setQueryData(documentsKeys.detail(input.id), ctx.previous);
      }
    },
    onSuccess: (doc) => {
      qc.setQueryData(documentsKeys.detail(doc.id), doc);
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
      void qc.invalidateQueries({ queryKey: documentsKeys.tags() });
    },
  });
}

export function useDeleteDocument(): UseMutationResult<void, Error, string> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await rawJson<ApiEnvelope<null>>(`/documents/${id}`, { method: "DELETE" });
    },
    onSuccess: (_, id) => {
      qc.removeQueries({ queryKey: documentsKeys.detail(id) });
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
    },
  });
}

export function useMoveDocument(): UseMutationResult<Document, Error, { readonly id: string; readonly parentId: string | null; readonly version: number }> {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, parentId, version }) => {
      const res = await rawJson<ApiEnvelope<Document>>(`/documents/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ parentId, version }),
      });
      return res.data;
    },
    onSuccess: (doc) => {
      qc.setQueryData(documentsKeys.detail(doc.id), doc);
      void qc.invalidateQueries({ queryKey: documentsKeys.tree() });
    },
  });
}

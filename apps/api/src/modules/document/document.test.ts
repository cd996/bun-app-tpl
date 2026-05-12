import type { AppDatabase } from "@/db";
import type { AppEnv, User } from "@/shared/lib/types";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { customAlphabet } from "nanoid";
import { createDb } from "@/db";
import { users } from "@/modules/account/users/schema";
import { registerAuthProvider } from "@/shared/middleware/auth-registry";
import { documentRoutes } from "./document.routes";
import { addDocumentShare, createDocument, deleteDocument, getDocumentById, getDocumentPermission, getDocumentTreeForUser, listDescendantIds, moveDocument, updateDocument } from "./document.service";

const nanoid = customAlphabet("0123456789abcdefghijklmnopqrstuvwxyz", 8);

let db: AppDatabase;
let dbPath: string;
let currentUser: User | undefined;

// Register a single auth provider for the whole suite — it reads from a
// per-test mutable variable so each request can flip between users.
registerAuthProvider(async () => currentUser);

async function seedUser(name: string, role: "admin" | "user" = "user"): Promise<User> {
  const id = nanoid();
  const now = new Date().toISOString();
  const row = {
    id,
    oauthSub: `sub-${id}`,
    username: name.toLowerCase(),
    name,
    email: `${name.toLowerCase()}@test.com`,
    avatar: null,
    role,
    status: "active" as const,
    lastLoginAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(users).values(row).run();
  return row;
}

function buildApp() {
  // Mounts documentRoutes() with `db` injected via middleware. The router's
  // built-in authRequired middleware then reads from the auth provider we
  // registered above, which closes over `currentUser`.
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("db", db);
    return next();
  });
  app.route("/api", documentRoutes());
  app.onError((err, c) => {
    const e = err as Error & { statusCode?: number; code?: string };
    return c.json({ success: false, error: { code: e.code ?? "ERR", message: e.message } }, (e.statusCode ?? 500) as 500);
  });
  return app;
}

async function request(path: string, init: RequestInit & { user?: User } = {}) {
  const app = buildApp();
  if (init.user)
    currentUser = init.user;
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  return await app.request(`/api${path}`, { ...init, headers });
}

beforeEach(async () => {
  const dir = resolve(tmpdir(), `test-document-${Date.now()}-${nanoid()}`);
  mkdirSync(dir, { recursive: true });
  dbPath = resolve(dir, "test.db");
  db = await createDb(dbPath);
  currentUser = undefined;
});

afterEach(() => {
  db.close();
  const dir = resolve(dbPath, "..");
  if (existsSync(dir))
    rmSync(dir, { recursive: true, force: true });
});

describe("service: createDocument with parentId", () => {
  test("creates a root document with parentId null and version 1", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Root", creatorId: alice.id });
    expect(doc.parentId).toBeNull();
    expect(doc.version).toBe(1);
  });

  test("creates a child document with the given parentId", async () => {
    const alice = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    expect(child.parentId).toBe(root.id);
  });
});

describe("service: tree", () => {
  test("returns every readable doc with parentId and childCount", async () => {
    const alice = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const a = await createDocument(db, { title: "A", creatorId: alice.id, parentId: root.id });
    await createDocument(db, { title: "B", creatorId: alice.id, parentId: root.id });
    await createDocument(db, { title: "A1", creatorId: alice.id, parentId: a.id });

    const nodes = await getDocumentTreeForUser(db, alice);
    expect(nodes).toHaveLength(4);

    const byId = new Map(nodes.map(n => [n.id, n]));
    expect(byId.get(root.id)!.childCount).toBe(2);
    expect(byId.get(a.id)!.childCount).toBe(1);
    expect(byId.get(a.id)!.parentId).toBe(root.id);
  });

  test("sorts siblings by case-insensitive title", async () => {
    const alice = await seedUser("Alice");
    await createDocument(db, { title: "banana", creatorId: alice.id });
    await createDocument(db, { title: "Apple", creatorId: alice.id });
    await createDocument(db, { title: "cherry", creatorId: alice.id });

    const nodes = await getDocumentTreeForUser(db, alice);
    expect(nodes.map(n => n.title)).toEqual(["Apple", "banana", "cherry"]);
  });

  test("excludes documents the caller cannot read", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    await createDocument(db, { title: "Alice doc", creatorId: alice.id });
    await createDocument(db, { title: "Bob doc", creatorId: bob.id });

    const aliceTree = await getDocumentTreeForUser(db, alice);
    expect(aliceTree.map(n => n.title)).toEqual(["Alice doc"]);
  });
});

describe("service: listDescendantIds", () => {
  test("returns transitive descendants but not self", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: alice.id });
    const b = await createDocument(db, { title: "B", creatorId: alice.id, parentId: a.id });
    const c = await createDocument(db, { title: "C", creatorId: alice.id, parentId: b.id });

    const descendantsOfA = await listDescendantIds(db, a.id);
    expect(new Set(descendantsOfA)).toEqual(new Set([b.id, c.id]));

    const descendantsOfC = await listDescendantIds(db, c.id);
    expect(descendantsOfC).toEqual([]);
  });
});

describe("service: deleteDocument cascades to descendants", () => {
  test("deleting the parent removes the entire subtree", async () => {
    const alice = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    const grand = await createDocument(db, { title: "Grand", creatorId: alice.id, parentId: child.id });

    await deleteDocument(db, root.id);

    expect(await getDocumentById(db, root.id)).toBeUndefined();
    expect(await getDocumentById(db, child.id)).toBeUndefined();
    expect(await getDocumentById(db, grand.id)).toBeUndefined();
  });
});

describe("service: updateDocument version concurrency", () => {
  test("matching expectedVersion bumps version", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Doc", creatorId: alice.id });
    const updated = await updateDocument(db, doc.id, { title: "Doc v2", expectedVersion: 1 });
    expect(updated).toBeDefined();
    expect((updated as { version: number }).version).toBe(2);
  });

  test("mismatched expectedVersion returns a conflict carrying the current row", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Doc", creatorId: alice.id });
    await updateDocument(db, doc.id, { title: "Doc v2", expectedVersion: 1 });
    const conflict = await updateDocument(db, doc.id, { title: "Stale", expectedVersion: 1 });
    expect(conflict).toMatchObject({ conflict: true });
    expect((conflict as { current: { version: number } }).current.version).toBe(2);
  });
});

describe("service: moveDocument", () => {
  test("moves a document under a new parent and bumps version", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: alice.id });
    const b = await createDocument(db, { title: "B", creatorId: alice.id });

    const moved = await moveDocument(db, b.id, a.id);
    expect((moved as { parentId: string | null }).parentId).toBe(a.id);
    expect((moved as { version: number }).version).toBe(2);
  });
});

describe("routes: GET /documents/tree", () => {
  test("returns a flat tree shape for the authenticated user", async () => {
    const alice = await seedUser("Alice");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });

    const res = await request("/documents/tree", { method: "GET", user: alice });
    expect(res.status).toBe(200);
    const body = await res.json() as { success: boolean; data: { id: string; parentId: string | null; childCount: number }[] };
    expect(body.success).toBe(true);
    expect(body.data).toHaveLength(2);
    const rootNode = body.data.find(n => n.id === root.id)!;
    expect(rootNode.parentId).toBeNull();
    expect(rootNode.childCount).toBe(1);
  });
});

describe("routes: PATCH /documents/:id/move", () => {
  test("rejects a move that would create a cycle", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: alice.id });
    const b = await createDocument(db, { title: "B", creatorId: alice.id, parentId: a.id });

    // Trying to move A under B (B is a descendant of A) → cycle.
    const res = await request(`/documents/${a.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: b.id }),
      user: alice,
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_MOVE");
  });

  test("rejects moving into a target the caller cannot edit (cross-user)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const aliceDoc = await createDocument(db, { title: "Alice doc", creatorId: alice.id });
    const bobDoc = await createDocument(db, { title: "Bob doc", creatorId: bob.id });

    // Alice tries to move her doc under Bob's doc. She has no edit on Bob's doc.
    const res = await request(`/documents/${aliceDoc.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: bobDoc.id }),
      user: alice,
    });
    expect(res.status).toBe(403);
  });

  test("rejects when the caller cannot edit the moving doc", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const aliceDoc = await createDocument(db, { title: "Alice doc", creatorId: alice.id });

    const res = await request(`/documents/${aliceDoc.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: null }),
      user: bob,
    });
    expect(res.status).toBe(403);
  });

  test("moves a document under a valid target owned by the caller", async () => {
    const alice = await seedUser("Alice");
    const a = await createDocument(db, { title: "A", creatorId: alice.id });
    const b = await createDocument(db, { title: "B", creatorId: alice.id });

    const res = await request(`/documents/${b.id}/move`, {
      method: "PATCH",
      body: JSON.stringify({ parentId: a.id }),
      user: alice,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { parentId: string; version: number } };
    expect(body.data.parentId).toBe(a.id);
    expect(body.data.version).toBe(2);
  });
});

describe("routes: PATCH /documents/:id with version", () => {
  test("succeeds and bumps version when expected version matches", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Doc", creatorId: alice.id });

    const res = await request(`/documents/${doc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Doc v2", version: 1 }),
      user: alice,
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: { version: number; title: string } };
    expect(body.data.version).toBe(2);
    expect(body.data.title).toBe("Doc v2");
  });

  test("returns 409 VERSION_CONFLICT when the client's version is stale", async () => {
    const alice = await seedUser("Alice");
    const doc = await createDocument(db, { title: "Doc", creatorId: alice.id });

    // First write advances version to 2.
    await request(`/documents/${doc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Doc v2", version: 1 }),
      user: alice,
    });
    // Second write at the stale version 1 conflicts.
    const res = await request(`/documents/${doc.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Doc v2 race", version: 1 }),
      user: alice,
    });
    expect(res.status).toBe(409);
    const body = await res.json() as { error: { code: string }; data: { version: number; title: string } };
    expect(body.error.code).toBe("VERSION_CONFLICT");
    expect(body.data.version).toBe(2);
    expect(body.data.title).toBe("Doc v2");
  });
});

describe("service: getDocumentPermission with inheritance", () => {
  test("direct share grants the configured permission on the doc itself", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const doc = await createDocument(db, { title: "Doc", creatorId: alice.id });
    await addDocumentShare(db, { documentId: doc.id, targetType: "user", targetId: bob.id, permission: "viewer" });
    expect(await getDocumentPermission(db, doc.id, bob.id)).toBe("viewer");
  });

  test("parent share grants the same permission on a child", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "editor" });
    expect(await getDocumentPermission(db, child.id, bob.id)).toBe("editor");
  });

  test("grandparent share grants access on a deep descendant", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const mid = await createDocument(db, { title: "Mid", creatorId: alice.id, parentId: root.id });
    const leaf = await createDocument(db, { title: "Leaf", creatorId: alice.id, parentId: mid.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });
    expect(await getDocumentPermission(db, leaf.id, bob.id)).toBe("viewer");
  });

  test("child override can escalate parent's viewer to editor", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });
    await addDocumentShare(db, { documentId: child.id, targetType: "user", targetId: bob.id, permission: "editor" });
    expect(await getDocumentPermission(db, child.id, bob.id)).toBe("editor");
  });

  test("child override cannot reduce parent's editor to viewer (strongest wins)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "editor" });
    await addDocumentShare(db, { documentId: child.id, targetType: "user", targetId: bob.id, permission: "viewer" });
    expect(await getDocumentPermission(db, child.id, bob.id)).toBe("editor");
  });

  test("no grant anywhere in the chain returns null", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    expect(await getDocumentPermission(db, child.id, bob.id)).toBeNull();
  });

  test("move: child gains the new parent's shares", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const oldParent = await createDocument(db, { title: "Old", creatorId: alice.id });
    const newParent = await createDocument(db, { title: "New", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: oldParent.id });
    await addDocumentShare(db, { documentId: newParent.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    expect(await getDocumentPermission(db, child.id, bob.id)).toBeNull();
    await moveDocument(db, child.id, newParent.id);
    expect(await getDocumentPermission(db, child.id, bob.id)).toBe("viewer");
  });

  test("move: child loses access via the old parent's shares", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const oldParent = await createDocument(db, { title: "Old", creatorId: alice.id });
    const newParent = await createDocument(db, { title: "New", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: oldParent.id });
    await addDocumentShare(db, { documentId: oldParent.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    expect(await getDocumentPermission(db, child.id, bob.id)).toBe("viewer");
    await moveDocument(db, child.id, newParent.id);
    expect(await getDocumentPermission(db, child.id, bob.id)).toBeNull();
  });

  test("performance: resolves on a 1k-deep chain in under 50ms", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");

    let parentId: string | null = null;
    let leafId = "";
    for (let i = 0; i < 1000; i++) {
      const node: { id: string } = await createDocument(db, { title: `n${i}`, creatorId: alice.id, parentId });
      if (i === 0)
        await addDocumentShare(db, { documentId: node.id, targetType: "user", targetId: bob.id, permission: "viewer" });
      parentId = node.id;
      leafId = node.id;
    }

    const t0 = performance.now();
    const perm = await getDocumentPermission(db, leafId, bob.id);
    const elapsed = performance.now() - t0;
    expect(perm).toBe("viewer");
    expect(elapsed).toBeLessThan(50);
  });
});

describe("routes: inheritance affects access checks", () => {
  test("GET /documents/:id allows a user with a parent-level share to read the child", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    const res = await request(`/documents/${child.id}`, { method: "GET", user: bob });
    expect(res.status).toBe(200);
  });

  test("PATCH /documents/:id denies when inherited grant is viewer-only", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    const res = await request(`/documents/${child.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Hacked", version: 1 }),
      user: bob,
    });
    expect(res.status).toBe(403);
  });

  test("PATCH /documents/:id allows when inherited grant is editor", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "editor" });

    const res = await request(`/documents/${child.id}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Updated", version: 1 }),
      user: bob,
    });
    expect(res.status).toBe(200);
  });

  test("GET /documents/tree includes documents reachable only via inherited share", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    const grand = await createDocument(db, { title: "Grand", creatorId: alice.id, parentId: child.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    const tree = await getDocumentTreeForUser(db, bob);
    const ids = new Set(tree.map(n => n.id));
    expect(ids.has(root.id)).toBe(true);
    expect(ids.has(child.id)).toBe(true);
    expect(ids.has(grand.id)).toBe(true);
  });
});

describe("routes: GET /documents/:id/shares includes inheritedFrom", () => {
  test("self-shares carry inheritedFrom=null; ancestor-shares carry the ancestor's id+title", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const carol = await seedUser("Carol");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });
    await addDocumentShare(db, { documentId: child.id, targetType: "user", targetId: carol.id, permission: "editor" });

    const res = await request(`/documents/${child.id}/shares`, { method: "GET", user: alice });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      data: Array<{
        targetId: string;
        permission: string;
        inheritedFrom: { id: string; title: string } | null;
      }>;
    };
    const carolShare = body.data.find(s => s.targetId === carol.id)!;
    const bobShare = body.data.find(s => s.targetId === bob.id)!;
    expect(carolShare.inheritedFrom).toBeNull();
    expect(carolShare.permission).toBe("editor");
    expect(bobShare.inheritedFrom).toEqual({ id: root.id, title: "Root" });
    expect(bobShare.permission).toBe("viewer");
  });

  test("DELETE on an inherited share returns 404 (the share does not belong to the current doc)", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });
    const child = await createDocument(db, { title: "Child", creatorId: alice.id, parentId: root.id });
    const share = await addDocumentShare(db, { documentId: root.id, targetType: "user", targetId: bob.id, permission: "viewer" });

    const res = await request(`/documents/${child.id}/shares/${share!.id}`, {
      method: "DELETE",
      user: alice,
    });
    expect(res.status).toBe(404);
  });
});

describe("routes: POST /documents/:id/shares response", () => {
  test("includes a note that the share applies recursively to descendants", async () => {
    const alice = await seedUser("Alice");
    const bob = await seedUser("Bob");
    const root = await createDocument(db, { title: "Root", creatorId: alice.id });

    const res = await request(`/documents/${root.id}/shares`, {
      method: "POST",
      body: JSON.stringify({ targetType: "user", targetId: bob.id, permission: "viewer" }),
      user: alice,
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { note?: string };
    expect(body.note).toBeDefined();
    expect(body.note).toMatch(/recurs/i);
  });
});

import { describe, expect, it } from "bun:test";
import { getClient } from "../../lib/oidc";

interface Folder { id: string; name: string }
interface Document { id: string; title: string; folderId: string | null }
interface Share { id: string; targetType: string; targetId: string; permission: string }

describe("/api/documents CRUD", () => {
  it("creates a folder, document inside it, then renames + deletes", async () => {
    const user = await getClient("user@example.com", "admin");

    const folder = await user.json<{ data: Folder }>("/api/documents/folders", {
      method: "POST",
      body: { name: "e2e-folder" },
    });
    const folderId = folder.data.id;

    const doc = await user.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "e2e-doc", content: "hello", folderId },
    });
    expect(doc.data.title).toBe("e2e-doc");
    expect(doc.data.folderId).toBe(folderId);
    const docId = doc.data.id;

    // List filters by folder.
    const list = await user.json<{ data: Document[] }>("/api/documents");
    expect(list.data.find(d => d.id === docId)).toBeDefined();

    // Patch title.
    const patched = await user.json<{ data: Document }>(`/api/documents/${docId}`, {
      method: "PATCH",
      body: { title: "e2e-doc-renamed" },
    });
    expect(patched.data.title).toBe("e2e-doc-renamed");

    // Delete document then folder.
    await user.raw(`/api/documents/${docId}`, { method: "DELETE" });
    await user.raw(`/api/documents/folders/${folderId}`, { method: "DELETE" });
  });

  it("share a document with a second user grants read access", async () => {
    const owner = await getClient("user@example.com", "admin");
    // Make sure admin@example.com is in the directory and grab its id.
    const admin = await getClient("admin@example.com", "admin");
    const users = await admin.json<{ data: { id: string; email: string }[] }>("/api/account/users");
    const adminId = users.data.find(u => u.email === "admin@example.com")?.id;
    if (!adminId)
      throw new Error("admin user missing from directory");

    const doc = await owner.json<{ data: Document }>("/api/documents", {
      method: "POST",
      body: { title: "shared-doc", content: "shared body" },
    });
    const docId = doc.data.id;

    // Owner shares with admin as viewer.
    const share = await owner.json<{ data: Share }>(`/api/documents/${docId}/shares`, {
      method: "POST",
      body: { targetType: "user", targetId: adminId, permission: "viewer" },
    });
    expect(share.data.permission).toBe("viewer");

    // Admin can now read it.
    const read = await admin.json<{ data: Document }>(`/api/documents/${docId}`);
    expect(read.data.id).toBe(docId);

    // Cleanup.
    await owner.raw(`/api/documents/${docId}`, { method: "DELETE" });
  });
});

import { describe, expect, it } from "vitest";
import { validateAttachmentSelection } from "./-attachment-upload";

function makeFile(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "text/plain" });
}

describe("validateAttachmentSelection", () => {
  it("rejects selections beyond the remaining slot count", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 10), makeFile("b.txt", 10)], 19, 1024, 20);
    expect(result).toBe("limit");
  });

  it("rejects oversized files", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 2048)], 0, 1024, 20);
    expect(result).toBe("size");
  });

  it("accepts selections within limits", () => {
    const result = validateAttachmentSelection([makeFile("a.txt", 512)], 2, 1024, 20);
    expect(result).toBe("ok");
  });
});

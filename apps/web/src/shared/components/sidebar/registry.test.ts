import { describe, expect, it } from "vitest";
import { getNavItems } from "./registry";

describe("getNavItems", () => {
  it("returns admin entries sorted by order", () => {
    const items = getNavItems("admin");
    expect(items.map(i => i.key)).toEqual(["users", "policies", "audit", "platformSettings"]);
    expect(items.every(i => i.area === "admin")).toBe(true);
  });

  it("returns portal entries sorted by order", () => {
    const items = getNavItems("portal");
    expect(items.map(i => i.key)).toEqual(["portal", "myTodos", "documents"]);
    expect(items.every(i => i.area === "portal")).toBe(true);
  });
});

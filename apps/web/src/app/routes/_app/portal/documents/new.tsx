import { createFileRoute } from "@tanstack/react-router";

interface NewSearch {
  readonly parent?: string;
}

export const Route = createFileRoute("/_app/portal/documents/new")({
  // `?parent=<id>` lets a "new child" sidebar action seed the parent without
  // a stash in store/state. Anything else is ignored.
  validateSearch: (raw: Record<string, unknown>): NewSearch => {
    const parent = raw.parent;
    if (typeof parent === "string" && parent.length > 0)
      return { parent };
    return {};
  },
});

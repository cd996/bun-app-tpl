import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/portal/documents")({
  staticData: { titleKey: "page.myDocuments.title" },
});

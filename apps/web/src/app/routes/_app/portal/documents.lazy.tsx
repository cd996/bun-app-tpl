// Documents layout: a sidebar shell that hosts every child route via
// <Outlet />. Selection lives in the URL (`/portal/documents/$docId`) so
// refresh and shareable links work, and TanStack Query is the cache layer —
// the sidebar fetches data once and other routes mounted in the outlet
// (detail, create) read from the same cache.

/* eslint-disable react-refresh/only-export-components */
import { createLazyFileRoute, Outlet } from "@tanstack/react-router";

import { DocumentsSidebar } from "./documents/-sidebar";

export const Route = createLazyFileRoute("/_app/portal/documents")({
  component: DocumentsLayout,
});

function DocumentsLayout() {
  return (
    <div className="flex flex-col md:flex-row h-[calc(100svh-60px)] md:h-[calc(100svh-28px)] -mx-4 -my-3 md:-mx-6 md:-my-4">
      <DocumentsSidebar />
      <div className="flex-1 min-w-0 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}

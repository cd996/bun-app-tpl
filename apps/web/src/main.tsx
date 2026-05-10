import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { Providers } from "./app/providers";
import { routeTree } from "./app/routeTree.gen";
import { NotFoundPage } from "./shared/components/not-found";
import "./index.css";

const basepath = import.meta.env.BASE_URL.replace(/\/+$/, "") || "/";
const router = createRouter({
  routeTree,
  basepath,
  defaultNotFoundComponent: NotFoundPage,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
  interface StaticDataRouteOption {
    titleKey?: string;
  }
}

const rootEl = document.getElementById("root");
if (!rootEl)
  throw new Error("Root element #root not found");

createRoot(rootEl).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
      {/* Sonner toaster — global notification surface. Picks up `dark` from
          the html class so it inherits the active theme. richColors gives
          info / success / warning / error the standard semantic colours. */}
      <Toaster position="top-right" richColors closeButton />
    </Providers>
  </StrictMode>,
);

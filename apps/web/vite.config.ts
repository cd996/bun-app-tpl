import process from "node:process";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const APP_NAME = process.env.APP_NAME ?? "app";
const APP_DISPLAY_NAME = process.env.APP_DISPLAY_NAME ?? "App";
// Vite reads VITE_-prefixed env at config-load time. Mirror APP_* into them
// so import.meta.env and index.html %VITE_*% substitution work uniformly.
process.env.VITE_APP_NAME = APP_NAME;
process.env.VITE_APP_DISPLAY_NAME = APP_DISPLAY_NAME;

// Mirror apps/api/src/config.ts: unset / empty means root ("/"); otherwise
// normalise to "/<x>/" (trailing slash required by Vite's `base`).
const trimmedBase = (process.env.BASE_PATH ?? "").replace(/^\/+|\/+$/g, "");
const base = trimmedBase ? `/${trimmedBase}/` : "/";

export default defineConfig({
  plugins: [
    tailwindcss(),
    TanStackRouterVite({
      routesDirectory: "./src/app/routes",
      generatedRouteTree: "./src/app/routeTree.gen.ts",
    }),
    react(),
  ],
  base,
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: 5000,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});

import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page is served under the same base path as the API (DEPLOYER_BASE_PATH, default /deploy).
const base = `/${(process.env.DEPLOYER_BASE_PATH ?? "/deploy").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const api = process.env.DEPLOYER_DEV_API ?? "http://127.0.0.1:8095";

export default defineConfig({
  root: "src/web",
  base,
  plugins: [react()],
  server: { host: "127.0.0.1", proxy: { [`${base}api/`]: api } },
  build: { outDir: fileURLToPath(new URL("dist/web", import.meta.url)), emptyOutDir: true },
});

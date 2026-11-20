import { defineConfig } from "@playwright/test";

// No web server of its own: it drives a running Deployer (see service-pages.spec.ts).
export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { trace: "retain-on-failure" },
});

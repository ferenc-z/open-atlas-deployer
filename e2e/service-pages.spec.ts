// S37 step 10: the service pages' final structure, against a running Deployer with a registered NiFi service
// (the local 8097 dev instance on the lab). E2E_URL (default http://127.0.0.1:8097) and E2E_PASSWORD (the emergency
// account's password) say where and how to sign in. Run: PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright test -c e2e
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.E2E_URL ?? "http://127.0.0.1:8097";

async function signIn(page: Page) {
  await page.goto(`${BASE}/deploy/`);
  const box = page.getByPlaceholder("Emergency account password");
  if (await box.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await box.fill(process.env.E2E_PASSWORD ?? "");
    await box.press("Enter");
  }
  await page.getByRole("button", { name: "Services", exact: true }).first().click();
}

/** Opens the first service on the Services page; returns its id. */
async function openFirst(page: Page): Promise<string> {
  await signIn(page);
  const card = page.locator(".svc-card").first();
  await expect(card).toBeVisible();
  const id = (await card.locator("strong.mono").first().textContent()) ?? "";
  await card.click();
  await expect(page.getByRole("heading", { name: id, level: 1 })).toBeVisible();
  return id;
}

// A tab may carry a badge (drift count, a running change): match the start of its name.
const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}(\\d|\\s|$)`) }).first();

test("Services is an ops desk: a queue, and a one-sentence verdict on every card", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("region", { name: "Operations desk" })).toBeVisible();
  await expect(page.locator(".svc-card .svc-card-now").first()).toContainText(/Normal|Needs attention|Critical/);
});

test("the service page has Status and Configuration and changes, and none of the removed tabs", async ({ page }) => {
  await openFirst(page);
  for (const name of ["Status", "Configuration and changes"]) await expect(tab(page, name)).toBeVisible();
  for (const name of ["Data trace", "Investigate", "Toolbox", "Overview", "Events and alerts", "Nodes", "Metrics", "Logs", "Changes", "Business model"]) await expect(tab(page, name)).toHaveCount(0);
  // Status is the default: the verdict and the to-dos.
  await expect(tab(page, "Status")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".verdict")).toContainText(/Normal|Needs attention|Critical/);
  await expect(page.getByRole("heading", { name: "To do" })).toBeVisible();
  await expect(page.getByText(/in detail/)).toBeVisible();
});

test("Configuration and changes has start/stop, changes and the configuration on one tab", async ({ page }) => {
  await openFirst(page);
  await tab(page, "Configuration and changes").click();
  await expect(page.getByRole("heading", { name: "Start and stop" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeVisible();
});

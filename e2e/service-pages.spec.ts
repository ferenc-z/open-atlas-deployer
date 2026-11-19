// Step 6a: the managed-service pages' structure, against a running Deployer with a registered NiFi service (the local 8097
// dev instance on the lab). E2E_URL (default http://127.0.0.1:8097) and E2E_PASSWORD (the emergency account's password) say
// where and how to sign in. Until the overview/page routes exist the pages run on the sample data (ops-data.ts), so the
// first card is the sample's c250-prod. Run: PLAYWRIGHT_HOST_PLATFORM_OVERRIDE=ubuntu24.04-x64 npx playwright test -c e2e
import { expect, test, type Page } from "@playwright/test";

const BASE = process.env.E2E_URL ?? "http://127.0.0.1:8097";

async function signIn(page: Page) {
  await page.goto(`${BASE}/deploy/`);
  const box = page.getByPlaceholder("Emergency account password");
  if (await box.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await box.fill(process.env.E2E_PASSWORD ?? "");
    await box.press("Enter");
  }
  await page.getByRole("button", { name: "Managed services", exact: true }).first().click();
}

/** Opens the first service on the overview; returns its id. */
async function openFirst(page: Page): Promise<string> {
  await signIn(page);
  const card = page.locator(".ov-card").first();
  await expect(card).toBeVisible();
  const id = (await card.locator(".ov-name").textContent()) ?? "";
  await card.click();
  await expect(page.getByRole("heading", { name: id, level: 1 })).toBeVisible();
  return id;
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}(\\d|\\s|$)`) }).first();

test("the overview has a card per service with a machine light and a business light, and no Alerts page", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("heading", { name: "Managed services", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Check now" })).toBeVisible();
  const card = page.locator(".ov-card").first();
  await expect(card.getByText("Machine", { exact: true })).toBeVisible();
  await expect(card.getByText(/^Business/)).toBeVisible();
  await expect(card).toContainText(/Failing|Attention|Healthy|Unknown/);
  await expect(page.getByRole("button", { name: "Alerts", exact: true })).toHaveCount(0);
});

test("the service page has Health and Configuration and changes, and none of the removed tabs", async ({ page }) => {
  await openFirst(page);
  for (const name of ["Health", "Configuration and changes"]) await expect(tab(page, name)).toBeVisible();
  for (const name of ["Status", "Data trace", "Investigate", "Toolbox", "Overview", "Events and alerts", "Nodes", "Metrics", "Logs", "Changes", "Business model"]) await expect(tab(page, name)).toHaveCount(0);
  await expect(tab(page, "Health")).toHaveAttribute("aria-selected", "true");
  // The machine card with its six checks, the business card, the analysis and the to-dos.
  await expect(page.locator(".sv-machine .sv-check")).toHaveCount(6);
  await expect(page.locator(".sv-business")).toBeVisible();
  await expect(page.getByRole("heading", { name: "AI analysis" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^For you/ })).toBeVisible();
});

test("Configuration and changes has start/stop, changes and the configuration on one tab", async ({ page }) => {
  await openFirst(page);
  await tab(page, "Configuration and changes").click();
  await expect(page.getByRole("heading", { name: "Start and stop" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Configuration", exact: true })).toBeVisible();
});

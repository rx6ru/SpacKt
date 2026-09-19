import { expect, type Locator, type Page, test } from "@playwright/test";

test.setTimeout(90_000);

async function gotoMarket(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("main", { name: "SpacKt market console" })).toBeVisible();
  await expect(connectionStatus(page)).toContainText("Live", { timeout: 20_000 });
}

function connectionStatus(page: Page) {
  return page.getByRole("region", { name: "Connection and delivery" });
}

async function openDiagnostics(page: Page) {
  await page.getByRole("button", { name: "Open diagnostics" }).click();
  const dialog = page.getByRole("dialog", { name: "Diagnostics and debug controls" });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function waitDebugReady(dialog: Locator) {
  await expect(dialog.getByRole("button", { name: "Apply pong delay" })).toBeEnabled({
    timeout: 2_000,
  });
}

async function setPongDelay(dialog: Locator, delayMs: number) {
  await waitDebugReady(dialog);
  await dialog.getByLabel("Pong delay").fill(String(delayMs));
  await dialog.getByRole("button", { name: "Apply pong delay" }).click();
}

async function forceTier(dialog: Locator, label: "Auto" | "Full" | "Degraded" | "Minimal") {
  await waitDebugReady(dialog);
  const option = dialog.getByRole("radio", { name: label });
  await expect(option).toBeEnabled();
  await option.click();
}

function diagnosticValue(dialog: Locator, label: string) {
  return dialog
    .locator(".diagnostic-item")
    .filter({ hasText: new RegExp(`^${escapeRegex(label)}`) })
    .locator("strong");
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function expectActiveTier(dialog: Locator, pattern: RegExp, timeout = 10_000) {
  await expect(diagnosticValue(dialog, "Active tier")).toHaveText(pattern, { timeout });
}

async function expectForcedTier(dialog: Locator, pattern: RegExp, timeout = 10_000) {
  await expect(diagnosticValue(dialog, "Forced tier")).toHaveText(pattern, { timeout });
}

function msFromText(text: string) {
  const match = text.match(/(\d+(?:\.\d+)?)\s*ms/);
  return match ? Number(match[1]) : null;
}

async function expectLatencyAtLeast(dialog: Locator, minimumMs: number, timeout = 20_000) {
  await expect
    .poll(async () => msFromText((await diagnosticValue(dialog, "Latency").textContent()) ?? ""), {
      timeout,
    })
    .toBeGreaterThanOrEqual(minimumMs);
}

test("automatic tier reaches minimal under high pong delay and recovers when delay is removed", async ({
  page,
}) => {
  await gotoMarket(page);
  const dialog = await openDiagnostics(page);

  await expectForcedTier(dialog, /^auto$/);
  await setPongDelay(dialog, 1000);

  await expectLatencyAtLeast(dialog, 900);
  await expectForcedTier(dialog, /^auto$/);
  await expectActiveTier(dialog, /^minimal$/, 35_000);

  await setPongDelay(dialog, 0);
  await expectActiveTier(dialog, /^(degraded|full)$/, 45_000);
});

test("forced tier applies to one browser context only", async ({ browser }) => {
  const left = await browser.newContext();
  const right = await browser.newContext();

  try {
    const pageA = await left.newPage();
    const pageB = await right.newPage();

    await Promise.all([gotoMarket(pageA), gotoMarket(pageB)]);
    const dialogA = await openDiagnostics(pageA);
    const dialogB = await openDiagnostics(pageB);

    await forceTier(dialogA, "Minimal");
    await expectForcedTier(dialogA, /^minimal$/);
    await expectActiveTier(dialogA, /^minimal$/);

    await expectForcedTier(dialogB, /^auto$/);
    await expectActiveTier(dialogB, /^(degraded|full)$/);
    await dialogB.getByRole("button", { name: "Close diagnostics" }).click();
    await expect(dialogB).toBeHidden();
    await expect(connectionStatus(pageB)).toContainText("Live");
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
});

import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  await page.route("**/*", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.hostname !== "127.0.0.1" || requestUrl.port !== "1420") {
      await route.continue();
      return;
    }
    const response = await fetch(requestUrl);
    await route.fulfill({
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
});

test("unlocks, verifies, and locks a C++ encrypted archive in the UI", async ({ page }) => {
  const fixture = fileURLToPath(new URL("../../tests/fixtures/encrypted-v1.tux", import.meta.url));
  await page.goto("/");

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await chooser).setFiles(fixture);
  await expect(page.getByText("This archive is encrypted", { exact: true })).toBeVisible();

  const passphrase = page.getByLabel("Archive passphrase");
  await passphrase.fill("incorrect passphrase");
  await page.getByRole("button", { name: "Unlock archive" }).click();
  await expect(page.getByRole("alert")).toContainText("Passphrase is incorrect");

  await passphrase.fill("Tutorux cross-language fixture phrase 2026");
  await page.getByRole("button", { name: "Unlock archive" }).click();
  await expect(page.getByText("Encrypted archive · read only")).toBeVisible();
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(page.getByRole("button", { name: "Add student", exact: true })).toBeDisabled();
  await expect(page.getByText("Interop Student", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Archive health", exact: true }).click();
  await page.getByRole("button", { name: "Verify archive" }).click();
  await expect(
    page.getByRole("heading", { name: "Every current record passed verification" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Lock archive" }).click();
  await expect(page.getByLabel("Archive passphrase")).toBeVisible();
  await expect(page.getByText("Interop Student", { exact: true })).toHaveCount(0);
});

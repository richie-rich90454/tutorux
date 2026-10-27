import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openArchiveBytes, verifyArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType } from "../../frontend/archive/format";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
});

test("reviews, saves, exports, and reopens a private manual AI package", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.getByLabel("Workspace name").fill("AI package QA");
  const initialDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await (await initialDownload).saveAs(info.outputPath("ai-initial.tux"));

  await page.getByRole("navigation").getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Session title").fill("Fractions review");
  await page.getByLabel("Subject", { exact: true }).fill("Mathematics");
  await page.getByLabel("Learning objective").fill("Compare equivalent fractions.");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(page.getByRole("heading", { name: "Fractions review" })).toBeVisible();

  await page.getByRole("navigation").getByRole("button", { name: "AI workspace" }).click();
  const sessionOption = page.getByRole("option", { name: /Fractions review/u });
  await page
    .getByLabel("Session to prepare")
    .selectOption((await sessionOption.getAttribute("value"))!);
  await page.getByRole("button", { name: "Prepare for review" }).click();
  await expect(page.getByRole("heading", { name: "Mathematics" })).toBeVisible();
  await expect(page.locator(".ai-message")).toContainText("Nothing has been sent or saved yet");

  const inspector = page.getByLabel("Complete AI package JSON");
  await page.getByText("Inspect the complete package JSON").click();
  await expect(inspector).toBeVisible();
  const packageText = await inspector.inputValue();
  const parsed = JSON.parse(packageText) as {
    manifest: { format: string; guide_template_id: string };
    session: { fields: Record<string, string> };
  };
  expect(parsed.manifest).toMatchObject({
    format: "tutorux-ai-package-v1",
    guide_template_id: "mathematics",
  });
  expect(parsed.session.fields["title"]).toBe("Fractions review");
  expect(page.getByRole("button", { name: "Save reviewed package" })).toBeDisabled();
  await page.getByRole("checkbox", { name: /I reviewed the package contents/u }).check();
  await page.getByRole("button", { name: "Save reviewed package" }).click();
  await expect(page.getByText(/Reviewed AI package saved in this archive/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Export JSON" })).toBeVisible();

  const packageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export JSON" }).click();
  const exported = await packageDownload;
  await exported.saveAs(info.outputPath("ai-package.json"));
  expect(JSON.parse(await readFile(info.outputPath("ai-package.json"), "utf8"))).toMatchObject({
    manifest: { format: "tutorux-ai-package-v1" },
  });

  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save archive" }).click();
  await (await archiveDownload).saveAs(info.outputPath("ai-saved.tux"));
  const archive = await openArchiveBytes(
    new Uint8Array(await readFile(info.outputPath("ai-saved.tux"))),
  );
  const verification = await verifyArchiveSnapshot(archive);
  expect(verification.currentRecords).toBeGreaterThanOrEqual(3);
  const [job] = await archive.listRecords(RecordType.aiJob);
  expect(job).toBeDefined();
  expect(job!.fields.get("status")).toBe("package-ready");
  expect(JSON.parse(new TextDecoder().decode(job!.blob))).toMatchObject({
    manifest: { format: "tutorux-ai-package-v1" },
  });
});

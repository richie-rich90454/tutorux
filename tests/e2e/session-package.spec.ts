import { expect, test } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
} from "../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { createSessionPackage } from "../../frontend/domain/session-packages";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
});

test("imports a portable session into the selected profile and exports it again", async ({
  page,
}, testInfo) => {
  const directory = testInfo.outputPath("session-package");
  const sourcePath = `${directory}/source.tux`;
  const packagePath = `${directory}/lesson-session.tux`;
  const destinationPath = `${directory}/destination.tux`;
  await mkdir(dirname(sourcePath), { recursive: true });

  const sourceStudentId = newUuid();
  const sourceSessionId = newUuid();
  const destinationStudentId = newUuid();
  const sourceBase = await openArchiveBytes(await createArchiveBytes("Package source"));
  const source = await appendRecords(sourceBase, [
    record(RecordType.student, sourceStudentId, { display_name: "Source learner private name" }),
    record(RecordType.session, sourceSessionId, {
      student_id: sourceStudentId,
      title: "Portable reading lesson",
      subject: "English",
      session_type: "notes-only",
      session_state: "completed",
    }),
  ]);
  await writeFile(sourcePath, await source.source.read(0n, Number(source.source.size)));

  const packageSnapshot = await createSessionPackage(source, sourceSessionId);
  await writeFile(
    packagePath,
    await packageSnapshot.source.read(0n, Number(packageSnapshot.source.size)),
  );
  packageSnapshot.lock();

  const destinationBase = await openArchiveBytes(await createArchiveBytes("Package destination"));
  const destination = await appendRecords(destinationBase, [
    record(RecordType.student, destinationStudentId, { display_name: "Destination learner" }),
  ]);
  await writeFile(
    destinationPath,
    await destination.source.read(0n, Number(destination.source.size)),
  );

  await page.goto("/");
  const archiveChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await archiveChooser).setFiles(destinationPath);
  await page.locator(".archive-status.is-open").waitFor();
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByLabel("Student for imported session").selectOption(destinationStudentId);

  const packageChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Import session package" }).click();
  await (await packageChooser).setFiles(packagePath);
  await expect(page.locator(".toast")).toContainText("Portable reading lesson");
  await expect(page.getByRole("heading", { name: "Portable reading lesson" })).toBeVisible();
  await expect(page.locator(".session-record")).toContainText("Destination learner");

  const packageDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export session package" }).click();
  const download = await packageDownload;
  expect(download.suggestedFilename()).toBe("Portable-reading-lesson-session.tux");
  const downloadPath = await download.path();
  if (!downloadPath) throw new Error("The session package export did not create a file.");
  const exported = await openArchiveBytes(new Uint8Array(await readFile(downloadPath)));
  const exportedManifest = await exported.getRecord(RecordType.settings, exported.header.id);
  expect(exportedManifest?.fields.get("record_role")).toBe("tutorux-session-package");
  expect(exportedManifest?.fields.get("source_session_id")).not.toBe(sourceSessionId);
  expect(exportedManifest?.fields.get("source_student_id")).toBe(destinationStudentId);
  const exportedSessions = await exported.listRecords(RecordType.session, true);
  expect(exportedSessions).toHaveLength(1);
  expect(exportedSessions[0]?.fields.get("student_id")).toBe("anonymous");
});

function record(type: number, id: string, fields: Record<string, string>): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob: new Uint8Array(),
  };
}

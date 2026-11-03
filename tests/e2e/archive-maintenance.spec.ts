import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import {
    addSession,
    addStudent,
    createArchive,
    installAppHarness,
    navigateToSidebarView,
} from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

test("verifies, compacts, rebuilds indexes, and creates repair and sanitized copies", async ({
    page,
}, testInfo) => {
    test.setTimeout(90_000);
    await createArchive(page, "Maintenance QA");
    await addStudent(page, "Maintenance Learner");
    await addSession(page, "Maintenance session", "Maintenance Learner");

    await navigateToSidebarView(page, "Archive health");
    await page.getByRole("button", { name: "Verify archive", exact: true }).click();
    await expect(
        page.getByRole("heading", { name: "Every current record passed verification" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Verify history" }).click();
    await expect(page.locator(".archive-integrity-copy")).toContainText("historical revisions");

    await page.getByRole("button", { name: "Review compaction" }).click();
    await expect(page.getByRole("heading", { name: "Compact archive" })).toBeVisible();
    await page.getByRole("button", { name: "Apply compaction", exact: true }).click();
    await expect(page.locator(".archive-maintenance").getByRole("status").first()).toContainText(
        "Changes are ready",
    );

    await page.getByRole("button", { name: "Review index updates" }).click();
    await expect(page.getByRole("heading", { name: "Update archive indexes" })).toBeVisible();
    await expect(page.locator(".archive-maintenance-review")).toContainText(
        "missing index entries can be added",
    );
    // A healthy archive already has every index entry, so there is nothing to apply.
    await page
        .locator(".archive-maintenance-review")
        .getByRole("button", { name: "Cancel", exact: true })
        .click();

    await page.getByRole("button", { name: "Review separate repair copy" }).click();
    await expect(
        page.getByRole("heading", { name: "Create a separate repaired archive" }),
    ).toBeVisible();
    await page
        .getByLabel(
            "I reviewed the destination and repair summary, and authorize creating a separate file that may contain student histories, recordings, private annotations, and provider data.",
        )
        .check();
    const repairDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create separate repair copy" }).click();
    const repairPath = testInfo.outputPath("repaired.tux");
    await (await repairDownload).saveAs(repairPath);
    expect((await readFile(repairPath)).subarray(0, 8).toString()).toBe("TUTORUX\u0000");

    // Sanitized copy: choose the browser download name, review, confirm, and create.
    await page.getByRole("button", { name: "Use this download name" }).click();
    await page.getByRole("button", { name: "Review copy contents" }).click();
    await expect(
        page.getByRole("heading", { name: "What the new archive will contain" }),
    ).toBeVisible();
    await page
        .getByLabel(
            "I reviewed these counts and confirm creating a separate archive file with this exact privacy selection.",
        )
        .check();
    const sanitizedDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create separate copy" }).click();
    const sanitizedPath = testInfo.outputPath("sanitized.tux");
    await (await sanitizedDownload).saveAs(sanitizedPath);
    expect((await readFile(sanitizedPath)).subarray(0, 8).toString()).toBe("TUTORUX\u0000");

    // Both copies are real archives: reopen the repaired copy and read its records.
    await page.reload();
    const chooser = page.waitForEvent("filechooser");
    await page
        .locator("#main-content")
        .getByRole("button", { name: "Open archive", exact: true })
        .click();
    await (await chooser).setFiles(repairPath);
    await expect(
        page.getByRole("heading", { name: "Teaching journal", exact: true }),
    ).toBeVisible();
    await navigateToSidebarView(page, "Students");
    await expect(page.getByRole("heading", { name: "Maintenance Learner" })).toBeVisible();
    await navigateToSidebarView(page, "Archive health");
    await page.getByRole("button", { name: "Verify archive", exact: true }).click();
    await expect(
        page.getByRole("heading", { name: "Every current record passed verification" }),
    ).toBeVisible();
});

test("encrypts, rotates the passphrase, locks, and reopens the archive", async ({
    page,
}, testInfo) => {
    test.setTimeout(90_000);
    await createArchive(page, "Encryption lifecycle");
    await addStudent(page, "Encrypted Learner");

    await navigateToSidebarView(page, "Preferences");
    await page.getByLabel("New passphrase").fill("first long passphrase");
    await page.getByLabel("Confirm passphrase").fill("first long passphrase");
    await page.getByRole("button", { name: "Enable encryption" }).click();
    await expect(page.getByText("Passphrase protection", { exact: true })).toBeVisible();
    await expect(page.getByText("Changes waiting to be saved")).toBeVisible();

    const firstSave = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save workspace" }).click();
    const firstPath = testInfo.outputPath("encrypted-first.tux");
    await (await firstSave).saveAs(firstPath);

    await navigateToSidebarView(page, "Archive health");
    await page.getByRole("button", { name: "Lock archive" }).click();
    await page.getByLabel("Archive passphrase").fill("first long passphrase");
    await page.getByRole("button", { name: "Unlock archive" }).click();
    await expect(page.getByLabel("Archive passphrase")).toHaveCount(0);

    await navigateToSidebarView(page, "Preferences");
    await page.getByRole("button", { name: "Change passphrase" }).click();
    await page.getByLabel("Current passphrase").fill("first long passphrase");
    await page.getByLabel("New passphrase", { exact: true }).fill("second long passphrase");
    await page.getByLabel("Confirm new passphrase").fill("second long passphrase");
    await page.getByRole("button", { name: "Change passphrase" }).last().click();
    await expect(page.getByText("Changes waiting to be saved")).toBeVisible();

    const secondSave = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save workspace" }).click();
    const secondPath = testInfo.outputPath("encrypted-second.tux");
    await (await secondSave).saveAs(secondPath);

    await page.reload();
    const chooser = page.waitForEvent("filechooser");
    await page
        .locator("#main-content")
        .getByRole("button", { name: "Open archive", exact: true })
        .click();
    await (await chooser).setFiles(secondPath);
    await page.getByLabel("Archive passphrase").fill("first long passphrase");
    await page.getByRole("button", { name: "Unlock archive" }).click();
    await expect(page.getByRole("alert")).toContainText("Passphrase is incorrect");
    await page.getByLabel("Archive passphrase").fill("second long passphrase");
    await page.getByRole("button", { name: "Unlock archive" }).click();
    await expect(page.getByLabel("Archive passphrase")).toHaveCount(0);
    await navigateToSidebarView(page, "Students");
    await expect(page.getByRole("heading", { name: "Encrypted Learner" })).toBeVisible();
});

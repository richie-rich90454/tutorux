import { expect, test } from "@playwright/test";
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

test("renders dates and counts with en-US wording", async ({ page }) => {
    await createArchive(page, "Locale QA");
    await addStudent(page, "Locale Learner");
    await addSession(page, "Locale check session", "Locale Learner");

    await navigateToSidebarView(page, "Journal");
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page.getByLabel("Entry title").fill("Locale check entry");
    await page.getByLabel("Journal entry date").fill("2026-11-01");
    await page.getByLabel("Reflection").fill("Checking the rendered locale.");
    await page.getByRole("button", { name: "Save entry", exact: true }).click();

    const card = page
        .locator(".record-list-journal .journal-record-card")
        .filter({ has: page.getByRole("heading", { name: "Locale check entry" }) });
    await expect(card).toBeVisible();
    await expect(card.locator(".journal-date small")).toHaveText(/nov/iu);

    const pageText = await page.locator("#main-content").innerText();
    expect(pageText).not.toContain("11月");
    expect(pageText).not.toContain("2026年");

    await navigateToSidebarView(page, "Students");
    const toolbar = page.locator(".record-list-toolbar");
    await expect(toolbar).toContainText("1 student");
    await expect(toolbar).not.toContainText("1 students");

    const history = page.locator(".student-history");
    await history.locator("summary").click();
    const counts = history.locator(".student-history-counts");
    await expect(counts).toContainText("1 session");
    await expect(counts).not.toContainText("1 sessions");
});

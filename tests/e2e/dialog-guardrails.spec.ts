import { expect, test } from "@playwright/test";
import { createArchive, installAppHarness, navigateToSidebarView } from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

test("keeps the quick-action palette closed while a form dialog is open", async ({ page }) => {
    await createArchive(page, "Guardrail QA");

    await navigateToSidebarView(page, "Students");
    await page.getByRole("button", { name: "Add student", exact: true }).click();
    const studentDialog = page.getByRole("dialog").filter({ has: page.getByLabel("Student name") });
    await expect(studentDialog).toBeVisible();

    await studentDialog.getByRole("button", { name: "Add student", exact: true }).focus();
    await page.keyboard.press("Control+k");

    await expect(page.getByRole("dialog", { name: "Quick actions" })).toHaveCount(0);
    await expect(page.getByLabel("Student name")).toBeVisible();
});

test("closes only the date calendar when Escape is pressed inside the picker", async ({ page }) => {
    await createArchive(page, "Date Guardrail QA");

    await navigateToSidebarView(page, "Journal");
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    const entryDialog = page.getByRole("dialog").filter({ has: page.getByLabel("Entry title") });
    await expect(entryDialog).toBeVisible();

    await entryDialog.getByRole("button", { name: "Choose date", exact: true }).click();
    const calendar = page.getByRole("dialog", { name: "Choose date", exact: true });
    await expect(calendar).toBeVisible();

    await expect
        .poll(() =>
            calendar
                .locator(".date-picker-weekdays")
                .evaluate(
                    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
                ),
        )
        .toBe(7);
    await expect(calendar.locator(".date-picker-days button")).toHaveCount(42);
    await expect
        .poll(() =>
            calendar
                .getByRole("button", { name: "Previous month" })
                .locator("svg")
                .evaluate((element) => getComputedStyle(element).rotate),
        )
        .not.toBe("none");
    await expect
        .poll(() =>
            calendar
                .locator(".date-picker-calendar-heading")
                .evaluate(
                    (element) => getComputedStyle(element).gridTemplateColumns.split(" ").length,
                ),
        )
        .toBe(3);

    await page.keyboard.press("Escape");

    await expect(calendar).toBeHidden();
    await expect(entryDialog).toBeVisible();
    await expect(page.getByLabel("Entry title")).toBeVisible();
});

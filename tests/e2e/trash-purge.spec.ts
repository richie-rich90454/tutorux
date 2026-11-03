import { expect, test } from "./fixtures";
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

test("reviews, cancels, and permanently purges trashed records", async ({ page }) => {
    test.setTimeout(60_000);
    await createArchive(page, "Trash purge QA");
    await addStudent(page, "Purge Learner");
    await addSession(page, "Purge session", "Purge Learner");

    await navigateToSidebarView(page, "Observations");
    await page.getByRole("button", { name: "Add observation", exact: true }).click();
    await page.getByRole("textbox", { name: "Title optional" }).fill("Purge observation");
    await page.getByRole("textbox", { name: "Observation", exact: true }).fill("Purge note");
    await page.getByRole("button", { name: "Save observation", exact: true }).click();
    await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
    await page
        .getByRole("alertdialog", { name: "Move observation to Trash?" })
        .getByRole("button", { name: "Move to Trash" })
        .click();

    await navigateToSidebarView(page, "Sessions");
    await page.getByRole("button", { name: /Review moving Purge session/u }).click();
    const sessionDialog = page.getByRole("alertdialog", { name: "Move this session to Trash?" });
    await expect(sessionDialog).toContainText("records affected");
    await sessionDialog.getByRole("button", { name: "Move session group to Trash" }).click();

    await navigateToSidebarView(page, "Students");
    await page.getByRole("button", { name: "Move Purge Learner to Trash" }).click();
    await page
        .getByRole("alertdialog", { name: "Move student to Trash?" })
        .getByRole("button", { name: "Move to Trash" })
        .click();

    await navigateToSidebarView(page, "Trash");
    await expect(page.getByText("Purge Learner", { exact: true })).toBeVisible();
    await expect(page.getByText("Purge session", { exact: true })).toBeVisible();
    await expect(page.getByText("Purge observation", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Permanently purge Trash" }).click();
    const review = page.getByLabel("Permanent Trash purge review");
    await expect(review).toContainText("Review permanent purge");
    await review.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(review).toHaveCount(0);

    await page.getByRole("button", { name: "Permanently purge Trash" }).click();
    const confirm = page.getByLabel("Permanent Trash purge review");
    await expect(confirm).toBeVisible();
    const purgeButton = confirm.getByRole("button", { name: /Permanently purge [\d,]+ records/u });
    await expect(purgeButton).toBeEnabled();
    await purgeButton.click();
    await expect(page.getByText("Trash is empty", { exact: true })).toBeVisible();
    await expect(page.getByText("Purge Learner", { exact: true })).toHaveCount(0);
});

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

test("creates sessions from journal entries and restores a trashed entry group", async ({
    page,
}) => {
    test.setTimeout(60_000);
    await createArchive(page, "Journal relations QA");
    await addStudent(page, "Connections Learner");
    await addSession(page, "Connections session", "Connections Learner");
    await navigateToSidebarView(page, "Journal");

    const newEntry = async (title: string, body: string): Promise<void> => {
        await page.getByRole("button", { name: "New entry", exact: true }).click();
        await page.getByLabel("Entry title").fill(title);
        await page.getByLabel("Reflection").fill(body);
        await page.getByRole("button", { name: "Save entry" }).click();
        await expect(page.getByRole("heading", { name: title })).toBeVisible();
    };
    await newEntry("Entry with a new session", "The session starts from this reflection.");
    await newEntry("Entry to remove", "This entry will move to Trash.");

    const entryCard = page
        .locator(".journal-record-card")
        .filter({ has: page.getByRole("heading", { name: "Entry with a new session" }) });
    await entryCard.getByRole("button", { name: "Connections", exact: true }).click();
    const relations = entryCard.locator(".journal-relations-content");
    await relations.getByLabel("Session title").fill("Session born from a journal entry");
    await relations.getByLabel("Student").selectOption({ label: "Connections Learner" });
    await relations.getByLabel("Subject").fill("Mathematics");
    await relations.getByLabel("Learning objectives").fill("Connect reflections to practice.");
    await relations.getByRole("button", { name: "Create session" }).click();
    await expect(page.locator(".toast")).toContainText("Session");

    await navigateToSidebarView(page, "Sessions");
    await expect(
        page.getByRole("heading", { name: "Session born from a journal entry" }),
    ).toBeVisible();

    await navigateToSidebarView(page, "Journal");
    const removable = page
        .locator(".journal-record-card")
        .filter({ has: page.getByRole("heading", { name: "Entry to remove" }) });
    await removable.getByRole("button", { name: "Connections", exact: true }).click();
    await removable
        .getByLabel(
            "Move this entry and its notes to recoverable Trash. The group can be restored later.",
        )
        .check();
    await removable.getByRole("button", { name: "Move entry to Trash" }).click();
    await expect(page.getByRole("heading", { name: "Entry to remove" })).toHaveCount(0);

    await navigateToSidebarView(page, "Trash");
    await expect(page.getByText("Entry to remove", { exact: true })).toBeVisible();
    await page
        .locator(".trash-record")
        .filter({ hasText: "Entry to remove" })
        .getByRole("button", { name: "Restore", exact: true })
        .click();
    await navigateToSidebarView(page, "Journal");
    await expect(page.getByRole("heading", { name: "Entry to remove" })).toBeVisible();
    await page
        .locator(".journal-record-card")
        .filter({ has: page.getByRole("heading", { name: "Entry to remove" }) })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    await expect(page.getByLabel("Reflection", { exact: true })).toHaveValue(
        "This entry will move to Trash.",
    );
});

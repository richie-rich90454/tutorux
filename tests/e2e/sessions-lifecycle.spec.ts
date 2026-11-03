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

test("moves a session through its lifecycle, archives, duplicates, and restores details", async ({
    page,
}) => {
    test.setTimeout(60_000);
    await createArchive(page, "Session lifecycle QA");
    await addStudent(page, "Session Learner");
    await addSession(page, "Lifecycle session", "Session Learner");
    await navigateToSidebarView(page, "Sessions");

    const row = page.locator(".session-record").filter({ hasText: "Lifecycle session" }).first();
    const status = row.locator(".session-state");
    const clickIfPresent = async (name: string): Promise<void> => {
        const button = row.getByRole("button", { name, exact: true });
        if ((await button.count()) > 0) await button.click();
    };
    await clickIfPresent("Start");
    await clickIfPresent("Complete");
    await expect(status).toHaveText("completed");
    await clickIfPresent("Review");
    await expect(status).toHaveText("reviewed");
    await clickIfPresent("Resume");
    await expect(status).toHaveText(/active|in-progress/u);

    await row.getByRole("button", { name: "Duplicate", exact: true }).click();
    const duplicate = page
        .locator(".session-record")
        .filter({ hasText: /Lifecycle session \(copy\)/u });
    await expect(duplicate).toBeVisible();

    await row.getByRole("button", { name: "Archive", exact: true }).click();
    await page.getByRole("button", { name: "Archived 1", exact: true }).click();
    const archived = page.locator(".session-record").filter({ hasText: "Lifecycle session" });
    await expect(archived.getByRole("button", { name: "Unarchive" })).toBeVisible();
    await archived.getByRole("button", { name: "Unarchive" }).click();
    await page.getByRole("button", { name: "Current 2", exact: true }).click();

    const active = page.locator(".session-record").filter({ hasText: "Lifecycle session" }).first();
    await active.getByRole("button", { name: "Notebook", exact: true }).click();
    await page.getByLabel("Session title").fill("Renamed lifecycle session");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Renamed lifecycle session" })).toBeVisible();

    const renamed = page
        .locator(".session-record")
        .filter({ hasText: "Renamed lifecycle session" })
        .first();
    await renamed.getByText("Session versions").click();
    await expect(renamed).toContainText("Earlier version");
    await renamed.getByRole("button", { name: "Restore these details" }).click();
    await renamed.getByRole("button", { name: "Confirm restore" }).click();
    await expect(
        page.getByRole("heading", { name: "Lifecycle session", exact: true }),
    ).toBeVisible();
});

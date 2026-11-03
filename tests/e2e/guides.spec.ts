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

test("generates, approves, regenerates, versions, duplicates, and trashes guides", async ({
    page,
}) => {
    test.setTimeout(60_000);
    await createArchive(page, "Guide lifecycle QA");
    await addStudent(page, "Guide Learner");
    await addSession(page, "Guides session", "Guide Learner");
    await navigateToSidebarView(page, "Sessions");
    await page.getByRole("button", { name: "Notebook", exact: true }).click();
    await page
        .getByLabel("Session notes", { exact: true })
        .fill("Guide Learner compared equivalent fractions with a number line.");
    await page.getByRole("button", { name: "Save changes" }).click();

    await navigateToSidebarView(page, "Journal");
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page.getByLabel("Entry title").fill("Guide journal source");
    await page.getByLabel("Reflection").fill("A journal source for guide generation.");
    await page.getByRole("button", { name: "Save entry" }).click();

    await navigateToSidebarView(page, "Study guides");
    await page.getByRole("button", { name: "Generate from a session" }).click();
    const generation = page.getByRole("dialog", { name: "Generate a study guide" });
    await generation.getByRole("combobox").nth(1).selectOption({ label: "Guides session" });
    await generation.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByLabel("Guide title")).toHaveValue(/Guides session/u);
    await page.getByRole("button", { name: "Save draft" }).click();

    const guideCard = page
        .locator(".guide-record-card")
        .filter({ hasText: "Guides session" })
        .first();
    await expect(guideCard).toBeVisible();
    await expect(guideCard.getByText("draft", { exact: true })).toBeVisible();

    await guideCard.getByRole("button", { name: "Approve" }).click();
    await expect(guideCard.getByText("approved", { exact: true })).toBeVisible();

    await guideCard.getByText("More", { exact: true }).click();
    await guideCard.getByRole("button", { name: "Regenerate from latest evidence" }).click();
    const regeneration = page.getByRole("dialog", { name: "Regenerate a study guide" });
    await regeneration.getByRole("button", { name: "Generate draft" }).click();
    await page.getByLabel("Guide title").fill("Regenerated knowledge guide");
    await page.getByRole("button", { name: /^Save (draft|changes)$/u }).click();
    await expect(page.getByRole("heading", { name: "Regenerated knowledge guide" })).toBeVisible();

    const regenerated = page
        .locator(".guide-record-card")
        .filter({ hasText: "Regenerated knowledge guide" });
    await regenerated.getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Guide title").fill("Edited knowledge guide");
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("heading", { name: "Edited knowledge guide" })).toBeVisible();

    const edited = page.locator(".guide-record-card").filter({ hasText: "Edited knowledge guide" });
    await edited.getByText("Guide versions").click();
    await expect(edited).toContainText("Earlier version");
    await edited.getByRole("button", { name: "Restore this version" }).click();
    await edited.getByRole("button", { name: "Confirm restore" }).click();
    await expect(page.getByRole("heading", { name: "Regenerated knowledge guide" })).toBeVisible();

    const restored = page
        .locator(".guide-record-card")
        .filter({ hasText: "Regenerated knowledge guide" });
    await restored.getByRole("button", { name: "Duplicate" }).click();
    await expect(
        page.getByRole("heading", { name: "Regenerated knowledge guide (copy)" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Generate from a journal entry" }).click();
    const entryGeneration = page.getByRole("dialog", { name: "Generate a study guide" });
    await entryGeneration
        .getByRole("combobox")
        .nth(1)
        .selectOption({ label: "Guide journal source" });
    await entryGeneration.getByRole("button", { name: "Generate draft" }).click();
    await expect(page.getByLabel("Guide title")).toHaveValue(/Guide journal source/u);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("heading", { name: /Guide journal source/u })).toBeVisible();

    const journalGuide = page
        .locator(".guide-record-card")
        .filter({ hasText: "Guide journal source" })
        .first();
    await journalGuide.getByRole("button", { name: /Move .* to Trash/u }).click();
    await navigateToSidebarView(page, "Trash");
    await expect(page.getByText(/Guide journal source/u, { exact: false })).toBeVisible();
    await page
        .locator(".trash-record")
        .filter({ hasText: "Guide journal source" })
        .getByRole("button", { name: "Restore", exact: true })
        .click();
    await navigateToSidebarView(page, "Study guides");
    await expect(page.getByRole("heading", { name: /Guide journal source/u })).toBeVisible();
});

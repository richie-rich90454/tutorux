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

test("duplicates, splits, merges, links, and re-prioritises observations", async ({ page }) => {
    test.setTimeout(60_000);
    await createArchive(page, "Observation lifecycle QA");
    await addStudent(page, "Observation Learner");
    await addSession(page, "Observation session", "Observation Learner");

    await navigateToSidebarView(page, "Materials");
    await page
        .getByLabel("Session for imported material")
        .selectOption({ label: "Observation session" });
    await page.getByLabel("Choose materials to import").setInputFiles({
        name: "observation-source.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("Observation source material", "utf8"),
    });
    await page.getByText("observation-source.txt", { exact: true }).waitFor();

    await navigateToSidebarView(page, "Observations");
    await expect(
        page.getByRole("combobox", { name: "Choose a session for observations" }),
    ).toContainText("Observation session");

    const addObservation = async (title: string, content: string): Promise<void> => {
        await page.getByRole("button", { name: "Add observation", exact: true }).click();
        await page.getByRole("textbox", { name: "Title optional" }).fill(title);
        await page.getByRole("textbox", { name: "Observation", exact: true }).fill(content);
        await page.getByRole("button", { name: "Save observation", exact: true }).click();
        await expect(page.getByRole("heading", { name: title })).toBeVisible();
    };
    await addObservation("Split this observation", "First half. Second half.");
    await addObservation("Merge this observation", "Another observation body.");

    const cards = page.locator(".annotation-card");
    const first = cards.filter({ hasText: "Split this observation" });
    const second = cards.filter({ hasText: "Merge this observation" });

    await second.getByRole("button", { name: "Duplicate" }).click();
    await expect(page.getByRole("heading", { name: "Merge this observation" })).toHaveCount(2);

    await first.getByRole("button", { name: "Split", exact: true }).click();
    const splitPanel = first.getByLabel("Split observation");
    await splitPanel
        .getByLabel("Select the split position in the observation text")
        .evaluate((element) => {
            const textarea = element as HTMLTextAreaElement;
            textarea.setSelectionRange(10, 10);
            textarea.dispatchEvent(new Event("select", { bubbles: true }));
        });
    await expect(splitPanel).toContainText("Split after character 10");
    await splitPanel.getByRole("button", { name: "Split observation" }).click();
    await expect(page.getByRole("heading", { name: "Split this observation" })).toHaveCount(2);

    const splittable = page.locator(".annotation-card").filter({ hasText: "Split this" });
    await splittable.nth(0).getByLabel("Select observation for merging").check();
    await splittable.nth(1).getByLabel("Select observation for merging").check();
    await page.getByRole("button", { name: "Merge selected" }).click();
    await expect(page.locator(".annotation-card").filter({ hasText: "Split this" })).toHaveCount(1);
    await expect(page.locator(".annotation-card").filter({ hasText: "First half" })).toContainText(
        "Second half.",
    );

    const linked = page.locator(".annotation-card").filter({ hasText: "Split this" });
    await linked.getByRole("button", { name: "Links", exact: true }).click();
    await linked
        .getByLabel("Linked records")
        .getByRole("checkbox", { name: "observation-source.txt" })
        .click();
    if ((await linked.getByLabel("Linked records").count()) === 0) {
        await linked.getByRole("button", { name: "Links", exact: true }).click();
    }
    await expect(
        linked
            .getByLabel("Linked records")
            .getByRole("checkbox", { name: "observation-source.txt" }),
    ).toBeChecked();

    const priority = page
        .locator(".annotation-card")
        .filter({ hasText: "Merge this observation" })
        .first();
    await priority.getByRole("combobox", { name: "Priority" }).selectOption("high");
    await expect(priority.locator(".annotation-priority")).toContainText("high");
});

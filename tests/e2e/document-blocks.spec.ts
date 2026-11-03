import { expect, test, type Page } from "@playwright/test";
import { createArchive, installAppHarness } from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
    await createArchive(page, "Document block layout");
});

async function openEntryEditor(page: Page): Promise<void> {
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "New journal entry" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".document-block-actions")).toBeVisible();
}

for (const width of [1440, 390]) {
    test(`keeps block actions inside their buttons at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await openEntryEditor(page);

        const split = page.getByRole("button", { name: "Split block 1 at cursor" });
        const merge = page.getByRole("button", { name: "Merge block 1 with next" });
        await expect(split).toBeVisible();
        await expect(merge).toBeVisible();

        for (const button of [split, merge]) {
            const overflow = await button.evaluate(
                (element) => element.scrollWidth - element.clientWidth,
            );
            expect(overflow).toBeLessThanOrEqual(1);
        }

        const splitBox = await split.boundingBox();
        const mergeBox = await merge.boundingBox();
        if (!splitBox || !mergeBox) throw new Error("Block action buttons were not laid out.");
        expect(splitBox.x + splitBox.width).toBeLessThanOrEqual(mergeBox.x + 0.5);

        const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
    });
}

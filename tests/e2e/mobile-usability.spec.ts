import { expect, test } from "./fixtures";
import { createArchive, installAppHarness } from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

const viewports = [
    { width: 390, height: 844 },
    { width: 650, height: 900 },
    { width: 820, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
];

test("creates an archive from the welcome screen and keeps the workspace usable at every width", async ({
    page,
}) => {
    for (const viewport of viewports) {
        await page.setViewportSize(viewport);
        await createArchive(page, `Responsive QA ${viewport.width}`);

        const layout = await page.evaluate(() => {
            const main = document.querySelector<HTMLElement>("#main-content");
            const body = document.querySelector<HTMLElement>("#main-content .page-body");
            return {
                main: main?.getBoundingClientRect().width ?? 0,
                body: body?.getBoundingClientRect().width ?? 0,
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
            };
        });

        expect(layout.main, `#main-content width at ${viewport.width}px`).toBeGreaterThan(300);
        expect(layout.body, `.page-body width at ${viewport.width}px`).toBeGreaterThan(300);
        expect(
            layout.documentWidth,
            `horizontal overflow at ${viewport.width}px`,
        ).toBeLessThanOrEqual(layout.viewportWidth + 1);

        const primary = page
            .locator("#main-content")
            .getByRole("button", { name: "New entry", exact: true });
        await expect(primary).toBeVisible();
        await expect(primary).toBeEnabled();
        const box = await primary.boundingBox();
        expect(box?.width ?? 0).toBeGreaterThan(40);
        expect(box?.height ?? 0).toBeGreaterThan(24);

        await primary.click();
        await expect(page.getByLabel("Entry title")).toBeVisible();
        const entryDialog = page.getByRole("dialog", { name: "New journal entry" });
        if (viewport.width === 390) {
            await entryDialog.getByRole("button", { name: "Choose date", exact: true }).click();
            const calendar = page.getByRole("dialog", { name: "Choose date", exact: true });
            await expect(calendar).toBeVisible();
            const calendarBox = await calendar.boundingBox();
            expect(calendarBox?.x ?? -1).toBeGreaterThanOrEqual(0);
            expect((calendarBox?.x ?? 0) + (calendarBox?.width ?? 0)).toBeLessThanOrEqual(391);
            await page.keyboard.press("Escape");
        }
        await entryDialog.getByRole("button", { name: "Cancel", exact: true }).click();
        await expect(page.getByLabel("Entry title")).toBeHidden();
    }
});

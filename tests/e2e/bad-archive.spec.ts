import { expect, test } from "./fixtures";
import { installAppHarness } from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

test("rejects a file that is not an archive and stays on the welcome screen", async ({ page }) => {
    const bytes = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 11) & 0xff);

    await page.goto("/");
    await expect(
        page.getByRole("heading", { name: "Open or create an archive", exact: true }),
    ).toBeVisible();

    const chooser = page.waitForEvent("filechooser");
    await page
        .locator("#main-content")
        .getByRole("button", { name: "Open archive", exact: true })
        .click();
    const fileChooser = await chooser;
    await fileChooser.setFiles({
        name: "random-bytes.tux",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(bytes),
    });

    await expect(
        page.getByRole("status").filter({ hasText: "File is not a Tutorux archive." }),
    ).toBeVisible();
    await expect(
        page.getByRole("heading", { name: "Open or create an archive", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".sidebar-archive-status")).toHaveCount(0);
});

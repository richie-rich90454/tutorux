import { expect, test } from "./fixtures";
import { createArchive, installAppHarness, navigateToSidebarView } from "./helpers/app";

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

test("edits blocks, formats, finds, replaces, undoes, and exports journal notes", async ({
    page,
}, testInfo) => {
    test.setTimeout(60_000);
    await createArchive(page, "Document editor QA");
    await navigateToSidebarView(page, "Journal");
    await page.getByRole("button", { name: "New entry", exact: true }).click();
    await page.getByLabel("Entry title").fill("Document editor entry");
    await page.getByLabel("Reflection").fill("Alpha beta beta. The learner explained the pattern.");

    for (const kind of ["heading", "checklist", "quote", "code"]) {
        await page.getByLabel("New block type").selectOption(kind);
        await page.getByRole("button", { name: "Add block", exact: true }).click();
    }
    await page.getByLabel("Reflection block 2").fill("Patterns to revisit");
    await page.getByLabel("Reflection block 3").fill("[ ] Recheck equivalent fractions");
    await page.getByLabel("Reflection block 4").fill("A useful question stays open.");
    await page.getByLabel("Reflection block 5").fill("const ratio = 3 / 4;");

    // Move and split blocks, then merge the split halves.
    await page.getByRole("button", { name: "Move block 5 up" }).click();
    await expect(page.getByLabel("Reflection block 4")).toHaveValue("const ratio = 3 / 4;");
    await page.getByRole("button", { name: "Move block 4 down" }).click();
    await expect(page.getByLabel("Reflection block 5")).toHaveValue("const ratio = 3 / 4;");
    await page.getByLabel("Reflection block 2").click();
    await page.getByLabel("Reflection block 2").press("Control+End");
    await page.getByRole("button", { name: "Split block 2 at cursor" }).click();
    await page.getByLabel("Reflection block 2").fill("Patterns");
    await page.getByRole("button", { name: "Merge block 2 with next" }).click();

    await page.getByRole("button", { name: "Find", exact: true }).click();
    const search = page.getByRole("search", { name: "Find and replace in notes" });
    await search.getByLabel("Find", { exact: true }).fill("beta");
    await expect(search).toContainText("2 matches");
    await search.getByLabel("Replace with").fill("gamma");
    await search.getByRole("button", { name: "Replace", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Reflection", exact: true })).toHaveValue(
        /gamma beta/u,
    );
    await search.getByRole("button", { name: "Replace all", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Reflection", exact: true })).toHaveValue(
        /gamma gamma/u,
    );
    await search.getByRole("button", { name: "Close find and replace" }).click();

    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.getByRole("button", { name: "Redo", exact: true }).click();
    await page.getByRole("button", { name: "Save entry" }).click();
    await expect(page.getByRole("heading", { name: "Document editor entry" })).toBeVisible();

    // Reopen the entry and export the document in every available format.
    await page
        .locator(".journal-record-card")
        .filter({ has: page.getByRole("heading", { name: "Document editor entry" }) })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
    await expect(page.getByLabel("Reflection block 2")).toHaveValue("Patterns");
    const exportFile = async (label: string, path: string): Promise<void> => {
        const menu = page.locator("details.document-export-menu");
        if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) {
            await menu.locator("summary").click();
        }
        const download = page.waitForEvent("download");
        await menu.getByRole("button", { name: label, exact: true }).click();
        await (await download).saveAs(path);
    };
    await exportFile("Markdown", testInfo.outputPath("notes.md"));
    await exportFile("HTML", testInfo.outputPath("notes.html"));
    await exportFile("Word document", testInfo.outputPath("notes.docx"));

    await page.evaluate(() => {
        window.print = () => undefined;
    });
    const menu = page.locator("details.document-export-menu");
    if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) {
        await menu.locator("summary").click();
    }
    await menu.getByRole("button", { name: "PDF / Print", exact: true }).click();
    await expect(page.locator("html")).toHaveClass(/note-printing/u);
    await expect(page.locator(".note-print-preview")).toHaveCount(1);
    await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator(".note-print-preview")).toHaveCount(0);
    await page.getByRole("button", { name: "Close", exact: true }).click();
});

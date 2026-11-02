import { expect, type Page } from "@playwright/test";

/** Serve the built preview through Playwright and disable native file pickers. */
export async function installAppHarness(page: Page): Promise<void> {
    await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.hostname !== "127.0.0.1" || requestUrl.port !== "1420") {
            await route.continue();
            return;
        }
        const response = await fetch(requestUrl);
        await route.fulfill({
            status: response.status,
            contentType: response.headers.get("content-type") ?? "application/octet-stream",
            body: Buffer.from(await response.arrayBuffer()),
        });
    });
    await page.addInitScript(() => {
        Object.defineProperty(window, "showOpenFilePicker", {
            configurable: true,
            value: undefined,
        });
        Object.defineProperty(window, "showSaveFilePicker", {
            configurable: true,
            value: undefined,
        });
    });
}

export async function createArchive(page: Page, name: string): Promise<void> {
    await page.goto("/");
    await page
        .locator("#main-content")
        .getByRole("button", { name: "Create archive", exact: true })
        .click();
    await page.getByLabel("Workspace name").fill(name);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create workspace", exact: true }).click();
    await download;
    await expect(
        page.getByRole("heading", { name: "Teaching journal", exact: true }),
    ).toBeVisible();
}

export async function navigateToSidebarView(page: Page, label: string): Promise<void> {
    const navigation = page.getByRole("navigation", { name: "Primary navigation" });
    const more = navigation.getByRole("button", { name: "More workspaces", exact: true });
    const menu = page.getByRole("menu", { name: "More workspaces" });
    if (await menu.isVisible().catch(() => false)) await more.click();

    const primaryItem = navigation.getByRole("button", { name: label, exact: true });
    if ((await primaryItem.count()) > 0) {
        await primaryItem.click();
        return;
    }

    await more.click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
}

export async function addStudent(page: Page, name: string): Promise<void> {
    await navigateToSidebarView(page, "Students");
    await page.getByRole("button", { name: "Add student", exact: true }).click();
    await page.getByLabel("Student name").fill(name);
    await page.getByRole("button", { name: "Add student", exact: true }).last().click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}

export async function addSession(page: Page, title: string, studentName: string): Promise<void> {
    await navigateToSidebarView(page, "Sessions");
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Session title").fill(title);
    await page.locator('select[name="student"]').selectOption({ label: studentName });
    await page.getByRole("button", { name: "Save session", exact: true }).click();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
}

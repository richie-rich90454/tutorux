import { expect, test } from "@playwright/test";
import { collectActionInventory } from "./helpers/action-inventory";
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

const expectedPrimaryActions: Record<string, string[]> = {
    Journal: ["New entry"],
    Students: ["Add student"],
    Sessions: ["New session"],
    Materials: ["Choose materials to import"],
    Observations: ["Add observation"],
    Record: ["New session"],
    "AI workspace": ["Test provider connection"],
    "Study guides": ["Manage templates"],
    Evidence: ["Extract session evidence"],
    Trash: ["Permanently purge Trash"],
    "Archive health": ["Verify archive"],
    Preferences: ["Color theme"],
};

test("each workspace exposes its enabled primary actions", async ({ page }) => {
    await createArchive(page, "Action inventory QA");
    await addStudent(page, "Inventory Learner");
    await addSession(page, "Inventory session", "Inventory Learner");

    for (const [workspace, actions] of Object.entries(expectedPrimaryActions)) {
        await navigateToSidebarView(page, workspace);
        await page.locator("#main-content .page-body").first().waitFor({ state: "visible" });
        const inventory = await collectActionInventory(page);

        expect(inventory.all.length, `${workspace} exposes enabled controls`).toBeGreaterThan(0);
        for (const action of actions) {
            expect(inventory.all, `${workspace} primary action: ${action}`).toContain(action);
        }
    }
});

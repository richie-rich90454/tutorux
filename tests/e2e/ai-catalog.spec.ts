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

const catalog = {
    openai: {
        name: "OpenAI",
        models: {
            "gpt-5": {
                id: "gpt-5",
                tool_call: true,
                limit: { context: 200_000, output: 100_000 },
                modalities: { input: ["text", "image"], output: ["text"] },
                cost: { input: 1.25, output: 10 },
            },
            "gpt-5-mini": {
                id: "gpt-5-mini",
                tool_call: false,
                limit: { context: 100_000, output: 20_000 },
                modalities: { input: ["text"], output: ["text"] },
            },
        },
    },
};

test("browses, filters, selects, and recovers from a failed model catalog", async ({ page }) => {
    test.setTimeout(60_000);
    await createArchive(page, "AI catalog QA");
    await addStudent(page, "Catalog Learner");
    await addSession(page, "Catalog session", "Catalog Learner");
    await navigateToSidebarView(page, "AI workspace");

    await page.getByLabel("AI provider").selectOption("openai");
    await page.route("https://models.dev/api.json", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(catalog),
        });
    });
    await page.getByRole("button", { name: "Browse models" }).click();
    const modelList = page.getByLabel("Public provider models");
    await expect(modelList.getByRole("option")).toHaveCount(2);
    await expect(
        page.getByRole("status").filter({ hasText: "2 public model records" }).first(),
    ).toBeVisible();

    await page.getByPlaceholder("Search model, publisher, or tokenizer").fill("mini");
    await expect(modelList.getByRole("option")).toHaveCount(1);
    await modelList.getByRole("option").click();
    await expect(page.getByLabel("AI model ID")).toHaveValue("gpt-5-mini");
    await expect(
        page.getByRole("status").filter({ hasText: "gpt-5-mini selected" }).first(),
    ).toBeVisible();

    await page.getByPlaceholder("Search model, publisher, or tokenizer").fill("no such model");
    await expect(page.getByText("No models match these filters.")).toBeVisible();

    // The catalog is cached, so a later failure keeps the last good records.
    await page.unroute("https://models.dev/api.json");
    await page.route("https://models.dev/api.json", async (route) => {
        await route.fulfill({ status: 500, body: "unavailable" });
    });
    await page.getByPlaceholder("Search model, publisher, or tokenizer").fill("");
    await page.getByRole("button", { name: "Close catalog" }).click();
    await page.getByLabel("AI provider").selectOption("anthropic");
    await page.getByRole("button", { name: "Browse models" }).click();
    await expect(
        page.getByRole("status").filter({ hasText: "Manual model ID entry remains available" }),
    ).toBeVisible();
});

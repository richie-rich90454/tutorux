import { expect, test } from "./fixtures";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
    addSession,
    addStudent,
    createArchive,
    installAppHarness,
    navigateToSidebarView,
} from "./helpers/app";

const fixture = (name: string): string =>
    fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

test.beforeEach(async ({ page }) => {
    await installAppHarness(page);
});

test("previews, exports, edits, moves, and trashes imported materials", async ({ page }) => {
    await createArchive(page, "Material lifecycle QA");
    await addStudent(page, "Material Learner");
    await addSession(page, "Material session", "Material Learner");
    await navigateToSidebarView(page, "Materials");
    await page
        .getByLabel("Session for imported material")
        .selectOption({ label: "Material session" });

    const image = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
    );
    await page.getByLabel("Choose materials to import").setInputFiles([
        {
            name: "worksheet.txt",
            mimeType: "text/plain",
            buffer: Buffer.from("Balance the equation before dividing.", "utf8"),
        },
        { name: "diagram.png", mimeType: "image/png", buffer: image },
        {
            name: "lesson-tone.mp3",
            mimeType: "audio/mpeg",
            buffer: await readFile(fixture("tone-997hz.mp3")),
        },
    ]);
    await expect(page.getByText("worksheet.txt", { exact: true })).toBeVisible();
    await expect(page.getByText("diagram.png", { exact: true })).toBeVisible();
    await expect(page.getByText("lesson-tone.mp3", { exact: true })).toBeVisible();

    // Library filtering separates the linked session from the general library.
    await page.getByLabel("Show materials for").selectOption({ label: "Material session" });
    await expect(page.getByText("worksheet.txt", { exact: true })).toBeVisible();
    await page.getByLabel("Show materials for").selectOption({ label: "General library" });
    await expect(page.getByText("worksheet.txt", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No materials in this view" })).toBeVisible();
    await page.getByRole("button", { name: "Show all materials" }).click();
    await expect(page.getByText("worksheet.txt", { exact: true })).toBeVisible();

    const worksheet = page.locator(".material-card").filter({ hasText: "worksheet.txt" });
    await worksheet.getByRole("button", { name: "Preview" }).click();
    const preview = page.getByRole("dialog", { name: "Preview worksheet.txt" });
    await expect(preview).toContainText("Balance the equation before dividing.");
    await preview.getByRole("button", { name: "Close preview" }).click();

    const imageCard = page.locator(".material-card").filter({ hasText: "diagram.png" });
    await imageCard.getByRole("button", { name: "Preview" }).click();
    await expect(
        page.getByRole("dialog", { name: "Preview diagram.png" }).getByRole("img"),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    const audioCard = page.locator(".material-card").filter({ hasText: "lesson-tone.mp3" });
    await audioCard.getByRole("button", { name: "Preview" }).click();
    const audioPreview = page.getByRole("dialog", { name: "Preview lesson-tone.mp3" });
    const playAudio = audioPreview.getByRole("button", { name: /^Play /u });
    await expect(playAudio).toBeVisible();
    await playAudio.click();
    await expect(audioPreview.getByRole("button", { name: /^Pause /u })).toBeVisible();
    await audioPreview.getByRole("button", { name: "Mute" }).click();
    await expect(audioPreview.getByRole("button", { name: "Unmute" })).toBeVisible();
    await audioPreview.getByRole("slider", { name: "Volume" }).fill("0.4");
    await audioPreview.getByRole("button", { name: /^Pause /u }).click();
    await audioPreview.getByRole("button", { name: "Close preview" }).click();

    const exported = page.waitForEvent("download");
    await worksheet.getByRole("button", { name: "Export" }).click();
    const download = await exported;
    expect(await download.path()).toBeTruthy();

    // Details round-trip and history restoration.
    await worksheet.getByRole("button", { name: "Details" }).click();
    await worksheet.getByLabel("File name").fill("renamed-worksheet.txt");
    await worksheet.getByLabel("Description").fill("Used for the balance model.");
    await worksheet.getByRole("button", { name: "Save details" }).click();
    await expect(page.getByText("renamed-worksheet.txt", { exact: true })).toBeVisible();
    await worksheet.getByRole("button", { name: "History" }).click();
    await expect(worksheet).toContainText("Earlier details");
    await worksheet.getByRole("button", { name: "Restore details" }).click();
    await expect(page.getByText("worksheet.txt", { exact: true })).toBeVisible();

    // Move the material to the general library and back into the session.
    await worksheet.getByRole("button", { name: "Session" }).click();
    await worksheet
        .getByRole("combobox", { name: "Session" })
        .selectOption({ label: "General library" });
    await worksheet.getByRole("button", { name: "Move material" }).click();
    await expect(worksheet).toContainText("General library");
    await worksheet.getByRole("button", { name: "Session" }).click();
    await worksheet
        .getByRole("combobox", { name: "Session" })
        .selectOption({ label: "Material session" });
    await worksheet.getByRole("button", { name: "Move material" }).click();
    await expect(worksheet).toContainText("Linked · Material session");

    // Trash and restore the stored material.
    await worksheet.getByRole("button", { name: "Move to Trash" }).click();
    await worksheet.getByRole("button", { name: "Move to Trash" }).last().click();
    await expect(page.getByText("worksheet.txt", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Removed materials" }).click();
    const removed = page.locator(".material-history-version").filter({ hasText: "worksheet.txt" });
    await expect(removed).toBeVisible();
    await removed.getByRole("button", { name: "Restore" }).click();
    await expect(page.getByText("worksheet.txt", { exact: true })).toBeVisible();
});

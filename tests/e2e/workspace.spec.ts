import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
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
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: undefined });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
});

test("creates, updates, exports, and reopens a portable tutoring workspace", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/Tutorux/u);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Your work with learners");

  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.getByLabel("Workspace name").fill("QA Workspace");
  const firstDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await (await firstDownload).saveAs(testInfo.outputPath("initial.tux"));
  await expect(page.getByRole("heading", { name: "Good", exact: false })).toBeVisible();

  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: "Add student", exact: true }).click();
  await page.getByLabel("Student name").fill("Mina Chen");
  await page.getByLabel("Grade or level").fill("Year 8");
  await page.getByLabel("Subjects").fill("Algebra, Science");
  await page.getByLabel("Learning goals").fill("Build confidence with linear equations.");
  await page.getByLabel("Areas to revisit").fill("Choosing a common denominator.");
  await page
    .getByLabel("Demonstrated improvements")
    .fill("Explains the scale factor with a visual model.");
  await page.getByLabel("Preferred study-guide structure").selectOption("mathematics");
  await page.getByRole("button", { name: "Add student", exact: true }).last().click();
  await expect(page.getByRole("heading", { name: "Mina Chen" })).toBeVisible();
  await page.getByText("Learning context", { exact: true }).click();
  await expect(page.getByText("Choosing a common denominator.")).toBeVisible();
  await expect(page.getByText("Explains the scale factor with a visual model.")).toBeVisible();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page
    .getByLabel("Learning goals")
    .fill("Build confidence with linear equations and ratios.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Build confidence with linear equations and ratios.")).toBeVisible();
  await page.getByRole("button", { name: "Move Mina Chen to Trash" }).click();
  await page
    .getByRole("alertdialog", { name: "Move student to Trash?" })
    .getByRole("button", { name: "Move to Trash" })
    .click();
  await expect(page.getByRole("heading", { name: "Mina Chen" })).toHaveCount(0);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByText("Mina Chen", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore" }).click();
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(page.getByText("Build confidence with linear equations and ratios.")).toBeVisible();

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Session title").fill("Linear equations, one step at a time");
  await page.locator('select[name="student"]').selectOption({ label: "Mina Chen" });
  await page.getByLabel("Subject", { exact: true }).fill("Algebra");
  await page
    .getByLabel("Session notes")
    .fill("We used balance scales to make the first step visible.");
  await page.getByRole("button", { name: "Save session" }).click();
  await expect(page.getByText("Linear equations, one step at a time")).toBeVisible();
  await page.getByRole("button", { name: "Edit session" }).click();
  await page.getByLabel("Session notes").fill("The balance model helped make each step visible.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Linear equations, one step at a time")).toBeVisible();

  await page.getByRole("button", { name: "Students", exact: true }).click();
  const learningHistory = page.locator(".student-history");
  await learningHistory.locator("summary").click();
  await expect(learningHistory).toContainText("1 session");
  await expect(learningHistory).toContainText("Linear equations, one step at a time");

  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Materials", exact: true })
    .click();
  await page
    .getByLabel("Session for imported material")
    .selectOption({ label: "Linear equations, one step at a time" });
  await page.getByLabel("Choose a material to import").setInputFiles({
    name: "lesson-notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Balance model worksheet", "utf8"),
  });
  await expect(page.getByText("lesson-notes.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Transcripts", exact: true }).click();
  await page.getByLabel("Choose transcript source file").setInputFiles({
    name: "lesson.srt",
    mimeType: "application/x-subrip",
    buffer: Buffer.from("1\n00:00:01,000 --> 00:00:03,000\nWe can use a balance model.\n", "utf8"),
  });
  await expect(page.getByText("We can use a balance model.")).toBeVisible();
  await page.getByRole("button", { name: "Correct cue" }).click();
  await page.getByLabel("Cue text").fill("The word <balance> is one step & clear.");
  await page.getByLabel("Speaker").fill("Tutor");
  await page.getByRole("button", { name: "Save correction" }).click();
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByLabel("Transcript cue version history")).toContainText(
    "We can use a balance model.",
  );
  await page.getByRole("button", { name: "Restore version 1" }).click();
  await expect(page.locator(".transcript-cue-text")).toHaveText("We can use a balance model.");
  await page.getByRole("button", { name: "View history" }).click();
  await expect(page.getByLabel("Transcript cue version history")).toContainText(
    "2 earlier versions",
  );
  await page.getByRole("button", { name: "Hide history" }).click();
  await page.getByRole("button", { name: "Correct cue" }).click();
  await page.getByLabel("Cue text").fill("The word <balance> is one step & clear.");
  await page.getByLabel("Speaker").fill("Tutor");
  await page.getByRole("button", { name: "Save correction" }).click();
  await page.getByRole("button", { name: "Mark verified" }).click();
  await expect(page.getByText("Human verified", { exact: true })).toBeVisible();

  await page
    .locator("#main-content")
    .getByRole("button", { name: "Materials", exact: true })
    .click();
  await page.getByLabel("lesson-notes.txt", { exact: true }).check();
  await page.getByRole("button", { name: "Save material links" }).click();
  await expect(page.getByLabel("Linked materials")).toContainText("lesson-notes.txt");

  await page.getByRole("button", { name: "Split cue" }).click();
  const beforeSplit = page.getByLabel("Before");
  const afterSplit = page.getByLabel("After");
  const beforeText = await beforeSplit.inputValue();
  const afterText = await afterSplit.inputValue();
  expect(beforeText + afterText).toBe("The word <balance> is one step & clear.");
  await page.getByRole("button", { name: "Save split" }).click();
  await expect(page.locator(".transcript-cue-text")).toHaveCount(2);
  await expect(page.getByLabel("Linked materials")).toHaveCount(2);

  await page.getByLabel("Select cue 1 to merge").check();
  await page.getByLabel("Select cue 2 to merge").check();
  await page.getByRole("button", { name: "Merge (2)" }).click();
  await expect(page.locator(".transcript-cue-text")).toHaveCount(1);
  await expect(page.locator(".transcript-cue-text")).toHaveText(
    "The word <balance> is one step & clear.",
  );
  await expect(page.getByLabel("Linked materials")).toHaveCount(1);
  await page.screenshot({ path: testInfo.outputPath("transcripts.png"), fullPage: true });
  await page.getByLabel("Transcript export format").selectOption("vtt");
  const transcriptDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportedTranscript = await transcriptDownload;
  const transcriptPath = testInfo.outputPath("reviewed.vtt");
  await exportedTranscript.saveAs(transcriptPath);
  const transcriptText = await readFile(transcriptPath, "utf8");
  expect(transcriptText).toContain("WEBVTT");
  expect(transcriptText).toContain("Tutor: The word &lt;balance&gt; is one step &amp; clear.");

  await page.getByRole("button", { name: "Observations", exact: true }).click();
  await page.getByRole("button", { name: "Add observation", exact: true }).click();
  await page.getByRole("combobox", { name: "Type" }).selectOption("student-mistake");
  await page.getByRole("combobox", { name: "Priority" }).selectOption("high");
  await page.getByRole("textbox", { name: "Title optional" }).fill("Check the sign change");
  await page.getByLabel("Start time").fill("00:00:02");
  await page.getByLabel("End time").fill("00:00:04");
  await page
    .getByRole("textbox", { name: "Observation", exact: true })
    .fill("Mina changed the sign when subtracting the same value from both sides.");
  await page.getByRole("button", { name: "Save observation", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check the sign change" })).toBeVisible();
  await page.getByRole("button", { name: "Edit observation" }).click();
  await page
    .getByRole("textbox", { name: "Observation", exact: true })
    .fill("We will revisit the sign when subtracting from both sides.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(
    page.getByText("We will revisit the sign when subtracting from both sides."),
  ).toBeVisible();
  await page.getByRole("button", { name: "View history" }).click();
  await expect(
    page
      .locator(".annotation-history-entry")
      .getByText("Mina changed the sign when subtracting the same value from both sides."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Restore version 1" }).click();
  await expect(
    page
      .locator(".annotation-card-copy")
      .getByText("Mina changed the sign when subtracting the same value from both sides."),
  ).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("observations.png"), fullPage: true });

  await page.getByRole("button", { name: "Move to Trash", exact: true }).click();
  await page
    .getByRole("alertdialog", { name: "Move observation to Trash?" })
    .getByRole("button", { name: "Move to Trash" })
    .click();
  await expect(page.getByRole("heading", { name: "Check the sign change" })).toHaveCount(0);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByText("Check the sign change", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("button", { name: "Observations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Check the sign change" })).toBeVisible();

  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.getByRole("button", { name: "Extract session evidence" }).click();
  await expect(page.getByRole("heading", { name: "Check the sign change" })).toBeVisible();
  await page.getByRole("button", { name: "Students", exact: true }).click();
  const studentHistory = page.locator(".student-history");
  await studentHistory.locator("summary").click();
  await studentHistory.getByRole("button", { name: "Review a skill" }).click();
  await page.getByLabel("Skill or learning goal").fill("Equivalent fractions");
  await page.getByLabel("Classification").selectOption("newly-observed");
  await page.getByRole("textbox", { name: /^Reviewed by/u }).fill("Mina’s tutor");
  await page.getByRole("checkbox").first().check();
  await studentHistory.getByRole("button", { name: "Save tutor review" }).click();
  await expect(studentHistory).toContainText("Equivalent fractions");
  await expect(studentHistory).toContainText("Newly observed");

  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await page.getByRole("button", { name: "New collection", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("Growing confidence");
  await page
    .getByPlaceholder("What belongs in this collection?")
    .fill("Reflections on learner confidence.");
  await page.getByRole("button", { name: "Create collection", exact: true }).click();
  await expect(page.locator(".journal-label-name")).toContainText("Growing confidence");
  await page.getByRole("button", { name: "New tag", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill("visual models");
  await page.getByRole("button", { name: "Create tag", exact: true }).click();

  await page.getByRole("button", { name: "New entry", exact: true }).click();
  await page.getByLabel("Entry title").fill("A useful way into balance");
  await page
    .getByLabel("Reflection")
    .fill("Mina found the visual model easier to explain back in her own words.");
  await page.getByLabel("Growing confidence", { exact: true }).check();
  await page.getByLabel("visual models", { exact: true }).check();
  await page.getByRole("button", { name: "Save entry" }).click();
  await expect(page.getByRole("heading", { name: "A useful way into balance" })).toBeVisible();
  await expect(page.locator(".journal-label-chips")).toContainText("Growing confidence");
  await page.getByLabel("Filter by collection").selectOption({ label: "Growing confidence" });
  await expect(page.locator(".record-list-journal")).toContainText("A useful way into balance");
  await page.getByLabel("Filter by collection").selectOption("");
  await page.getByLabel("Filter by tag").selectOption({ label: "visual models" });
  await expect(page.locator(".record-list-journal")).toContainText("A useful way into balance");
  await page.getByLabel("Filter by tag").selectOption("");
  await page
    .locator(".journal-record-card")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page.getByLabel("Entry title").fill("Balance as a visual model");
  await page.getByLabel("Reflection").fill("Mina explained the model clearly in her own words.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("heading", { name: "Balance as a visual model" })).toBeVisible();
  await page.getByRole("button", { name: "Archive Growing confidence" }).click();
  await page.getByText("Archived labels · 1", { exact: true }).click();
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(page.locator(".journal-label-chips")).toContainText("Growing confidence");

  const updatedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save archive" }).click();
  const download = await updatedDownload;
  const archivePath = testInfo.outputPath("updated.tux");
  await download.saveAs(archivePath);
  await page.reload();

  const fileChooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await (await fileChooser).setFiles(archivePath);
  await page.locator(".archive-status.is-open").waitFor();
  await expect(page.getByRole("heading", { name: "Good", exact: false })).toBeVisible();
  await expect(page.locator(".stat-card").nth(0)).toContainText("1");
  await expect(page.locator(".stat-card").nth(1)).toContainText("1");
  await expect(page.locator(".stat-card").nth(2)).toContainText("1");
  await page.getByRole("button", { name: "Archive health", exact: true }).click();
  await page.getByRole("button", { name: "Verify archive" }).click();
  await expect(
    page.getByRole("heading", { name: "Every current record passed verification" }),
  ).toBeVisible();
  await expect(page.locator(".integrity-status")).toContainText("verified");

  await page.getByRole("button", { name: "Students", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Mina Chen" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("students.png"), fullPage: true });
  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await expect(page.getByText("Linear equations, one step at a time")).toBeVisible();
  await page.getByRole("button", { name: "Journal", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Balance as a visual model" })).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const overflow = await page
    .locator("body")
    .evaluate((element) => element.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: testInfo.outputPath("journal-mobile.png"), fullPage: true });
});

test("creates and manages archive-backed study guide templates", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.getByLabel("Workspace name").fill("Template QA Workspace");
  const initialDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await (await initialDownload).saveAs(testInfo.outputPath("template-initial.tux"));

  await page.getByRole("button", { name: "Sessions", exact: true }).click();
  await page.getByRole("button", { name: "New session", exact: true }).click();
  await page.getByLabel("Session title").fill("A question-led lesson");
  await page.getByLabel("Subject", { exact: true }).fill("General");
  await page.getByRole("button", { name: "Save session", exact: true }).click();

  await page.getByRole("button", { name: "Study guides", exact: true }).click();
  await page.getByRole("button", { name: "Manage templates" }).click();
  await page.getByRole("button", { name: "Create template" }).click();
  await page.getByLabel("Template name").fill("Socratic review");
  await page.getByLabel("Subject", { exact: true }).last().fill("General");
  await page.getByLabel("Short description").fill("Let the learner reason aloud.");
  await page.getByLabel("Sections").fill("Starting point\nGuiding questions\nEvidence\nNext steps");
  await page.getByLabel("Writing guidance").fill("Keep each question close to the lesson.");
  await page.getByRole("button", { name: "Save template" }).click();
  await expect(page.locator(".guide-template-manage-list")).toContainText("Socratic review");

  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByRole("button", { name: "Add student", exact: true }).click();
  await page.getByLabel("Student name").fill("Template learner");
  await page
    .getByLabel("Preferred study-guide structure")
    .selectOption({ label: "Socratic review" });
  await page.getByRole("button", { name: "Add student", exact: true }).last().click();
  await expect(page.locator(".student-record-card")).toContainText("Socratic review");

  await page.getByRole("button", { name: "Study guides", exact: true }).click();

  await page.getByRole("button", { name: /Socratic review/u }).click();
  const headings = page.getByLabel("Section heading");
  await expect(headings).toHaveCount(4);
  await expect(headings.nth(1)).toHaveValue("Guiding questions");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByRole("heading", { name: /Study Guide/u })).toBeVisible();
  const guideHtmlDownload = page.waitForEvent("download");
  await page.locator(".guide-record-actions").getByRole("button", { name: "HTML" }).click();
  const guideHtmlPath = testInfo.outputPath("study-guide.html");
  await (await guideHtmlDownload).saveAs(guideHtmlPath);
  const guideHtml = await readFile(guideHtmlPath, "utf8");
  expect(guideHtml).toContain('<main class="document">');
  expect(guideHtml).toContain("@media print");

  await expect(page.getByRole("button", { name: "Close manager" })).toBeVisible();
  const templateRow = page
    .locator(".guide-template-manage-row")
    .filter({ hasText: "Socratic review" });
  const exported = page.waitForEvent("download");
  await templateRow.getByRole("button", { name: "Export" }).click();
  const templatePath = testInfo.outputPath("socratic-review.json");
  await (await exported).saveAs(templatePath);
  const json = await readFile(templatePath, "utf8");
  expect(json).toContain('"format": "tutorux-guide-template-v1"');
  expect(json).toContain("Guiding questions");
  const importedTemplate = { ...JSON.parse(json), name: "Imported review" };
  await page.getByLabel("Import a study guide template JSON file").setInputFiles({
    name: "imported-review.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(importedTemplate), "utf8"),
  });
  await expect(page.locator(".guide-template-manage-list")).toContainText("Imported review");
  await page.screenshot({
    path: testInfo.outputPath("guide-template-manager.png"),
    fullPage: true,
  });

  await templateRow.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Sections").fill("Opening\nLearner's reasoning\nReflection");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(templateRow).toContainText("3 sections");

  await templateRow.getByRole("button", { name: "Move to Trash" }).click();
  await expect(templateRow).toHaveCount(0);
  await page.getByRole("button", { name: "Restore", exact: true }).click();
  await expect(templateRow).toContainText("3 sections");
});

test("supports keyboard quick actions and appearance preferences", async ({ page }, testInfo) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Create your workspace" }).click();
  await page.getByLabel("Workspace name").fill("Appearance QA");
  const archiveDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await (await archiveDownload).saveAs(testInfo.outputPath("appearance.tux"));
  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Quick actions" })).toBeVisible();
  await page.getByPlaceholder("What would you like to do?").fill("appearance");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "Quick actions" })).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("navigation").getByRole("button", { name: "Preferences" }).click();
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("combobox", { name: "Color theme" }).selectOption("system");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

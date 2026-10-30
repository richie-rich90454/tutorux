import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { openArchiveBytes, verifyArchiveSnapshot } from "../../frontend/archive/archive";
import { RecordType } from "../../frontend/archive/format";

test.beforeEach(async ({ page }) => {
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
});

test("reviews, saves, exports, and reopens a private manual AI package", async ({ page }, info) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create your workspace" }).click();
    await page.getByLabel("Workspace name").fill("AI package QA");
    const initialDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await (await initialDownload).saveAs(info.outputPath("ai-initial.tux"));

    await page
        .getByRole("navigation")
        .getByRole("button", { name: "Sessions", exact: true })
        .click();
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Session title").fill("Fractions review");
    await page.getByLabel("Subject", { exact: true }).fill("Mathematics");
    await page.getByLabel("Learning objective").fill("Compare equivalent fractions.");
    await page.getByRole("button", { name: "Save session" }).click();
    await expect(page.getByRole("heading", { name: "Fractions review" })).toBeVisible();

    await page
        .getByRole("navigation")
        .getByRole("button", { name: "Materials", exact: true })
        .click();
    await page
        .getByLabel("Session for imported material")
        .selectOption({ label: "Fractions review" });
    await page.getByLabel("Choose materials to import").setInputFiles({
        name: "leaf-cell.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    });
    await expect(page.getByText("leaf-cell.png", { exact: true })).toBeVisible();

    await page.getByRole("navigation").getByRole("button", { name: "AI workspace" }).click();
    await page.getByLabel("AI model ID").fill("gpt-4.1");
    await page.getByRole("button", { name: "Save provider settings" }).click();
    await expect(page.getByText("Configured", { exact: true })).toBeVisible();

    const sessionOption = page.getByRole("option", { name: /Fractions review/u });
    await page
        .getByLabel("Session to prepare")
        .selectOption((await sessionOption.getAttribute("value"))!);
    await page.getByRole("checkbox", { name: /leaf-cell\.png/u }).check();
    await page.getByRole("button", { name: "Prepare for review" }).click();
    await expect(page.getByRole("heading", { name: "Mathematics" })).toBeVisible();
    await expect(page.getByText("Images for request")).toBeVisible();
    await expect(page.locator(".ai-message")).toContainText("Nothing has been sent or saved yet");

    await page.getByRole("button", { name: "Preview exact request" }).click();
    await expect(page.getByRole("heading", { name: "Request ready for review" })).toBeVisible();
    await expect(page.getByText(/No API key is saved for this provider/u)).toBeVisible();
    await expect(page.locator(".ai-request-images")).toContainText("leaf-cell.png");
    await expect(page.locator(".ai-image-body-note")).toContainText("attached material bytes");
    await expect(page.getByRole("heading", { name: "Request ready for review" })).toBeVisible();

    const inspector = page.getByLabel("Complete AI package JSON");
    await page.getByText("Inspect the complete package JSON").click();
    await expect(inspector).toBeVisible();
    const packageText = await inspector.inputValue();
    const parsed = JSON.parse(packageText) as {
        manifest: { format: string; guide_template_id: string; attached_image_ids: string[] };
        attached_images: { filename: string; mime_type: string }[];
        session: { fields: Record<string, string> };
    };
    expect(parsed.manifest).toMatchObject({
        format: "tutorux-ai-package-v1",
        guide_template_id: "mathematics",
        attached_image_ids: [expect.any(String)],
    });
    expect(parsed.attached_images).toMatchObject([
        { filename: "leaf-cell.png", mime_type: "image/png" },
    ]);
    expect(parsed.session.fields["title"]).toBe("Fractions review");
    expect(page.getByRole("button", { name: "Save reviewed package" })).toBeDisabled();
    await page.getByRole("checkbox", { name: /I reviewed the package contents/u }).check();
    await page.getByRole("button", { name: "Save reviewed package" }).click();
    await expect(page.getByText(/Reviewed AI package saved in this archive/u)).toBeVisible();
    await expect(page.getByRole("button", { name: "Export JSON" })).toBeVisible();

    const packageDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export JSON" }).click();
    const exported = await packageDownload;
    await exported.saveAs(info.outputPath("ai-package.json"));
    expect(JSON.parse(await readFile(info.outputPath("ai-package.json"), "utf8"))).toMatchObject({
        manifest: { format: "tutorux-ai-package-v1" },
    });

    const archiveDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save archive" }).click();
    await (await archiveDownload).saveAs(info.outputPath("ai-saved.tux"));
    const archive = await openArchiveBytes(
        new Uint8Array(await readFile(info.outputPath("ai-saved.tux"))),
    );
    const verification = await verifyArchiveSnapshot(archive);
    expect(verification.currentRecords).toBeGreaterThanOrEqual(3);
    const [job] = await archive.listRecords(RecordType.aiJob);
    expect(job).toBeDefined();
    expect(job!.fields.get("status")).toBe("package-ready");
    expect(JSON.parse(new TextDecoder().decode(job!.blob))).toMatchObject({
        manifest: { format: "tutorux-ai-package-v1" },
    });
});

test("saves provider preferences and keeps API keys inside encrypted archives", async ({
    page,
}, info) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Create your workspace" }).click();
    await page.getByLabel("Workspace name").fill("Encrypted AI settings");
    await page.getByLabel(/Protect this workspace with a passphrase/u).check();
    await page.getByLabel("Archive passphrase").fill("encrypted-ai-test-passphrase");
    await page.getByLabel("Confirm passphrase").fill("encrypted-ai-test-passphrase");
    const initialDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await (await initialDownload).saveAs(info.outputPath("ai-encrypted-initial.tux"));

    await page.getByRole("navigation").getByRole("button", { name: "AI workspace" }).click();
    await page.getByLabel("AI model ID").fill("gpt-4.1");
    await page.getByRole("button", { name: "Save provider settings" }).click();
    await expect(page.getByText("Configured", { exact: true })).toBeVisible();

    const apiKey = "sk-test-secret-never-display";
    await page.getByLabel("Provider API key").fill(apiKey);
    await page
        .getByRole("checkbox", {
            name: /understand this key will be stored inside the encrypted archive/u,
        })
        .check();
    await page.getByRole("button", { name: "Save key securely" }).click();
    await expect(
        page.getByText("A key is saved in this encrypted archive. Its value is never shown here."),
    ).toBeVisible();
    await expect(page.getByLabel("Provider API key")).toHaveCount(0);
    await expect(page.locator("body")).not.toContainText(apiKey);

    const archiveDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save archive" }).click();
    await (await archiveDownload).saveAs(info.outputPath("ai-encrypted-saved.tux"));
    const locked = await openArchiveBytes(
        new Uint8Array(await readFile(info.outputPath("ai-encrypted-saved.tux"))),
    );
    const archive = await locked.unlock("encrypted-ai-test-passphrase");
    await expect(verifyArchiveSnapshot(archive)).resolves.toMatchObject({ deletedRecords: 0 });
    const settings = await archive.listRecords(RecordType.settings);
    const provider = settings.find((record) => record.fields.get("record_role") === "ai-provider");
    expect(provider?.fields.get("provider_id")).toBe("openai");
    expect(provider?.fields.get("selected_model")).toBe("gpt-4.1");
    expect(provider?.fields.get("credential_storage")).toBe("memory-only");
    const credential = settings.find((record) => record.fields.get("record_role") === "credential");
    expect(credential?.fields.get("key")).toBe("OPENAI_API_KEY");
    expect(credential?.fields.get("value")).toBe(apiKey);
    archive.lock();
});

test("archives successful and HTTP-error responses after explicit request confirmation", async ({
    page,
}, info) => {
    const apiKey = "sk-e2e-only-secret";
    const rawProviderError = JSON.stringify({ error: { message: "rate limit details" } });
    let providerPosts = 0;
    await page.route("https://api.openai.com/v1/chat/completions", async (route) => {
        const request = route.request();
        const origin = request.headers()["origin"] ?? "http://127.0.0.1";
        if (request.method() === "OPTIONS") {
            await route.fulfill({
                status: 204,
                headers: {
                    "Access-Control-Allow-Origin": origin,
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "authorization, content-type",
                    "Access-Control-Max-Age": "60",
                },
            });
            return;
        }
        providerPosts += 1;
        expect(request.method()).toBe("POST");
        expect(request.headers()["authorization"]).toBe(`Bearer ${apiKey}`);
        if (providerPosts > 1) {
            await route.fulfill({
                status: 429,
                headers: {
                    "Access-Control-Allow-Origin": origin,
                    "Content-Type": "application/json; charset=utf-8",
                },
                body: rawProviderError,
            });
            return;
        }
        const requestBody = JSON.parse(request.postData() ?? "{}") as {
            model: string;
            messages: {
                role: string;
                content: string | { type: string; text?: string; image_url?: { url: string } }[];
            }[];
        };
        expect(requestBody.model).toBe("gpt-4.1");
        const userContent = requestBody.messages[1]?.content;
        expect(Array.isArray(userContent)).toBe(true);
        if (!Array.isArray(userContent))
            throw new Error("The image request did not use content parts.");
        const textPart = userContent.find((part) => part.type === "text");
        const imagePart = userContent.find((part) => part.type === "image_url");
        expect(textPart?.text).toContain('"format":"tutorux-ai-package-v1"');
        expect(imagePart?.image_url?.url).toBe(
            `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]).toString("base64")}`,
        );
        expect(JSON.stringify(requestBody)).not.toContain(apiKey);
        const packageValue = JSON.parse(textPart?.text ?? "{}") as {
            manifest: { guide_template_id: string };
            session: { id: string };
        };
        const generatedGuide = JSON.stringify({
            title: "Fractions guide",
            template_id: packageValue.manifest.guide_template_id,
            sections: [
                {
                    heading: "Equivalent fractions",
                    blocks: [
                        {
                            kind: "paragraph",
                            text: "Equivalent fractions name the same amount.",
                            source_ids: [packageValue.session.id],
                        },
                    ],
                },
            ],
        });
        await route.fulfill({
            status: 200,
            headers: {
                "Access-Control-Allow-Origin": origin,
                "Content-Type": "text/event-stream; charset=utf-8",
            },
            body: `data: ${JSON.stringify({ choices: [{ delta: { content: generatedGuide } }] })}\n\ndata: [DONE]\n\n`,
        });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Create your workspace" }).click();
    await page.getByLabel("Workspace name").fill("Provider execution QA");
    await page.getByRole("checkbox", { name: /Protect this workspace with a passphrase/u }).check();
    await page.getByLabel("Archive passphrase").fill("provider-execution-test-passphrase");
    await page.getByLabel("Confirm passphrase").fill("provider-execution-test-passphrase");
    const initialDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Create workspace" }).click();
    await (await initialDownload).saveAs(info.outputPath("ai-run-initial.tux"));

    await page
        .getByRole("navigation")
        .getByRole("button", { name: "Sessions", exact: true })
        .click();
    await page.getByRole("button", { name: "New session", exact: true }).click();
    await page.getByLabel("Session title").fill("Fractions review");
    await page.getByLabel("Subject", { exact: true }).fill("Mathematics");
    await page.getByLabel("Learning objective").fill("Compare equivalent fractions.");
    await page.getByRole("button", { name: "Save session" }).click();

    await page
        .getByRole("navigation")
        .getByRole("button", { name: "Materials", exact: true })
        .click();
    await page
        .getByLabel("Session for imported material")
        .selectOption({ label: "Fractions review" });
    await page.getByLabel("Choose materials to import").setInputFiles({
        name: "leaf-cell.png",
        mimeType: "image/png",
        buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    });

    await page.getByRole("navigation").getByRole("button", { name: "AI workspace" }).click();
    await page.getByLabel("AI model ID").fill("gpt-4.1");
    await page.getByRole("button", { name: "Save provider settings" }).click();
    await page.getByLabel("Provider API key").fill(apiKey);
    await page
        .getByRole("checkbox", {
            name: /understand this key will be stored inside the encrypted archive/u,
        })
        .check();
    await page.getByRole("button", { name: "Save key securely" }).click();

    const sessionOption = page.getByRole("option", { name: /Fractions review/u });
    await page
        .getByLabel("Session to prepare")
        .selectOption((await sessionOption.getAttribute("value"))!);
    await page.getByRole("checkbox", { name: /leaf-cell\.png/u }).check();
    await page.getByRole("button", { name: "Prepare for review" }).click();
    await page.getByRole("button", { name: "Preview exact request" }).click();
    await expect(page.getByRole("heading", { name: "Request ready for review" })).toBeVisible();
    await expect(page.locator(".ai-request-images")).toContainText("leaf-cell.png");
    await page.getByRole("checkbox", { name: /I reviewed the package contents/u }).check();
    await page.locator(".ai-send-consent input").check();
    await page.getByRole("button", { name: "Send exact reviewed request" }).click();
    await expect(
        page.getByRole("heading", { name: "Proposed study guide is ready" }),
    ).toBeVisible();
    await expect(page.getByText("Source validation")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(apiKey);
    expect(providerPosts).toBe(1);

    const retrySessionOption = page.getByRole("option", { name: /Fractions review/u });
    await page
        .getByLabel("Session to prepare")
        .selectOption((await retrySessionOption.getAttribute("value"))!);
    await page.getByRole("checkbox", { name: /leaf-cell\.png/u }).check();
    await page.getByRole("button", { name: "Prepare for review" }).click();
    await expect(page.getByRole("heading", { name: "Mathematics" })).toBeVisible();
    await page.getByRole("button", { name: "Preview exact request" }).click();
    await expect(page.getByRole("heading", { name: "Request ready for review" })).toBeVisible();
    await page.getByRole("checkbox", { name: /I reviewed the package contents/u }).check();
    await page.locator(".ai-send-consent input").check();
    await page.getByRole("button", { name: "Send exact reviewed request" }).click();
    await expect(
        page.getByRole("heading", { name: "Provider response saved for review" }),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(rawProviderError);
    expect(providerPosts).toBe(2);
    const rawResponseDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export raw response" }).click();
    await (await rawResponseDownload).saveAs(info.outputPath("ai-provider-error.json"));
    expect(await readFile(info.outputPath("ai-provider-error.json"))).toEqual(
        Buffer.from(rawProviderError),
    );

    const archiveDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save archive" }).click();
    await (await archiveDownload).saveAs(info.outputPath("ai-run-saved.tux"));

    await page.getByRole("navigation").getByRole("button", { name: "Archive health" }).click();
    await page.getByRole("button", { name: "Lock archive" }).click();
    const lockedPassphrase = page.getByLabel("Archive passphrase");
    await expect(lockedPassphrase).toBeVisible();
    await lockedPassphrase.fill("provider-execution-test-passphrase");
    await page.getByRole("button", { name: "Unlock archive" }).click();
    await expect(lockedPassphrase).toHaveCount(0);
    await page.getByRole("navigation").getByRole("button", { name: "AI workspace" }).click();
    await expect(page.getByRole("heading", { name: "Proposed study guide is ready" })).toHaveCount(
        0,
    );
    await expect(
        page.getByRole("heading", { name: "Provider response saved for review" }),
    ).toHaveCount(0);

    const locked = await openArchiveBytes(
        new Uint8Array(await readFile(info.outputPath("ai-run-saved.tux"))),
    );
    const archive = await locked.unlock("provider-execution-test-passphrase");
    const jobs = await archive.listRecords(RecordType.aiJob);
    const responseJobs = jobs.filter((job) => job.fields.get("mode") === "byok");
    const successfulJob = responseJobs.find(
        (job) => job.fields.get("status") === "response-needs-review",
    );
    const errorJob = responseJobs.find((job) => job.fields.get("status") === "provider-error");
    expect(successfulJob).toBeDefined();
    expect(errorJob?.fields.get("http_status")).toBe("429");
    expect(errorJob?.fields.get("response_content_type")).toBe("application/json");
    expect(errorJob?.fields.get("response_complete")).toBe("true");
    expect(errorJob?.blob).toEqual(Buffer.from(rawProviderError));
    expect(successfulJob?.fields.get("outbound_consent_hash")).toBe(
        successfulJob?.fields.get("request_body_sha256"),
    );
    expect(new TextDecoder().decode(successfulJob?.blob)).toContain("data: ");
    expect(successfulJob?.fields.get("error_message")).toBeUndefined();
    expect((await archive.listRecords(RecordType.guide))[0]?.fields.get("approval_state")).toBe(
        "draft",
    );
    const credentials = (await archive.listRecords(RecordType.settings)).filter(
        (record) => record.fields.get("record_role") === "credential",
    );
    expect(credentials[0]?.fields.get("value")).toBe(apiKey);
    archive.lock();
});

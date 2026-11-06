import {
    For,
    Show,
    createEffect,
    createResource,
    createSignal,
    onCleanup,
    type JSX,
} from "solid-js";
import {
    chooseTextExport,
    errorMessage,
    guides as guidesApi,
    students as studentsApi,
    writeExportFile,
} from "../../api/client";
import type { Guide } from "../../api/types";
import {
    Badge,
    Button,
    ConfirmButton,
    EmptyState,
    Field,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
    Select,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import { formatDate } from "../../shared/format";
import { Icon } from "../../shared-ui";
import { guidePath, navigate, useRoute } from "../../app/router";

function escapeHtml(value: string): string {
    return value
        .replace(/&/gu, "&amp;")
        .replace(/</gu, "&lt;")
        .replace(/>/gu, "&gt;")
        .replace(/"/gu, "&quot;");
}

function inlineMarkdown(value: string): string {
    return escapeHtml(value)
        .replace(/\*\*(.+?)\*\*/gu, "<strong>$1</strong>")
        .replace(/\*(.+?)\*/gu, "<em>$1</em>")
        .replace(/`(.+?)`/gu, "<code>$1</code>");
}

function markdownToHtml(markdown: string): string {
    const lines = markdown.split("\n");
    const output: string[] = [];
    let listOpen = false;
    for (const line of lines) {
        if (/^\s*[-*]\s+/u.test(line)) {
            if (!listOpen) {
                output.push("<ul>");
                listOpen = true;
            }
            output.push(`<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/u, ""))}</li>`);
            continue;
        }
        if (listOpen) {
            output.push("</ul>");
            listOpen = false;
        }
        if (/^###\s+/u.test(line)) output.push(`<h3>${inlineMarkdown(line.slice(4))}</h3>`);
        else if (/^##\s+/u.test(line)) output.push(`<h2>${inlineMarkdown(line.slice(3))}</h2>`);
        else if (/^#\s+/u.test(line)) output.push(`<h1>${inlineMarkdown(line.slice(2))}</h1>`);
        else if (line.trim() === "") output.push("");
        else output.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    if (listOpen) output.push("</ul>");
    return output.join("\n");
}

function defaultGuideBody(title: string, template = "blank"): string {
    if (template === "recap") {
        return `# ${title}\n\n## What we worked on\n\n\n## Key idea\n\n\n## Worked example\n\n\n## What to remember\n\n- \n`;
    }
    if (template === "practice") {
        return `# ${title}\n\n## Warm-up\n\n- \n\n## Guided practice\n\n1. \n2. \n\n## Independent practice\n\n1. \n2. \n\n## Check your understanding\n\n- \n`;
    }
    return `# ${title}\n\n## What we worked on\n\n\n## What to remember\n\n\n## Practice\n\n- \n`;
}

export function GuidesPage(): JSX.Element {
    const [error, setError] = createSignal("");
    const [creating, setCreating] = createSignal(false);
    const [title, setTitle] = createSignal("");
    const [studentId, setStudentId] = createSignal("");
    const [status, setStatus] = createSignal("draft");
    const [template, setTemplate] = createSignal("blank");
    const [students] = createResource(() => studentsApi.list(""));
    const [guides] = createResource(() => guidesApi.list(null, null));

    async function createGuide(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const guide = await guidesApi.create({
                studentId: studentId() || null,
                sessionId: null,
                title: title() || "Untitled guide",
                status: status(),
                body: defaultGuideBody(title() || "Untitled guide", template()),
                sourceIds: [],
            });
            setCreating(false);
            setTitle("");
            navigate(guidePath(guide.id));
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Study guides"
                description="Lesson material that a learner can keep, reread, and practise from."
                actions={
                    <Button variant="primary" onClick={() => setCreating((value) => !value)}>
                        <Icon name="plus" />
                        New guide
                    </Button>
                }
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <Show when={creating()}>
                <div class="mb-4">
                    <Panel>
                        <PanelHeader
                            title="New guide"
                            detail="Start blank, then edit the guide in the full-page editor."
                        />
                        <form class="grid gap-3 p-4" onSubmit={(event) => void createGuide(event)}>
                            <Field label="Guide title">
                                <TextInput
                                    value={title()}
                                    onInput={setTitle}
                                    placeholder="Linear equations · study guide"
                                    ariaLabel="Guide title"
                                />
                            </Field>
                            <div class="grid gap-3 sm:grid-cols-2">
                                <Field label="Student">
                                    <Select
                                        value={studentId()}
                                        onChange={setStudentId}
                                        ariaLabel="Student"
                                        options={[
                                            { value: "", label: "No student" },
                                            ...(students() ?? []).map((student) => ({
                                                value: student.id,
                                                label: student.displayName,
                                            })),
                                        ]}
                                    />
                                </Field>
                                <Field label="Status">
                                    <Select
                                        value={status()}
                                        onChange={setStatus}
                                        ariaLabel="Guide status"
                                        options={[
                                            { value: "draft", label: "Draft" },
                                            { value: "approved", label: "Approved" },
                                        ]}
                                    />
                                </Field>
                            </div>
                            <Field
                                label="Template"
                                helper="The template only fills the first draft; edit anything in the guide editor."
                            >
                                <Select
                                    value={template()}
                                    onChange={setTemplate}
                                    ariaLabel="Guide template"
                                    options={[
                                        { value: "blank", label: "Blank guide" },
                                        { value: "recap", label: "Lesson recap" },
                                        { value: "practice", label: "Practice plan" },
                                    ]}
                                />
                            </Field>
                            <div class="flex justify-end gap-2">
                                <Button variant="ghost" onClick={() => setCreating(false)}>
                                    Cancel
                                </Button>
                                <Button variant="primary" type="submit">
                                    Create guide
                                </Button>
                            </div>
                        </form>
                    </Panel>
                </div>
            </Show>
            <Panel>
                <PanelHeader title="All guides" detail={`${guides()?.length ?? 0} guides`} />
                <Show
                    when={guides()?.length}
                    fallback={
                        <EmptyState
                            icon="guides"
                            title="No study guides yet"
                            text="Create one from a session or start with a blank guide."
                            action={
                                <Button size="sm" onClick={() => setCreating(true)}>
                                    New guide
                                </Button>
                            }
                        />
                    }
                >
                    <div class="divide-y divide-line-soft">
                        <For each={guides()}>
                            {(guide) => (
                                <button
                                    type="button"
                                    class="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-inset"
                                    onClick={() => navigate(guidePath(guide.id))}
                                >
                                    <span class="grid h-8 w-8 flex-none place-items-center rounded-[5px] bg-accent-soft text-accent">
                                        <Icon name="guides" />
                                    </span>
                                    <span class="min-w-0 flex-1">
                                        <span class="flex flex-wrap items-center gap-2">
                                            <strong class="truncate text-[13px] font-medium text-ink">
                                                {guide.title}
                                            </strong>
                                            <Badge
                                                tone={
                                                    guide.status === "approved"
                                                        ? "success"
                                                        : "neutral"
                                                }
                                            >
                                                {guide.status}
                                            </Badge>
                                        </span>
                                        <span class="mt-0.5 block truncate text-xs text-muted">
                                            {guide.body
                                                .split("\n")
                                                .find(
                                                    (line) => line.trim() && !line.startsWith("#"),
                                                ) ?? "No content yet."}{" "}
                                            · updated {formatDate(guide.updatedAt)}
                                        </span>
                                    </span>
                                    <Icon name="chevron" class="text-faint" />
                                </button>
                            )}
                        </For>
                    </div>
                </Show>
            </Panel>
        </div>
    );
}

function GuidePreview(props: { body: string }): JSX.Element {
    const [element, setElement] = createSignal<HTMLElement>();
    createEffect(() => {
        const node = element();
        if (node) node.innerHTML = markdownToHtml(props.body);
    });
    return <article ref={setElement} class="max-w-[72ch] p-6 text-sm leading-relaxed text-ink" />;
}

export function GuideEditorPage(): JSX.Element {
    const route = useRoute();
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [preview, setPreview] = createSignal(true);
    const [guide, { refetch }] = createResource(() => route().id, guidesApi.get);
    const [title, setTitle] = createSignal("");
    const [body, setBody] = createSignal("");
    const [status, setStatus] = createSignal("draft");
    let loadedId = "";
    let saveTimer = 0;

    const syncFields = (value: Guide): void => {
        if (loadedId === value.id) return;
        loadedId = value.id;
        setTitle(value.title);
        setBody(value.body);
        setStatus(value.status);
    };

    const save = async (): Promise<void> => {
        const value = guide();
        if (!value) return;
        setError("");
        try {
            await guidesApi.update(value.id, {
                studentId: value.studentId,
                sessionId: value.sessionId,
                title: title(),
                status: status(),
                body: body(),
                sourceIds: value.sourceIds,
            });
            setMessage("Guide saved.");
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    };

    const scheduleSave = (): void => {
        window.clearTimeout(saveTimer);
        saveTimer = window.setTimeout(() => void save(), 900);
    };

    onCleanup(() => window.clearTimeout(saveTimer));

    async function exportGuide(format: "md" | "html" | "doc" | "txt"): Promise<void> {
        setError("");
        try {
            const value = guide();
            if (!value) return;
            const path = await chooseTextExport(
                `${value.title || "study-guide"}.${format}`,
                format === "doc" ? "doc" : format,
                format === "md"
                    ? "Markdown guide"
                    : format === "html"
                      ? "HTML guide"
                      : format === "doc"
                        ? "Word document"
                        : "Text guide",
            );
            if (!path) return;
            if (format === "md") await writeExportFile(path, body());
            else if (format === "txt") await writeExportFile(path, body().replace(/[#*`]/gu, ""));
            else {
                const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title())}</title><style>body{font-family:system-ui,sans-serif;line-height:1.6;max-width:720px;margin:40px auto;padding:0 20px;color:#171a1c}h1,h2,h3{line-height:1.25}code{background:#f1f4f3;padding:1px 4px;border-radius:3px}</style></head><body>${markdownToHtml(body())}</body></html>`;
                await writeExportFile(path, html);
            }
            setMessage("Guide exported.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <Show when={guide()} fallback={<p class="text-sm text-muted">Loading guide…</p>}>
                {(value) => {
                    syncFields(value());
                    return (
                        <>
                            <div class="mb-4 flex flex-wrap items-center gap-2 text-xs text-muted">
                                <button
                                    type="button"
                                    class="hover:text-ink"
                                    onClick={() => navigate("/guides")}
                                >
                                    Guides
                                </button>
                                <Icon name="chevron" class="h-3 w-3" />
                                <span class="text-ink">{value().title}</span>
                            </div>
                            <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                                <div class="min-w-0 flex-1">
                                    <input
                                        class="w-full border-0 bg-transparent p-0 text-[26px] font-semibold leading-tight tracking-tight text-ink outline-none"
                                        value={title()}
                                        onInput={(event) => {
                                            setTitle(event.currentTarget.value);
                                            scheduleSave();
                                        }}
                                        aria-label="Guide title"
                                    />
                                    <p class="mt-1 text-xs text-muted">
                                        Updated {formatDate(value().updatedAt)} · saved
                                        automatically
                                    </p>
                                </div>
                                <div class="flex flex-wrap gap-2">
                                    <Select
                                        value={status()}
                                        onChange={(next) => {
                                            setStatus(next);
                                            scheduleSave();
                                        }}
                                        ariaLabel="Guide status"
                                        class="max-w-[150px]"
                                        options={[
                                            { value: "draft", label: "Draft" },
                                            { value: "approved", label: "Approved" },
                                        ]}
                                    />
                                    <Button onClick={() => setPreview((current) => !current)}>
                                        {preview() ? "Edit" : "Preview"}
                                    </Button>
                                    <Button onClick={() => void save()}>Save now</Button>
                                    <Button onClick={() => window.print()}>Print / PDF</Button>
                                </div>
                            </div>
                            <Show when={error()}>
                                <div class="mb-4">
                                    <InlineNotice tone="danger">{error()}</InlineNotice>
                                </div>
                            </Show>
                            <Show when={message()}>
                                <div class="mb-4">
                                    <InlineNotice tone="success">{message()}</InlineNotice>
                                </div>
                            </Show>
                            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
                                <Panel class="min-h-[60vh]">
                                    <Show
                                        when={preview()}
                                        fallback={
                                            <TextArea
                                                class="min-h-[60vh] rounded-none border-0 font-mono text-[13px]"
                                                value={body()}
                                                onInput={(next) => {
                                                    setBody(next);
                                                    scheduleSave();
                                                }}
                                                ariaLabel="Guide body"
                                            />
                                        }
                                    >
                                        <GuidePreview body={body()} />
                                    </Show>
                                </Panel>
                                <div class="grid content-start gap-3">
                                    <Panel>
                                        <PanelHeader title="Export" />
                                        <div class="grid gap-1.5 p-3">
                                            <Button
                                                size="sm"
                                                onClick={() => void exportGuide("md")}
                                            >
                                                Markdown
                                            </Button>
                                            <Button
                                                size="sm"
                                                onClick={() => void exportGuide("html")}
                                            >
                                                HTML
                                            </Button>
                                            <Button
                                                size="sm"
                                                onClick={() => void exportGuide("doc")}
                                            >
                                                Word document
                                            </Button>
                                            <Button
                                                size="sm"
                                                onClick={() => void exportGuide("txt")}
                                            >
                                                Plain text
                                            </Button>
                                            <Button size="sm" onClick={() => window.print()}>
                                                Print / PDF
                                            </Button>
                                        </div>
                                    </Panel>
                                    <Panel>
                                        <PanelHeader title="Guide details" />
                                        <div class="grid gap-2 p-3 text-xs text-muted">
                                            <div class="flex justify-between gap-2">
                                                <span>Status</span>
                                                <Badge
                                                    tone={
                                                        status() === "approved"
                                                            ? "success"
                                                            : "neutral"
                                                    }
                                                >
                                                    {status()}
                                                </Badge>
                                            </div>
                                            <div class="flex justify-between gap-2">
                                                <span>Sources</span>
                                                <strong class="text-ink">
                                                    {value().sourceIds.length}
                                                </strong>
                                            </div>
                                            <ConfirmButton
                                                label="Delete guide"
                                                confirmLabel="Delete guide"
                                                onConfirm={() =>
                                                    void guidesApi
                                                        .remove(value().id)
                                                        .then(() => navigate("/guides"))
                                                }
                                            />
                                        </div>
                                    </Panel>
                                </div>
                            </div>
                        </>
                    );
                }}
            </Show>
        </div>
    );
}

import { For, Show, createResource, createSignal, onCleanup, type JSX } from "solid-js";
import {
    chooseMaterialFiles,
    errorMessage,
    materials as materialsApi,
    sessions as sessionsApi,
} from "../../api/client";
import type { Material } from "../../api/types";
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
    TextInput,
} from "../../design-system/ui";
import { formatBytes, formatDate } from "../../shared/format";
import { Icon } from "../../shared-ui";

export function MaterialsPage(): JSX.Element {
    const [query, setQuery] = createSignal("");
    const [sessionId, setSessionId] = createSignal("");
    const [link, setLink] = createSignal({ title: "", url: "", notes: "" });
    const [showLink, setShowLink] = createSignal(false);
    const [error, setError] = createSignal("");
    const [preview, setPreview] = createSignal<{
        id: string;
        url: string;
        text: string;
        mimeType: string;
    } | null>(null);
    const [loading, setLoading] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [sessions] = createResource(() => sessionsApi.list(null, null, 500));
    const [materials, { refetch }] = createResource(
        () => ({ query: query(), sessionId: sessionId() }),
        (source) => materialsApi.list(source.sessionId || null, null, source.query),
    );

    onCleanup(() => {
        const value = preview();
        if (value?.url) URL.revokeObjectURL(value.url);
    });

    async function importFiles(): Promise<void> {
        setError("");
        try {
            const files = await chooseMaterialFiles();
            for (const path of files)
                await materialsApi.importFile(path, sessionId() || null, null);
            if (files.length) await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function addLink(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            const value = link();
            await materialsApi.link({
                sessionId: sessionId() || null,
                studentId: null,
                title: value.title,
                url: value.url,
                notes: value.notes,
            });
            setLink({ title: "", url: "", notes: "" });
            setShowLink(false);
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function open(material: Material): Promise<void> {
        setError("");
        setLoading(material.id);
        try {
            if (material.kind === "link") {
                window.open(material.sourceUrl, "_blank", "noopener,noreferrer");
                return;
            }
            const bytes = await materialsApi.read(material.id);
            const previous = preview();
            if (previous?.url) URL.revokeObjectURL(previous.url);
            const isText =
                material.mimeType.startsWith("text/") || material.mimeType === "application/json";
            const text = isText ? new TextDecoder().decode(bytes) : "";
            const url = URL.createObjectURL(new Blob([bytes], { type: material.mimeType }));
            setPreview({ id: material.id, url, text, mimeType: material.mimeType });
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setLoading("");
        }
    }

    async function extractText(material: Material): Promise<void> {
        setError("");
        setMessage("");
        setLoading(material.id);
        try {
            const updated = await materialsApi.ocr(material.id);
            setMessage(
                updated.extractedText
                    ? `Extracted ${updated.extractedText.length} characters from ${updated.filename}.`
                    : `No text was found in ${updated.filename}.`,
            );
            await refetch();
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setLoading("");
        }
    }

    const visible = (): Material[] => materials() ?? [];
    const previewText = (): string => {
        const current = preview();
        if (!current) return "";
        return (materials() ?? []).find((item) => item.id === current.id)?.extractedText ?? "";
    };

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Materials"
                description="Files, links, audio, video, and documents tied to the lessons they support."
                actions={
                    <>
                        <Button onClick={() => setShowLink((value) => !value)}>Add link</Button>
                        <Button variant="primary" onClick={() => void importFiles()}>
                            <Icon name="plus" />
                            Add files
                        </Button>
                    </>
                }
            />
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
            <Show when={showLink()}>
                <div class="mb-4">
                    <Panel>
                        <PanelHeader
                            title="Save a link"
                            detail="Bookmarks keep a title, URL, and note."
                        />
                        <form class="grid gap-3 p-4" onSubmit={(event) => void addLink(event)}>
                            <div class="grid gap-3 sm:grid-cols-2">
                                <Field label="Title">
                                    <TextInput
                                        value={link().title}
                                        onInput={(value) => setLink({ ...link(), title: value })}
                                        placeholder="Khan Academy fractions"
                                        ariaLabel="Link title"
                                    />
                                </Field>
                                <Field label="URL">
                                    <TextInput
                                        value={link().url}
                                        onInput={(value) => setLink({ ...link(), url: value })}
                                        placeholder="https://…"
                                        ariaLabel="Link URL"
                                    />
                                </Field>
                            </div>
                            <Field label="Notes">
                                <TextInput
                                    value={link().notes}
                                    onInput={(value) => setLink({ ...link(), notes: value })}
                                    placeholder="Why this link matters"
                                    ariaLabel="Link notes"
                                />
                            </Field>
                            <div class="flex justify-end gap-2">
                                <Button variant="ghost" onClick={() => setShowLink(false)}>
                                    Cancel
                                </Button>
                                <Button variant="primary" type="submit">
                                    Save link
                                </Button>
                            </div>
                        </form>
                    </Panel>
                </div>
            </Show>

            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.55fr)]">
                <Panel>
                    <div class="flex flex-wrap items-center gap-2 border-b border-line-soft px-4 py-3">
                        <label class="flex min-h-8 min-w-[200px] flex-1 items-center gap-2 rounded-[5px] border border-line-strong bg-surface px-2.5 text-xs text-muted">
                            <Icon name="search" />
                            <input
                                class="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
                                placeholder="Search materials"
                                value={query()}
                                onInput={(event) => setQuery(event.currentTarget.value)}
                                aria-label="Search materials"
                            />
                        </label>
                        <Select
                            value={sessionId()}
                            onChange={setSessionId}
                            ariaLabel="Filter by session"
                            class="max-w-[260px]"
                            options={[
                                { value: "", label: "All sessions" },
                                ...(sessions() ?? []).map((session) => ({
                                    value: session.id,
                                    label: `${session.title} · ${formatDate(session.startedAt ?? session.scheduledAt ?? session.createdAt)}`,
                                })),
                            ]}
                        />
                        <span class="ml-auto text-xs text-muted">{visible().length} items</span>
                    </div>
                    <Show
                        when={visible().length}
                        fallback={
                            <EmptyState
                                icon="assets"
                                title="No materials yet"
                                text="Add a file, drop one here, or save a link. Materials stay in the workspace file."
                                action={
                                    <Button size="sm" onClick={() => void importFiles()}>
                                        Add files
                                    </Button>
                                }
                            />
                        }
                    >
                        <div class="divide-y divide-line-soft">
                            <For each={visible()}>
                                {(material) => (
                                    <div class="flex flex-wrap items-center gap-2 px-4 py-3">
                                        <span class="grid h-8 w-8 flex-none place-items-center rounded-[5px] border border-line bg-surface-subtle text-muted">
                                            <Icon
                                                name={
                                                    material.kind === "link" ? "folder" : "assets"
                                                }
                                            />
                                        </span>
                                        <button
                                            type="button"
                                            class="min-w-0 flex-1 text-left"
                                            onClick={() => void open(material)}
                                            disabled={loading() === material.id}
                                        >
                                            <span class="block truncate text-[13px] font-medium text-ink">
                                                {material.title || material.filename}
                                            </span>
                                            <span class="block truncate text-xs text-muted">
                                                {material.kind}
                                                {material.kind === "file"
                                                    ? ` · ${formatBytes(material.byteSize)} · ${material.mimeType}`
                                                    : ""}
                                                {material.notes ? ` · ${material.notes}` : ""}
                                                {` · ${formatDate(material.createdAt)}`}
                                            </span>
                                        </button>
                                        <Show when={material.kind === "link"}>
                                            <Badge>link</Badge>
                                        </Show>
                                        <Show when={material.extractedText}>
                                            <Badge tone="success">text extracted</Badge>
                                        </Show>
                                        <Show
                                            when={
                                                material.mimeType.startsWith("image/") ||
                                                material.mimeType === "application/pdf"
                                            }
                                        >
                                            <Button
                                                size="sm"
                                                onClick={() => void extractText(material)}
                                                disabled={loading() === material.id}
                                            >
                                                {loading() === material.id
                                                    ? "Reading…"
                                                    : "Extract text"}
                                            </Button>
                                        </Show>
                                        <Button
                                            size="sm"
                                            onClick={() => void open(material)}
                                            disabled={loading() === material.id}
                                        >
                                            {loading() === material.id ? "Loading…" : "Open"}
                                        </Button>
                                        <ConfirmButton
                                            label="Delete"
                                            confirmLabel="Delete material"
                                            onConfirm={() =>
                                                void materialsApi
                                                    .remove(material.id)
                                                    .then(() => void refetch())
                                            }
                                        />
                                    </div>
                                )}
                            </For>
                        </div>
                    </Show>
                </Panel>
                <Panel>
                    <PanelHeader
                        title="Preview"
                        detail="Images, audio, video, PDFs, and text open in place."
                    />
                    <Show
                        when={preview()}
                        fallback={
                            <EmptyState
                                icon="assets"
                                title="Nothing selected"
                                text="Choose a material to preview it."
                            />
                        }
                    >
                        {(value) => (
                            <div class="p-3">
                                <Show when={value().mimeType.startsWith("image/")}>
                                    <img
                                        class="max-h-[55vh] w-full object-contain"
                                        src={value().url}
                                        alt="Material preview"
                                    />
                                </Show>
                                <Show when={value().mimeType.startsWith("audio/")}>
                                    <audio class="w-full" controls src={value().url} />
                                </Show>
                                <Show when={value().mimeType.startsWith("video/")}>
                                    <video class="max-h-[55vh] w-full" controls src={value().url} />
                                </Show>
                                <Show when={value().mimeType === "application/pdf"}>
                                    <iframe
                                        class="h-[55vh] w-full border-0"
                                        src={value().url}
                                        title="PDF preview"
                                    />
                                </Show>
                                <Show when={value().text}>
                                    <pre class="max-h-[55vh] whitespace-pre-wrap overflow-auto text-xs leading-relaxed text-ink-soft">
                                        {value().text}
                                    </pre>
                                </Show>
                                <Show
                                    when={
                                        !value().text &&
                                        !value().mimeType.match(
                                            /^(image|audio|video)\/|application\/pdf/u,
                                        )
                                    }
                                >
                                    <p class="text-xs leading-relaxed text-muted">
                                        This file type has no in-app preview. It is stored safely in
                                        the workspace.
                                    </p>
                                </Show>
                                <Show when={previewText()}>
                                    <div class="mt-3 border-t border-line-soft pt-3">
                                        <strong class="text-[11px] text-muted">
                                            Extracted text
                                        </strong>
                                        <pre class="mt-1 max-h-[30vh] whitespace-pre-wrap overflow-auto text-xs leading-relaxed text-ink-soft">
                                            {previewText()}
                                        </pre>
                                    </div>
                                </Show>
                            </div>
                        )}
                    </Show>
                </Panel>
            </div>
        </div>
    );
}

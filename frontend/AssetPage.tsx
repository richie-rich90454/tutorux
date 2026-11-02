import { For, Show, createMemo, createSignal, onCleanup, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import { filterAssetsBySession } from "./domain/assets";
import type { AssetBatchProgress } from "./domain/assets-stream";
import { buildPcmWavAssetWaveform, type PcmWavAssetWaveform } from "./domain/asset-waveform";
import {
    MaterialAudioPreview,
    MaterialDetails,
    MaterialImportControls,
    MaterialTrash,
} from "./lazy-components";
import { MediaPlayer } from "./MediaPlayer";
import { Icon, ManagedDialog } from "./shared-ui";
import { errorMessage, field, formatBytes, formatTimestamp } from "./shared-utils";
import {
    bodyText,
    buttonOutline,
    buttonQuiet,
    card,
    cn,
    eyebrow,
    heading1,
    heading3,
    iconButton,
    mutedText,
    pageBody,
    selectBase,
} from "./ui";

const recordAction = "record-action min-h-[30px] px-2.5 text-xs";

export function AssetPage(props: {
    records: ArchiveRecord[];
    sessions: ArchiveRecord[];
    snapshot: ArchiveSnapshot;
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
    disabled: boolean;
    onImport: (
        files: readonly File[],
        sessionId: string,
        onProgress: AssetBatchProgress,
    ) => Promise<boolean>;
    onPreview: (record: ArchiveRecord) => Promise<{ bytes: Uint8Array; mimeType: string } | null>;
    onExport: (record: ArchiveRecord) => void;
}): JSX.Element {
    const [sessionId, setSessionId] = createSignal("");
    const [librarySessionFilter, setLibrarySessionFilter] = createSignal("all");
    const visibleRecords = createMemo(() =>
        filterAssetsBySession(
            props.records,
            librarySessionFilter() === "all" ? null : librarySessionFilter(),
        ),
    );
    const [preview, setPreview] = createSignal<{
        record: ArchiveRecord;
        url: string;
        mimeType: string;
        text: string | null;
        waveform: PcmWavAssetWaveform | null;
    } | null>(null);
    const [fileDropActive, setFileDropActive] = createSignal(false);
    const [dropStatus, setDropStatus] = createSignal("");
    let dragDepth = 0;
    let previewTrigger: HTMLButtonElement | undefined;

    onCleanup(() => {
        const active = preview();
        if (active) URL.revokeObjectURL(active.url);
    });

    async function openPreview(record: ArchiveRecord): Promise<void> {
        const loaded = await props.onPreview(record);
        if (!loaded) return;
        const previous = preview();
        if (previous) URL.revokeObjectURL(previous.url);
        const url = URL.createObjectURL(
            new Blob([loaded.bytes.slice().buffer], { type: loaded.mimeType }),
        );
        const textType =
            loaded.mimeType.startsWith("text/") || loaded.mimeType === "application/json";
        let text: string | null = null;
        if (textType && loaded.bytes.byteLength <= 2 * 1024 * 1024) {
            try {
                text = new TextDecoder("utf-8", { fatal: true }).decode(loaded.bytes);
            } catch {
                text = null;
            }
        }
        const waveform = loaded.mimeType.startsWith("audio/")
            ? buildPcmWavAssetWaveform(loaded.bytes)
            : null;
        setPreview({ record, url, mimeType: loaded.mimeType, text, waveform });
    }

    function closePreview(): void {
        const active = preview();
        if (active) URL.revokeObjectURL(active.url);
        setPreview(null);
        previewTrigger?.focus();
    }

    function containsFiles(event: DragEvent): boolean {
        return Array.from(event.dataTransfer?.types ?? []).includes("Files");
    }

    function dragEnter(event: DragEvent): void {
        if (!containsFiles(event)) return;
        event.preventDefault();
        if (props.disabled) return;
        dragDepth += 1;
        setFileDropActive(true);
    }

    function dragLeave(event: DragEvent): void {
        if (!containsFiles(event)) return;
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) setFileDropActive(false);
    }

    function dragOver(event: DragEvent): void {
        if (!containsFiles(event)) return;
        event.preventDefault();
        if (!props.disabled && event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    }

    function dropFiles(event: DragEvent): void {
        if (!containsFiles(event)) return;
        event.preventDefault();
        dragDepth = 0;
        setFileDropActive(false);
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) {
            setDropStatus("The drop did not contain any readable files.");
            return;
        }
        if (props.disabled) {
            setDropStatus("Finish the current archive operation before importing dropped files.");
            return;
        }

        setDropStatus(`Preparing ${files.length.toLocaleString("en-US")} dropped materials…`);
        void props
            .onImport(files, sessionId(), (phase, completed, total) => {
                if (phase === "staging" && completed === total) {
                    setDropStatus("Verifying and finalizing the dropped materials…");
                } else {
                    setDropStatus(
                        `${phase === "checking" ? "Checking" : "Writing"} dropped material ${completed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}…`,
                    );
                }
            })
            .then((imported) => {
                setDropStatus(
                    imported
                        ? `${files.length.toLocaleString("en-US")} dropped ${files.length === 1 ? "material is" : "materials are"} ready in the archive. Save to write them to disk.`
                        : "Dropped file import was not completed. Review the archive message and try again.",
                );
            })
            .catch((error: unknown) => setDropStatus(errorMessage(error)));
    }

    return (
        <div
            class={cn("page-body material-page relative flex flex-col gap-7", pageBody)}
            onDragEnter={dragEnter}
            onDragLeave={dragLeave}
            onDragOver={dragOver}
            onDrop={dropFiles}
        >
            <Show when={fileDropActive()}>
                <div
                    class="material-file-drop-overlay pointer-events-none fixed inset-[18px] z-[1000] grid place-content-center justify-items-center gap-2 rounded-[5px] border-2 border-dashed border-accent bg-surface/95 text-ink max-[700px]:inset-2.5 max-[700px]:p-4 max-[700px]:text-center"
                    aria-hidden="true"
                >
                    <strong class="text-sm font-semibold text-ink">
                        Drop files to add them to Materials
                    </strong>
                    <span class="text-xs text-ink-soft">
                        {sessionId()
                            ? "Files will be linked to the selected session."
                            : "Files will be added to the general library."}
                    </span>
                </div>
            </Show>
            <Show when={dropStatus()}>
                <p
                    class="material-drop-status -mt-4 -mb-3 max-w-[min(680px,100%)] self-end text-right text-xs leading-relaxed text-muted max-[700px]:self-stretch max-[700px]:text-left"
                    role="status"
                    aria-live="polite"
                >
                    {dropStatus()}
                </p>
            </Show>
            <section class="record-heading material-heading mb-5 flex flex-wrap items-end justify-between gap-5 max-[700px]:flex-col max-[700px]:items-start">
                <div class="grid gap-1">
                    <span class={eyebrow}>Materials for the work</span>
                    <h1 class={heading1}>Materials</h1>
                    <p class={cn("m-0 max-w-[620px] text-muted", bodyText)}>
                        Keep lesson files beside the sessions and observations they support. Imports
                        are limited to 256 MiB per file.
                    </p>
                </div>
                <MaterialImportControls
                    disabled={props.disabled}
                    onImport={(files, onProgress) => props.onImport(files, sessionId(), onProgress)}
                />
            </section>

            <section class={cn("material-library surface-card overflow-hidden p-0", card)}>
                <div class="material-library-toolbar flex flex-wrap items-center justify-between gap-6 border-b border-line-soft px-5 py-4 max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-3">
                    <div class="grid gap-1">
                        <span class={eyebrow}>File library</span>
                        <strong class="text-sm font-semibold text-ink">
                            {visibleRecords().length}{" "}
                            {visibleRecords().length === 1 ? "item" : "items"}
                        </strong>
                    </div>
                    <label class="material-session-picker flex items-center gap-3 text-xs text-muted max-[700px]:w-full max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-1">
                        <span>Show materials for</span>
                        <select
                            value={librarySessionFilter()}
                            onChange={(event) => setLibrarySessionFilter(event.currentTarget.value)}
                            aria-label="Show materials for"
                            class={cn(selectBase, "w-auto min-w-[200px] max-[700px]:w-full")}
                        >
                            <option value="all">All materials</option>
                            <option value="">General library</option>
                            <For each={props.sessions}>
                                {(session) => (
                                    <option value={session.id}>
                                        {field(session, "title", "Untitled session")}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <label class="material-session-picker flex items-center gap-3 text-xs text-muted max-[700px]:w-full max-[700px]:flex-col max-[700px]:items-start max-[700px]:gap-1">
                        <span>Link new material to</span>
                        <select
                            value={sessionId()}
                            disabled={props.disabled}
                            onChange={(event) => setSessionId(event.currentTarget.value)}
                            aria-label="Session for imported material"
                            class={cn(selectBase, "w-auto min-w-[200px] max-[700px]:w-full")}
                        >
                            <option value="">General library</option>
                            <For each={props.sessions}>
                                {(session) => (
                                    <option value={session.id}>
                                        {field(session, "title", "Untitled session")}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                </div>
                <Show
                    when={visibleRecords().length > 0}
                    fallback={
                        <div class="material-empty flex min-h-[235px] items-center justify-center gap-5 p-9 max-[700px]:flex-col max-[700px]:items-start max-[700px]:p-6">
                            <span class="material-empty-mark grid h-12 w-12 shrink-0 place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                <Icon name="assets" />
                            </span>
                            <div class="grid gap-1.5">
                                <h2 class="text-lg font-semibold tracking-tight text-ink">
                                    {props.records.length === 0
                                        ? "A thoughtful library starts with one file"
                                        : "No materials in this view"}
                                </h2>
                                <p class={cn("m-0 max-w-[520px]", mutedText)}>
                                    {props.records.length === 0
                                        ? "Import a worksheet, reference image, recording, or document. Tutorux keeps its content inside this archive."
                                        : "Choose another session or switch to All materials to see files from the rest of your library."}
                                </p>
                                <Show when={props.records.length > 0}>
                                    <button
                                        class={cn("button button-outline", buttonOutline)}
                                        type="button"
                                        onClick={() => setLibrarySessionFilter("all")}
                                    >
                                        Show all materials
                                    </button>
                                </Show>
                            </div>
                        </div>
                    }
                >
                    <div class="material-grid grid grid-cols-3 gap-3.5 p-5 max-[1050px]:grid-cols-2 max-[700px]:grid-cols-1 max-[700px]:p-3">
                        <For each={visibleRecords()}>
                            {(record) => {
                                const session = () =>
                                    props.sessions.find(
                                        (item) => item.id === field(record, "session_id"),
                                    );
                                const contentType = () =>
                                    field(record, "mime_type", "application/octet-stream");
                                const label = () =>
                                    contentType().split("/")[0]?.toLocaleUpperCase() || "FILE";
                                return (
                                    <article class="material-card flex min-w-0 flex-col rounded-[5px] border border-line-soft bg-surface-subtle p-4 transition-colors hover:border-line-strong">
                                        <div class="material-card-top mb-4 flex items-center justify-between gap-2.5">
                                            <span class="material-file-glyph grid h-10 w-10 place-items-center rounded-[5px] border border-accent/20 bg-accent-soft text-accent">
                                                <Icon name="assets" />
                                            </span>
                                            <span class="material-type-badge rounded-[5px] border border-line bg-surface px-2 py-1 text-xs font-bold tracking-wider text-faint">
                                                {label()}
                                            </span>
                                        </div>
                                        <div class="material-card-copy min-h-[63px] min-w-0">
                                            <h2
                                                title={field(
                                                    record,
                                                    "filename",
                                                    "Untitled material",
                                                )}
                                                class={cn("truncate", heading3)}
                                            >
                                                {field(record, "filename", "Untitled material")}
                                            </h2>
                                            <p class="m-0 mt-1 truncate text-xs text-faint">
                                                {contentType()}
                                            </p>
                                        </div>
                                        <div class="material-card-meta flex items-center justify-between gap-3 border-b border-line-soft py-3 text-xs text-faint">
                                            <span>
                                                {formatBytes(
                                                    BigInt(field(record, "byte_size", "0")),
                                                )}
                                            </span>
                                            <span>
                                                {formatTimestamp(field(record, "created_at_us"))}
                                            </span>
                                        </div>
                                        <div class="material-card-footer mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2.5">
                                            <span class="material-link-context truncate text-xs text-muted">
                                                {session()
                                                    ? `Linked · ${field(session()!, "title", "Session")}`
                                                    : "General library"}
                                            </span>
                                            <div class="material-card-actions ml-auto flex flex-wrap items-center gap-2">
                                                <button
                                                    class={cn(
                                                        "button button-quiet",
                                                        buttonQuiet,
                                                        recordAction,
                                                    )}
                                                    type="button"
                                                    disabled={props.disabled}
                                                    onClick={(event) => {
                                                        previewTrigger = event.currentTarget;
                                                        void openPreview(record);
                                                    }}
                                                >
                                                    Preview
                                                </button>
                                                <button
                                                    class={cn(
                                                        "button button-outline",
                                                        buttonOutline,
                                                        recordAction,
                                                    )}
                                                    type="button"
                                                    disabled={props.disabled}
                                                    onClick={() => props.onExport(record)}
                                                >
                                                    Export
                                                </button>
                                            </div>
                                        </div>
                                        <Show when={field(record, "text_extraction_status")}>
                                            <small class="material-extraction-note mt-3 block text-xs text-faint">
                                                Text extraction:{" "}
                                                {field(record, "text_extraction_status")}
                                            </small>
                                        </Show>
                                        <MaterialDetails
                                            record={record}
                                            snapshot={props.snapshot}
                                            disabled={props.disabled}
                                            onWriteRecords={props.onWriteRecords}
                                        />
                                    </article>
                                );
                            }}
                        </For>
                    </div>
                </Show>
                <MaterialTrash
                    snapshot={props.snapshot}
                    disabled={props.disabled}
                    onWriteRecords={props.onWriteRecords}
                />
            </section>
            <Show when={preview()}>
                {(active) => (
                    <div
                        class="material-preview-backdrop fixed inset-0 z-20 grid place-items-center bg-ink/60 p-7 max-[700px]:p-2.5"
                        onClick={(event) => {
                            if (event.target === event.currentTarget) closePreview();
                        }}
                    >
                        <ManagedDialog
                            class="material-preview-dialog flex max-h-[min(760px,calc(100vh-56px))] w-[min(900px,100%)] flex-col overflow-hidden rounded-[5px] border border-line bg-surface"
                            role="dialog"
                            label={`Preview ${field(active().record, "filename", "material")}`}
                            onEscape={closePreview}
                            restoreFocus={() => false}
                        >
                            <header class="material-preview-header flex min-h-[68px] items-center justify-between gap-4 border-b border-line-soft px-4 py-3">
                                <div class="grid gap-1">
                                    <span class={eyebrow}>Material preview</span>
                                    <h2 class="text-lg font-semibold tracking-tight text-ink">
                                        {field(active().record, "filename", "Untitled material")}
                                    </h2>
                                </div>
                                <button
                                    class={cn("icon-button", iconButton)}
                                    type="button"
                                    aria-label="Close preview"
                                    onClick={closePreview}
                                >
                                    <Icon name="close" />
                                </button>
                            </header>
                            <div class="material-preview-content grid min-h-[220px] place-items-center overflow-auto bg-surface-subtle p-5">
                                <Show
                                    when={active().text !== null}
                                    fallback={
                                        active().mimeType.startsWith("image/") ? (
                                            <img
                                                src={active().url}
                                                alt={field(
                                                    active().record,
                                                    "filename",
                                                    "Material preview",
                                                )}
                                                class="block max-h-[58vh] max-w-full rounded-[5px] object-contain"
                                            />
                                        ) : active().mimeType.startsWith("audio/") ? (
                                            active().waveform ? (
                                                <MaterialAudioPreview
                                                    waveform={active().waveform!}
                                                    url={active().url}
                                                />
                                            ) : (
                                                <MediaPlayer
                                                    kind="audio"
                                                    src={active().url}
                                                    label={field(
                                                        active().record,
                                                        "filename",
                                                        "Audio material",
                                                    )}
                                                />
                                            )
                                        ) : active().mimeType.startsWith("video/") ? (
                                            <MediaPlayer
                                                kind="video"
                                                src={active().url}
                                                label={field(
                                                    active().record,
                                                    "filename",
                                                    "Video material",
                                                )}
                                            />
                                        ) : active().mimeType.startsWith("text/") ||
                                          active().mimeType === "application/json" ? (
                                            <div class="material-preview-unavailable max-w-[420px] text-center text-[13px] leading-relaxed text-muted">
                                                Text previews are limited to 2 MiB. Export the
                                                verified original file to read the full document.
                                            </div>
                                        ) : (
                                            <div class="material-preview-unavailable max-w-[420px] text-center text-[13px] leading-relaxed text-muted">
                                                Preview is unavailable for this file type. Export
                                                the verified original file to open it in another
                                                app.
                                            </div>
                                        )
                                    }
                                >
                                    <pre class="m-0 max-h-[58vh] w-full overflow-auto whitespace-pre-wrap rounded-[5px] border border-line bg-surface p-5 font-mono text-xs leading-relaxed text-ink-soft wrap-anywhere">
                                        {active().text}
                                    </pre>
                                </Show>
                            </div>
                            <footer class="material-preview-footer flex min-h-[68px] flex-wrap items-center justify-between gap-4 border-t border-line-soft px-4 py-3 text-xs text-muted max-[700px]:flex-col max-[700px]:items-start">
                                <span>
                                    {active().mimeType} ·{" "}
                                    {formatBytes(BigInt(field(active().record, "byte_size", "0")))}
                                </span>
                                <button
                                    class={cn("button button-outline", buttonOutline)}
                                    type="button"
                                    onClick={() => props.onExport(active().record)}
                                >
                                    Export original
                                </button>
                            </footer>
                        </ManagedDialog>
                    </div>
                )}
            </Show>
        </div>
    );
}

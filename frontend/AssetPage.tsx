import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./AssetPage.tailwind";
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

        setDropStatus(`Preparing ${files.length.toLocaleString()} dropped materials…`);
        void props
            .onImport(files, sessionId(), (phase, completed, total) => {
                if (phase === "staging" && completed === total) {
                    setDropStatus("Verifying and finalizing the dropped materials…");
                } else {
                    setDropStatus(
                        `${phase === "checking" ? "Checking" : "Writing"} dropped material ${completed.toLocaleString()} of ${total.toLocaleString()}…`,
                    );
                }
            })
            .then((imported) => {
                setDropStatus(
                    imported
                        ? `${files.length.toLocaleString()} dropped ${files.length === 1 ? "material is" : "materials are"} ready in the archive. Save to write them to disk.`
                        : "Dropped file import was not completed. Review the archive message and try again.",
                );
            })
            .catch((error: unknown) => setDropStatus(errorMessage(error)));
    }

    return (
        <div
            class={twClasses("page-body material-page", jsxTailwindStyles, "div")}
            onDragEnter={dragEnter}
            onDragLeave={dragLeave}
            onDragOver={dragOver}
            onDrop={dropFiles}
        >
            <Show when={fileDropActive()}>
                <div
                    class={twClasses("material-file-drop-overlay", jsxTailwindStyles, "div")}
                    aria-hidden="true"
                >
                    <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                        Drop files to add them to Materials
                    </strong>
                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                        {sessionId()
                            ? "Files will be linked to the selected session."
                            : "Files will be added to the general library."}
                    </span>
                </div>
            </Show>
            <Show when={dropStatus()}>
                <p
                    class={twClasses("material-drop-status", jsxTailwindStyles, "p")}
                    role="status"
                    aria-live="polite"
                >
                    {dropStatus()}
                </p>
            </Show>
            <section
                class={twClasses("record-heading material-heading", jsxTailwindStyles, "section")}
            >
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        Materials for the work
                    </span>
                    <h1 class={twClasses("", jsxTailwindStyles, "h1")}>Materials</h1>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                        Keep lesson files beside the sessions and observations they support. Imports
                        are limited to 256 MiB per file.
                    </p>
                </div>
                <MaterialImportControls
                    disabled={props.disabled}
                    onImport={(files, onProgress) => props.onImport(files, sessionId(), onProgress)}
                />
            </section>

            <section
                class={twClasses("material-library surface-card", jsxTailwindStyles, "section")}
            >
                <div class={twClasses("material-library-toolbar", jsxTailwindStyles, "div")}>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                            File library
                        </span>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {visibleRecords().length}{" "}
                            {visibleRecords().length === 1 ? "item" : "items"}
                        </strong>
                    </div>
                    <label class={twClasses("material-session-picker", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Show materials for
                        </span>
                        <select
                            value={librarySessionFilter()}
                            onChange={(event) => setLibrarySessionFilter(event.currentTarget.value)}
                            aria-label="Show materials for"
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                    <label class={twClasses("material-session-picker", jsxTailwindStyles, "label")}>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Link new material to
                        </span>
                        <select
                            value={sessionId()}
                            disabled={props.disabled}
                            onChange={(event) => setSessionId(event.currentTarget.value)}
                            aria-label="Session for imported material"
                            class={twClasses("", jsxTailwindStyles, "select")}
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
                        <div class={twClasses("material-empty", jsxTailwindStyles, "div")}>
                            <span
                                class={twClasses("material-empty-mark", jsxTailwindStyles, "span")}
                            >
                                <Icon name="assets" />
                            </span>
                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                    {props.records.length === 0
                                        ? "A thoughtful library starts with one file"
                                        : "No materials in this view"}
                                </h2>
                                <p class={twClasses("", jsxTailwindStyles, "p")}>
                                    {props.records.length === 0
                                        ? "Import a worksheet, reference image, recording, or document. Tutorux keeps its content inside this archive."
                                        : "Choose another session or switch to All materials to see files from the rest of your library."}
                                </p>
                                <Show when={props.records.length > 0}>
                                    <button
                                        class={twClasses(
                                            "button button-outline",
                                            jsxTailwindStyles,
                                            "button",
                                        )}
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
                    <div class={twClasses("material-grid", jsxTailwindStyles, "div")}>
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
                                    <article
                                        class={twClasses(
                                            "material-card",
                                            jsxTailwindStyles,
                                            "article",
                                        )}
                                    >
                                        <div
                                            class={twClasses(
                                                "material-card-top",
                                                jsxTailwindStyles,
                                                "div",
                                            )}
                                        >
                                            <span
                                                class={twClasses(
                                                    "material-file-glyph",
                                                    jsxTailwindStyles,
                                                    "span",
                                                )}
                                            >
                                                <Icon name="assets" />
                                            </span>
                                            <span
                                                class={twClasses(
                                                    "material-type-badge",
                                                    jsxTailwindStyles,
                                                    "span",
                                                )}
                                            >
                                                {label()}
                                            </span>
                                        </div>
                                        <div
                                            class={twClasses(
                                                "material-card-copy",
                                                jsxTailwindStyles,
                                                "div",
                                            )}
                                        >
                                            <h2
                                                title={field(
                                                    record,
                                                    "filename",
                                                    "Untitled material",
                                                )}
                                                class={twClasses("", jsxTailwindStyles, "h2")}
                                            >
                                                {field(record, "filename", "Untitled material")}
                                            </h2>
                                            <p class={twClasses("", jsxTailwindStyles, "p")}>
                                                {contentType()}
                                            </p>
                                        </div>
                                        <div
                                            class={twClasses(
                                                "material-card-meta",
                                                jsxTailwindStyles,
                                                "div",
                                            )}
                                        >
                                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                                {formatBytes(
                                                    BigInt(field(record, "byte_size", "0")),
                                                )}
                                            </span>
                                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                                {formatTimestamp(field(record, "created_at_us"))}
                                            </span>
                                        </div>
                                        <div
                                            class={twClasses(
                                                "material-card-footer",
                                                jsxTailwindStyles,
                                                "div",
                                            )}
                                        >
                                            <span
                                                class={twClasses(
                                                    "material-link-context",
                                                    jsxTailwindStyles,
                                                    "span",
                                                )}
                                            >
                                                {session()
                                                    ? `Linked · ${field(session()!, "title", "Session")}`
                                                    : "General library"}
                                            </span>
                                            <div
                                                class={twClasses(
                                                    "material-card-actions",
                                                    jsxTailwindStyles,
                                                    "div",
                                                )}
                                            >
                                                <button
                                                    class={twClasses(
                                                        "button button-quiet record-action",
                                                        jsxTailwindStyles,
                                                        "button",
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
                                                    class={twClasses(
                                                        "button button-outline record-action",
                                                        jsxTailwindStyles,
                                                        "button",
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
                                            <small
                                                class={twClasses(
                                                    "material-extraction-note",
                                                    jsxTailwindStyles,
                                                    "small",
                                                )}
                                            >
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
                        class={twClasses("material-preview-backdrop", jsxTailwindStyles, "div")}
                        onClick={(event) => {
                            if (event.target === event.currentTarget) closePreview();
                        }}
                    >
                        <ManagedDialog
                            class={twClasses("material-preview-dialog", jsxTailwindStyles, "")}
                            role="dialog"
                            label={`Preview ${field(active().record, "filename", "material")}`}
                            onEscape={closePreview}
                            restoreFocus={() => false}
                        >
                            <header
                                class={twClasses(
                                    "material-preview-header",
                                    jsxTailwindStyles,
                                    "header",
                                )}
                            >
                                <div class={twClasses("", jsxTailwindStyles, "div")}>
                                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                        Material preview
                                    </span>
                                    <h2 class={twClasses("", jsxTailwindStyles, "h2")}>
                                        {field(active().record, "filename", "Untitled material")}
                                    </h2>
                                </div>
                                <button
                                    class={twClasses("icon-button", jsxTailwindStyles, "button")}
                                    type="button"
                                    aria-label="Close preview"
                                    onClick={closePreview}
                                >
                                    <Icon name="close" />
                                </button>
                            </header>
                            <div
                                class={twClasses(
                                    "material-preview-content",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
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
                                                class={twClasses("", jsxTailwindStyles, "img")}
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
                                            <div
                                                class={twClasses(
                                                    "material-preview-unavailable",
                                                    jsxTailwindStyles,
                                                    "div",
                                                )}
                                            >
                                                Text previews are limited to 2 MiB. Export the
                                                verified original file to read the full document.
                                            </div>
                                        ) : (
                                            <div
                                                class={twClasses(
                                                    "material-preview-unavailable",
                                                    jsxTailwindStyles,
                                                    "div",
                                                )}
                                            >
                                                Preview is unavailable for this file type. Export
                                                the verified original file to open it in another
                                                app.
                                            </div>
                                        )
                                    }
                                >
                                    <pre class={twClasses("", jsxTailwindStyles, "pre")}>
                                        {active().text}
                                    </pre>
                                </Show>
                            </div>
                            <footer
                                class={twClasses(
                                    "material-preview-footer",
                                    jsxTailwindStyles,
                                    "footer",
                                )}
                            >
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {active().mimeType} ·{" "}
                                    {formatBytes(BigInt(field(active().record, "byte_size", "0")))}
                                </span>
                                <button
                                    class={twClasses(
                                        "button button-outline",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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

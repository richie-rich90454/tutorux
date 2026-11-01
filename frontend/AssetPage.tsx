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

import "./assets.css";

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
            class="page-body material-page"
            onDragEnter={dragEnter}
            onDragLeave={dragLeave}
            onDragOver={dragOver}
            onDrop={dropFiles}
        >
            <Show when={fileDropActive()}>
                <div class="material-file-drop-overlay" aria-hidden="true">
                    <strong>Drop files to add them to Materials</strong>
                    <span>
                        {sessionId()
                            ? "Files will be linked to the selected session."
                            : "Files will be added to the general library."}
                    </span>
                </div>
            </Show>
            <Show when={dropStatus()}>
                <p class="material-drop-status" role="status" aria-live="polite">
                    {dropStatus()}
                </p>
            </Show>
            <section class="record-heading material-heading">
                <div>
                    <span class="eyebrow">Materials for the work</span>
                    <h1>Materials</h1>
                    <p>
                        Keep lesson files beside the sessions and observations they support. Imports
                        are limited to 256 MiB per file.
                    </p>
                </div>
                <MaterialImportControls
                    disabled={props.disabled}
                    onImport={(files, onProgress) => props.onImport(files, sessionId(), onProgress)}
                />
            </section>

            <section class="material-library surface-card">
                <div class="material-library-toolbar">
                    <div>
                        <span class="eyebrow">File library</span>
                        <strong>
                            {visibleRecords().length}{" "}
                            {visibleRecords().length === 1 ? "item" : "items"}
                        </strong>
                    </div>
                    <label class="material-session-picker">
                        <span>Show materials for</span>
                        <select
                            value={librarySessionFilter()}
                            onChange={(event) => setLibrarySessionFilter(event.currentTarget.value)}
                            aria-label="Show materials for"
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
                    <label class="material-session-picker">
                        <span>Link new material to</span>
                        <select
                            value={sessionId()}
                            disabled={props.disabled}
                            onChange={(event) => setSessionId(event.currentTarget.value)}
                            aria-label="Session for imported material"
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
                        <div class="material-empty">
                            <span class="material-empty-mark">
                                <Icon name="assets" />
                            </span>
                            <div>
                                <h2>
                                    {props.records.length === 0
                                        ? "A thoughtful library starts with one file"
                                        : "No materials in this view"}
                                </h2>
                                <p>
                                    {props.records.length === 0
                                        ? "Import a worksheet, reference image, recording, or document. Tutorux keeps its content inside this archive."
                                        : "Choose another session or switch to All materials to see files from the rest of your library."}
                                </p>
                                <Show when={props.records.length > 0}>
                                    <button
                                        class="button button-outline"
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
                    <div class="material-grid">
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
                                    <article class="material-card">
                                        <div class="material-card-top">
                                            <span class="material-file-glyph">
                                                <Icon name="assets" />
                                            </span>
                                            <span class="material-type-badge">{label()}</span>
                                        </div>
                                        <div class="material-card-copy">
                                            <h2
                                                title={field(
                                                    record,
                                                    "filename",
                                                    "Untitled material",
                                                )}
                                            >
                                                {field(record, "filename", "Untitled material")}
                                            </h2>
                                            <p>{contentType()}</p>
                                        </div>
                                        <div class="material-card-meta">
                                            <span>
                                                {formatBytes(
                                                    BigInt(field(record, "byte_size", "0")),
                                                )}
                                            </span>
                                            <span>
                                                {formatTimestamp(field(record, "created_at_us"))}
                                            </span>
                                        </div>
                                        <div class="material-card-footer">
                                            <span class="material-link-context">
                                                {session()
                                                    ? `Linked · ${field(session()!, "title", "Session")}`
                                                    : "General library"}
                                            </span>
                                            <div class="material-card-actions">
                                                <button
                                                    class="button button-quiet record-action"
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
                                                    class="button button-outline record-action"
                                                    type="button"
                                                    disabled={props.disabled}
                                                    onClick={() => props.onExport(record)}
                                                >
                                                    Export
                                                </button>
                                            </div>
                                        </div>
                                        <Show when={field(record, "text_extraction_status")}>
                                            <small class="material-extraction-note">
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
                        class="material-preview-backdrop"
                        onClick={(event) => {
                            if (event.target === event.currentTarget) closePreview();
                        }}
                    >
                        <ManagedDialog
                            class="material-preview-dialog"
                            role="dialog"
                            label={`Preview ${field(active().record, "filename", "material")}`}
                            onEscape={closePreview}
                            restoreFocus={() => false}
                        >
                            <header class="material-preview-header">
                                <div>
                                    <span class="eyebrow">Material preview</span>
                                    <h2>
                                        {field(active().record, "filename", "Untitled material")}
                                    </h2>
                                </div>
                                <button
                                    class="icon-button"
                                    type="button"
                                    aria-label="Close preview"
                                    onClick={closePreview}
                                >
                                    <Icon name="close" />
                                </button>
                            </header>
                            <div class="material-preview-content">
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
                                            <div class="material-preview-unavailable">
                                                Text previews are limited to 2 MiB. Export the
                                                verified original file to read the full document.
                                            </div>
                                        ) : (
                                            <div class="material-preview-unavailable">
                                                Preview is unavailable for this file type. Export
                                                the verified original file to open it in another
                                                app.
                                            </div>
                                        )
                                    }
                                >
                                    <pre>{active().text}</pre>
                                </Show>
                            </div>
                            <footer class="material-preview-footer">
                                <span>
                                    {active().mimeType} ·{" "}
                                    {formatBytes(BigInt(field(active().record, "byte_size", "0")))}
                                </span>
                                <button
                                    class="button button-outline"
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

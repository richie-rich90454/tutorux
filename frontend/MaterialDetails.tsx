import { createSignal, For, Show, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { canChangeAssetSession, moveAssetToSession } from "./domain/asset-placement";
import { MAX_ASSET_BATCH_FILES, type AssetBatchProgress } from "./domain/assets-stream";
import {
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    cn,
    errorText,
    inputBase,
    labelBase,
    mutedText,
    selectBase,
    textareaBase,
} from "./ui";

const recordAction = "record-action min-h-[30px] px-2.5 text-xs";

const field = (record: ArchiveRecord, key: string, fallback = "") =>
    record.fields.get(key) ?? fallback;
const now = () => (BigInt(Date.now()) * 1000n).toString();
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
function hasInvalidControls(value: string, multiline: boolean): boolean {
    return [...value].some((character) => {
        const code = character.codePointAt(0)!;
        return code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10)));
    });
}
function editMetadata(record: ArchiveRecord, filename: string, description: string): ArchiveRecord {
    const name = filename.trim();
    if (!name || new TextEncoder().encode(name).length > 1024 || hasInvalidControls(name, false))
        throw new Error("Use a file name of up to 1024 bytes without control characters.");
    if (
        new TextEncoder().encode(description).length > 16_384 ||
        hasInvalidControls(description, true)
    )
        throw new Error("The description is too long or contains unsupported characters.");
    const fields = new Map(record.fields);
    fields.set("filename", name);
    fields.set("description", description);
    fields.set("updated_at_us", now());
    return { ...record, fields };
}

export function MaterialDetails(props: {
    record: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [sessions, setSessions] = createSignal<ArchiveRecord[]>([]);
    const [sessionPanelOpen, setSessionPanelOpen] = createSignal(false);
    const [sessionSelection, setSessionSelection] = createSignal("");
    const [error, setError] = createSignal("");
    const [pending, setPending] = createSignal(false);
    const [confirmRemove, setConfirmRemove] = createSignal(false);

    async function openSessionPanel(): Promise<void> {
        const shouldOpen = !sessionPanelOpen();
        setSessionPanelOpen(shouldOpen);
        if (!shouldOpen) return;
        setSessionSelection(field(props.record, "session_id").toLowerCase());
        setError("");
        setPending(true);
        try {
            const available = (await props.snapshot.listRecords(RecordType.session, true))
                .filter((session) => field(session, "_deleted") !== "true")
                .sort((left, right) =>
                    field(left, "title", "Untitled session").localeCompare(
                        field(right, "title", "Untitled session"),
                        undefined,
                        { sensitivity: "base" },
                    ),
                );
            setSessions(available);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }

    async function saveSessionPlacement(): Promise<void> {
        setError("");
        setPending(true);
        try {
            const moved = await moveAssetToSession(
                props.snapshot,
                props.record,
                sessionSelection(),
            );
            if (
                await props.onWriteRecords(
                    [moved],
                    sessionSelection()
                        ? "Material moved into the selected session. Save to write the change to disk."
                        : "Material moved to the general library. Save to write the change to disk.",
                )
            )
                setSessionPanelOpen(false);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }

    async function save(): Promise<void> {
        setError("");
        setPending(true);
        try {
            if (
                await props.onWriteRecords(
                    [editMetadata(props.record, name(), description())],
                    "Material details updated.",
                )
            )
                setOpen(false);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    async function showHistory(): Promise<void> {
        if (history()) {
            setHistory(null);
            return;
        }
        setError("");
        setPending(true);
        try {
            setHistory(
                await props.snapshot.getRecordHistory(RecordType.assetMetadata, props.record.id),
            );
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    async function restore(revision: ArchiveRecord): Promise<void> {
        setError("");
        setPending(true);
        try {
            const latest = await props.snapshot.getRecord(
                RecordType.assetMetadata,
                props.record.id,
            );
            if (!latest || field(latest, "_deleted") === "true")
                throw new Error("This material is no longer available.");
            if (
                await props.onWriteRecords(
                    [
                        editMetadata(
                            latest,
                            field(revision, "filename"),
                            field(revision, "description"),
                        ),
                    ],
                    "Material details restored.",
                )
            ) {
                setName(field(revision, "filename"));
                setDescription(field(revision, "description"));
                setHistory(
                    await props.snapshot.getRecordHistory(
                        RecordType.assetMetadata,
                        props.record.id,
                    ),
                );
            }
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    async function remove(): Promise<void> {
        setError("");
        setPending(true);
        try {
            const fields = new Map(props.record.fields);
            fields.set("_deleted", "true");
            fields.set("deleted_at_us", now());
            fields.set("updated_at_us", now());
            await props.onWriteRecords([{ ...props.record, fields }], "Material moved to Trash.");
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <section class="material-details border-t border-line-soft pt-2">
            <div class="material-details-actions flex flex-wrap items-center gap-2">
                <button
                    class={cn("button button-quiet", buttonQuiet, recordAction)}
                    type="button"
                    aria-expanded={open()}
                    onClick={() => {
                        setName(field(props.record, "filename"));
                        setDescription(field(props.record, "description"));
                        setOpen((value) => !value);
                    }}
                >
                    Details
                </button>
                <Show when={canChangeAssetSession(props.record)}>
                    <button
                        class={cn("button button-quiet", buttonQuiet, recordAction)}
                        type="button"
                        disabled={pending()}
                        aria-expanded={sessionPanelOpen()}
                        onClick={() => void openSessionPanel()}
                    >
                        Session
                    </button>
                </Show>
                <button
                    class={cn("button button-quiet", buttonQuiet, recordAction)}
                    type="button"
                    disabled={pending()}
                    aria-expanded={history() !== null}
                    onClick={() => void showHistory()}
                >
                    History
                </button>
                <button
                    class={cn("button button-quiet", buttonQuiet, recordAction)}
                    type="button"
                    disabled={props.disabled || pending()}
                    onClick={() => setConfirmRemove((value) => !value)}
                >
                    Move to Trash
                </button>
            </div>
            <Show when={error()}>
                <p role="alert" class={cn("m-0", errorText)}>
                    {error()}
                </p>
            </Show>
            <Show when={confirmRemove()}>
                <div class="material-details-panel mt-2 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3">
                    <p class="m-0 text-xs leading-relaxed text-ink-soft">
                        Move this material to Trash? Its stored file can be restored later.
                    </p>
                    <div class="material-details-actions flex flex-wrap items-center gap-2">
                        <button
                            class={cn("button button-outline", buttonOutline, recordAction)}
                            type="button"
                            disabled={props.disabled || pending()}
                            onClick={() => void remove()}
                        >
                            Move to Trash
                        </button>
                        <button
                            class={cn("button button-quiet", buttonQuiet, recordAction)}
                            type="button"
                            onClick={() => setConfirmRemove(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </Show>
            <Show when={sessionPanelOpen()}>
                <form
                    class="material-details-panel mt-2 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void saveSessionPlacement();
                    }}
                >
                    <p class="m-0 text-xs leading-relaxed text-ink-soft">
                        Choose which session owns this material. A material can belong to one
                        session or stay in the general library.
                    </p>
                    <label class={labelBase}>
                        Session
                        <select
                            value={sessionSelection()}
                            disabled={props.disabled || pending()}
                            onChange={(event) => setSessionSelection(event.currentTarget.value)}
                            class={selectBase}
                        >
                            <option value="">General library</option>
                            <Show
                                when={
                                    sessionSelection() &&
                                    !sessions().some(
                                        (session) =>
                                            session.id.toLowerCase() === sessionSelection(),
                                    )
                                }
                            >
                                <option value={sessionSelection()}>
                                    Unavailable session · move to General library
                                </option>
                            </Show>
                            <For each={sessions()}>
                                {(session) => (
                                    <option value={session.id.toLowerCase()}>
                                        {field(session, "title", "Untitled session")}
                                        {field(session, "archived") === "true" ? " · Archived" : ""}
                                    </option>
                                )}
                            </For>
                        </select>
                    </label>
                    <div class="material-details-actions flex flex-wrap items-center gap-2">
                        <button
                            class={cn("button button-outline", buttonOutline, recordAction)}
                            type="submit"
                            disabled={
                                props.disabled ||
                                pending() ||
                                sessionSelection() ===
                                    field(props.record, "session_id").toLowerCase()
                            }
                        >
                            Move material
                        </button>
                        <button
                            class={cn("button button-quiet", buttonQuiet, recordAction)}
                            type="button"
                            disabled={pending()}
                            onClick={() => setSessionPanelOpen(false)}
                        >
                            Cancel
                        </button>
                    </div>
                </form>
            </Show>
            <Show when={open()}>
                <form
                    class="material-details-panel mt-2 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3"
                    onSubmit={(event) => {
                        event.preventDefault();
                        void save();
                    }}
                >
                    <label class={labelBase}>
                        File name
                        <input
                            value={name()}
                            maxlength="1024"
                            required
                            disabled={props.disabled || pending()}
                            onInput={(event) => setName(event.currentTarget.value)}
                            class={inputBase}
                        />
                    </label>
                    <label class={labelBase}>
                        Description
                        <textarea
                            value={description()}
                            rows={3}
                            maxlength="16384"
                            disabled={props.disabled || pending()}
                            onInput={(event) => setDescription(event.currentTarget.value)}
                            class={textareaBase}
                        />
                    </label>
                    <button
                        class={cn("button button-outline", buttonOutline, recordAction)}
                        type="submit"
                        disabled={props.disabled || pending()}
                    >
                        Save details
                    </button>
                </form>
            </Show>
            <Show when={history() !== null}>
                <div class="material-details-panel mt-2 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3">
                    <strong class="text-sm font-semibold text-ink">Earlier details</strong>
                    <p class="m-0 text-xs leading-relaxed text-ink-soft">
                        Restoring details keeps the current stored file and links.
                    </p>
                    <Show
                        when={(history()?.length ?? 0) > 1}
                        fallback={
                            <p class="m-0 text-xs leading-relaxed text-ink-soft">
                                No earlier versions.
                            </p>
                        }
                    >
                        <For each={history()?.slice(1)}>
                            {(revision) => (
                                <div class="material-history-version flex items-start justify-between gap-2 border-t border-line pt-2">
                                    <div class="grid gap-1">
                                        <strong class="text-sm font-semibold text-ink">
                                            {field(revision, "filename") || "Untitled material"}
                                        </strong>
                                        <p class="m-0 text-xs leading-relaxed text-ink-soft">
                                            {field(revision, "description")}
                                        </p>
                                        <small class={mutedText}>
                                            Version {revision.revision.toString()}
                                        </small>
                                    </div>
                                    <button
                                        class={cn(
                                            "button button-outline",
                                            buttonOutline,
                                            recordAction,
                                        )}
                                        type="button"
                                        disabled={
                                            props.disabled ||
                                            pending() ||
                                            field(revision, "_deleted") === "true"
                                        }
                                        onClick={() => void restore(revision)}
                                    >
                                        Restore details
                                    </button>
                                </div>
                            )}
                        </For>
                    </Show>
                </div>
            </Show>
        </section>
    );
}

export function MaterialTrash(props: {
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    const [records, setRecords] = createSignal<ArchiveRecord[]>([]);
    const [error, setError] = createSignal("");
    const [pending, setPending] = createSignal(false);
    async function load(): Promise<void> {
        setPending(true);
        setError("");
        try {
            setRecords(
                (await props.snapshot.listRecords(RecordType.assetMetadata, true)).filter(
                    (record) =>
                        field(record, "_deleted") === "true" &&
                        !field(record, "_trash_group_id") &&
                        !["recording-take", "recording-track"].includes(
                            field(record, "record_role"),
                        ),
                ),
            );
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    async function restore(record: ArchiveRecord): Promise<void> {
        setPending(true);
        setError("");
        try {
            const fields = new Map(record.fields);
            fields.delete("_deleted");
            fields.delete("deleted_at_us");
            fields.set("restored_at_us", now());
            fields.set("updated_at_us", now());
            if (
                await props.onWriteRecords([{ ...record, fields }], "Material restored from Trash.")
            )
                setRecords((current) => current.filter((item) => item.id !== record.id));
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setPending(false);
        }
    }
    return (
        <section class="material-trash my-3">
            <button
                type="button"
                class={cn("button button-quiet", buttonQuiet, recordAction)}
                aria-expanded={open()}
                onClick={() => {
                    if (!open()) void load();
                    setOpen((value) => !value);
                }}
            >
                {open() ? "Hide removed materials" : "Removed materials"}
            </button>
            <Show when={open()}>
                <div class="material-details-panel mt-2 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3">
                    <Show when={error()}>
                        <p role="alert" class={cn("m-0", errorText)}>
                            {error()}
                        </p>
                    </Show>
                    <Show
                        when={!pending()}
                        fallback={<p class="m-0 text-xs leading-relaxed text-ink-soft">Loading…</p>}
                    >
                        <Show
                            when={records().length}
                            fallback={
                                <p class="m-0 text-xs leading-relaxed text-ink-soft">
                                    No removed materials.
                                </p>
                            }
                        >
                            <For each={records()}>
                                {(record) => (
                                    <div class="material-history-version flex items-start justify-between gap-2 border-t border-line pt-2">
                                        <strong class="text-sm font-semibold text-ink">
                                            {field(record, "filename") || "Untitled material"}
                                        </strong>
                                        <button
                                            type="button"
                                            class={cn(
                                                "button button-outline",
                                                buttonOutline,
                                                recordAction,
                                            )}
                                            disabled={props.disabled || pending()}
                                            onClick={() => void restore(record)}
                                        >
                                            Restore
                                        </button>
                                    </div>
                                )}
                            </For>
                        </Show>
                    </Show>
                </div>
            </Show>
        </section>
    );
}

export function MaterialImportControls(props: {
    disabled: boolean;
    onImport: (files: readonly File[], onProgress: AssetBatchProgress) => Promise<boolean>;
}): JSX.Element {
    const [pending, setPending] = createSignal(false);
    const [status, setStatus] = createSignal("");
    const [error, setError] = createSignal("");
    let fileInput: HTMLInputElement | undefined;
    let folderInput: HTMLInputElement | undefined;

    async function importSelection(input: HTMLInputElement): Promise<void> {
        const files = Array.from(input.files ?? []);
        input.value = "";
        setError("");
        if (files.length === 0) return;
        if (files.length > MAX_ASSET_BATCH_FILES) {
            setError(
                `Choose no more than ${MAX_ASSET_BATCH_FILES.toLocaleString("en-US")} files at a time.`,
            );
            return;
        }

        setPending(true);
        setStatus(
            `Preparing ${files.length.toLocaleString("en-US")} ${files.length === 1 ? "material" : "materials"}…`,
        );
        let lastProgressAt = 0;
        try {
            const imported = await props.onImport(files, (phase, completed, total) => {
                const now = performance.now();
                if (completed !== total && now - lastProgressAt < 500) return;
                lastProgressAt = now;
                if (phase === "staging" && completed === total) {
                    setStatus("Verifying and finalizing the material archive…");
                    return;
                }
                const action = phase === "checking" ? "Checking" : "Writing";
                setStatus(
                    `${action} material ${completed.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}…`,
                );
            });
            setStatus(
                imported
                    ? `${files.length.toLocaleString("en-US")} ${files.length === 1 ? "material is" : "materials are"} ready in the archive. Save to write them to disk.`
                    : "Import was not completed. Review the archive message and try again.",
            );
        } catch (cause) {
            setError(errorMessage(cause));
            setStatus("");
        } finally {
            setPending(false);
        }
    }

    return (
        <div
            class="material-import-controls flex max-w-[390px] flex-wrap items-center justify-end gap-2 max-[700px]:w-full max-[700px]:max-w-none max-[700px]:justify-start"
            aria-busy={pending()}
        >
            <input
                ref={(element) => (fileInput = element)}
                class="visually-hidden sr-only"
                type="file"
                multiple
                disabled={props.disabled || pending()}
                aria-label="Choose materials to import"
                onChange={(event) => void importSelection(event.currentTarget)}
            />
            <input
                ref={(element) => {
                    folderInput = element;
                    element.setAttribute("webkitdirectory", "");
                    element.setAttribute("directory", "");
                }}
                class="visually-hidden sr-only"
                type="file"
                multiple
                disabled={props.disabled || pending()}
                aria-label="Choose a folder of materials to import"
                onChange={(event) => void importSelection(event.currentTarget)}
            />
            <button
                class={cn("button button-primary", buttonPrimary)}
                type="button"
                disabled={props.disabled || pending()}
                onClick={() => fileInput?.click()}
            >
                {pending() ? "Importing materials…" : "Add materials"}
            </button>
            <button
                class={cn("button button-outline", buttonOutline)}
                type="button"
                disabled={props.disabled || pending()}
                onClick={() => folderInput?.click()}
            >
                Import folder
            </button>
            <Show when={error()}>
                <p
                    class="material-import-feedback m-0 basis-full text-right text-xs leading-relaxed text-muted max-[700px]:text-left"
                    role="alert"
                >
                    {error()}
                </p>
            </Show>
            <Show when={status()}>
                <p
                    class="material-import-feedback m-0 basis-full text-right text-xs leading-relaxed text-muted max-[700px]:text-left"
                    role="status"
                    aria-live="polite"
                >
                    {status()}
                </p>
            </Show>
        </div>
    );
}

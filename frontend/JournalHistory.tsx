import { buttonOutline, buttonQuiet, cn } from "./ui";
import { createSignal, For, Show, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { notesEditState } from "./domain/records";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
function date(value: string): string {
    try {
        const ms = Number(BigInt(value || "0") / 1000n);
        return ms > 0
            ? new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
              }).format(new Date(ms))
            : "Date unavailable";
    } catch {
        return "Date unavailable";
    }
}

export function JournalHistory(props: {
    entry: ArchiveRecord;
    notesDocument: ArchiveRecord | undefined;
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal("");
    const [entries, setEntries] = createSignal<ArchiveRecord[]>([]);
    const [notes, setNotes] = createSignal<ArchiveRecord[]>([]);

    async function load(): Promise<void> {
        setLoading(true);
        setError("");
        try {
            const [entryHistory, notesHistory] = await Promise.all([
                props.snapshot.getRecordHistory(RecordType.settings, props.entry.id),
                props.notesDocument
                    ? props.snapshot.getRecordHistory(RecordType.settings, props.notesDocument.id)
                    : Promise.resolve([]),
            ]);
            setEntries(entryHistory);
            setNotes(notesHistory);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }
    async function toggle(): Promise<void> {
        if (open()) {
            setOpen(false);
            return;
        }
        setOpen(true);
        await load();
    }
    async function restoreEntry(revision: ArchiveRecord): Promise<void> {
        try {
            const latest = await props.snapshot.getRecord(RecordType.settings, props.entry.id);
            if (!latest || field(latest, "_deleted") === "true")
                throw new Error("This journal entry is no longer available.");
            if (field(revision, "record_role") !== "journal-entry")
                throw new Error("This version is not a journal entry.");
            const fields = new Map(latest.fields);
            fields.set("title", field(revision, "title"));
            fields.set("entry_date", field(revision, "entry_date"));
            fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            fields.set("restored_from_revision", revision.revision.toString());
            if (
                await props.onWriteRecords(
                    [{ ...latest, fields }],
                    "Journal entry details restored.",
                )
            )
                await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    async function restoreNotes(revision: ArchiveRecord): Promise<void> {
        try {
            const latestEntry = await props.snapshot.getRecord(RecordType.settings, props.entry.id);
            const latest = await props.snapshot.getRecord(RecordType.settings, revision.id);
            if (
                !latestEntry ||
                !latest ||
                field(latestEntry, "_deleted") === "true" ||
                field(latest, "_deleted") === "true" ||
                field(latestEntry, "notes_document_id").toLowerCase() !== revision.id.toLowerCase()
            )
                throw new Error("This notes document is no longer attached to the entry.");
            if (
                field(revision, "record_role") !== "journal-notes" ||
                field(revision, "entry_id").toLowerCase() !== props.entry.id.toLowerCase() ||
                field(revision, "session_id")
            )
                throw new Error("This notes version belongs to another record.");
            const fields = new Map(revision.fields);
            fields.delete("_deleted");
            fields.delete("deleted_at_us");
            fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            fields.set("restored_from_revision", revision.revision.toString());
            if (
                await props.onWriteRecords(
                    [{ ...latest, fields, blob: revision.blob }],
                    "Journal notes restored.",
                )
            )
                await load();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        }
    }
    return (
        <section class={cn("journal-history", "mt-3")}>
            <button
                type="button"
                class={cn("button record-action", buttonQuiet)}
                aria-expanded={open()}
                onClick={() => void toggle()}
            >
                {open() ? "Hide history" : "View history"}
            </button>
            <Show when={open()}>
                <div class="mt-2.5 grid gap-2.5 rounded-[5px] border border-line bg-surface-subtle p-3.5">
                    <Show when={loading()}>
                        <p class="m-0 text-xs text-muted">Loading versions…</p>
                    </Show>
                    <Show when={error()}>
                        <p role="alert" class="m-0 text-xs text-muted">
                            {error()}
                        </p>
                    </Show>
                    <Show when={!loading()}>
                        <h3 class="m-0 text-sm font-semibold text-ink">Entry details</h3>
                        <p class="m-0 text-xs text-muted">
                            Restoring details changes the title and date and keeps current links.
                        </p>
                        <Show
                            when={entries().length > 1}
                            fallback={
                                <p class="m-0 text-xs text-muted">No earlier entry versions.</p>
                            }
                        >
                            <For each={entries().slice(1)}>
                                {(revision) => (
                                    <article class="journal-history-version flex items-start justify-between gap-3 border-t border-line pt-2.5">
                                        <div class="grid min-w-0 gap-1">
                                            <strong class="font-semibold text-ink">
                                                {field(revision, "title") || "Untitled entry"}
                                            </strong>
                                            <small class="text-xs text-muted">
                                                {field(revision, "entry_date")} ·{" "}
                                                {date(field(revision, "updated_at_us"))}
                                            </small>
                                        </div>
                                        <button
                                            type="button"
                                            class={cn("button record-action", buttonOutline)}
                                            disabled={
                                                props.disabled ||
                                                field(revision, "_deleted") === "true"
                                            }
                                            onClick={() => void restoreEntry(revision)}
                                        >
                                            Restore details
                                        </button>
                                    </article>
                                )}
                            </For>
                        </Show>
                        <h3 class="m-0 text-sm font-semibold text-ink">Notes</h3>
                        <Show
                            when={notes().length > 1}
                            fallback={
                                <p class="m-0 text-xs text-muted">No earlier notes versions.</p>
                            }
                        >
                            <For each={notes().slice(1)}>
                                {(revision) => {
                                    const state = notesEditState(revision, {
                                        entryId: props.entry.id,
                                        sessionId: "",
                                    });
                                    return (
                                        <article class="journal-history-version flex items-start justify-between gap-3 border-t border-line pt-2.5">
                                            <div class="grid min-w-0 gap-1">
                                                <strong class="font-semibold text-ink">
                                                    Version {revision.revision.toString()}
                                                </strong>
                                                <small class="text-xs text-muted">
                                                    {date(field(revision, "updated_at_us"))}
                                                </small>
                                                <p class="m-0 max-h-48 overflow-auto whitespace-pre-wrap wrap-anywhere text-xs leading-relaxed text-muted">
                                                    {state.editable
                                                        ? state.blocks
                                                              .map((block) => block.text)
                                                              .join("\n") || "Empty notes"
                                                        : "This version uses a notes format that cannot be previewed here."}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                class={cn("button record-action", buttonOutline)}
                                                disabled={
                                                    props.disabled ||
                                                    field(revision, "_deleted") === "true"
                                                }
                                                onClick={() => void restoreNotes(revision)}
                                            >
                                                Restore notes
                                            </button>
                                        </article>
                                    );
                                }}
                            </For>
                        </Show>
                    </Show>
                </div>
            </Show>
        </section>
    );
}

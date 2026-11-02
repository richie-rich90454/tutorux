import { buttonOutline, buttonPrimary, cn, selectBase } from "./ui";
import { For, Show, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";

interface SessionVersionHistoryProps {
    session: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    /** Persist against the reviewed current revision; preserve links, lifecycle, and notes. */
    onRestore: (current: ArchiveRecord, previous: ArchiveRecord) => Promise<boolean>;
}

const details = [
    ["title", "Title"],
    ["subject", "Subject"],
    ["learning_objectives", "Learning objectives"],
] as const;

function dateLabel(record: ArchiveRecord): string {
    try {
        const milliseconds = Number(
            BigInt(
                record.fields.get("updated_at_us") || record.fields.get("created_at_us") || "0",
            ) / 1000n,
        );
        return milliseconds > 0 && Number.isFinite(milliseconds)
            ? new Intl.DateTimeFormat("en-US", {
                  dateStyle: "medium",
                  timeStyle: "short",
              }).format(new Date(milliseconds))
            : "Date unavailable";
    } catch {
        return "Date unavailable";
    }
}

/** Restore only the editable session details, leaving related records and lifecycle intact. */
export function restoreSessionDetails(
    current: ArchiveRecord,
    previous: ArchiveRecord,
): ArchiveRecord {
    if (
        current.type !== RecordType.session ||
        previous.type !== RecordType.session ||
        current.id !== previous.id
    ) {
        throw new Error("Choose a version of the same session.");
    }
    if (current.fields.get("_deleted") === "true")
        throw new Error("Restore the session from Trash first.");
    const title = previous.fields.get("title") ?? "";
    if (!title.trim()) throw new Error("The selected version has no session title.");
    const fields = new Map(current.fields);
    for (const [key] of details) fields.set(key, previous.fields.get(key) ?? "");
    fields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
    fields.set("restored_from_revision", previous.revision.toString());
    return { ...current, fields };
}

/** Inspect and selectively restore session details without rewinding linked data. */
export function SessionVersionHistory(props: SessionVersionHistoryProps): JSX.Element {
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [selected, setSelected] = createSignal(1);
    const [confirming, setConfirming] = createSignal(false);
    const [error, setError] = createSignal("");

    async function load(): Promise<void> {
        setLoading(true);
        setError("");
        try {
            setHistory(
                await props.snapshot.getRecordHistory(RecordType.session, props.session.id, 10000),
            );
            setSelected(1);
            setConfirming(false);
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : "Session versions could not be loaded.",
            );
        } finally {
            setLoading(false);
        }
    }

    async function restore(): Promise<void> {
        const reviewed = history();
        const index = selected();
        if (!reviewed?.[index]) return;
        setLoading(true);
        setError("");
        try {
            const latest = await props.snapshot.getRecordHistory(
                RecordType.session,
                props.session.id,
                index + 1,
            );
            const current = latest[0];
            const previous = latest[index];
            if (
                !current ||
                !previous ||
                current.revision !== reviewed[0]?.revision ||
                previous.revision !== reviewed[index]?.revision
            ) {
                throw new Error(
                    "The session changed since history was opened. Reload before restoring.",
                );
            }
            if (await props.onRestore(current, previous)) {
                setHistory(null);
                setConfirming(false);
            }
        } catch (cause) {
            setError(
                cause instanceof Error
                    ? cause.message
                    : "The session version could not be restored.",
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <details
            class="session-version-history mt-3 border-t border-line pt-2.5"
            onToggle={(event) => {
                if (event.currentTarget.open && !history()) void load();
                if (!event.currentTarget.open) {
                    setHistory(null);
                    setConfirming(false);
                }
            }}
        >
            <summary class="cursor-pointer py-1.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Session versions
            </summary>
            <div class="session-version-content grid gap-3 py-2.5 pb-4">
                <p class="m-0">
                    Restore the title, subject and learning objectives from an earlier version.
                    Notes, recordings, links and session status stay current.
                </p>
                <Show when={error()}>
                    <p class="session-version-error m-0 text-danger" role="alert">
                        {error()}
                    </p>
                    <button
                        class={cn("button", buttonOutline)}
                        type="button"
                        disabled={loading()}
                        onClick={() => void load()}
                    >
                        Reload history
                    </button>
                </Show>
                <Show when={loading()}>
                    <p role="status" class="m-0">
                        Loading session versions…
                    </p>
                </Show>
                <Show when={!loading() && history()}>
                    {(revisions) => (
                        <Show
                            when={revisions().length > 1}
                            fallback={<p class="m-0">No earlier versions yet.</p>}
                        >
                            <label class="session-version-selector grid max-w-[28rem] gap-1.5 font-semibold">
                                Earlier version
                                <select
                                    value={selected()}
                                    onChange={(event) => {
                                        setSelected(Number(event.currentTarget.value));
                                        setConfirming(false);
                                    }}
                                    class={cn(selectBase, "max-w-full")}
                                >
                                    <For each={revisions().slice(1)}>
                                        {(record, index) => (
                                            <option value={index() + 1}>
                                                Version {record.revision.toString()} ·{" "}
                                                {dateLabel(record)}
                                            </option>
                                        )}
                                    </For>
                                </select>
                            </label>
                            <div
                                class="session-version-table overflow-hidden rounded-[5px] border border-line"
                                role="table"
                                aria-label="Session details comparison"
                            >
                                <div
                                    class="session-version-row session-version-header grid grid-cols-[minmax(7rem,0.7fr)_repeat(2,minmax(0,1fr))] bg-surface-subtle font-semibold max-sm:grid-cols-[minmax(4.5rem,0.65fr)_repeat(2,minmax(0,1fr))] max-sm:text-[13px]"
                                    role="row"
                                >
                                    <span
                                        role="columnheader"
                                        class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                    >
                                        Detail
                                    </span>
                                    <span
                                        role="columnheader"
                                        class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                    >
                                        Earlier
                                    </span>
                                    <span
                                        role="columnheader"
                                        class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                    >
                                        Current
                                    </span>
                                </div>
                                <For each={details}>
                                    {([key, label]) => (
                                        <div
                                            class="session-version-row grid grid-cols-[minmax(7rem,0.7fr)_repeat(2,minmax(0,1fr))] border-t border-line max-sm:grid-cols-[minmax(4.5rem,0.65fr)_repeat(2,minmax(0,1fr))] max-sm:text-[13px]"
                                            role="row"
                                        >
                                            <strong
                                                role="rowheader"
                                                class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                            >
                                                {label}
                                            </strong>
                                            <span
                                                role="cell"
                                                class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                            >
                                                {revisions()[selected()]?.fields.get(key) || "—"}
                                            </span>
                                            <span
                                                role="cell"
                                                class="wrap-anywhere whitespace-pre-wrap p-2.5 max-sm:p-1.5"
                                            >
                                                {revisions()[0]?.fields.get(key) || "—"}
                                            </span>
                                        </div>
                                    )}
                                </For>
                            </div>
                            <Show
                                when={!confirming()}
                                fallback={
                                    <div class="session-version-confirm flex flex-wrap items-center gap-2">
                                        <span class="text-xs text-muted">
                                            Restore these session details?
                                        </span>
                                        <button
                                            class={cn("button", buttonPrimary)}
                                            type="button"
                                            disabled={props.disabled || loading()}
                                            onClick={() => void restore()}
                                        >
                                            Confirm restore
                                        </button>
                                        <button
                                            class={cn("button", buttonOutline)}
                                            type="button"
                                            onClick={() => setConfirming(false)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                }
                            >
                                <button
                                    class={cn("button", buttonOutline)}
                                    type="button"
                                    disabled={props.disabled || loading()}
                                    onClick={() => setConfirming(true)}
                                >
                                    Restore these details
                                </button>
                            </Show>
                        </Show>
                    )}
                </Show>
            </div>
        </details>
    );
}

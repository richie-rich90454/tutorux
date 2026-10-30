import { For, Show, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import "./session-version-history.css";

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
            ? new Intl.DateTimeFormat(undefined, {
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
            class="session-version-history"
            onToggle={(event) => {
                if (event.currentTarget.open && !history()) void load();
                if (!event.currentTarget.open) {
                    setHistory(null);
                    setConfirming(false);
                }
            }}
        >
            <summary>Session versions</summary>
            <div class="session-version-content">
                <p>
                    Restore the title, subject and learning objectives from an earlier version.
                    Notes, recordings, links and session status stay current.
                </p>
                <Show when={error()}>
                    <p class="session-version-error" role="alert">
                        {error()}
                    </p>
                    <button
                        class="button button-outline"
                        type="button"
                        disabled={loading()}
                        onClick={() => void load()}
                    >
                        Reload history
                    </button>
                </Show>
                <Show when={loading()}>
                    <p role="status">Loading session versions…</p>
                </Show>
                <Show when={!loading() && history()}>
                    {(revisions) => (
                        <Show
                            when={revisions().length > 1}
                            fallback={<p>No earlier versions yet.</p>}
                        >
                            <label class="session-version-selector">
                                Earlier version
                                <select
                                    value={selected()}
                                    onChange={(event) => {
                                        setSelected(Number(event.currentTarget.value));
                                        setConfirming(false);
                                    }}
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
                                class="session-version-table"
                                role="table"
                                aria-label="Session details comparison"
                            >
                                <div class="session-version-row session-version-header" role="row">
                                    <span role="columnheader">Detail</span>
                                    <span role="columnheader">Earlier</span>
                                    <span role="columnheader">Current</span>
                                </div>
                                <For each={details}>
                                    {([key, label]) => (
                                        <div class="session-version-row" role="row">
                                            <strong role="rowheader">{label}</strong>
                                            <span role="cell">
                                                {revisions()[selected()]?.fields.get(key) || "—"}
                                            </span>
                                            <span role="cell">
                                                {revisions()[0]?.fields.get(key) || "—"}
                                            </span>
                                        </div>
                                    )}
                                </For>
                            </div>
                            <Show
                                when={!confirming()}
                                fallback={
                                    <div class="session-version-confirm">
                                        <span>Restore these session details?</span>
                                        <button
                                            class="button button-primary"
                                            type="button"
                                            disabled={props.disabled || loading()}
                                            onClick={() => void restore()}
                                        >
                                            Confirm restore
                                        </button>
                                        <button
                                            class="button button-outline"
                                            type="button"
                                            onClick={() => setConfirming(false)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                }
                            >
                                <button
                                    class="button button-outline"
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

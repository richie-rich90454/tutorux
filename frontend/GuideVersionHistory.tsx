import { buttonOutline, buttonPrimary, cn, selectBase } from "./ui";
import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { guideDraftFromRecord, renderGuideMarkdown } from "./domain/guides";

interface GuideVersionHistoryProps {
    guide: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    /** Save a restored draft as a new revision, preserving the current guide's links. */
    onRestore: (selected: ArchiveRecord, current: ArchiveRecord) => Promise<boolean>;
}

function dateLabel(record: ArchiveRecord): string {
    try {
        const micros =
            record.fields.get("updated_at_us") || record.fields.get("created_at_us") || "0";
        const milliseconds = Number(BigInt(micros) / 1000n);
        if (milliseconds <= 0 || !Number.isFinite(milliseconds)) return "Date unavailable";
        return new Intl.DateTimeFormat("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
        }).format(new Date(milliseconds));
    } catch {
        return "Date unavailable";
    }
}

/** Review earlier versions side by side before restoring one as a new revision. */
export function GuideVersionHistory(props: GuideVersionHistoryProps): JSX.Element {
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [selectedIndex, setSelectedIndex] = createSignal(1);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal("");
    const [confirming, setConfirming] = createSignal(false);
    const selected = createMemo(() => history()?.[selectedIndex()]);
    const current = createMemo(() => history()?.[0]);
    const selectedMarkdown = createMemo(() => {
        const record = selected();
        if (!record) return "";
        try {
            return renderGuideMarkdown(record);
        } catch {
            return "This version could not be displayed.";
        }
    });
    const currentMarkdown = createMemo(() => {
        const record = current();
        if (!record) return "";
        try {
            return renderGuideMarkdown(record);
        } catch {
            return "This version could not be displayed.";
        }
    });
    const changeSummary = createMemo(() => {
        const before = selected();
        const after = current();
        if (!before || !after) return "";
        try {
            const oldDraft = guideDraftFromRecord(before);
            const newDraft = guideDraftFromRecord(after);
            const oldBlocks = oldDraft.sections.reduce(
                (count, section) => count + section.blocks.length,
                0,
            );
            const newBlocks = newDraft.sections.reduce(
                (count, section) => count + section.blocks.length,
                0,
            );
            return `Earlier: ${oldDraft.sections.length} sections, ${oldBlocks} blocks · Current: ${newDraft.sections.length} sections, ${newBlocks} blocks`;
        } catch {
            return "Version details could not be read.";
        }
    });

    async function load(): Promise<void> {
        setLoading(true);
        setError("");
        try {
            const revisions = await props.snapshot.getRecordHistory(
                RecordType.guide,
                props.guide.id,
                10000,
            );
            setHistory(revisions);
            setSelectedIndex(1);
            setConfirming(false);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Guide history could not be loaded.");
        } finally {
            setLoading(false);
        }
    }

    async function restore(): Promise<void> {
        const reviewed = history();
        const index = selectedIndex();
        if (!reviewed?.[index]) return;
        setLoading(true);
        setError("");
        try {
            const latest = await props.snapshot.getRecordHistory(
                RecordType.guide,
                props.guide.id,
                index + 1,
            );
            const currentRecord = latest[0];
            const selectedRecord = latest[index];
            if (
                !currentRecord ||
                !selectedRecord ||
                currentRecord.revision !== reviewed[0]?.revision ||
                selectedRecord.revision !== reviewed[index]?.revision
            ) {
                throw new Error(
                    "The guide changed after this history was opened. Reload before restoring.",
                );
            }
            if (await props.onRestore(selectedRecord, currentRecord)) {
                setHistory(null);
                setConfirming(false);
            }
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : "The guide version could not be restored.",
            );
        } finally {
            setLoading(false);
        }
    }

    return (
        <details
            class="guide-version-history mt-4 border-t border-line pt-3"
            onToggle={(event) => {
                if (event.currentTarget.open && !history()) void load();
                if (!event.currentTarget.open) {
                    setHistory(null);
                    setConfirming(false);
                }
            }}
        >
            <summary class="cursor-pointer py-1.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Guide versions
            </summary>
            <div class="guide-version-content grid gap-3 py-2.5 pb-4">
                <p class="m-0">
                    Compare an earlier version with the current guide. Restoring saves a new
                    version.
                </p>
                <Show when={error()}>
                    <p class="guide-version-error m-0 text-danger" role="alert">
                        {error()}
                    </p>
                    <button
                        type="button"
                        class={cn("button", buttonOutline)}
                        disabled={loading()}
                        onClick={() => void load()}
                    >
                        Reload history
                    </button>
                </Show>
                <Show when={loading()}>
                    <p role="status" class="m-0">
                        Loading guide versions…
                    </p>
                </Show>
                <Show when={!loading() && history()}>
                    {(revisions) => (
                        <Show
                            when={revisions().length > 1}
                            fallback={<p class="m-0">No earlier versions yet.</p>}
                        >
                            <label class="guide-version-selector grid max-w-[28rem] gap-1.5 font-semibold">
                                Earlier version
                                <select
                                    value={selectedIndex()}
                                    onChange={(event) => {
                                        setSelectedIndex(Number(event.currentTarget.value));
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
                            <p class="guide-version-summary m-0 text-sm opacity-75">
                                {changeSummary()}
                            </p>
                            <div class="guide-version-comparison grid gap-3 md:grid-cols-2">
                                <section
                                    aria-label="Earlier guide version"
                                    class="min-w-0 rounded-[5px] border border-line p-3"
                                >
                                    <h3 class="mb-2 mt-0 text-sm font-semibold text-ink">
                                        Earlier version
                                    </h3>
                                    <pre class="m-0 max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere font-sans text-sm">
                                        {selectedMarkdown()}
                                    </pre>
                                </section>
                                <section
                                    aria-label="Current guide version"
                                    class="min-w-0 rounded-[5px] border border-line p-3"
                                >
                                    <h3 class="mb-2 mt-0 text-sm font-semibold text-ink">
                                        Current version
                                    </h3>
                                    <pre class="m-0 max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere font-sans text-sm">
                                        {currentMarkdown()}
                                    </pre>
                                </section>
                            </div>
                            <Show
                                when={!confirming()}
                                fallback={
                                    <div class="guide-version-confirm flex flex-wrap items-center gap-2">
                                        <span class="text-xs text-muted">
                                            Restore this version as a new revision?
                                        </span>
                                        <button
                                            type="button"
                                            class={cn("button", buttonPrimary)}
                                            disabled={props.disabled || loading()}
                                            onClick={() => void restore()}
                                        >
                                            Confirm restore
                                        </button>
                                        <button
                                            type="button"
                                            class={cn("button", buttonOutline)}
                                            onClick={() => setConfirming(false)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                }
                            >
                                <button
                                    type="button"
                                    class={cn("button", buttonOutline)}
                                    disabled={props.disabled || loading()}
                                    onClick={() => setConfirming(true)}
                                >
                                    Restore this version
                                </button>
                            </Show>
                        </Show>
                    )}
                </Show>
            </div>
        </details>
    );
}

import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./GuideVersionHistory.tailwind";
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
        return new Intl.DateTimeFormat(undefined, {
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
            class={twClasses("guide-version-history", jsxTailwindStyles, "details")}
            onToggle={(event) => {
                if (event.currentTarget.open && !history()) void load();
                if (!event.currentTarget.open) {
                    setHistory(null);
                    setConfirming(false);
                }
            }}
        >
            <summary class={twClasses("", jsxTailwindStyles, "summary")}>Guide versions</summary>
            <div class={twClasses("guide-version-content", jsxTailwindStyles, "div")}>
                <p class={twClasses("", jsxTailwindStyles, "p")}>
                    Compare an earlier version with the current guide. Restoring saves a new
                    version.
                </p>
                <Show when={error()}>
                    <p
                        class={twClasses("guide-version-error", jsxTailwindStyles, "p")}
                        role="alert"
                    >
                        {error()}
                    </p>
                    <button
                        type="button"
                        class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                        disabled={loading()}
                        onClick={() => void load()}
                    >
                        Reload history
                    </button>
                </Show>
                <Show when={loading()}>
                    <p role="status" class={twClasses("", jsxTailwindStyles, "p")}>
                        Loading guide versions…
                    </p>
                </Show>
                <Show when={!loading() && history()}>
                    {(revisions) => (
                        <Show
                            when={revisions().length > 1}
                            fallback={
                                <p class={twClasses("", jsxTailwindStyles, "p")}>
                                    No earlier versions yet.
                                </p>
                            }
                        >
                            <label
                                class={twClasses(
                                    "guide-version-selector",
                                    jsxTailwindStyles,
                                    "label",
                                )}
                            >
                                Earlier version
                                <select
                                    value={selectedIndex()}
                                    onChange={(event) => {
                                        setSelectedIndex(Number(event.currentTarget.value));
                                        setConfirming(false);
                                    }}
                                    class={twClasses("", jsxTailwindStyles, "select")}
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
                            <p class={twClasses("guide-version-summary", jsxTailwindStyles, "p")}>
                                {changeSummary()}
                            </p>
                            <div
                                class={twClasses(
                                    "guide-version-comparison",
                                    jsxTailwindStyles,
                                    "div",
                                )}
                            >
                                <section
                                    aria-label="Earlier guide version"
                                    class={twClasses("", jsxTailwindStyles, "section")}
                                >
                                    <h3 class={twClasses("", jsxTailwindStyles, "h3")}>
                                        Earlier version
                                    </h3>
                                    <pre class={twClasses("", jsxTailwindStyles, "pre")}>
                                        {selectedMarkdown()}
                                    </pre>
                                </section>
                                <section
                                    aria-label="Current guide version"
                                    class={twClasses("", jsxTailwindStyles, "section")}
                                >
                                    <h3 class={twClasses("", jsxTailwindStyles, "h3")}>
                                        Current version
                                    </h3>
                                    <pre class={twClasses("", jsxTailwindStyles, "pre")}>
                                        {currentMarkdown()}
                                    </pre>
                                </section>
                            </div>
                            <Show
                                when={!confirming()}
                                fallback={
                                    <div
                                        class={twClasses(
                                            "guide-version-confirm",
                                            jsxTailwindStyles,
                                            "div",
                                        )}
                                    >
                                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                                            Restore this version as a new revision?
                                        </span>
                                        <button
                                            type="button"
                                            class={twClasses(
                                                "button button-primary",
                                                jsxTailwindStyles,
                                                "button",
                                            )}
                                            disabled={props.disabled || loading()}
                                            onClick={() => void restore()}
                                        >
                                            Confirm restore
                                        </button>
                                        <button
                                            type="button"
                                            class={twClasses(
                                                "button button-outline",
                                                jsxTailwindStyles,
                                                "button",
                                            )}
                                            onClick={() => setConfirming(false)}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                }
                            >
                                <button
                                    type="button"
                                    class={twClasses(
                                        "button button-outline",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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

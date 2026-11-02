import { buttonOutline, buttonPrimary, buttonQuiet, cn } from "./ui";
import { For, Show, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { classificationLabel, decodeStudentProgress } from "./domain/student-progress";

interface StudentVersionHistoryProps {
    student: ArchiveRecord;
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    onSave: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}

const fields = [
    ["display_name", "Name"],
    ["grade", "Grade"],
    ["subjects", "Subjects"],
    ["learning_objectives", "Learning objectives"],
    ["known_difficulties", "Areas to revisit"],
    ["demonstrated_improvements", "Demonstrated improvements"],
    ["preferred_guide_template", "Preferred guide structure"],
    ["tutor_notes", "Tutor notes"],
] as const;
const field = (record: ArchiveRecord, name: string): string => record.fields.get(name) ?? "";

function dateLabel(value: string): string {
    try {
        const milliseconds = Number(BigInt(value || "0") / 1000n);
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

/** Browse earlier profile revisions and restore an explicitly selected revision. */
export function StudentVersionHistory(props: StudentVersionHistoryProps): JSX.Element {
    const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal("");
    const [confirmIndex, setConfirmIndex] = createSignal<number | null>(null);

    async function load(): Promise<void> {
        setLoading(true);
        setError("");
        try {
            setHistory(
                await props.snapshot.getRecordHistory(RecordType.student, props.student.id, 10000),
            );
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }
    async function restore(index: number): Promise<void> {
        setLoading(true);
        setError("");
        try {
            const currentHistory = await props.snapshot.getRecordHistory(
                RecordType.student,
                props.student.id,
                index + 1,
            );
            const current = currentHistory[0];
            const selected = currentHistory[index];
            const reviewed = history();
            if (
                !current ||
                !selected ||
                !reviewed?.[index] ||
                current.revision !== reviewed[0]?.revision ||
                selected.revision !== reviewed[index]?.revision
            ) {
                throw new Error(
                    "The profile changed since this history was opened. Reload it before restoring.",
                );
            }
            const restoredFields = new Map(selected.fields);
            restoredFields.delete("_deleted");
            restoredFields.delete("deleted_at_us");
            restoredFields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
            restoredFields.set("restored_from_revision", selected.revision.toString());
            if (
                await props.onSave(
                    [{ ...selected, fields: restoredFields }],
                    "Student profile restored from an earlier version.",
                )
            ) {
                setHistory(null);
                setConfirmIndex(null);
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }
    function progress(record: ArchiveRecord): string {
        try {
            const items = decodeStudentProgress(field(record, "progress_classifications"));
            return items.length
                ? items
                      .map((item) => `${item.skill}: ${classificationLabel(item.classification)}`)
                      .join(" · ")
                : "No reviewed skills";
        } catch {
            return "Progress data could not be read";
        }
    }
    return (
        <details
            class="student-version-history mt-3 border-t border-line"
            onToggle={(event) => {
                if (event.currentTarget.open && !history()) void load();
                else if (!event.currentTarget.open) {
                    setHistory(null);
                    setConfirmIndex(null);
                }
            }}
        >
            <summary class="cursor-pointer py-3.5 font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
                Profile versions
            </summary>
            <div class="student-versions-content pb-4 text-sm text-muted">
                <p class="m-0">
                    Earlier versions include profile details and tutor progress reviews. Restoring a
                    version creates a new revision.
                </p>
                <Show when={error()}>
                    <p class="student-versions-error m-0 text-danger" role="alert">
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
                        Loading profile history…
                    </p>
                </Show>
                <Show when={!loading() && history()}>
                    {(revisions) => (
                        <>
                            <Show
                                when={revisions().length > 1}
                                fallback={<p class="m-0">No earlier profile versions yet.</p>}
                            >
                                <ol class="student-versions-list m-0 mt-3 list-none p-0">
                                    <For each={revisions()}>
                                        {(version, index) => (
                                            <li class="border-t border-line-soft">
                                                <details class="pb-2.5">
                                                    <summary class="flex cursor-pointer justify-between gap-3 py-3">
                                                        <strong class="text-ink">
                                                            {index() === 0
                                                                ? "Current profile"
                                                                : `Version ${version.revision}`}
                                                        </strong>
                                                        <span>
                                                            {dateLabel(
                                                                field(version, "updated_at_us") ||
                                                                    field(version, "created_at_us"),
                                                            )}
                                                        </span>
                                                    </summary>
                                                    <dl class="mb-3.5 grid gap-2.5">
                                                        <For each={fields}>
                                                            {([name, label]) => (
                                                                <Show when={field(version, name)}>
                                                                    <div>
                                                                        <dt class="font-semibold text-ink-soft">
                                                                            {label}
                                                                        </dt>
                                                                        <dd class="mt-1 whitespace-pre-wrap wrap-anywhere">
                                                                            {field(version, name)}
                                                                        </dd>
                                                                    </div>
                                                                </Show>
                                                            )}
                                                        </For>
                                                        <div>
                                                            <dt class="font-semibold text-ink-soft">
                                                                Progress
                                                            </dt>
                                                            <dd class="mt-1 whitespace-pre-wrap wrap-anywhere">
                                                                {progress(version)}
                                                            </dd>
                                                        </div>
                                                    </dl>
                                                    <Show when={index() > 0}>
                                                        <Show
                                                            when={confirmIndex() === index()}
                                                            fallback={
                                                                <button
                                                                    class={cn(
                                                                        "button",
                                                                        buttonOutline,
                                                                    )}
                                                                    type="button"
                                                                    disabled={
                                                                        props.disabled || loading()
                                                                    }
                                                                    onClick={() =>
                                                                        setConfirmIndex(index())
                                                                    }
                                                                >
                                                                    Restore this version
                                                                </button>
                                                            }
                                                        >
                                                            <div class="student-versions-confirm flex flex-wrap items-center gap-2">
                                                                <p class="m-0 flex-1 basis-[200px]">
                                                                    Restore profile details and
                                                                    progress reviews from this
                                                                    version?
                                                                </p>
                                                                <button
                                                                    class={cn(
                                                                        "button",
                                                                        buttonQuiet,
                                                                    )}
                                                                    type="button"
                                                                    onClick={() =>
                                                                        setConfirmIndex(null)
                                                                    }
                                                                >
                                                                    Cancel
                                                                </button>
                                                                <button
                                                                    class={cn(
                                                                        "button",
                                                                        buttonPrimary,
                                                                    )}
                                                                    type="button"
                                                                    disabled={
                                                                        props.disabled || loading()
                                                                    }
                                                                    onClick={() =>
                                                                        void restore(index())
                                                                    }
                                                                >
                                                                    Restore version
                                                                </button>
                                                            </div>
                                                        </Show>
                                                    </Show>
                                                </details>
                                            </li>
                                        )}
                                    </For>
                                </ol>
                            </Show>
                        </>
                    )}
                </Show>
            </div>
        </details>
    );
}

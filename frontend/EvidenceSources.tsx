import { cn } from "./ui";
import { createSignal, For, Show, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { evidenceSourcesAreCurrent } from "./domain/evidence";

interface SourceView {
    id: string;
    label: string;
    record: ArchiveRecord | null;
    expected: string;
    error: string;
}
const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const ids = (value: string) =>
    value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/** Inspect the source records and check whether evidence still refers to their current revisions. */
export function EvidenceSources(props: {
    record: ArchiveRecord;
    snapshot: ArchiveSnapshot;
}): JSX.Element {
    const [open, setOpen] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [sources, setSources] = createSignal<SourceView[]>([]);
    const [current, setCurrent] = createSignal<boolean | null>(null);
    const [error, setError] = createSignal("");
    async function inspect(): Promise<void> {
        setLoading(true);
        setError("");
        setCurrent(null);
        try {
            const specs: { id: string; label: string; type: number; expected: string }[] = [];
            const annotationId = field(props.record, "source_annotation_id");
            if (annotationId)
                specs.push({
                    id: annotationId,
                    label: "Observation",
                    type: RecordType.annotation,
                    expected: field(props.record, "source_annotation_revision"),
                });
            const revisions = new Map(
                ids(field(props.record, "source_segment_revisions")).map((item) => {
                    const split = item.indexOf("=");
                    return [item.slice(0, split).toLowerCase(), item.slice(split + 1)];
                }),
            );
            for (const id of ids(field(props.record, "source_segment_ids")))
                specs.push({
                    id,
                    label: "Transcript",
                    type: RecordType.transcriptSegment,
                    expected: revisions.get(id.toLowerCase()) ?? "",
                });
            for (const id of ids(field(props.record, "source_asset_ids")))
                specs.push({ id, label: "Material", type: RecordType.assetMetadata, expected: "" });
            const snapshot = props.snapshot;
            const loaded = await Promise.all(
                specs.map(async (spec): Promise<SourceView> => {
                    if (!uuid.test(spec.id))
                        return { ...spec, record: null, error: "Invalid source ID" };
                    try {
                        return {
                            ...spec,
                            record: await snapshot.getRecord(spec.type, spec.id),
                            error: "",
                        };
                    } catch (cause) {
                        return {
                            ...spec,
                            record: null,
                            error: cause instanceof Error ? cause.message : String(cause),
                        };
                    }
                }),
            );
            setSources(loaded);
            setCurrent(await evidenceSourcesAreCurrent(props.snapshot, props.record));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setLoading(false);
        }
    }
    function toggle(): void {
        if (!open()) void inspect();
        setOpen((value) => !value);
    }
    return (
        <section class={cn("evidence-sources", "mt-2")}>
            <button
                type="button"
                class={cn(
                    "button button-quiet record-action",
                    "active:translate-y-px items-center rounded-[7px] border border-transparent cursor-pointer inline-flex font-semibold gap-2 justify-center no-underline transition-colors whitespace-nowrap hover:bg-accent-soft bg-transparent text-xs min-h-[30px] py-0 px-[9px] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                )}
                aria-expanded={open()}
                onClick={toggle}
            >
                {open() ? "Hide sources" : "Inspect sources"}
            </button>
            <Show when={open()}>
                <div
                    class={cn(
                        "evidence-sources-panel",
                        "bg-surface-subtle rounded-[5px] border border-line grid gap-2.5 mt-2 p-3",
                    )}
                >
                    <div
                        class={cn(
                            "evidence-sources-heading",
                            "items-center flex gap-2 justify-between",
                        )}
                    >
                        <strong>Source records</strong>
                        <button
                            type="button"
                            class={cn(
                                "button button-quiet record-action",
                                "active:translate-y-px items-center rounded-[7px] border border-transparent cursor-pointer inline-flex font-semibold gap-2 justify-center no-underline transition-colors whitespace-nowrap hover:bg-accent-soft bg-transparent text-xs min-h-[30px] py-0 px-[9px] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                            )}
                            disabled={loading()}
                            onClick={() => void inspect()}
                        >
                            Recheck
                        </button>
                    </div>
                    <Show when={loading()}>
                        <p class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap">
                            Checking sources…
                        </p>
                    </Show>
                    <Show when={error()}>
                        <p
                            role="alert"
                            class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap"
                        >
                            {error()}
                        </p>
                    </Show>
                    <Show when={!loading() && current() !== null}>
                        <p
                            role="status"
                            class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap"
                        >
                            {current()
                                ? "Sources are current and belong to this session."
                                : "One or more sources are missing, changed, or outside this session."}
                        </p>
                    </Show>
                    <Show when={!loading() && sources().length === 0 && !error()}>
                        <p class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap">
                            No source records were recorded.
                        </p>
                    </Show>
                    <For each={sources()}>
                        {(source) => (
                            <article
                                class={cn(
                                    "evidence-source-item",
                                    "border-t border-t-line grid gap-[5px] pt-2",
                                )}
                            >
                                <div class="flex flex-wrap gap-1.5 justify-between">
                                    <strong>{source.label}</strong>
                                    <small class="text-muted wrap-anywhere">{source.id}</small>
                                </div>
                                <Show
                                    when={source.record}
                                    fallback={
                                        <p class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap">
                                            {source.error || "Source unavailable"}
                                        </p>
                                    }
                                >
                                    {(record) => (
                                        <>
                                            <p class="text-muted text-[0.8rem] m-0 wrap-anywhere whitespace-pre-wrap">
                                                {field(record(), "title") ||
                                                    field(record(), "filename") ||
                                                    field(record(), "text") ||
                                                    field(record(), "content") ||
                                                    "Untitled source"}
                                            </p>
                                            <small class="text-muted wrap-anywhere">
                                                Current version {record().revision.toString()}
                                                {source.expected
                                                    ? ` · cited version ${source.expected}`
                                                    : ""}
                                                {field(record(), "_deleted") === "true"
                                                    ? " · in Trash"
                                                    : ""}
                                            </small>
                                        </>
                                    )}
                                </Show>
                            </article>
                        )}
                    </For>
                </div>
            </Show>
        </section>
    );
}

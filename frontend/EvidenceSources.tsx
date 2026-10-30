import { createSignal, For, Show, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { evidenceSourcesAreCurrent } from "./domain/evidence";
import "./evidence-sources.css";

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
        <section class="evidence-sources">
            <button
                type="button"
                class="button button-quiet record-action"
                aria-expanded={open()}
                onClick={toggle}
            >
                {open() ? "Hide sources" : "Inspect sources"}
            </button>
            <Show when={open()}>
                <div class="evidence-sources-panel">
                    <div class="evidence-sources-heading">
                        <strong>Source records</strong>
                        <button
                            type="button"
                            class="button button-quiet record-action"
                            disabled={loading()}
                            onClick={() => void inspect()}
                        >
                            Recheck
                        </button>
                    </div>
                    <Show when={loading()}>
                        <p>Checking sources…</p>
                    </Show>
                    <Show when={error()}>
                        <p role="alert">{error()}</p>
                    </Show>
                    <Show when={!loading() && current() !== null}>
                        <p role="status">
                            {current()
                                ? "Sources are current and belong to this session."
                                : "One or more sources are missing, changed, or outside this session."}
                        </p>
                    </Show>
                    <Show when={!loading() && sources().length === 0 && !error()}>
                        <p>No source records were recorded.</p>
                    </Show>
                    <For each={sources()}>
                        {(source) => (
                            <article class="evidence-source-item">
                                <div>
                                    <strong>{source.label}</strong>
                                    <small>{source.id}</small>
                                </div>
                                <Show
                                    when={source.record}
                                    fallback={<p>{source.error || "Source unavailable"}</p>}
                                >
                                    {(record) => (
                                        <>
                                            <p>
                                                {field(record(), "title") ||
                                                    field(record(), "filename") ||
                                                    field(record(), "text") ||
                                                    field(record(), "content") ||
                                                    "Untitled source"}
                                            </p>
                                            <small>
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

import { For, Show, createSignal, type JSX } from "solid-js";
import {
    makeJournalCollectionRecord,
    makeJournalTagRecord,
    updateJournalOrganizerRecord,
    type JournalCollectionInput,
    type JournalTagInput,
} from "./domain/records";
import type { ArchiveRecord } from "./archive/format";

type Editor = { kind: "collection" | "tag"; record: ArchiveRecord | null } | null;

interface Props {
    collections: ArchiveRecord[];
    tags: ArchiveRecord[];
    archived: ArchiveRecord[];
    disabled: boolean;
    busy: boolean;
    onSave(record: ArchiveRecord, message: string): Promise<boolean>;
    onArchive(record: ArchiveRecord): void;
    onRestore(record: ArchiveRecord): void;
}

const palette = ["#6f8f7b", "#bf8057", "#7185ad", "#ad7180", "#a18b52", "#7b7799"];

export function JournalOrganizer(props: Props): JSX.Element {
    const [editor, setEditor] = createSignal<Editor>(null);
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [color, setColor] = createSignal(palette[0]!);
    const [error, setError] = createSignal("");

    function start(kind: "collection" | "tag", record: ArchiveRecord | null = null): void {
        setEditor({ kind, record });
        setName(record?.fields.get("name") ?? "");
        setDescription(record?.fields.get("description") ?? "");
        setColor(record?.fields.get("color") || palette[0]!);
        setError("");
    }

    async function save(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const active = editor();
        if (!active) return;
        setError("");
        const normalized = name().trim().toLocaleLowerCase();
        const siblings = active.kind === "collection" ? props.collections : props.tags;
        if (
            siblings.some(
                (item) =>
                    item.id !== active.record?.id &&
                    (item.fields.get("name") ?? "").trim().toLocaleLowerCase() === normalized,
            )
        ) {
            setError(`A ${active.kind} with that name already exists.`);
            return;
        }
        try {
            const input: JournalCollectionInput | JournalTagInput =
                active.kind === "collection"
                    ? { name: name(), description: description(), color: color() }
                    : { name: name(), color: color() };
            const record = active.record
                ? updateJournalOrganizerRecord(active.record, input)
                : active.kind === "collection"
                  ? makeJournalCollectionRecord(input as JournalCollectionInput)
                  : makeJournalTagRecord(input as JournalTagInput);
            if (
                await props.onSave(
                    record,
                    active.record ? `${active.kind} updated.` : `${active.kind} created.`,
                )
            ) {
                setEditor(null);
            }
        } catch (caught) {
            setError(
                caught instanceof Error ? caught.message : "Could not save this journal label.",
            );
        }
    }

    return (
        <section class="journal-organizer" aria-labelledby="journal-organizer-title">
            <div class="journal-organizer-heading">
                <div>
                    <span class="eyebrow">Make reflections easier to return to</span>
                    <h2 id="journal-organizer-title">Collections & tags</h2>
                    <p>Group related notes, then find them again by the way you work.</p>
                </div>
                <div class="journal-organizer-actions">
                    <button
                        class="button button-outline"
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => start("collection")}
                    >
                        New collection
                    </button>
                    <button
                        class="button button-primary"
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => start("tag")}
                    >
                        New tag
                    </button>
                </div>
            </div>

            <div class="journal-organizer-lists">
                <OrganizerList
                    title="Collections"
                    hint="A home for connected reflections"
                    records={props.collections}
                    disabled={props.disabled || props.busy}
                    onEdit={(record) => start("collection", record)}
                    onArchive={props.onArchive}
                />
                <OrganizerList
                    title="Tags"
                    hint="Small labels for a useful detail"
                    records={props.tags}
                    disabled={props.disabled || props.busy}
                    onEdit={(record) => start("tag", record)}
                    onArchive={props.onArchive}
                />
            </div>

            <Show when={props.archived.length > 0}>
                <details class="journal-archived-labels">
                    <summary>Archived labels · {props.archived.length}</summary>
                    <div class="journal-archived-list">
                        <For each={props.archived}>
                            {(record) => (
                                <div class="journal-archived-row">
                                    <span>{record.fields.get("name") || "Unnamed label"}</span>
                                    <small>
                                        {record.fields.get("record_role") === "journal-tag"
                                            ? "Tag"
                                            : "Collection"}
                                    </small>
                                    <button
                                        class="text-action"
                                        type="button"
                                        disabled={props.busy}
                                        onClick={() => props.onRestore(record)}
                                    >
                                        Restore
                                    </button>
                                </div>
                            )}
                        </For>
                    </div>
                </details>
            </Show>

            <Show when={editor()}>
                {(active) => (
                    <form class="journal-label-editor" onSubmit={save}>
                        <div class="journal-label-editor-title">
                            <div>
                                <span class="eyebrow">
                                    {active().record ? "REFINE YOUR LABEL" : "ADD TO YOUR JOURNAL"}
                                </span>
                                <h3>
                                    {active().record ? "Edit" : "New"} {active().kind}
                                </h3>
                            </div>
                            <button
                                class="icon-button"
                                type="button"
                                aria-label="Close label editor"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                ×
                            </button>
                        </div>
                        <label class="form-field">
                            Name
                            <input
                                autofocus
                                value={name()}
                                maxlength={active().kind === "collection" ? 256 : 128}
                                required
                                onInput={(event) => setName(event.currentTarget.value)}
                                placeholder={
                                    active().kind === "collection"
                                        ? "e.g. Building confidence"
                                        : "e.g. fractions"
                                }
                            />
                        </label>
                        <Show when={active().kind === "collection"}>
                            <label class="form-field">
                                Description <span class="optional">Optional</span>
                                <textarea
                                    rows="2"
                                    maxlength="4096"
                                    value={description()}
                                    onInput={(event) => setDescription(event.currentTarget.value)}
                                    placeholder="What belongs in this collection?"
                                />
                            </label>
                        </Show>
                        <label class="form-field journal-color-field">
                            Color <span class="optional">Optional</span>
                            <div class="journal-color-control">
                                <input
                                    type="color"
                                    value={color()}
                                    onInput={(event) => setColor(event.currentTarget.value)}
                                />
                                <div class="journal-color-swatches" aria-label="Suggested colors">
                                    <For each={palette}>
                                        {(swatch) => (
                                            <button
                                                class="journal-color-swatch"
                                                classList={{ selected: color() === swatch }}
                                                type="button"
                                                style={{ "--swatch": swatch }}
                                                aria-label={`Use ${swatch}`}
                                                aria-pressed={color() === swatch}
                                                onClick={() => setColor(swatch)}
                                            />
                                        )}
                                    </For>
                                </div>
                            </div>
                        </label>
                        <Show when={error()}>
                            <p class="form-error" role="alert">
                                {error()}
                            </p>
                        </Show>
                        <div class="dialog-actions">
                            <button
                                class="button button-outline"
                                type="button"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                Cancel
                            </button>
                            <button
                                class="button button-primary"
                                type="submit"
                                disabled={props.disabled || props.busy}
                            >
                                {props.busy
                                    ? "Saving…"
                                    : active().record
                                      ? "Save changes"
                                      : `Create ${active().kind}`}
                            </button>
                        </div>
                    </form>
                )}
            </Show>
        </section>
    );
}

function OrganizerList(props: {
    title: string;
    hint: string;
    records: ArchiveRecord[];
    disabled: boolean;
    onEdit(record: ArchiveRecord): void;
    onArchive(record: ArchiveRecord): void;
}): JSX.Element {
    return (
        <section class="journal-organizer-list" aria-label={props.title}>
            <div class="journal-organizer-list-heading">
                <h3>{props.title}</h3>
                <small>{props.records.length}</small>
            </div>
            <Show
                when={props.records.length > 0}
                fallback={<p class="journal-organizer-empty">{props.hint}. Nothing here yet.</p>}
            >
                <div class="journal-label-list">
                    <For
                        each={[...props.records].sort((left, right) =>
                            (left.fields.get("name") ?? "").localeCompare(
                                right.fields.get("name") ?? "",
                            ),
                        )}
                    >
                        {(record) => (
                            <div class="journal-label-row">
                                <span
                                    class="journal-label-dot"
                                    style={{
                                        "--label-color": safeLabelColor(record.fields.get("color")),
                                    }}
                                />
                                <span
                                    class="journal-label-name"
                                    title={record.fields.get("description") ?? ""}
                                >
                                    {record.fields.get("name") || "Unnamed label"}
                                </span>
                                <button
                                    class="text-action"
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={() => props.onEdit(record)}
                                >
                                    Edit
                                </button>
                                <button
                                    class="icon-button journal-label-archive"
                                    type="button"
                                    disabled={props.disabled}
                                    aria-label={`Archive ${record.fields.get("name") || "label"}`}
                                    title="Archive label"
                                    onClick={() => props.onArchive(record)}
                                >
                                    ×
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </section>
    );
}

function safeLabelColor(color: string | undefined): string {
    return color && /^#[\da-f]{6}$/iu.test(color) ? color : "var(--accent)";
}

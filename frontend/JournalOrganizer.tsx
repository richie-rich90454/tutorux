import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./JournalOrganizer.tailwind";
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
    const [colorText, setColorText] = createSignal(palette[0]!);
    const [colorInvalid, setColorInvalid] = createSignal(false);
    const [error, setError] = createSignal("");
    const hasLabels = () => props.collections.length > 0 || props.tags.length > 0;

    function start(kind: "collection" | "tag", record: ArchiveRecord | null = null): void {
        const initialColor = safeLabelColor(record?.fields.get("color"));
        const selectedColor = initialColor.startsWith("#") ? initialColor : palette[0]!;
        setEditor({ kind, record });
        setName(record?.fields.get("name") ?? "");
        setDescription(record?.fields.get("description") ?? "");
        setColor(selectedColor);
        setColorText(selectedColor);
        setColorInvalid(false);
        setError("");
    }

    async function save(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const active = editor();
        if (!active) return;
        setError("");
        if (colorInvalid()) {
            setError("Enter a six-digit hex color, such as #42666A.");
            return;
        }
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
        <section
            class={twClasses("journal-organizer", jsxTailwindStyles, "section")}
            aria-labelledby="journal-organizer-title"
        >
            <div class={twClasses("journal-organizer-heading", jsxTailwindStyles, "div")}>
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                        Make reflections easier to return to
                    </span>
                    <h2 id="journal-organizer-title" class={twClasses("", jsxTailwindStyles, "h2")}>
                        Collections & tags
                    </h2>
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                        Group related notes, then find them again by the way you work.
                    </p>
                </div>
                <div class={twClasses("journal-organizer-actions", jsxTailwindStyles, "div")}>
                    <button
                        class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => start("collection")}
                    >
                        New collection
                    </button>
                    <button
                        class={twClasses("button button-primary", jsxTailwindStyles, "button")}
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => start("tag")}
                    >
                        New tag
                    </button>
                </div>
            </div>

            <Show
                when={hasLabels()}
                fallback={
                    <p class={twClasses("journal-organizer-empty-summary", jsxTailwindStyles, "p")}>
                        Add a collection to group related notes, or a tag to make them easier to
                        find.
                    </p>
                }
            >
                <div class={twClasses("journal-organizer-lists", jsxTailwindStyles, "div")}>
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
            </Show>

            <Show when={props.archived.length > 0}>
                <details class={twClasses("journal-archived-labels", jsxTailwindStyles, "details")}>
                    <summary class={twClasses("", jsxTailwindStyles, "summary")}>
                        Archived labels · {props.archived.length}
                    </summary>
                    <div class={twClasses("journal-archived-list", jsxTailwindStyles, "div")}>
                        <For each={props.archived}>
                            {(record) => (
                                <div
                                    class={twClasses(
                                        "journal-archived-row",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                >
                                    <span class={twClasses("", jsxTailwindStyles, "span")}>
                                        {record.fields.get("name") || "Unnamed label"}
                                    </span>
                                    <small class={twClasses("", jsxTailwindStyles, "small")}>
                                        {record.fields.get("record_role") === "journal-tag"
                                            ? "Tag"
                                            : "Collection"}
                                    </small>
                                    <button
                                        class={twClasses(
                                            "text-action",
                                            jsxTailwindStyles,
                                            "button",
                                        )}
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
                    <form
                        class={twClasses("journal-label-editor", jsxTailwindStyles, "form")}
                        onSubmit={save}
                    >
                        <div
                            class={twClasses(
                                "journal-label-editor-title",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                    {active().record ? "REFINE YOUR LABEL" : "ADD TO YOUR JOURNAL"}
                                </span>
                                <h3 class={twClasses("", jsxTailwindStyles, "h3")}>
                                    {active().record ? "Edit" : "New"} {active().kind}
                                </h3>
                            </div>
                            <button
                                class={twClasses("icon-button", jsxTailwindStyles, "button")}
                                type="button"
                                aria-label="Close label editor"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                ×
                            </button>
                        </div>
                        <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
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
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                        <Show when={active().kind === "collection"}>
                            <label class={twClasses("form-field", jsxTailwindStyles, "label")}>
                                Description{" "}
                                <span class={twClasses("optional", jsxTailwindStyles, "span")}>
                                    Optional
                                </span>
                                <textarea
                                    rows="2"
                                    maxlength="4096"
                                    value={description()}
                                    onInput={(event) => setDescription(event.currentTarget.value)}
                                    placeholder="What belongs in this collection?"
                                    class={twClasses("", jsxTailwindStyles, "textarea")}
                                />
                            </label>
                        </Show>
                        <label
                            class={twClasses(
                                "form-field journal-color-field",
                                jsxTailwindStyles,
                                "label",
                            )}
                        >
                            Color{" "}
                            <span class={twClasses("optional", jsxTailwindStyles, "span")}>
                                Optional
                            </span>
                            <div
                                class={twClasses("journal-color-control", jsxTailwindStyles, "div")}
                            >
                                <input
                                    type="text"
                                    class={twClasses(
                                        "journal-color-value",
                                        jsxTailwindStyles,
                                        "input",
                                    )}
                                    value={colorText()}
                                    maxlength="7"
                                    autocapitalize="off"
                                    spellcheck={false}
                                    aria-label="Custom hex color"
                                    aria-invalid={colorInvalid()}
                                    placeholder="#42666A"
                                    onInput={(event) => {
                                        const value = event.currentTarget.value;
                                        setColorText(value);
                                        const valid = /^#[0-9a-f]{6}$/iu.test(value);
                                        setColorInvalid(!valid);
                                        if (valid) setColor(value);
                                        setError("");
                                    }}
                                />
                                <div
                                    class={twClasses(
                                        "journal-color-swatches",
                                        jsxTailwindStyles,
                                        "div",
                                    )}
                                    aria-label="Suggested colors"
                                >
                                    <For each={palette}>
                                        {(swatch) => (
                                            <button
                                                class={twClasses(
                                                    "journal-color-swatch",
                                                    jsxTailwindStyles,
                                                    "button",
                                                    ["selected"],
                                                )}
                                                classList={{ selected: color() === swatch }}
                                                type="button"
                                                style={{ "--swatch": swatch }}
                                                aria-label={`Use ${swatch}`}
                                                aria-pressed={color() === swatch}
                                                onClick={() => {
                                                    setColor(swatch);
                                                    setColorText(swatch);
                                                    setColorInvalid(false);
                                                }}
                                            />
                                        )}
                                    </For>
                                </div>
                            </div>
                        </label>
                        <Show when={error()}>
                            <p class={twClasses("form-error", jsxTailwindStyles, "p")} role="alert">
                                {error()}
                            </p>
                        </Show>
                        <div class={twClasses("dialog-actions", jsxTailwindStyles, "div")}>
                            <button
                                class={twClasses(
                                    "button button-outline",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                Cancel
                            </button>
                            <button
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
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
        <section
            class={twClasses("journal-organizer-list", jsxTailwindStyles, "section")}
            aria-label={props.title}
        >
            <div class={twClasses("journal-organizer-list-heading", jsxTailwindStyles, "div")}>
                <h3 class={twClasses("", jsxTailwindStyles, "h3")}>{props.title}</h3>
                <small class={twClasses("", jsxTailwindStyles, "small")}>
                    {props.records.length}
                </small>
            </div>
            <Show
                when={props.records.length > 0}
                fallback={
                    <p class={twClasses("journal-organizer-empty", jsxTailwindStyles, "p")}>
                        {props.hint}. Nothing here yet.
                    </p>
                }
            >
                <div class={twClasses("journal-label-list", jsxTailwindStyles, "div")}>
                    <For
                        each={[...props.records].sort((left, right) =>
                            (left.fields.get("name") ?? "").localeCompare(
                                right.fields.get("name") ?? "",
                            ),
                        )}
                    >
                        {(record) => (
                            <div class={twClasses("journal-label-row", jsxTailwindStyles, "div")}>
                                <span
                                    class={twClasses(
                                        "journal-label-dot",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                    style={{
                                        "--label-color": safeLabelColor(record.fields.get("color")),
                                    }}
                                />
                                <span
                                    class={twClasses(
                                        "journal-label-name",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                    title={record.fields.get("description") ?? ""}
                                >
                                    {record.fields.get("name") || "Unnamed label"}
                                </span>
                                <button
                                    class={twClasses("text-action", jsxTailwindStyles, "button")}
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={() => props.onEdit(record)}
                                >
                                    Edit
                                </button>
                                <button
                                    class={twClasses(
                                        "icon-button journal-label-archive",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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

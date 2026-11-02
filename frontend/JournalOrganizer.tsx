import {
    buttonOutline,
    buttonPrimary,
    cn,
    iconButton,
    inputBase,
    labelBase,
    textareaBase,
} from "./ui";
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
            class="journal-organizer -mt-0.5 mb-4 rounded-[5px] border border-line bg-surface px-5 py-4"
            aria-labelledby="journal-organizer-title"
        >
            <div class="journal-organizer-heading flex flex-col items-start gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                    <span class="text-xs font-bold tracking-widest text-faint">
                        Make reflections easier to return to
                    </span>
                    <h2
                        id="journal-organizer-title"
                        class="mb-0.5 mt-1 text-base font-semibold tracking-tight text-ink"
                    >
                        Collections & tags
                    </h2>
                    <p class="m-0 text-xs leading-relaxed text-muted">
                        Group related notes, then find them again by the way you work.
                    </p>
                </div>
                <div class="journal-organizer-actions flex flex-wrap gap-2 max-md:w-full">
                    <button
                        class={cn("button flex-1 md:flex-none", buttonOutline)}
                        type="button"
                        disabled={props.disabled || props.busy}
                        onClick={() => start("collection")}
                    >
                        New collection
                    </button>
                    <button
                        class={cn("button flex-1 md:flex-none", buttonPrimary)}
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
                    <p class="journal-organizer-empty-summary mt-3 text-[13px] leading-snug text-muted">
                        Add a collection to group related notes, or a tag to make them easier to
                        find.
                    </p>
                }
            >
                <div class="journal-organizer-lists mt-4 grid gap-3 sm:grid-cols-2">
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
                <details class="journal-archived-labels mt-3 border-t border-line-soft pt-2">
                    <summary class="w-fit cursor-pointer text-xs text-muted">
                        Archived labels · {props.archived.length}
                    </summary>
                    <div class="journal-archived-list mt-2 grid gap-1">
                        <For each={props.archived}>
                            {(record) => (
                                <div class="journal-archived-row flex min-h-[29px] items-center gap-2 text-xs text-ink-soft">
                                    <span class="flex-1">
                                        {record.fields.get("name") || "Unnamed label"}
                                    </span>
                                    <small class="text-xs text-faint">
                                        {record.fields.get("record_role") === "journal-tag"
                                            ? "Tag"
                                            : "Collection"}
                                    </small>
                                    <button
                                        class="text-action inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 py-0.5 text-xs font-semibold text-accent hover:text-accent-hover"
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
                        class="journal-label-editor mt-3 grid gap-2.5 rounded-[5px] border border-accent/25 bg-surface p-3.5 sm:grid-cols-[minmax(0,1fr)_minmax(120px,0.7fr)]"
                        onSubmit={save}
                    >
                        <div class="journal-label-editor-title flex items-center justify-between gap-4 sm:col-span-2">
                            <div>
                                <span class="text-xs font-bold tracking-widest text-faint">
                                    {active().record ? "REFINE YOUR LABEL" : "ADD TO YOUR JOURNAL"}
                                </span>
                                <h3 class="mt-0.5 text-[13px] font-semibold capitalize text-ink">
                                    {active().record ? "Edit" : "New"} {active().kind}
                                </h3>
                            </div>
                            <button
                                class={cn("icon-button", iconButton)}
                                type="button"
                                aria-label="Close label editor"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                ×
                            </button>
                        </div>
                        <label class={cn("form-field", labelBase)}>
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
                                class={inputBase}
                            />
                        </label>
                        <Show when={active().kind === "collection"}>
                            <label class={cn("form-field sm:col-span-2", labelBase)}>
                                Description{" "}
                                <span class="text-xs font-normal text-faint">Optional</span>
                                <textarea
                                    rows="2"
                                    maxlength="4096"
                                    value={description()}
                                    onInput={(event) => setDescription(event.currentTarget.value)}
                                    placeholder="What belongs in this collection?"
                                    class={cn(textareaBase, "min-h-[72px] py-2.5")}
                                />
                            </label>
                        </Show>
                        <label class={cn("form-field journal-color-field", labelBase)}>
                            Color <span class="text-xs font-normal text-faint">Optional</span>
                            <div class="journal-color-control flex min-h-[33px] items-center gap-2.5">
                                <input
                                    type="text"
                                    class={cn(
                                        "journal-color-value h-8 w-[88px] rounded-[7px] border border-line bg-surface px-2 text-xs uppercase tabular-nums text-ink-soft",
                                        "aria-invalid:border-danger",
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
                                    class="journal-color-swatches flex flex-wrap gap-1.5"
                                    aria-label="Suggested colors"
                                >
                                    <For each={palette}>
                                        {(swatch) => (
                                            <button
                                                class="journal-color-swatch h-[17px] w-[17px] cursor-pointer rounded-full border-2 border-surface bg-[var(--swatch)] p-0 outline outline-1 outline-transparent focus-visible:outline-ink-soft aria-pressed:outline-ink-soft"
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
                            <p
                                class="form-error m-0 text-xs text-danger sm:col-span-2"
                                role="alert"
                            >
                                {error()}
                            </p>
                        </Show>
                        <div class="dialog-actions mt-1 flex justify-end gap-2 border-t border-line-soft pt-3 sm:col-span-2">
                            <button
                                class={cn("button", buttonOutline)}
                                type="button"
                                disabled={props.busy}
                                onClick={() => setEditor(null)}
                            >
                                Cancel
                            </button>
                            <button
                                class={cn("button", buttonPrimary)}
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
            class="journal-organizer-list min-w-0 rounded-[5px] border border-line-soft bg-surface-subtle/50 px-3 py-2.5"
            aria-label={props.title}
        >
            <div class="journal-organizer-list-heading mb-2 flex items-center justify-between gap-4">
                <h3 class="m-0 text-xs font-semibold text-ink-soft">{props.title}</h3>
                <small class="text-xs text-faint">{props.records.length}</small>
            </div>
            <Show
                when={props.records.length > 0}
                fallback={
                    <p class="journal-organizer-empty py-1 text-xs text-muted">
                        {props.hint}. Nothing here yet.
                    </p>
                }
            >
                <div class="journal-label-list grid gap-1">
                    <For
                        each={[...props.records].sort((left, right) =>
                            (left.fields.get("name") ?? "").localeCompare(
                                right.fields.get("name") ?? "",
                            ),
                        )}
                    >
                        {(record) => (
                            <div class="journal-label-row flex min-h-[30px] min-w-0 items-center gap-2">
                                <span
                                    class="journal-label-dot h-2 w-2 shrink-0 rounded-full bg-[var(--label-color)]"
                                    style={{
                                        "--label-color": safeLabelColor(record.fields.get("color")),
                                    }}
                                />
                                <span
                                    class="journal-label-name min-w-0 flex-1 truncate text-xs text-ink-soft"
                                    title={record.fields.get("description") ?? ""}
                                >
                                    {record.fields.get("name") || "Unnamed label"}
                                </span>
                                <button
                                    class="text-action inline-flex cursor-pointer items-center gap-1.5 border-0 bg-transparent px-0 py-0.5 text-xs font-semibold text-accent hover:text-accent-hover"
                                    type="button"
                                    disabled={props.disabled}
                                    onClick={() => props.onEdit(record)}
                                >
                                    Edit
                                </button>
                                <button
                                    class="icon-button journal-label-archive inline-grid h-[23px] w-[23px] shrink-0 place-items-center rounded-[5px] p-0 text-[13px] text-faint transition-colors hover:bg-surface-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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

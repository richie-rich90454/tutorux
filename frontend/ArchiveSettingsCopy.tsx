import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./ArchiveSettingsCopy.tailwind";
import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { openArchiveSource, verifyArchiveSnapshot, type ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { prepareArchiveSettingsCopy, type ArchiveSettingsCopyPlan } from "./archive-settings-copy";
import { platform } from "@platform";

interface ArchiveSettingsCopyProps {
    archiveId: string;
    archiveGeneration: string;
    settings: readonly ArchiveRecord[];
    disabled: boolean;
    onSave: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}

/** Reviewed, credential-safe transfer of ordinary settings between archive files. */
export function ArchiveSettingsCopy(props: ArchiveSettingsCopyProps): JSX.Element {
    const [opening, setOpening] = createSignal(false);
    const [saving, setSaving] = createSignal(false);
    const [sourceSnapshot, setSourceSnapshot] = createSignal<ArchiveSnapshot | null>(null);
    const [sourceName, setSourceName] = createSignal("");
    const [sourcePassphrase, setSourcePassphrase] = createSignal("");
    const [plan, setPlan] = createSignal<ArchiveSettingsCopyPlan | null>(null);
    const [reviewTargetId, setReviewTargetId] = createSignal("");
    const [reviewTargetGeneration, setReviewTargetGeneration] = createSignal("");
    const [error, setError] = createSignal("");
    const [status, setStatus] = createSignal("");
    let passphraseInput: HTMLInputElement | undefined;

    createEffect(() => {
        if (!sourceSnapshot()) return;
        queueMicrotask(() => passphraseInput?.focus());
    });

    async function closeSource(): Promise<void> {
        const snapshot = sourceSnapshot();
        setSourceSnapshot(null);
        snapshot?.lock();
        await snapshot?.source.close?.().catch(() => undefined);
    }

    function clearReview(): void {
        setPlan(null);
        setSourceName("");
        setSourcePassphrase("");
        setReviewTargetId("");
        setReviewTargetGeneration("");
        setError("");
    }

    async function discard(): Promise<void> {
        await closeSource();
        clearReview();
    }

    onCleanup(() => {
        const snapshot = sourceSnapshot();
        snapshot?.lock();
        void snapshot?.source.close?.();
    });

    async function prepare(snapshot: ArchiveSnapshot): Promise<void> {
        setError("");
        setOpening(true);
        try {
            await verifyArchiveSnapshot(snapshot);
            const manifest = await snapshot.getManifest();
            if (snapshot.header.id.toLowerCase() === props.archiveId.toLowerCase()) {
                throw new Error("Choose a different archive from the one that is currently open.");
            }
            const sourceSettings = await snapshot.listRecords(RecordType.settings);
            const copyPlan = prepareArchiveSettingsCopy(sourceSettings, props.settings);
            setPlan(copyPlan);
            setSourceName(manifest.displayName || "Untitled archive");
            setReviewTargetId(props.archiveId.toLowerCase());
            setReviewTargetGeneration(props.archiveGeneration);
            setStatus("");
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            snapshot.lock();
            await snapshot.source.close?.().catch(() => undefined);
            setSourceSnapshot(null);
            setOpening(false);
            setSourcePassphrase("");
            if (passphraseInput) passphraseInput.value = "";
        }
    }

    async function chooseSource(): Promise<void> {
        if (props.disabled || opening() || saving()) return;
        setError("");
        setStatus("");
        setPlan(null);
        setOpening(true);
        let openedArchive: Awaited<ReturnType<typeof platform.openArchive>> = null;
        let sourceSnapshot: ArchiveSnapshot | null = null;
        try {
            const opened = await platform.openArchive();
            if (!opened) return;
            openedArchive = opened;
            sourceSnapshot = await openArchiveSource(opened.source);
            const snapshot = sourceSnapshot;
            if (snapshot.header.id.toLowerCase() === props.archiveId.toLowerCase()) {
                snapshot.lock();
                await snapshot.source.close?.();
                sourceSnapshot = null;
                openedArchive = null;
                throw new Error("Choose a different archive from the one that is currently open.");
            }
            setSourceName(opened.name);
            if (snapshot.locked) {
                setSourceSnapshot(snapshot);
                sourceSnapshot = null;
                openedArchive = null;
                return;
            }
            await prepare(snapshot);
            sourceSnapshot = null;
            openedArchive = null;
        } catch (cause) {
            sourceSnapshot?.lock();
            await sourceSnapshot?.source.close?.().catch(() => undefined);
            await openedArchive?.source.close?.().catch(() => undefined);
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setOpening(false);
        }
    }

    async function unlockSource(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        const snapshot = sourceSnapshot();
        if (!snapshot || !sourcePassphrase()) return;
        const passphrase = sourcePassphrase();
        setSourcePassphrase("");
        if (passphraseInput) passphraseInput.value = "";
        setOpening(true);
        setError("");
        try {
            const unlocked = await snapshot.unlock(passphrase);
            if (unlocked !== snapshot) snapshot.lock();
            await prepare(unlocked);
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            setOpening(false);
        }
    }

    async function copySettings(): Promise<void> {
        const currentPlan = plan();
        if (!currentPlan || saving() || props.disabled) return;
        if (
            reviewTargetId() !== props.archiveId.toLowerCase() ||
            reviewTargetGeneration() !== props.archiveGeneration
        ) {
            clearReview();
            setError(
                "The open archive changed. Choose the source archive and review the copy again.",
            );
            return;
        }
        if (!currentPlan.records.length) return;

        setSaving(true);
        setError("");
        try {
            const saved = await props.onSave(
                currentPlan.records,
                `Copied ${currentPlan.records.length} ordinary setting${currentPlan.records.length === 1 ? "" : "s"} from ${sourceName()}. Save the workspace to write the new generation to disk.`,
            );
            if (saved) {
                setStatus(
                    `Copied ${currentPlan.additions} new setting${currentPlan.additions === 1 ? "" : "s"} and replaced ${currentPlan.replacements} existing setting${currentPlan.replacements === 1 ? "" : "s"} from ${sourceName()}.`,
                );
                await discard();
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setSaving(false);
        }
    }

    const summarizedKeys = () => plan()?.keys.slice(0, 8) ?? [];

    return (
        <section
            class={twClasses(
                "settings-section archive-settings-copy",
                jsxTailwindStyles,
                "section",
            )}
            aria-labelledby="settings-copy-title"
        >
            <div class={twClasses("settings-section-heading", jsxTailwindStyles, "div")}>
                <h2 id="settings-copy-title" class={twClasses("", jsxTailwindStyles, "h2")}>
                    Copy settings from another archive
                </h2>
                <p class={twClasses("", jsxTailwindStyles, "p")}>
                    Bring ordinary preferences into this archive. Tutorux verifies the selected
                    archive and keeps API credentials out of the transfer.
                </p>
            </div>
            <Show when={error()}>
                <p
                    class={twClasses("archive-settings-copy-error", jsxTailwindStyles, "p")}
                    role="alert"
                >
                    {error()}
                </p>
            </Show>
            <Show when={status()}>
                <p
                    class={twClasses("archive-settings-copy-status", jsxTailwindStyles, "p")}
                    role="status"
                    aria-live="polite"
                >
                    {status()}
                </p>
            </Show>
            <Show when={!plan() && !sourceSnapshot()}>
                <div class={twClasses("archive-settings-copy-start", jsxTailwindStyles, "div")}>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            Transfer archive-specific preferences
                        </strong>
                        <span class={twClasses("", jsxTailwindStyles, "span")}>
                            Existing keys are shown for review and replaced only after you confirm.
                            Credentials are never copied by this workflow.
                        </span>
                    </div>
                    <button
                        class={twClasses("button button-outline", jsxTailwindStyles, "button")}
                        type="button"
                        disabled={props.disabled || opening() || saving()}
                        onClick={() => void chooseSource()}
                    >
                        {opening() ? "Opening archive…" : "Choose source archive"}
                    </button>
                </div>
            </Show>
            <Show when={sourceSnapshot()}>
                <form
                    class={twClasses("archive-settings-copy-unlock", jsxTailwindStyles, "form")}
                    onSubmit={(event) => void unlockSource(event)}
                >
                    <p class={twClasses("", jsxTailwindStyles, "p")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {sourceName()}
                        </strong>{" "}
                        is protected with a passphrase. Unlock it to review its ordinary settings.
                        The passphrase is used only to unlock this review and is never written into
                        either archive.
                    </p>
                    <label
                        class={twClasses("form-field", jsxTailwindStyles, "label")}
                        for="settings-copy-source-passphrase"
                    >
                        Source archive passphrase
                        <input
                            ref={(element) => (passphraseInput = element)}
                            id="settings-copy-source-passphrase"
                            type="password"
                            autocomplete="current-password"
                            value={sourcePassphrase()}
                            disabled={opening() || saving()}
                            onInput={(event) => setSourcePassphrase(event.currentTarget.value)}
                            required
                            class={twClasses("", jsxTailwindStyles, "input")}
                        />
                    </label>
                    <div class={twClasses("archive-setting-actions", jsxTailwindStyles, "div")}>
                        <button
                            class={twClasses("button button-quiet", jsxTailwindStyles, "button")}
                            type="button"
                            disabled={opening() || saving()}
                            onClick={() => void discard()}
                        >
                            Cancel
                        </button>
                        <button
                            class={twClasses("button button-primary", jsxTailwindStyles, "button")}
                            type="submit"
                            disabled={opening() || saving() || !sourcePassphrase()}
                        >
                            {opening() ? "Verifying archive…" : "Unlock and review"}
                        </button>
                    </div>
                </form>
            </Show>
            <Show when={plan()} keyed>
                {(review) => (
                    <div
                        class={twClasses("archive-settings-copy-review", jsxTailwindStyles, "div")}
                        aria-labelledby="settings-copy-review-title"
                    >
                        <div
                            class={twClasses(
                                "archive-settings-copy-review-heading",
                                jsxTailwindStyles,
                                "div",
                            )}
                        >
                            <div class={twClasses("", jsxTailwindStyles, "div")}>
                                <span class={twClasses("eyebrow", jsxTailwindStyles, "span")}>
                                    Review transfer
                                </span>
                                <h3
                                    id="settings-copy-review-title"
                                    class={twClasses("", jsxTailwindStyles, "h3")}
                                >
                                    {sourceName()}
                                </h3>
                            </div>
                            <span
                                class={twClasses(
                                    "archive-settings-copy-count",
                                    jsxTailwindStyles,
                                    "span",
                                )}
                            >
                                {review.records.length} settings
                            </span>
                        </div>
                        <p class={twClasses("", jsxTailwindStyles, "p")}>
                            {review.additions} new · {review.replacements} existing key
                            {review.replacements === 1 ? "" : "s"} will be replaced in the open
                            archive.
                            {review.withheldSensitive > 0
                                ? ` ${review.withheldSensitive} credential-like setting${review.withheldSensitive === 1 ? " was" : "s were"} withheld.`
                                : " Credential records are not included."}
                        </p>
                        <Show when={review.records.length > 0}>
                            <ul
                                class={twClasses(
                                    "archive-settings-copy-key-list",
                                    jsxTailwindStyles,
                                    "ul",
                                )}
                                aria-label="Settings to copy"
                            >
                                <For each={summarizedKeys()}>
                                    {(key) => (
                                        <li class={twClasses("", jsxTailwindStyles, "li")}>
                                            {key}
                                        </li>
                                    )}
                                </For>
                                <Show when={review.keys.length > 8}>
                                    <li class={twClasses("", jsxTailwindStyles, "li")}>
                                        and {review.keys.length - 8} more
                                    </li>
                                </Show>
                            </ul>
                        </Show>
                        <Show when={review.records.length === 0}>
                            <p
                                class={twClasses(
                                    "archive-settings-copy-empty",
                                    jsxTailwindStyles,
                                    "p",
                                )}
                            >
                                No transferable ordinary settings were found in this source archive.
                            </p>
                        </Show>
                        <div class={twClasses("archive-setting-actions", jsxTailwindStyles, "div")}>
                            <button
                                class={twClasses(
                                    "button button-quiet",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={saving()}
                                onClick={() => void discard()}
                            >
                                Cancel
                            </button>
                            <button
                                class={twClasses(
                                    "button button-primary",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                disabled={props.disabled || saving() || review.records.length === 0}
                                onClick={() => void copySettings()}
                            >
                                {saving()
                                    ? "Copying settings…"
                                    : `Copy ${review.records.length} setting${review.records.length === 1 ? "" : "s"}`}
                            </button>
                        </div>
                    </div>
                )}
            </Show>
            <Show when={opening() && !sourceSnapshot() && !plan()}>
                <p
                    class={twClasses("archive-settings-copy-progress", jsxTailwindStyles, "p")}
                    role="status"
                    aria-live="polite"
                >
                    Verifying source archive…
                </p>
            </Show>
        </section>
    );
}

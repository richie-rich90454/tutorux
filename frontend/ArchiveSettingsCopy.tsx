import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import { openArchiveSource, verifyArchiveSnapshot, type ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { prepareArchiveSettingsCopy, type ArchiveSettingsCopyPlan } from "./archive-settings-copy";
import {
    bodyText,
    buttonOutline,
    buttonPrimary,
    buttonQuiet,
    card,
    cn,
    errorText,
    inputBase,
    labelBase,
    mutedText,
} from "./ui";
import { platform } from "@platform";

interface ArchiveSettingsCopyProps {
    archiveId: string;
    archiveGeneration: string;
    settings: readonly ArchiveRecord[];
    disabled: boolean;
    onSave: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}

const settingsSection = cn(card, "settings-section my-3 overflow-hidden");
const sectionHeading = "settings-section-heading border-b border-line-soft px-4 pb-2.5 pt-3.5";
const actionRow = "archive-setting-actions flex flex-wrap items-center gap-2";

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
            class={cn("archive-settings-copy", settingsSection)}
            aria-labelledby="settings-copy-title"
        >
            <div class={sectionHeading}>
                <h2 id="settings-copy-title" class="text-xs font-semibold text-ink-soft">
                    Copy settings from another archive
                </h2>
                <p class={cn(mutedText, "mt-1")}>
                    Bring ordinary preferences into this archive. Tutorux verifies the selected
                    archive and keeps API credentials out of the transfer.
                </p>
            </div>
            <Show when={error()}>
                <p class={cn("archive-settings-copy-error", errorText, "px-4 pt-3")} role="alert">
                    {error()}
                </p>
            </Show>
            <Show when={status()}>
                <p
                    class={cn(
                        "archive-settings-copy-status",
                        "px-4 pt-3 text-xs leading-relaxed text-accent",
                    )}
                    role="status"
                    aria-live="polite"
                >
                    {status()}
                </p>
            </Show>
            <Show when={!plan() && !sourceSnapshot()}>
                <div class="archive-settings-copy-start flex items-start justify-between gap-4.5 px-4 pt-4 max-sm:flex-col max-sm:items-stretch">
                    <div class="grid max-w-[590px] gap-1.5">
                        <strong class="text-[13px] font-semibold text-ink">
                            Transfer archive-specific preferences
                        </strong>
                        <span class="text-xs leading-relaxed text-muted">
                            Existing keys are shown for review and replaced only after you confirm.
                            Credentials are never copied by this workflow.
                        </span>
                    </div>
                    <button
                        class={cn("button", buttonOutline, "shrink-0")}
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
                    class="archive-settings-copy-unlock grid max-w-[520px] gap-3.5 px-4 py-4"
                    onSubmit={(event) => void unlockSource(event)}
                >
                    <p class={bodyText}>
                        <strong class="font-semibold text-ink">{sourceName()}</strong> is protected
                        with a passphrase. Unlock it to review its ordinary settings. The passphrase
                        is used only to unlock this review and is never written into either archive.
                    </p>
                    <label
                        class={cn("form-field", labelBase)}
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
                            class={inputBase}
                        />
                    </label>
                    <div class={actionRow}>
                        <button
                            class={cn("button", buttonQuiet)}
                            type="button"
                            disabled={opening() || saving()}
                            onClick={() => void discard()}
                        >
                            Cancel
                        </button>
                        <button
                            class={cn("button", buttonPrimary)}
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
                        class="archive-settings-copy-review mx-4 mb-4 mt-3.5 grid gap-3 rounded-[5px] border border-line bg-surface-subtle p-[18px]"
                        aria-labelledby="settings-copy-review-title"
                    >
                        <div class="archive-settings-copy-review-heading flex items-center justify-between gap-4.5 max-sm:flex-col max-sm:items-stretch">
                            <div class="grid gap-1">
                                <span class="text-xs font-medium tracking-wide text-muted">
                                    Review transfer
                                </span>
                                <h3
                                    id="settings-copy-review-title"
                                    class="text-[1.02rem] font-semibold leading-snug text-ink"
                                >
                                    {sourceName()}
                                </h3>
                            </div>
                            <span class="archive-settings-copy-count shrink-0 text-[0.88rem] text-muted">
                                {review.records.length} settings
                            </span>
                        </div>
                        <p class={bodyText}>
                            {review.additions} new · {review.replacements} existing key
                            {review.replacements === 1 ? "" : "s"} will be replaced in the open
                            archive.
                            {review.withheldSensitive > 0
                                ? ` ${review.withheldSensitive} credential-like setting${review.withheldSensitive === 1 ? " was" : "s were"} withheld.`
                                : " Credential records are not included."}
                        </p>
                        <Show when={review.records.length > 0}>
                            <ul
                                class="archive-settings-copy-key-list flex list-none flex-wrap gap-[7px] p-0"
                                aria-label="Settings to copy"
                            >
                                <For each={summarizedKeys()}>
                                    {(key) => (
                                        <li class="max-w-full break-words rounded-[5px] border border-line bg-surface px-2 py-1 text-[0.78rem] text-ink">
                                            {key}
                                        </li>
                                    )}
                                </For>
                                <Show when={review.keys.length > 8}>
                                    <li class="max-w-full break-words rounded-[5px] border border-line bg-surface px-2 py-1 text-[0.78rem] text-ink">
                                        and {review.keys.length - 8} more
                                    </li>
                                </Show>
                            </ul>
                        </Show>
                        <Show when={review.records.length === 0}>
                            <p class={cn("archive-settings-copy-empty", mutedText, "m-0")}>
                                No transferable ordinary settings were found in this source archive.
                            </p>
                        </Show>
                        <div class={actionRow}>
                            <button
                                class={cn("button", buttonQuiet)}
                                type="button"
                                disabled={saving()}
                                onClick={() => void discard()}
                            >
                                Cancel
                            </button>
                            <button
                                class={cn("button", buttonPrimary)}
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
                    class={cn("archive-settings-copy-progress", mutedText, "px-4 pb-4")}
                    role="status"
                    aria-live="polite"
                >
                    Verifying source archive…
                </p>
            </Show>
        </section>
    );
}

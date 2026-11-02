import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import {
    compactArchiveSnapshot,
    backfillArchiveSecondaryIndexes,
    repairArchiveSnapshot,
    recoverUnpublishedCommit,
    type ArchiveSnapshot,
    type ArchiveCompactionResult,
    type ArchiveRepairResult,
    type ArchiveRecoveryResult,
    type ArchiveIndexMigrationResult,
} from "./archive/archive";
import type { SanitizedCopyDestination } from "./platform/types";
import { buttonOutline, buttonPrimary, buttonQuiet, card, cn, eyebrow, mutedText } from "./ui";
import { platform } from "@platform";

type Review =
    | { kind: "recover"; source: ArchiveSnapshot; result: ArchiveRecoveryResult }
    | {
          kind: "compact";
          source: ArchiveSnapshot;
          result: ArchiveCompactionResult;
          pruneUnreferencedAssets: boolean;
      }
    | { kind: "indexes"; source: ArchiveSnapshot; result: ArchiveIndexMigrationResult };

interface ArchiveMaintenanceProps {
    snapshot: ArchiveSnapshot;
    disabled: boolean;
    /** Install the reviewed snapshot in the workspace as unsaved changes. */
    onApply: (
        original: ArchiveSnapshot,
        replacement: ArchiveSnapshot,
        kind: "recover" | "compact" | "indexes",
    ) => Promise<boolean>;
}

interface RepairCopyReview {
    source: ArchiveSnapshot;
    result: ArchiveRepairResult;
    destination: SanitizedCopyDestination;
}

const BROWSER_COPY_LIMIT = 512n * 1024n * 1024n;

const noteText = "text-xs leading-relaxed text-muted";

const reviewPanel =
    "mt-4 grid gap-2 rounded-[5px] border border-line bg-[var(--surface-inset)] p-4";

const reviewText = "text-[13px] leading-relaxed text-muted";

const reviewHeading = "text-base font-semibold leading-snug text-ink";

const actionRow = "mt-4 flex flex-wrap items-center gap-2";

const errorText = "text-xs font-medium text-danger";

const checkbox =
    "mt-0.5 size-4 shrink-0 accent-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-50";

const checkboxLabel = "flex cursor-pointer items-start gap-2 text-xs leading-relaxed";

function bytes(value: bigint): string {
    if (value < 1024n) return `${value} B`;
    let size = Number(value);
    const units = ["B", "KB", "MB", "GB", "TB"];
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
        size /= 1024;
        unit++;
    }
    return `${size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Review archive maintenance before changing the workspace. */
export function ArchiveMaintenance(props: ArchiveMaintenanceProps): JSX.Element {
    const [review, setReview] = createSignal<Review | null>(null);
    const [repairCopy, setRepairCopy] = createSignal<RepairCopyReview | null>(null);
    const [working, setWorking] = createSignal(false);
    const [pruneAssets, setPruneAssets] = createSignal(false);
    const [pruneConfirmed, setPruneConfirmed] = createSignal(false);
    const [repairCopyConfirmed, setRepairCopyConfirmed] = createSignal(false);
    const [error, setError] = createSignal("");
    const [status, setStatus] = createSignal("");
    let repairRun = 0;
    const unavailable = () => props.disabled || props.snapshot.locked || working();

    function discardReview(): void {
        const current = review();
        setReview(null);
        setPruneConfirmed(false);
        if (current && current.result.snapshot !== current.source) current.result.snapshot.lock();
    }

    function disposeRepairCopy(current: RepairCopyReview): void {
        if (current.result.snapshot !== current.source) {
            current.result.snapshot.lock();
            void current.result.snapshot.source.close?.().catch(() => undefined);
        }
        void current.destination.cancel().catch(() => undefined);
    }

    function discardRepairCopy(): void {
        repairRun++;
        const current = repairCopy();
        setRepairCopy(null);
        setRepairCopyConfirmed(false);
        if (current) disposeRepairCopy(current);
    }

    onCleanup(() => {
        discardReview();
        discardRepairCopy();
    });

    async function prepare(kind: Review["kind"]): Promise<void> {
        const source = props.snapshot;
        setWorking(true);
        setError("");
        setStatus("");
        discardReview();
        discardRepairCopy();
        try {
            if (kind === "recover")
                setReview({ kind, source, result: await recoverUnpublishedCommit(source) });
            else if (kind === "compact") {
                const pruneUnreferencedAssets = pruneAssets();
                setReview({
                    kind,
                    source,
                    result: await compactArchiveSnapshot(source, { pruneUnreferencedAssets }),
                    pruneUnreferencedAssets,
                });
            } else
                setReview({ kind, source, result: await backfillArchiveSecondaryIndexes(source) });
            if (props.snapshot !== source) {
                discardReview();
                throw new Error(
                    "The archive changed while the preview was being prepared. Review it again.",
                );
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setWorking(false);
        }
    }
    async function apply(): Promise<void> {
        const current = review();
        if (!current || unavailable() || current.result.snapshot === current.source) return;
        if (props.snapshot !== current.source) {
            discardReview();
            setError("The archive changed after this preview. Review it again.");
            return;
        }
        if (
            current.kind === "compact" &&
            current.pruneUnreferencedAssets &&
            current.result.prunedAssetRecords > 0 &&
            !pruneConfirmed()
        ) {
            setError(
                "Confirm the unreferenced-content removal shown in this preview before applying it.",
            );
            return;
        }
        setWorking(true);
        setError("");
        try {
            const saved = await props.onApply(
                current.source,
                current.result.snapshot,
                current.kind,
            );
            if (saved) {
                setReview(null);
                setPruneConfirmed(false);
                setStatus("Changes are ready. Save the archive to write them to disk.");
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setWorking(false);
        }
    }

    async function prepareRepairCopy(): Promise<void> {
        discardReview();
        discardRepairCopy();
        const request = repairRun;
        const source = props.snapshot;
        let destination: SanitizedCopyDestination | null = null;
        let result: ArchiveRepairResult | null = null;
        let retained = false;
        setWorking(true);
        setError("");
        setStatus("");
        try {
            destination = await platform.chooseSanitizedCopyDestination(
                "tutorux-repaired-copy.tux",
            );
            if (!destination) return;
            if (request !== repairRun || source !== props.snapshot) return;

            result = await repairArchiveSnapshot(source);
            if (request !== repairRun || source !== props.snapshot) return;

            setRepairCopy({ source, result, destination });
            retained = true;
            setStatus("Repair preview ready. The open archive remains unchanged.");
        } catch (cause) {
            if (request === repairRun)
                setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            if (!retained) {
                if (result && result.snapshot !== source) {
                    result.snapshot.lock();
                    await result.snapshot.source.close?.().catch(() => undefined);
                }
                await destination?.cancel().catch(() => undefined);
            }
            if (request === repairRun) setWorking(false);
        }
    }

    async function createRepairCopy(): Promise<void> {
        const reviewed = repairCopy();
        if (!reviewed || !repairCopyConfirmed() || unavailable()) return;
        if (reviewed.source !== props.snapshot) {
            discardRepairCopy();
            setError("The archive changed after this preview. Review the repair copy again.");
            return;
        }
        if (platform.kind === "browser" && reviewed.result.compactedBytes > BROWSER_COPY_LIMIT) {
            setError(
                "This browser cannot safely download repaired archives larger than 512 MiB. Use the desktop app for this copy.",
            );
            return;
        }

        setWorking(true);
        setError("");
        setStatus("");
        try {
            await reviewed.destination.checkpoint(reviewed.result.snapshot.source, 0n);
            if (
                repairCopy() !== reviewed ||
                reviewed.source !== props.snapshot ||
                reviewed.result.snapshot.source.size !== reviewed.result.compactedBytes
            ) {
                throw new Error(
                    "The source or repair preview changed before the copy could be published.",
                );
            }
            const location = await reviewed.destination.publish(reviewed.result.snapshot.source);
            if (!location) throw new Error("No repair copy was created.");

            setRepairCopy(null);
            setRepairCopyConfirmed(false);
            if (reviewed.result.snapshot !== reviewed.source) {
                reviewed.result.snapshot.lock();
                await reviewed.result.snapshot.source.close?.().catch(() => undefined);
            }
            await reviewed.destination.cancel().catch(() => undefined);
            setStatus(`Repair copy created at ${location}. The open archive was not changed.`);
        } catch (cause) {
            setRepairCopy(null);
            setRepairCopyConfirmed(false);
            if (reviewed.result.snapshot !== reviewed.source) {
                reviewed.result.snapshot.lock();
                await reviewed.result.snapshot.source.close?.().catch(() => undefined);
            }
            await reviewed.destination.cancel().catch(() => undefined);
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setWorking(false);
        }
    }

    return (
        <section class={cn(card, "archive-maintenance mt-5 p-6")}>
            <div class="archive-maintenance-heading grid gap-1">
                <span class={eyebrow}>Archive maintenance</span>
                <h2 class="text-[1.15rem] font-semibold leading-snug tracking-tight text-ink">
                    Review and maintain
                </h2>
                <p class={mutedText}>
                    Inspect a proposed change before applying it to the workspace.
                </p>
            </div>
            <label class={cn("archive-maintenance-note", checkboxLabel, "mt-3 text-muted")}>
                <input
                    type="checkbox"
                    checked={pruneAssets()}
                    disabled={unavailable()}
                    onChange={(event) => {
                        setPruneAssets(event.currentTarget.checked);
                        discardReview();
                        setError("");
                        setStatus("");
                    }}
                    class={checkbox}
                />
                Remove unreferenced material content during compaction
            </label>
            <p class={cn("archive-maintenance-note", noteText, "mt-2")}>
                Repair creates a separate verified archive file and leaves this workspace untouched.
                Unlock encrypted archives before repairing them.
            </p>
            <div class={cn("archive-maintenance-actions", actionRow)}>
                <button
                    class={cn("button", buttonOutline)}
                    type="button"
                    disabled={unavailable()}
                    onClick={() => void prepare("recover")}
                >
                    Review recovery
                </button>
                <button
                    class={cn("button", buttonOutline)}
                    type="button"
                    disabled={unavailable()}
                    onClick={() => void prepare("compact")}
                >
                    Review compaction
                </button>
                <button
                    class={cn("button", buttonOutline)}
                    type="button"
                    disabled={unavailable()}
                    onClick={() => void prepare("indexes")}
                >
                    Review index updates
                </button>
                <button
                    class={cn("button", buttonOutline)}
                    type="button"
                    disabled={unavailable()}
                    onClick={() => void prepareRepairCopy()}
                >
                    Review separate repair copy
                </button>
            </div>
            <Show when={working()}>
                <p role="status" class={cn(noteText, "mt-3")}>
                    Reading and checking archive data…
                </p>
            </Show>
            <Show when={error()}>
                <p class={cn("archive-maintenance-error", errorText, "mt-2")} role="alert">
                    {error()}
                </p>
            </Show>
            <Show when={status()}>
                <p role="status" class={cn(noteText, "mt-3")}>
                    {status()}
                </p>
            </Show>
            <Show when={review()} keyed>
                {(item) => (
                    <div class={cn("archive-maintenance-review", reviewPanel)}>
                        <Show when={item.kind === "recover" && item}>
                            {(entry) => (
                                <>
                                    <h3 class={reviewHeading}>
                                        Recover generation{" "}
                                        {entry().result.recoveredGeneration.toString()}
                                    </h3>
                                    <p class={reviewText}>
                                        This publishes{" "}
                                        {entry().result.recoveredGenerations.toLocaleString(
                                            "en-US",
                                        )}{" "}
                                        verified unpublished{" "}
                                        {entry().result.recoveredGenerations === 1
                                            ? "generation"
                                            : "generations"}{" "}
                                        and discards {bytes(entry().result.discardedTrailingBytes)}{" "}
                                        of trailing data.
                                    </p>
                                </>
                            )}
                        </Show>
                        <Show when={item.kind === "compact" && item}>
                            {(entry) => (
                                <>
                                    <h3 class={reviewHeading}>Compact archive</h3>
                                    <p class={reviewText}>
                                        {bytes(entry().result.originalBytes)} to{" "}
                                        {bytes(entry().result.compactedBytes)} ·{" "}
                                        {entry().result.preservedRecords.toLocaleString("en-US")}{" "}
                                        record revisions preserved.
                                    </p>
                                    <Show
                                        when={entry().pruneUnreferencedAssets}
                                        fallback={
                                            <p class={reviewText}>
                                                Unreferenced material content will be preserved.
                                            </p>
                                        }
                                    >
                                        <div
                                            class={cn(
                                                "archive-maintenance-prune-preview",
                                                "mt-3 grid gap-2.5 rounded-[5px] border border-line p-3",
                                            )}
                                        >
                                            <strong class="text-sm font-semibold text-ink">
                                                Unreferenced content removal
                                            </strong>
                                            <Show
                                                when={entry().result.prunedAssetRecords > 0}
                                                fallback={
                                                    <p class={reviewText}>
                                                        No unreferenced material content records
                                                        were found, so this preview removes none.
                                                    </p>
                                                }
                                            >
                                                <p class={reviewText}>
                                                    {entry().result.prunedAssetRecords.toLocaleString(
                                                        "en-US",
                                                    )}{" "}
                                                    unreferenced material content records will be
                                                    omitted from the compacted archive. The source
                                                    archive remains unchanged until you save this
                                                    compacted workspace over it.
                                                </p>
                                                <label
                                                    class={cn(
                                                        "archive-maintenance-prune-confirm",
                                                        checkboxLabel,
                                                    )}
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={pruneConfirmed()}
                                                        disabled={unavailable()}
                                                        onChange={(event) =>
                                                            setPruneConfirmed(
                                                                event.currentTarget.checked,
                                                            )
                                                        }
                                                        class={checkbox}
                                                    />
                                                    <span>
                                                        I reviewed this count and authorize removing
                                                        this unreferenced material content when I
                                                        apply this preview.
                                                    </span>
                                                </label>
                                            </Show>
                                        </div>
                                    </Show>
                                </>
                            )}
                        </Show>
                        <Show when={item.kind === "indexes" && item}>
                            {(entry) => (
                                <>
                                    <h3 class={reviewHeading}>Update archive indexes</h3>
                                    <p class={reviewText}>
                                        {entry().result.addedEntries.toLocaleString("en-US")}{" "}
                                        missing index entries can be added. Existing entries and
                                        record history are preserved.
                                    </p>
                                    <Show when={entry().result.schemaVersionsUpdated}>
                                        <p class={reviewText}>
                                            Index version markers will be updated. A family with
                                            conflicting mappings will keep using primary-record
                                            scans.
                                        </p>
                                    </Show>
                                    <Show when={entry().result.conflictingEntries > 0}>
                                        <p class={reviewText}>
                                            {entry().result.conflictingEntries.toLocaleString(
                                                "en-US",
                                            )}{" "}
                                            existing entries point to different revisions or records
                                            and will be left unchanged.
                                        </p>
                                    </Show>
                                </>
                            )}
                        </Show>
                        <Show when={props.snapshot !== item.source}>
                            <p class={cn("archive-maintenance-error", errorText)}>
                                The workspace changed. Prepare a new preview.
                            </p>
                        </Show>
                        <div class={cn("archive-maintenance-actions", actionRow)}>
                            <button
                                class={cn("button", buttonQuiet)}
                                type="button"
                                disabled={working()}
                                onClick={discardReview}
                            >
                                Cancel
                            </button>
                            <button
                                class={cn("button", buttonPrimary)}
                                type="button"
                                disabled={
                                    unavailable() ||
                                    props.snapshot !== item.source ||
                                    item.result.snapshot === item.source ||
                                    (item.kind === "compact" &&
                                        item.pruneUnreferencedAssets &&
                                        item.result.prunedAssetRecords > 0 &&
                                        !pruneConfirmed())
                                }
                                onClick={() => void apply()}
                            >
                                {item.kind === "recover"
                                    ? "Apply recovery"
                                    : item.kind === "compact"
                                      ? item.pruneUnreferencedAssets &&
                                        item.result.prunedAssetRecords > 0
                                          ? "Apply compaction and remove content"
                                          : "Apply compaction"
                                      : "Apply index updates"}
                            </button>
                        </div>
                    </div>
                )}
            </Show>
            <Show when={repairCopy()} keyed>
                {(item) => {
                    const browserLimitExceeded =
                        platform.kind === "browser" &&
                        item.result.compactedBytes > BROWSER_COPY_LIMIT;
                    return (
                        <div
                            class={cn(
                                "archive-maintenance-review archive-maintenance-repair-copy",
                                reviewPanel,
                            )}
                        >
                            <span class={cn(eyebrow, "block")}>Review before creating</span>
                            <h3 class={reviewHeading}>Create a separate repaired archive</h3>
                            <p class={reviewText}>
                                Output destination:{" "}
                                <strong class="break-words text-[13px] font-semibold text-ink">
                                    {item.destination.label}
                                </strong>
                            </p>
                            <dl class="my-3.5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2.5">
                                <div class="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
                                    <dt class="text-[0.8rem] text-muted">Source generation</dt>
                                    <dd class="mt-1 min-w-0 break-words font-semibold text-ink">
                                        {item.source.commit.generation.toString()}
                                    </dd>
                                </div>
                                <div class="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
                                    <dt class="text-[0.8rem] text-muted">
                                        Verified generation selected
                                    </dt>
                                    <dd class="mt-1 min-w-0 break-words font-semibold text-ink">
                                        {item.result.selectedGeneration.toString()}
                                    </dd>
                                </div>
                                <div class="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
                                    <dt class="text-[0.8rem] text-muted">Trailing data excluded</dt>
                                    <dd class="mt-1 min-w-0 break-words font-semibold text-ink">
                                        {bytes(item.result.discardedTrailingBytes)}
                                    </dd>
                                </div>
                                <div class="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
                                    <dt class="text-[0.8rem] text-muted">Source → output size</dt>
                                    <dd class="mt-1 min-w-0 break-words font-semibold text-ink">
                                        {bytes(item.result.originalBytes)} →{" "}
                                        {bytes(item.result.compactedBytes)}
                                    </dd>
                                </div>
                                <div class="min-w-0 rounded-[5px] border border-line bg-surface p-2.5">
                                    <dt class="text-[0.8rem] text-muted">
                                        Record revisions preserved
                                    </dt>
                                    <dd class="mt-1 min-w-0 break-words font-semibold text-ink">
                                        {item.result.preservedRecords.toLocaleString("en-US")}
                                    </dd>
                                </div>
                            </dl>
                            <p class={reviewText}>
                                The new file uses the newest generation that passed full record
                                verification. The source archive and open workspace stay unchanged.
                                {item.source.encrypted
                                    ? " The repaired copy remains encrypted."
                                    : ""}
                            </p>
                            <Show when={browserLimitExceeded}>
                                <p class={cn("archive-maintenance-error", errorText)} role="status">
                                    Browser downloads are limited to 512 MiB for this operation.
                                    Open the archive in the desktop app to create this copy.
                                </p>
                            </Show>
                            <Show when={props.snapshot !== item.source}>
                                <p class={cn("archive-maintenance-error", errorText)}>
                                    The workspace changed. Prepare a new repair preview.
                                </p>
                            </Show>
                            <label
                                class={cn(
                                    "archive-maintenance-repair-confirm",
                                    checkboxLabel,
                                    "mt-3",
                                )}
                            >
                                <input
                                    type="checkbox"
                                    checked={repairCopyConfirmed()}
                                    disabled={unavailable() || browserLimitExceeded}
                                    onChange={(event) =>
                                        setRepairCopyConfirmed(event.currentTarget.checked)
                                    }
                                    class={checkbox}
                                />
                                <span>
                                    I reviewed the destination and repair summary, and authorize
                                    creating a separate file that may contain student histories,
                                    recordings, private annotations, and provider data.
                                </span>
                            </label>
                            <div class={cn("archive-maintenance-actions", actionRow)}>
                                <button
                                    class={cn("button", buttonQuiet)}
                                    type="button"
                                    disabled={working()}
                                    onClick={discardRepairCopy}
                                >
                                    Cancel
                                </button>
                                <button
                                    class={cn("button", buttonPrimary)}
                                    type="button"
                                    disabled={
                                        unavailable() ||
                                        props.snapshot !== item.source ||
                                        !repairCopyConfirmed() ||
                                        browserLimitExceeded
                                    }
                                    onClick={() => void createRepairCopy()}
                                >
                                    Create separate repair copy
                                </button>
                            </div>
                        </div>
                    );
                }}
            </Show>
        </section>
    );
}

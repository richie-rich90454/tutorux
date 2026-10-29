import { Show, createSignal, onCleanup, type JSX } from "solid-js";
import {
  compactArchiveSnapshot,
  backfillArchiveSecondaryIndexes,
  recoverUnpublishedCommit,
  type ArchiveSnapshot,
  type ArchiveCompactionResult,
  type ArchiveRecoveryResult,
  type ArchiveIndexMigrationResult,
} from "./archive/archive";
import "./archive-maintenance.css";

type Review =
  | { kind: "recover"; source: ArchiveSnapshot; result: ArchiveRecoveryResult }
  | { kind: "compact"; source: ArchiveSnapshot; result: ArchiveCompactionResult }
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
  const [working, setWorking] = createSignal(false);
  const [pruneAssets, setPruneAssets] = createSignal(false);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  const unavailable = () => props.disabled || props.snapshot.locked || working();

  function discardReview(): void {
    const current = review();
    setReview(null);
    if (current && current.result.snapshot !== current.source) current.result.snapshot.lock();
  }
  onCleanup(discardReview);

  async function prepare(kind: Review["kind"]): Promise<void> {
    const source = props.snapshot;
    setWorking(true);
    setError("");
    setStatus("");
    discardReview();
    try {
      if (kind === "recover")
        setReview({ kind, source, result: await recoverUnpublishedCommit(source) });
      else if (kind === "compact")
        setReview({
          kind,
          source,
          result: await compactArchiveSnapshot(source, { pruneUnreferencedAssets: pruneAssets() }),
        });
      else setReview({ kind, source, result: await backfillArchiveSecondaryIndexes(source) });
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
    setWorking(true);
    setError("");
    try {
      const saved = await props.onApply(current.source, current.result.snapshot, current.kind);
      if (saved) {
        setReview(null);
        setStatus("Changes are ready. Save the archive to write them to disk.");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setWorking(false);
    }
  }

  return (
    <section class="surface-card archive-maintenance">
      <div class="archive-maintenance-heading">
        <span class="eyebrow">ARCHIVE MAINTENANCE</span>
        <h2>Review and maintain</h2>
        <p>Inspect a proposed change before applying it to the workspace.</p>
      </div>
      <label class="archive-maintenance-note">
        <input
          type="checkbox"
          checked={pruneAssets()}
          disabled={unavailable()}
          onChange={(event) => {
            setPruneAssets(event.currentTarget.checked);
            discardReview();
          }}
        />
        Remove unreferenced material content during compaction
      </label>
      <div class="archive-maintenance-actions">
        <button
          class="button button-outline"
          type="button"
          disabled={unavailable()}
          onClick={() => void prepare("recover")}
        >
          Review recovery
        </button>
        <button
          class="button button-outline"
          type="button"
          disabled={unavailable()}
          onClick={() => void prepare("compact")}
        >
          Review compaction
        </button>
        <button
          class="button button-outline"
          type="button"
          disabled={unavailable()}
          onClick={() => void prepare("indexes")}
        >
          Review index updates
        </button>
      </div>
      <Show when={working()}>
        <p role="status">Reading and checking archive data…</p>
      </Show>
      <Show when={error()}>
        <p class="archive-maintenance-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={status()}>
        <p role="status">{status()}</p>
      </Show>
      <Show when={review()} keyed>
        {(item) => (
          <div class="archive-maintenance-review">
            <Show when={item.kind === "recover" && item}>
              {(entry) => (
                <>
                  <h3>Recover generation {entry().result.recoveredGeneration.toString()}</h3>
                  <p>
                    This publishes {entry().result.recoveredGenerations.toLocaleString()} verified
                    unpublished{" "}
                    {entry().result.recoveredGenerations === 1 ? "generation" : "generations"} and
                    discards {bytes(entry().result.discardedTrailingBytes)} of trailing data.
                  </p>
                </>
              )}
            </Show>
            <Show when={item.kind === "compact" && item}>
              {(entry) => (
                <>
                  <h3>Compact archive</h3>
                  <p>
                    {bytes(entry().result.originalBytes)} to {bytes(entry().result.compactedBytes)}{" "}
                    · {entry().result.preservedRecords.toLocaleString()} record revisions preserved.
                  </p>
                  <Show when={entry().result.prunedAssetRecords > 0}>
                    <p>
                      {entry().result.prunedAssetRecords.toLocaleString()} unreferenced material
                      records will be removed.
                    </p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={item.kind === "indexes" && item}>
              {(entry) => (
                <>
                  <h3>Update archive indexes</h3>
                  <p>
                    {entry().result.addedEntries.toLocaleString()} missing index entries can be
                    added. Existing entries and record history are preserved.
                  </p>
                  <Show when={entry().result.conflictingEntries > 0}>
                    <p>
                      {entry().result.conflictingEntries.toLocaleString()} existing entries point to
                      different revisions or records and will be left unchanged.
                    </p>
                  </Show>
                </>
              )}
            </Show>
            <Show when={props.snapshot !== item.source}>
              <p class="archive-maintenance-error">The workspace changed. Prepare a new preview.</p>
            </Show>
            <div class="archive-maintenance-actions">
              <button
                class="button button-quiet"
                type="button"
                disabled={working()}
                onClick={discardReview}
              >
                Cancel
              </button>
              <button
                class="button button-primary"
                type="button"
                disabled={
                  unavailable() ||
                  props.snapshot !== item.source ||
                  item.result.snapshot === item.source
                }
                onClick={() => void apply()}
              >
                {item.kind === "recover"
                  ? "Apply recovery"
                  : item.kind === "compact"
                    ? "Apply compaction"
                    : "Apply index updates"}
              </button>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}

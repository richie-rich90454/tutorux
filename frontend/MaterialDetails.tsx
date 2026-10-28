import { createSignal, For, Show, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import "./material-details.css";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const now = () => (BigInt(Date.now()) * 1000n).toString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
function hasInvalidControls(value: string, multiline: boolean): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10)));
  });
}
function editMetadata(record: ArchiveRecord, filename: string, description: string): ArchiveRecord {
  const name = filename.trim();
  if (!name || new TextEncoder().encode(name).length > 1024 || hasInvalidControls(name, false))
    throw new Error("Use a file name of up to 1024 bytes without control characters.");
  if (
    new TextEncoder().encode(description).length > 16_384 ||
    hasInvalidControls(description, true)
  )
    throw new Error("The description is too long or contains unsupported characters.");
  const fields = new Map(record.fields);
  fields.set("filename", name);
  fields.set("description", description);
  fields.set("updated_at_us", now());
  return { ...record, fields };
}

export function MaterialDetails(props: {
  record: ArchiveRecord;
  snapshot: ArchiveSnapshot;
  disabled: boolean;
  onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const [confirmRemove, setConfirmRemove] = createSignal(false);
  async function save(): Promise<void> {
    setError("");
    setPending(true);
    try {
      if (
        await props.onWriteRecords(
          [editMetadata(props.record, name(), description())],
          "Material details updated.",
        )
      )
        setOpen(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  async function showHistory(): Promise<void> {
    if (history()) {
      setHistory(null);
      return;
    }
    setError("");
    setPending(true);
    try {
      setHistory(await props.snapshot.getRecordHistory(RecordType.assetMetadata, props.record.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  async function restore(revision: ArchiveRecord): Promise<void> {
    setError("");
    setPending(true);
    try {
      const latest = await props.snapshot.getRecord(RecordType.assetMetadata, props.record.id);
      if (!latest || field(latest, "_deleted") === "true")
        throw new Error("This material is no longer available.");
      if (
        await props.onWriteRecords(
          [editMetadata(latest, field(revision, "filename"), field(revision, "description"))],
          "Material details restored.",
        )
      ) {
        setName(field(revision, "filename"));
        setDescription(field(revision, "description"));
        setHistory(
          await props.snapshot.getRecordHistory(RecordType.assetMetadata, props.record.id),
        );
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  async function remove(): Promise<void> {
    setError("");
    setPending(true);
    try {
      const fields = new Map(props.record.fields);
      fields.set("_deleted", "true");
      fields.set("deleted_at_us", now());
      fields.set("updated_at_us", now());
      await props.onWriteRecords([{ ...props.record, fields }], "Material moved to Trash.");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section class="material-details">
      <div class="material-details-actions">
        <button
          class="button button-quiet record-action"
          type="button"
          aria-expanded={open()}
          onClick={() => {
            setName(field(props.record, "filename"));
            setDescription(field(props.record, "description"));
            setOpen((value) => !value);
          }}
        >
          Details
        </button>
        <button
          class="button button-quiet record-action"
          type="button"
          disabled={pending()}
          aria-expanded={history() !== null}
          onClick={() => void showHistory()}
        >
          History
        </button>
        <button
          class="button button-quiet record-action"
          type="button"
          disabled={props.disabled || pending()}
          onClick={() => setConfirmRemove((value) => !value)}
        >
          Move to Trash
        </button>
      </div>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
      <Show when={confirmRemove()}>
        <div class="material-details-panel">
          <p>Move this material to Trash? Its stored file can be restored later.</p>
          <div class="material-details-actions">
            <button
              class="button button-outline record-action"
              type="button"
              disabled={props.disabled || pending()}
              onClick={() => void remove()}
            >
              Move to Trash
            </button>
            <button
              class="button button-quiet record-action"
              type="button"
              onClick={() => setConfirmRemove(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={open()}>
        <form
          class="material-details-panel"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label>
            File name
            <input
              value={name()}
              maxlength="1024"
              required
              disabled={props.disabled || pending()}
              onInput={(event) => setName(event.currentTarget.value)}
            />
          </label>
          <label>
            Description
            <textarea
              value={description()}
              rows={3}
              maxlength="16384"
              disabled={props.disabled || pending()}
              onInput={(event) => setDescription(event.currentTarget.value)}
            />
          </label>
          <button
            class="button button-outline record-action"
            type="submit"
            disabled={props.disabled || pending()}
          >
            Save details
          </button>
        </form>
      </Show>
      <Show when={history() !== null}>
        <div class="material-details-panel">
          <strong>Earlier details</strong>
          <p>Restoring details keeps the current stored file and links.</p>
          <Show when={(history()?.length ?? 0) > 1} fallback={<p>No earlier versions.</p>}>
            <For each={history()?.slice(1)}>
              {(revision) => (
                <div class="material-history-version">
                  <div>
                    <strong>{field(revision, "filename") || "Untitled material"}</strong>
                    <p>{field(revision, "description")}</p>
                    <small>Version {revision.revision.toString()}</small>
                  </div>
                  <button
                    class="button button-outline record-action"
                    type="button"
                    disabled={props.disabled || pending() || field(revision, "_deleted") === "true"}
                    onClick={() => void restore(revision)}
                  >
                    Restore details
                  </button>
                </div>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </section>
  );
}

export function MaterialTrash(props: {
  snapshot: ArchiveSnapshot;
  disabled: boolean;
  onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [records, setRecords] = createSignal<ArchiveRecord[]>([]);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  async function load(): Promise<void> {
    setPending(true);
    setError("");
    try {
      setRecords(
        (await props.snapshot.listRecords(RecordType.assetMetadata, true)).filter(
          (record) =>
            field(record, "_deleted") === "true" &&
            !field(record, "_trash_group_id") &&
            !["recording-take", "recording-track"].includes(field(record, "record_role")),
        ),
      );
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  async function restore(record: ArchiveRecord): Promise<void> {
    setPending(true);
    setError("");
    try {
      const fields = new Map(record.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      fields.set("restored_at_us", now());
      fields.set("updated_at_us", now());
      if (await props.onWriteRecords([{ ...record, fields }], "Material restored from Trash."))
        setRecords((current) => current.filter((item) => item.id !== record.id));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setPending(false);
    }
  }
  return (
    <section class="material-trash">
      <button
        type="button"
        class="button button-quiet record-action"
        aria-expanded={open()}
        onClick={() => {
          if (!open()) void load();
          setOpen((value) => !value);
        }}
      >
        {open() ? "Hide removed materials" : "Removed materials"}
      </button>
      <Show when={open()}>
        <div class="material-details-panel">
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <Show when={!pending()} fallback={<p>Loading…</p>}>
            <Show when={records().length} fallback={<p>No removed materials.</p>}>
              <For each={records()}>
                {(record) => (
                  <div class="material-history-version">
                    <strong>{field(record, "filename") || "Untitled material"}</strong>
                    <button
                      type="button"
                      class="button button-outline record-action"
                      disabled={props.disabled || pending()}
                      onClick={() => void restore(record)}
                    >
                      Restore
                    </button>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </section>
  );
}

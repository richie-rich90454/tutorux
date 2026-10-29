import { createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { guideDraftFromRecord, makeGuideRecord } from "./domain/guides";
import "./journal-relations.css";

const field = (record: ArchiveRecord, key: string) => record.fields.get(key) ?? "";
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const ids = (value: string) =>
  value
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
const timestamp = () => (BigInt(Date.now()) * 1000n).toString();
function update(record: ArchiveRecord, changes: Record<string, string>): ArchiveRecord {
  const fields = new Map(record.fields);
  for (const [key, value] of Object.entries(changes)) fields.set(key, value);
  fields.set("updated_at_us", timestamp());
  return { ...record, fields };
}
function withId(value: string, id: string, present: boolean): string {
  const list = ids(value).filter((item) => !same(item, id));
  if (present) list.push(id.toLowerCase());
  return list.join(",");
}

/** Move a session and its dependent notes and guides in one archive transaction. */
export function moveJournalSession(
  entry: ArchiveRecord,
  session: ArchiveRecord,
  entries: readonly ArchiveRecord[],
  notes: readonly ArchiveRecord[],
  guides: readonly ArchiveRecord[],
): ArchiveRecord[] {
  if (
    field(entry, "record_role") !== "journal-entry" ||
    field(entry, "_deleted") === "true" ||
    session.type !== RecordType.session ||
    field(session, "_deleted") === "true"
  )
    throw new Error("Choose an active entry and session.");
  const oldId = field(session, "entry_id");
  if (
    oldId &&
    !same(oldId, entry.id) &&
    guides.some(
      (guide) =>
        field(guide, "_deleted") !== "true" &&
        !field(guide, "session_id") &&
        same(field(guide, "entry_id"), oldId),
    )
  ) {
    throw new Error(
      "This session's current journal entry has an entry-wide study guide. Review or move that guide before moving the session, so its sources remain valid.",
    );
  }
  const old = entries.find((item) => same(item.id, oldId));
  const relatedGuides = guides.filter(
    (guide) => same(field(guide, "session_id"), session.id) && field(guide, "_deleted") !== "true",
  );
  const noteId = field(session, "notes_document_id");
  const note = notes.find((item) => same(item.id, noteId));
  if (
    noteId &&
    (!note ||
      field(note, "record_role") !== "journal-notes" ||
      !same(field(note, "session_id"), session.id) ||
      !same(field(note, "entry_id"), oldId))
  )
    throw new Error("The session notes cannot be safely moved. Repair their ownership first.");
  const movedGuideIds = new Set(relatedGuides.map((guide) => guide.id.toLowerCase()));
  const changes: ArchiveRecord[] = [];
  if (old && !same(old.id, entry.id))
    changes.push(
      update(old, {
        session_ids: withId(field(old, "session_ids"), session.id, false),
        study_guide_ids: ids(field(old, "study_guide_ids"))
          .filter((id) => !movedGuideIds.has(id.toLowerCase()))
          .join(","),
      }),
    );
  let targetGuideIds = field(entry, "study_guide_ids");
  for (const guide of relatedGuides) targetGuideIds = withId(targetGuideIds, guide.id, true);
  changes.push(
    update(entry, {
      session_ids: withId(field(entry, "session_ids"), session.id, true),
      study_guide_ids: targetGuideIds,
    }),
  );
  changes.push(update(session, { entry_id: entry.id.toLowerCase() }));
  if (note) changes.push(update(note, { entry_id: entry.id.toLowerCase() }));
  changes.push(
    ...relatedGuides.map((guide) => update(guide, { entry_id: entry.id.toLowerCase() })),
  );
  return changes;
}

export function JournalRelations(props: {
  entry: ArchiveRecord;
  snapshot: ArchiveSnapshot;
  entries: ArchiveRecord[];
  sessions: ArchiveRecord[];
  guides: ArchiveRecord[];
  assets: ArchiveRecord[];
  notesDocuments: ArchiveRecord[];
  disabled: boolean;
  onWriteRecords: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const [error, setError] = createSignal("");
  const [pending, setPending] = createSignal(false);
  const attached = createMemo(
    () => new Set(ids(field(props.entry, "attachment_ids")).map((id) => id.toLowerCase())),
  );
  const linkedSessions = createMemo(() =>
    props.sessions.filter((item) => same(field(item, "entry_id"), props.entry.id)),
  );
  const linkedGuides = createMemo(() =>
    props.guides.filter((item) => same(field(item, "entry_id"), props.entry.id)),
  );
  const availableSessions = createMemo(() =>
    props.sessions.filter((item) => !same(field(item, "entry_id"), props.entry.id)),
  );
  const [sessionId, setSessionId] = createSignal("");
  const [guideId, setGuideId] = createSignal("");
  const availableGuides = createMemo(() =>
    props.guides.filter(
      (guide) => !field(guide, "session_id") && !same(field(guide, "entry_id"), props.entry.id),
    ),
  );
  async function moveGuide(): Promise<void> {
    try {
      const guide = availableGuides().find((item) => same(item.id, guideId()));
      if (!guide) throw new Error("Choose a study guide to move.");
      const draft = guideDraftFromRecord(guide);
      const sourceTypes = [
        RecordType.student,
        RecordType.session,
        RecordType.transcriptSegment,
        RecordType.annotation,
        RecordType.assetMetadata,
        RecordType.evidenceNode,
        RecordType.settings,
      ];
      const sourceRecords = (
        await Promise.all(sourceTypes.map((type) => props.snapshot.listRecords(type)))
      ).flat();
      // Validate every explicit, inline, and image citation against the destination.
      // Preserve the original guide fields and content when changing its owner.
      makeGuideRecord(
        { ...draft, entryId: props.entry.id },
        { entry: props.entry, records: sourceRecords },
        guide,
      );
      const old = props.entries.find((item) => same(item.id, field(guide, "entry_id")));
      const records = [
        update(props.entry, {
          study_guide_ids: withId(field(props.entry, "study_guide_ids"), guide.id, true),
        }),
        update(guide, { entry_id: props.entry.id.toLowerCase() }),
      ];
      if (old)
        records.push(
          update(old, { study_guide_ids: withId(field(old, "study_guide_ids"), guide.id, false) }),
        );
      if (await write(records, "Study guide moved to journal entry.")) setGuideId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function write(records: ArchiveRecord[], message: string): Promise<boolean> {
    setPending(true);
    setError("");
    try {
      return await props.onWriteRecords(records, message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setPending(false);
    }
  }
  async function move(): Promise<void> {
    try {
      const session = availableSessions().find((item) => same(item.id, sessionId()));
      if (!session) throw new Error("Choose a session to move.");
      const records = moveJournalSession(
        props.entry,
        session,
        props.entries,
        props.notesDocuments,
        props.guides,
      );
      if (await write(records, "Session and related records moved to journal entry."))
        setSessionId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function toggleAsset(asset: ArchiveRecord, enabled: boolean): Promise<void> {
    await write(
      [
        update(props.entry, {
          attachment_ids: withId(field(props.entry, "attachment_ids"), asset.id, enabled),
        }),
      ],
      enabled ? "Material linked to journal entry." : "Material unlinked from journal entry.",
    );
  }
  return (
    <section class="journal-relations">
      <button
        type="button"
        class="button button-quiet record-action"
        aria-expanded={open()}
        onClick={() => setOpen((value) => !value)}
      >
        {open() ? "Hide connections" : "Connections"}
      </button>
      <Show when={open()}>
        <div class="journal-relations-content">
          <Show when={error()}>
            <p role="alert">{error()}</p>
          </Show>
          <h3>Sessions</h3>
          <Show when={linkedSessions().length} fallback={<p>No sessions linked.</p>}>
            <ul>
              <For each={linkedSessions()}>
                {(item) => <li>{field(item, "title") || "Untitled session"}</li>}
              </For>
            </ul>
          </Show>
          <Show when={availableSessions().length}>
            <div class="journal-relations-action">
              <label>
                Move a session here
                <select
                  value={sessionId()}
                  disabled={props.disabled || pending()}
                  onChange={(event) => setSessionId(event.currentTarget.value)}
                >
                  <option value="">Choose a session</option>
                  <For each={availableSessions()}>
                    {(item) => (
                      <option value={item.id}>{field(item, "title") || "Untitled session"}</option>
                    )}
                  </For>
                </select>
              </label>
              <button
                type="button"
                class="button button-outline record-action"
                disabled={props.disabled || pending() || !sessionId()}
                onClick={() => void move()}
              >
                Move session
              </button>
            </div>
            <p>Session notes and linked study guides move with it.</p>
          </Show>
          <h3>Study guides</h3>
          <Show when={linkedGuides().length} fallback={<p>No study guides linked.</p>}>
            <ul>
              <For each={linkedGuides()}>
                {(item) => <li>{field(item, "title") || "Untitled guide"}</li>}
              </For>
            </ul>
          </Show>
          <Show when={availableGuides().length}>
            <div class="journal-relations-action">
              <label>
                Move an entry guide here
                <select
                  value={guideId()}
                  disabled={props.disabled || pending()}
                  onChange={(event) => setGuideId(event.currentTarget.value)}
                >
                  <option value="">Choose a guide</option>
                  <For each={availableGuides()}>
                    {(item) => (
                      <option value={item.id}>{field(item, "title") || "Untitled guide"}</option>
                    )}
                  </For>
                </select>
              </label>
              <button
                type="button"
                class="button button-outline record-action"
                disabled={props.disabled || pending() || !guideId()}
                onClick={() => void moveGuide()}
              >
                Move guide
              </button>
            </div>
            <p>All cited sources must belong to this entry to move a guide here.</p>
          </Show>
          <h3>Materials</h3>
          <Show when={props.assets.length} fallback={<p>No materials available.</p>}>
            <div class="journal-relations-materials">
              <For each={props.assets}>
                {(asset) => (
                  <label>
                    <input
                      type="checkbox"
                      checked={attached().has(asset.id.toLowerCase())}
                      disabled={props.disabled || pending()}
                      onChange={(event) => void toggleAsset(asset, event.currentTarget.checked)}
                    />{" "}
                    {field(asset, "filename") ||
                      field(asset, "display_name") ||
                      field(asset, "file_name") ||
                      "Untitled material"}
                  </label>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </section>
  );
}

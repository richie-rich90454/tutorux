import { For, Show, createEffect, createSignal, onCleanup, type JSX } from "solid-js";
import {
  createSanitizedCopy,
  previewSanitizedCopy,
  type SanitizedCopyOptions,
  type SanitizedCopySummary,
} from "./archive/sanitized-copy";
import { RecordType, type ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import type { SanitizedCopyDestination } from "./platform/types";
import { platform } from "@platform";
import "./sanitized-copy.css";

type SelectionMode = "all" | "include" | "exclude";
type RecordingMode = "none" | "all" | "include" | "exclude";
type Working = "inventory" | "preview" | "destination" | "create" | null;

interface RecordSelection {
  mode: SelectionMode;
  ids: Set<string>;
}

interface TrackSelection {
  mode: RecordingMode;
  ids: Set<string>;
}

interface RecordingTrack {
  id: string;
  sessionId: string;
  sessionName: string;
  label: string;
  chunks: number;
}

interface Inventory {
  students: ArchiveRecord[];
  sessions: ArchiveRecord[];
  tracks: RecordingTrack[];
}

interface Preview {
  source: ArchiveSnapshot;
  destination: SanitizedCopyDestination;
  selectionKey: string;
  summary: SanitizedCopySummary;
}

interface SanitizedCopyProps {
  snapshot: ArchiveSnapshot;
  disabled: boolean;
}

const field = (record: ArchiveRecord, name: string): string => record.fields.get(name) ?? "";
const active = (record: ArchiveRecord): boolean => field(record, "_deleted") !== "true";

function title(record: ArchiveRecord, fallback: string): string {
  for (const key of ["display_name", "student_name", "name", "title", "label"]) {
    const value = field(record, key).trim();
    if (value) return value;
  }
  return fallback;
}

function selectedIds(records: ArchiveRecord[], selection: RecordSelection): Set<string> {
  const available = new Set(records.map((record) => record.id.toLowerCase()));
  if (selection.mode === "all") return available;
  if (selection.mode === "include")
    return new Set([...selection.ids].filter((id) => available.has(id)));
  return new Set([...available].filter((id) => !selection.ids.has(id)));
}

function validFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Enter a name for the separate archive file.");
  if (trimmed.length > 180) throw new Error("Archive file names must be 180 characters or fewer.");
  if (/[<>:"/\\|?*\p{Cc}]/u.test(trimmed) || /[. ]$/u.test(trimmed)) {
    throw new Error("Use a file name without path separators or reserved characters.");
  }
  const stem = trimmed.replace(/\.tux$/iu, "");
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) {
    throw new Error("That name is reserved by Windows. Choose another archive name.");
  }
  return `${stem}.tux`;
}

/** Let a tutor inspect exactly which records go into a new, privacy-filtered archive. */
export function SanitizedCopy(props: SanitizedCopyProps): JSX.Element {
  const [inventory, setInventory] = createSignal<Inventory | null>(null);
  const [inventoryError, setInventoryError] = createSignal("");
  const [students, setStudents] = createSignal<RecordSelection>({ mode: "all", ids: new Set() });
  const [sessions, setSessions] = createSignal<RecordSelection>({ mode: "all", ids: new Set() });
  const [tracks, setTracks] = createSignal<TrackSelection>({ mode: "none", ids: new Set() });
  const [includePrivate, setIncludePrivate] = createSignal(false);
  const [includeGenerationLogs, setIncludeGenerationLogs] = createSignal(false);
  const [includeCredentials, setIncludeCredentials] = createSignal(false);
  const [fileName, setFileName] = createSignal("tutorux-sanitized-copy.tux");
  const [destination, setDestination] = createSignal<SanitizedCopyDestination | null>(null);
  const [preview, setPreview] = createSignal<Preview | null>(null);
  const [confirmed, setConfirmed] = createSignal(false);
  const [working, setWorking] = createSignal<Working>(null);
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  let previewRun = 0;
  let destinationRun = 0;
  let activeSource: ArchiveSnapshot | null = null;
  let securityForm: HTMLFormElement | undefined;

  const unavailable = () => props.disabled || props.snapshot.locked || working() !== null;
  const retainedStudentIds = () =>
    inventory() ? selectedIds(inventory()!.students, students()) : new Set<string>();
  const retainedSessions = () => {
    const current = inventory();
    if (!current) return [];
    const studentIds = retainedStudentIds();
    return current.sessions.filter((record) => {
      const id = record.id.toLowerCase();
      if (sessions().mode === "include" && !sessions().ids.has(id)) return false;
      if (sessions().mode === "exclude" && sessions().ids.has(id)) return false;
      const studentId = field(record, "student_id").toLowerCase();
      const linkedStudentIsAvailable = current.students.some(
        (student) => student.id.toLowerCase() === studentId,
      );
      if (students().mode === "include")
        return linkedStudentIsAvailable && studentIds.has(studentId);
      return !linkedStudentIsAvailable || studentIds.has(studentId);
    });
  };
  const visibleTracks = () => {
    const retained = new Set(retainedSessions().map((record) => record.id.toLowerCase()));
    return (inventory()?.tracks ?? []).filter((track) => retained.has(track.sessionId));
  };
  const passphraseRequired = () => props.snapshot.encrypted || includeCredentials();
  const selectionError = () => {
    if (!inventory()) return "Archive records are still being read.";
    if (
      students().mode === "include" &&
      students().ids.size === 0 &&
      (inventory()?.students.length ?? 0) > 0
    )
      return "Choose at least one student, or change the student rule.";
    if (
      sessions().mode === "include" &&
      sessions().ids.size === 0 &&
      (inventory()?.sessions.length ?? 0) > 0
    )
      return "Choose at least one session, or change the session rule.";
    if (tracks().mode === "include" && tracks().ids.size === 0 && visibleTracks().length > 0)
      return "Choose at least one recording track, or change the recording rule.";
    if (includeCredentials() && !props.snapshot.encrypted)
      return "Credentials can only be copied from an encrypted archive.";
    return "";
  };

  function invalidatePreview(): void {
    previewRun++;
    setPreview(null);
    setConfirmed(false);
    setError("");
    setStatus("");
  }

  function clearDestination(): void {
    const current = destination();
    destinationRun++;
    setDestination(null);
    void current?.cancel();
  }

  function currentOptions(): SanitizedCopyOptions {
    return {
      ...(students().mode === "include" ? { includeStudents: new Set(students().ids) } : {}),
      ...(students().mode === "exclude" ? { excludeStudents: new Set(students().ids) } : {}),
      ...(sessions().mode === "include" ? { includeSessions: new Set(sessions().ids) } : {}),
      ...(sessions().mode === "exclude" ? { excludeSessions: new Set(sessions().ids) } : {}),
      ...(tracks().mode === "include" ? { includeRecordingTracks: new Set(tracks().ids) } : {}),
      ...(tracks().mode === "exclude" ? { excludeRecordingTracks: new Set(tracks().ids) } : {}),
      includeRecordings: tracks().mode === "all",
      includePrivateAnnotations: includePrivate(),
      includeGenerationLogs: includeGenerationLogs(),
      includeCredentials: includeCredentials(),
    };
  }

  function selectionKey(): string {
    return JSON.stringify({
      students: [students().mode, [...students().ids].sort()],
      sessions: [sessions().mode, [...sessions().ids].sort()],
      tracks: [tracks().mode, [...tracks().ids].sort()],
      includePrivate: includePrivate(),
      includeGenerationLogs: includeGenerationLogs(),
      includeCredentials: includeCredentials(),
    });
  }

  function pruneTrackSelection(): void {
    const available = new Set(visibleTracks().map((track) => track.id));
    setTracks((current) => ({
      ...current,
      ids: new Set([...current.ids].filter((id) => available.has(id))),
    }));
  }

  function updateStudents(next: RecordSelection): void {
    setStudents(next);
    pruneTrackSelection();
    invalidatePreview();
  }

  function updateSessions(next: RecordSelection): void {
    setSessions(next);
    pruneTrackSelection();
    invalidatePreview();
  }

  async function loadInventory(source: ArchiveSnapshot): Promise<void> {
    const request = ++previewRun;
    setInventory(null);
    setInventoryError("");
    setStudents({ mode: "all", ids: new Set() });
    setSessions({ mode: "all", ids: new Set() });
    setTracks({ mode: "none", ids: new Set() });
    setIncludePrivate(false);
    setIncludeGenerationLogs(false);
    setIncludeCredentials(false);
    setPreview(null);
    setConfirmed(false);
    setWorking("inventory");
    try {
      const [studentRecords, sessionRecords, chunks] = await Promise.all([
        source.listRecordMetadata(RecordType.student, true),
        source.listRecordMetadata(RecordType.session, true),
        source.listRecordMetadata(RecordType.audioChunk, true),
      ]);
      if (request !== previewRun || source !== props.snapshot) return;
      const availableStudents = studentRecords.filter(active);
      const availableSessions = sessionRecords.filter(active);
      const sessionNames = new Map(
        availableSessions.map((record) => [
          record.id.toLowerCase(),
          title(record, `Session ${record.id.slice(0, 8)}`),
        ]),
      );
      const byTrack = new Map<string, RecordingTrack>();
      for (const chunk of chunks) {
        if (!active(chunk)) continue;
        const id = field(chunk, "track_id").toLowerCase();
        const sessionId = field(chunk, "session_id").toLowerCase();
        if (!id || !sessionId) continue;
        const key = `${sessionId}:${id}`;
        const existing = byTrack.get(key);
        if (existing) {
          existing.chunks++;
          continue;
        }
        const sessionName = sessionNames.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`;
        byTrack.set(key, {
          id,
          sessionId,
          sessionName,
          label:
            field(chunk, "track_name") ||
            field(chunk, "track_label") ||
            field(chunk, "recording_track_name") ||
            `Track ${id.slice(0, 8)}`,
          chunks: 1,
        });
      }
      setInventory({
        students: availableStudents,
        sessions: availableSessions,
        tracks: [...byTrack.values()].sort((a, b) =>
          `${a.sessionName}\0${a.label}`.localeCompare(`${b.sessionName}\0${b.label}`),
        ),
      });
    } catch (cause) {
      if (request === previewRun)
        setInventoryError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === previewRun) setWorking(null);
    }
  }

  createEffect(() => {
    const source = props.snapshot;
    if (source === activeSource) return;
    activeSource = source;
    invalidatePreview();
    clearDestination();
    void loadInventory(source);
  });

  onCleanup(() => {
    previewRun++;
    destinationRun++;
    void destination()?.cancel();
  });

  async function chooseDestination(): Promise<void> {
    setError("");
    setStatus("");
    let suggestedName: string;
    try {
      suggestedName = validFileName(fileName());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    invalidatePreview();
    clearDestination();
    setWorking("destination");
    const request = ++destinationRun;
    const source = props.snapshot;
    try {
      const selected = await platform.chooseSanitizedCopyDestination(suggestedName);
      if (request !== destinationRun || source !== props.snapshot) {
        await selected?.cancel();
        return;
      }
      if (!selected) return;
      setDestination(selected);
      setStatus(
        platform.kind === "desktop"
          ? "Destination selected. Review the privacy choices again before creating the copy."
          : "The copy will be sent to browser downloads. Review the privacy choices before creating it.",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === destinationRun) setWorking(null);
    }
  }

  async function reviewCopy(): Promise<void> {
    invalidatePreview();
    setError(selectionError());
    const destinationValue = destination();
    if (!destinationValue || selectionError()) return;
    const source = props.snapshot;
    const key = selectionKey();
    const request = ++previewRun;
    setWorking("preview");
    try {
      const summary = await previewSanitizedCopy(source, currentOptions());
      if (
        request !== previewRun ||
        source !== props.snapshot ||
        destinationValue !== destination() ||
        key !== selectionKey()
      ) {
        return;
      }
      setPreview({ source, destination: destinationValue, selectionKey: key, summary });
      setStatus("Preview ready. Check every count before creating the separate archive.");
    } catch (cause) {
      if (request === previewRun) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === previewRun) setWorking(null);
    }
  }

  async function createCopy(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const reviewed = preview();
    const target = destination();
    const source = props.snapshot;
    const key = selectionKey();
    if (
      !reviewed ||
      !target ||
      !confirmed() ||
      reviewed.source !== source ||
      reviewed.destination !== target ||
      reviewed.selectionKey !== key
    ) {
      invalidatePreview();
      setError("The source, destination, or privacy choices changed. Review the copy again.");
      return;
    }
    const invalid = selectionError();
    if (invalid) {
      setError(invalid);
      return;
    }

    setWorking("create");
    setError("");
    setStatus("");
    let output: Awaited<ReturnType<typeof createSanitizedCopy>> | undefined;
    try {
      let destinationPassphrase: string | undefined;
      if (passphraseRequired()) {
        const form = securityForm;
        const formData = form ? new FormData(form) : new FormData();
        const passphrase = String(formData.get("destinationPassphrase") ?? "");
        const confirmation = String(formData.get("destinationPassphraseConfirmation") ?? "");
        const encoded = new TextEncoder().encode(passphrase);
        const length = encoded.byteLength;
        const validUnicode = new TextDecoder().decode(encoded) === passphrase;
        encoded.fill(0);
        if (!validUnicode) throw new Error("Enter a passphrase using valid Unicode text.");
        if (length < 12 || length > 4096)
          throw new Error("Use a new passphrase between 12 and 4096 UTF-8 bytes long.");
        if (passphrase !== confirmation) throw new Error("The new passphrases do not match.");
        destinationPassphrase = passphrase;
      }

      const options = currentOptions();
      output = await createSanitizedCopy(source, options, reviewed.summary, {
        ...(destinationPassphrase ? { destinationPassphrase } : {}),
        checkpoint: async (snapshot, previousSize) => {
          await target.checkpoint(snapshot.source, previousSize);
          return snapshot;
        },
      });
      if (source !== props.snapshot || target !== destination() || key !== selectionKey()) {
        throw new Error(
          "The source or copy settings changed before the output could be published.",
        );
      }
      const savedLocation = await target.publish(output.snapshot.source);
      if (!savedLocation) throw new Error("No output file was created.");
      output.snapshot.lock();
      await output.snapshot.source.close?.();
      output = undefined;
      setPreview(null);
      setConfirmed(false);
      setDestination(null);
      await target.cancel();
      setStatus(`Sanitized copy created at ${savedLocation}. The open archive was not changed.`);
    } catch (cause) {
      output?.snapshot.lock();
      await output?.snapshot.source.close?.().catch(() => undefined);
      await target.cancel();
      setDestination(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (securityForm) {
        securityForm
          .querySelectorAll<HTMLInputElement>('input[type="password"]')
          .forEach((input) => {
            input.value = "";
          });
      }
      setConfirmed(false);
      setWorking(null);
    }
  }

  const summaryItems = (summary: SanitizedCopySummary) => [
    { label: "Students", count: summary.students },
    { label: "Sessions", count: summary.sessions },
    { label: "Annotations", count: summary.annotations },
    { label: "Materials", count: summary.assets },
    { label: "Evidence items", count: summary.evidenceItems },
    { label: "Study guides", count: summary.guides },
    { label: "Recording tracks", count: summary.recordingTracks },
    { label: "Recording chunks", count: summary.recordings },
    { label: "Generation logs", count: summary.generationLogs },
    { label: "Credentials", count: summary.credentials },
  ];

  return (
    <section class="surface-card sanitized-copy" aria-labelledby="sanitized-copy-title">
      <header class="sanitized-copy-heading">
        <span class="eyebrow">PRIVACY WORKFLOW</span>
        <h2 id="sanitized-copy-title">Create a reviewed copy</h2>
        <p>
          Build a separate archive from selected students, sessions, and records. The source stays
          untouched, and nothing is written until you approve the preview.
        </p>
      </header>

      <div class="sanitized-copy-destination">
        <label class="form-field" for="sanitized-copy-filename">
          Copy file name
          <input
            id="sanitized-copy-filename"
            value={fileName()}
            maxlength="180"
            disabled={unavailable()}
            onInput={(event) => {
              setFileName(event.currentTarget.value);
              clearDestination();
              invalidatePreview();
            }}
          />
        </label>
        <div class="sanitized-copy-destination-action">
          <button
            class="button button-outline"
            type="button"
            disabled={unavailable()}
            onClick={() => void chooseDestination()}
          >
            {working() === "destination"
              ? "Choosing destination…"
              : platform.kind === "desktop"
                ? "Choose output file"
                : "Use this download name"}
          </button>
          <Show when={destination()}>
            {(target) => <span class="sanitized-copy-target">{target().label}</span>}
          </Show>
        </div>
        <p class="sanitized-copy-subtle">
          {platform.kind === "desktop"
            ? "Tutorux refuses to replace an existing archive at the destination."
            : "Your browser download keeps the open archive separate; duplicate names may be adjusted by the browser."}
        </p>
      </div>

      <Show when={props.snapshot.locked}>
        <p class="sanitized-copy-notice" role="status">
          Unlock this archive to review a sanitized copy. Encrypted sources stay encrypted in the
          new file.
        </p>
      </Show>
      <Show when={inventoryError()}>
        <p class="sanitized-copy-error" role="alert">
          {inventoryError()}
        </p>
      </Show>

      <div class="sanitized-copy-selection-grid">
        <fieldset class="sanitized-copy-choice">
          <legend>
            Students <span>{inventory()?.students.length ?? "—"}</span>
          </legend>
          <label class="form-field">
            Student selection
            <select
              value={students().mode}
              disabled={unavailable() || !inventory()}
              onChange={(event) =>
                updateStudents({ ...students(), mode: event.currentTarget.value as SelectionMode })
              }
            >
              <option value="all">Include all students</option>
              <option value="include">Include selected students</option>
              <option value="exclude">Exclude selected students</option>
            </select>
          </label>
          <Show when={students().mode !== "all"}>
            <div class="sanitized-copy-checklist" aria-label="Choose students">
              <For each={inventory()?.students ?? []}>
                {(record) => {
                  const id = record.id.toLowerCase();
                  return (
                    <label class="sanitized-copy-check-row">
                      <input
                        type="checkbox"
                        checked={students().ids.has(id)}
                        disabled={unavailable()}
                        onChange={(event) => {
                          const ids = new Set(students().ids);
                          if (event.currentTarget.checked) ids.add(id);
                          else ids.delete(id);
                          updateStudents({ ...students(), ids });
                        }}
                      />
                      <span>{title(record, `Student ${record.id.slice(0, 8)}`)}</span>
                    </label>
                  );
                }}
              </For>
              <Show when={!inventory()?.students.length}>
                <p class="sanitized-copy-empty">No active students are in this archive.</p>
              </Show>
            </div>
          </Show>
        </fieldset>

        <fieldset class="sanitized-copy-choice">
          <legend>
            Sessions <span>{inventory()?.sessions.length ?? "—"}</span>
          </legend>
          <label class="form-field">
            Session selection
            <select
              value={sessions().mode}
              disabled={unavailable() || !inventory()}
              onChange={(event) =>
                updateSessions({ ...sessions(), mode: event.currentTarget.value as SelectionMode })
              }
            >
              <option value="all">Include all sessions</option>
              <option value="include">Include selected sessions</option>
              <option value="exclude">Exclude selected sessions</option>
            </select>
          </label>
          <Show when={sessions().mode !== "all"}>
            <div class="sanitized-copy-checklist" aria-label="Choose sessions">
              <For each={inventory()?.sessions ?? []}>
                {(record) => {
                  const id = record.id.toLowerCase();
                  return (
                    <label class="sanitized-copy-check-row">
                      <input
                        type="checkbox"
                        checked={sessions().ids.has(id)}
                        disabled={unavailable()}
                        onChange={(event) => {
                          const ids = new Set(sessions().ids);
                          if (event.currentTarget.checked) ids.add(id);
                          else ids.delete(id);
                          updateSessions({ ...sessions(), ids });
                        }}
                      />
                      <span>{title(record, `Session ${record.id.slice(0, 8)}`)}</span>
                    </label>
                  );
                }}
              </For>
              <Show when={!inventory()?.sessions.length}>
                <p class="sanitized-copy-empty">No active sessions are in this archive.</p>
              </Show>
            </div>
          </Show>
        </fieldset>

        <fieldset class="sanitized-copy-choice sanitized-copy-recordings">
          <legend>
            Recording tracks <span>{visibleTracks().length}</span>
          </legend>
          <label class="form-field">
            Recording selection
            <select
              value={tracks().mode}
              disabled={unavailable() || !inventory()}
              onChange={(event) => {
                setTracks({ ...tracks(), mode: event.currentTarget.value as RecordingMode });
                invalidatePreview();
              }}
            >
              <option value="none">Omit all recordings</option>
              <option value="all">Include all available recordings</option>
              <option value="include">Include selected tracks</option>
              <option value="exclude">Exclude selected tracks</option>
            </select>
          </label>
          <Show when={tracks().mode === "include" || tracks().mode === "exclude"}>
            <div class="sanitized-copy-checklist" aria-label="Choose recording tracks">
              <For each={visibleTracks()}>
                {(track) => (
                  <label class="sanitized-copy-check-row sanitized-copy-track-row">
                    <input
                      type="checkbox"
                      checked={tracks().ids.has(track.id)}
                      disabled={unavailable()}
                      onChange={(event) => {
                        const ids = new Set(tracks().ids);
                        if (event.currentTarget.checked) ids.add(track.id);
                        else ids.delete(track.id);
                        setTracks({ ...tracks(), ids });
                        invalidatePreview();
                      }}
                    />
                    <span>
                      <strong>{track.label}</strong>
                      <small>
                        {track.sessionName} · {track.chunks.toLocaleString()} chunks
                      </small>
                    </span>
                  </label>
                )}
              </For>
              <Show when={tracks().mode !== "none" && !visibleTracks().length}>
                <p class="sanitized-copy-empty">
                  No recordings belong to the currently retained sessions.
                </p>
              </Show>
            </div>
          </Show>
        </fieldset>
      </div>

      <fieldset class="sanitized-copy-options">
        <legend>Optional private data</legend>
        <label class="sanitized-copy-toggle">
          <input
            type="checkbox"
            checked={includePrivate()}
            disabled={unavailable()}
            onChange={(event) => {
              setIncludePrivate(event.currentTarget.checked);
              invalidatePreview();
            }}
          />
          <span>
            <strong>Include private annotations</strong>
            <small>Private and restricted observations are omitted by default.</small>
          </span>
        </label>
        <label class="sanitized-copy-toggle">
          <input
            type="checkbox"
            checked={includeGenerationLogs()}
            disabled={unavailable()}
            onChange={(event) => {
              setIncludeGenerationLogs(event.currentTarget.checked);
              invalidatePreview();
            }}
          />
          <span>
            <strong>Include AI generation logs</strong>
            <small>Keep prompts and provider response metadata linked to retained sessions.</small>
          </span>
        </label>
        <label class="sanitized-copy-toggle">
          <input
            type="checkbox"
            checked={includeCredentials()}
            disabled={unavailable() || !props.snapshot.encrypted}
            onChange={(event) => {
              setIncludeCredentials(event.currentTarget.checked);
              invalidatePreview();
            }}
          />
          <span>
            <strong>Include encrypted provider credentials</strong>
            <small>
              Explicit opt-in. Available only from an encrypted source and requires a new output
              passphrase.
            </small>
          </span>
        </label>
      </fieldset>

      <div class="sanitized-copy-actions">
        <button
          class="button button-outline"
          type="button"
          disabled={unavailable() || !destination() || Boolean(selectionError())}
          onClick={() => void reviewCopy()}
        >
          {working() === "preview" ? "Reviewing archive…" : "Review copy contents"}
        </button>
      </div>

      <Show when={preview()} keyed>
        {(reviewed) => (
          <div class="sanitized-copy-review">
            <div class="sanitized-copy-review-heading">
              <span class="eyebrow">REVIEW BEFORE CREATING</span>
              <h3>What the new archive will contain</h3>
              <p>
                Source generation {reviewed.summary.sourceGeneration.toString()} · reviewed output{" "}
                <strong>{reviewed.destination.label}</strong>
              </p>
            </div>
            <div class="sanitized-copy-counts">
              <For each={summaryItems(reviewed.summary)}>
                {(item) => (
                  <div class="sanitized-copy-count">
                    <strong>{item.count.toLocaleString()}</strong>
                    <span>{item.label}</span>
                  </div>
                )}
              </For>
            </div>
            <p class="sanitized-copy-protection">
              {props.snapshot.encrypted
                ? "This encrypted source will remain protected in the new archive."
                : includeCredentials()
                  ? "Credentials are explicitly included and the new archive will be encrypted."
                  : "The source remains unchanged. Only the new file receives this selection."}
            </p>
            <form
              class="sanitized-copy-finalize"
              ref={(element) => (securityForm = element)}
              onSubmit={(event) => void createCopy(event)}
            >
              <Show when={passphraseRequired()}>
                <div class="sanitized-copy-passphrase-grid">
                  <label class="form-field">
                    New output passphrase
                    <input
                      name="destinationPassphrase"
                      type="password"
                      autocomplete="new-password"
                      minlength="12"
                      maxlength="4096"
                      required
                      disabled={unavailable()}
                    />
                  </label>
                  <label class="form-field">
                    Confirm output passphrase
                    <input
                      name="destinationPassphraseConfirmation"
                      type="password"
                      autocomplete="new-password"
                      minlength="12"
                      maxlength="4096"
                      required
                      disabled={unavailable()}
                    />
                  </label>
                </div>
                <p class="sanitized-copy-subtle">
                  Use 12–4096 UTF-8 bytes. Tutorux cannot recover a lost passphrase.
                </p>
              </Show>
              <label class="sanitized-copy-confirm">
                <input
                  type="checkbox"
                  checked={confirmed()}
                  disabled={unavailable()}
                  onChange={(event) => setConfirmed(event.currentTarget.checked)}
                  required
                />
                <span>
                  I reviewed these counts and confirm creating a separate archive file with this
                  exact privacy selection.
                </span>
              </label>
              <div class="sanitized-copy-actions">
                <button
                  class="button button-primary"
                  type="submit"
                  disabled={unavailable() || !confirmed() || reviewed.source !== props.snapshot}
                >
                  {working() === "create" ? "Creating verified copy…" : "Create separate copy"}
                </button>
              </div>
            </form>
          </div>
        )}
      </Show>

      <Show when={selectionError()}>
        <p class="sanitized-copy-error" role="status">
          {selectionError()}
        </p>
      </Show>
      <Show when={error()}>
        <p class="sanitized-copy-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={status()}>
        <p class="sanitized-copy-status" role="status" aria-live="polite">
          {status()}
        </p>
      </Show>
      <Show when={working() === "inventory"}>
        <p class="sanitized-copy-subtle" role="status">
          Reading archive selections…
        </p>
      </Show>
    </section>
  );
}

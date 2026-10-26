import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { RecordType, type ArchiveRecord } from "./archive/format";
import {
  canonicalizeProgressUuid,
  classificationLabel,
  decodeStudentProgress,
  STUDENT_PROGRESS_CLASSIFICATIONS,
  validateProgressEvidence,
  type StudentProgressClassification,
} from "./domain/student-progress";
import "./student-progress.css";

interface StudentProgressPanelProps {
  student: ArchiveRecord;
  sessions: ArchiveRecord[];
  evidence: ArchiveRecord[];
  disabled: boolean;
  busy: boolean;
  onSave: (input: {
    student: ArchiveRecord;
    skill: string;
    classification: StudentProgressClassification;
    evidenceSourceIds: string[];
    reviewedBy: string;
    note: string;
  }) => Promise<boolean>;
}

export function StudentProgressPanel(props: StudentProgressPanelProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [skill, setSkill] = createSignal("");
  const [classification, setClassification] =
    createSignal<StudentProgressClassification>("newly-observed");
  const [reviewedBy, setReviewedBy] = createSignal("");
  const [note, setNote] = createSignal("");
  const [selectedIds, setSelectedIds] = createSignal<string[]>([]);
  const [error, setError] = createSignal("");

  const history = createMemo(() =>
    props.sessions
      .filter(
        (session) =>
          session.type === RecordType.session &&
          session.fields.get("_deleted") !== "true" &&
          canonicalizeProgressUuid(session.fields.get("student_id") ?? "") ===
            canonicalizeProgressUuid(props.student.id),
      )
      .sort((left, right) =>
        compareUs(right.fields.get("started_at_us"), left.fields.get("started_at_us")),
      ),
  );
  const progress = createMemo(() => {
    try {
      return {
        items: decodeStudentProgress(props.student.fields.get("progress_classifications") ?? ""),
        error: "",
      };
    } catch (cause) {
      return {
        items: [],
        error: cause instanceof Error ? cause.message : "Progress history could not be read.",
      };
    }
  });
  const evidenceOptions = createMemo(() => {
    const sessionById = new Set(
      history()
        .map((session) => canonicalizeProgressUuid(session.id))
        .filter((id): id is string => id !== undefined),
    );
    return props.evidence
      .filter(
        (item) =>
          item.type === RecordType.evidenceNode &&
          item.fields.get("_deleted") !== "true" &&
          sessionById.has(canonicalizeProgressUuid(item.fields.get("session_id") ?? "") ?? ""),
      )
      .sort((left, right) =>
        compareUs(right.fields.get("created_at_us"), left.fields.get("created_at_us")),
      );
  });
  const evidenceById = createMemo(
    () =>
      new Map(
        props.evidence.map((item) => [
          canonicalizeProgressUuid(item.id) ?? item.id.toLowerCase(),
          item,
        ]),
      ),
  );

  function sourcesAreValid(sourceIds: string[], type: StudentProgressClassification): boolean {
    try {
      validateProgressEvidence(props.student.id, sourceIds, props.sessions, props.evidence, type);
      return true;
    } catch {
      return false;
    }
  }

  async function saveReview(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setError("");
    try {
      const saved = await props.onSave({
        student: props.student,
        skill: skill(),
        classification: classification(),
        evidenceSourceIds: selectedIds(),
        reviewedBy: reviewedBy(),
        note: note(),
      });
      if (!saved) return;
      setEditing(false);
      setSkill("");
      setReviewedBy("");
      setNote("");
      setSelectedIds([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The progress review could not be saved.");
    }
  }

  return (
    <details class="student-history">
      <summary>
        <span class="student-history-title">Learning history</span>
        <span class="student-history-counts">
          {history().length} {history().length === 1 ? "session" : "sessions"}
          <span aria-hidden="true">·</span>
          {progress().items.length} reviewed {progress().items.length === 1 ? "skill" : "skills"}
        </span>
      </summary>

      <div class="student-history-content">
        <section class="student-session-history" aria-label="Session history">
          <div class="student-history-section-heading">
            <div>
              <span class="eyebrow">THE THREAD OVER TIME</span>
              <h3>Sessions</h3>
            </div>
            <span class="student-history-total">{history().length} recorded</span>
          </div>
          <Show
            when={history().length > 0}
            fallback={
              <p class="student-history-empty">
                Sessions linked to this learner will appear here as their work unfolds.
              </p>
            }
          >
            <ol class="student-session-list">
              <For each={history()}>
                {(session) => (
                  <li class="student-session-item">
                    <span class="student-session-date">
                      {formatTimestamp(field(session, "started_at_us"))}
                    </span>
                    <span class="student-session-copy">
                      <strong>{field(session, "title", "Tutoring session")}</strong>
                      <small>
                        {[field(session, "subject"), field(session, "session_state")]
                          .filter(Boolean)
                          .join(" · ") || "Session"}
                      </small>
                    </span>
                  </li>
                )}
              </For>
            </ol>
          </Show>
        </section>

        <section class="student-progress-history" aria-label="Tutor-reviewed progress">
          <div class="student-history-section-heading">
            <div>
              <span class="eyebrow">HUMAN REVIEW, SOURCES ATTACHED</span>
              <h3>Progress by skill</h3>
            </div>
            <button
              class="button button-outline student-review-trigger"
              type="button"
              disabled={props.disabled || props.busy}
              onClick={() => {
                setEditing(!editing());
                setError("");
              }}
            >
              {editing() ? "Close review" : "Review a skill"}
            </button>
          </div>

          <Show when={progress().error}>
            <p class="student-progress-warning" role="status">
              This archive’s stored progress history is malformed. Other student details remain
              available.
            </p>
          </Show>
          <Show when={!progress().error && progress().items.length === 0}>
            <p class="student-history-empty">
              No tutor-reviewed progress yet. A review stays tied to evidence from this learner’s
              sessions.
            </p>
          </Show>
          <Show when={!progress().error && progress().items.length > 0}>
            <ul class="student-progress-list">
              <For each={progress().items}>
                {(item) => {
                  const valid = () => sourcesAreValid(item.evidenceSourceIds, item.classification);
                  return (
                    <li class="student-progress-item">
                      <div class="student-progress-item-heading">
                        <div>
                          <h4>{item.skill}</h4>
                          <span
                            class={`student-classification classification-${item.classification}`}
                          >
                            {classificationLabel(item.classification)}
                          </span>
                        </div>
                        <span class="student-review-date">
                          Reviewed {formatTimestamp(item.reviewedAtUs)}
                        </span>
                      </div>
                      <Show when={item.classification === "unverified-improvement"}>
                        <p class="student-unverified-claim">
                          UNVERIFIED CLAIM: improvement is not established.
                        </p>
                      </Show>
                      <Show when={item.note}>
                        <p class="student-progress-note">{item.note}</p>
                      </Show>
                      <div class="student-progress-sources">
                        <span>
                          {item.evidenceSourceIds.length} cited source
                          {item.evidenceSourceIds.length === 1 ? "" : "s"}
                        </span>
                        <span>Reviewed by {item.reviewedBy}</span>
                        <Show when={!valid()}>
                          <span class="student-source-warning">
                            Sources unavailable or no longer valid
                          </span>
                        </Show>
                      </div>
                      <ul class="student-source-chips" aria-label="Cited evidence">
                        <For each={item.evidenceSourceIds}>
                          {(id) => {
                            const source = () =>
                              evidenceById().get(canonicalizeProgressUuid(id) ?? id.toLowerCase());
                            return (
                              <li class={source() ? "" : "is-missing"}>
                                {source()
                                  ? field(source()!, "title", "Untitled evidence")
                                  : `Missing source ${id}`}
                              </li>
                            );
                          }}
                        </For>
                      </ul>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>

          <Show when={editing()}>
            <form class="student-review-form" onSubmit={(event) => void saveReview(event)}>
              <div class="student-review-form-heading">
                <span class="eyebrow">A NEW TUTOR REVIEW</span>
                <p>
                  Each skill keeps its latest classification. Earlier archive revisions remain part
                  of the file history.
                </p>
              </div>
              <div class="student-review-fields">
                <label class="field-label">
                  Skill or learning goal
                  <input
                    required
                    maxLength={256}
                    value={skill()}
                    onInput={(event) => setSkill(event.currentTarget.value)}
                    placeholder="For example, equivalent fractions"
                  />
                </label>
                <label class="field-label">
                  Classification
                  <select
                    value={classification()}
                    onChange={(event) =>
                      setClassification(event.currentTarget.value as StudentProgressClassification)
                    }
                  >
                    <For each={STUDENT_PROGRESS_CLASSIFICATIONS}>
                      {(item) => <option value={item}>{classificationLabel(item)}</option>}
                    </For>
                  </select>
                </label>
                <label class="field-label">
                  Reviewed by
                  <input
                    required
                    maxLength={128}
                    value={reviewedBy()}
                    onInput={(event) => setReviewedBy(event.currentTarget.value)}
                    placeholder="Your name or tutor label"
                  />
                  <small>This is a tutor-entered audit label, not an authenticated identity.</small>
                </label>
              </div>

              <fieldset class="student-evidence-picker">
                <legend>Evidence from this learner’s sessions</legend>
                <p class="student-evidence-guidance">
                  Recurring, partial improvement, and mastery need sources from at least two
                  sessions. Mastery also needs every source verified by a tutor.
                </p>
                <Show
                  when={evidenceOptions().length > 0}
                  fallback={
                    <p class="student-history-empty">
                      No evidence is available yet. Review evidence from this learner’s sessions
                      first.
                    </p>
                  }
                >
                  <div class="student-evidence-options">
                    <For each={evidenceOptions()}>
                      {(item) => {
                        const session = () =>
                          history().find(
                            (candidate) =>
                              canonicalizeProgressUuid(candidate.id) ===
                              canonicalizeProgressUuid(item.fields.get("session_id") ?? ""),
                          );
                        const checked = () => selectedIds().includes(item.id);
                        return (
                          <label class="student-evidence-option">
                            <input
                              type="checkbox"
                              checked={checked()}
                              onChange={(event) => {
                                const selected = new Set(selectedIds());
                                if (event.currentTarget.checked) selected.add(item.id);
                                else selected.delete(item.id);
                                setSelectedIds([...selected]);
                              }}
                            />
                            <span class="student-evidence-option-copy">
                              <strong>{field(item, "title", "Untitled evidence")}</strong>
                              <small>
                                {session()
                                  ? field(session()!, "title", "Tutoring session")
                                  : "Session unavailable"}
                                {field(item, "verification_state") === "human-verified"
                                  ? " · Tutor verified"
                                  : " · Needs review"}
                              </small>
                              <span>{snippet(field(item, "content"))}</span>
                            </span>
                          </label>
                        );
                      }}
                    </For>
                  </div>
                </Show>
              </fieldset>

              <label class="field-label student-review-note">
                Review note <span class="field-optional">Optional</span>
                <textarea
                  maxLength={4096}
                  rows={3}
                  value={note()}
                  onInput={(event) => setNote(event.currentTarget.value)}
                  placeholder="Describe what the evidence means for this learner."
                />
              </label>
              <Show when={error()}>
                <p class="student-progress-form-error" role="alert">
                  {error()}
                </p>
              </Show>
              <div class="student-review-form-actions">
                <span>
                  {selectedIds().length} source{selectedIds().length === 1 ? "" : "s"} selected
                </span>
                <button
                  class="button button-primary"
                  type="submit"
                  disabled={props.disabled || props.busy || evidenceOptions().length === 0}
                >
                  Save tutor review
                </button>
              </div>
            </form>
          </Show>
        </section>
      </div>
    </details>
  );
}

function field(record: ArchiveRecord, name: string, fallback = ""): string {
  return record.fields.get(name) ?? fallback;
}

function compareUs(left = "0", right = "0"): number {
  try {
    const a = BigInt(left || "0");
    const b = BigInt(right || "0");
    return a < b ? -1 : a > b ? 1 : 0;
  } catch {
    return left.localeCompare(right);
  }
}

function formatTimestamp(value: string): string {
  try {
    const milliseconds = Number(BigInt(value || "0") / 1000n);
    if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Date not set";
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(milliseconds),
    );
  } catch {
    return "Date not set";
  }
}

function snippet(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 150
    ? `${normalized.slice(0, 147)}…`
    : normalized || "No evidence detail";
}

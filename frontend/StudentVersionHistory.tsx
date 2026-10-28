import { For, Show, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { classificationLabel, decodeStudentProgress } from "./domain/student-progress";
import "./student-version-history.css";

interface StudentVersionHistoryProps {
  student: ArchiveRecord;
  snapshot: ArchiveSnapshot;
  disabled: boolean;
  onSave: (records: ArchiveRecord[], message: string) => Promise<boolean>;
}

const fields = [
  ["display_name", "Name"],
  ["grade", "Grade"],
  ["subjects", "Subjects"],
  ["learning_objectives", "Learning objectives"],
  ["known_difficulties", "Areas to revisit"],
  ["demonstrated_improvements", "Demonstrated improvements"],
  ["preferred_guide_template", "Preferred guide structure"],
  ["tutor_notes", "Tutor notes"],
] as const;
const field = (record: ArchiveRecord, name: string): string => record.fields.get(name) ?? "";

function dateLabel(value: string): string {
  try {
    const milliseconds = Number(BigInt(value || "0") / 1000n);
    return milliseconds > 0 && Number.isFinite(milliseconds)
      ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(
          new Date(milliseconds),
        )
      : "Date unavailable";
  } catch {
    return "Date unavailable";
  }
}

/** Browse earlier profile revisions and restore an explicitly selected revision. */
export function StudentVersionHistory(props: StudentVersionHistoryProps): JSX.Element {
  const [history, setHistory] = createSignal<ArchiveRecord[] | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal("");
  const [confirmIndex, setConfirmIndex] = createSignal<number | null>(null);

  async function load(): Promise<void> {
    setLoading(true);
    setError("");
    try {
      setHistory(
        await props.snapshot.getRecordHistory(RecordType.student, props.student.id, 10000),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  async function restore(index: number): Promise<void> {
    setLoading(true);
    setError("");
    try {
      const currentHistory = await props.snapshot.getRecordHistory(
        RecordType.student,
        props.student.id,
        index + 1,
      );
      const current = currentHistory[0];
      const selected = currentHistory[index];
      const reviewed = history();
      if (
        !current ||
        !selected ||
        !reviewed?.[index] ||
        current.revision !== reviewed[0]?.revision ||
        selected.revision !== reviewed[index]?.revision
      ) {
        throw new Error(
          "The profile changed since this history was opened. Reload it before restoring.",
        );
      }
      const restoredFields = new Map(selected.fields);
      restoredFields.delete("_deleted");
      restoredFields.delete("deleted_at_us");
      restoredFields.set("updated_at_us", (BigInt(Date.now()) * 1000n).toString());
      restoredFields.set("restored_from_revision", selected.revision.toString());
      if (
        await props.onSave(
          [{ ...selected, fields: restoredFields }],
          "Student profile restored from an earlier version.",
        )
      ) {
        setHistory(null);
        setConfirmIndex(null);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }
  function progress(record: ArchiveRecord): string {
    try {
      const items = decodeStudentProgress(field(record, "progress_classifications"));
      return items.length
        ? items
            .map((item) => `${item.skill}: ${classificationLabel(item.classification)}`)
            .join(" · ")
        : "No reviewed skills";
    } catch {
      return "Progress data could not be read";
    }
  }
  return (
    <details
      class="student-version-history"
      onToggle={(event) => {
        if (event.currentTarget.open && !history()) void load();
        else if (!event.currentTarget.open) {
          setHistory(null);
          setConfirmIndex(null);
        }
      }}
    >
      <summary>Profile versions</summary>
      <div class="student-versions-content">
        <p>
          Earlier versions include profile details and tutor progress reviews. Restoring a version
          creates a new revision.
        </p>
        <Show when={error()}>
          <p class="student-versions-error" role="alert">
            {error()}
          </p>
          <button
            class="button button-outline"
            type="button"
            disabled={loading()}
            onClick={() => void load()}
          >
            Reload history
          </button>
        </Show>
        <Show when={loading()}>
          <p role="status">Loading profile history…</p>
        </Show>
        <Show when={!loading() && history()}>
          {(revisions) => (
            <>
              <Show
                when={revisions().length > 1}
                fallback={<p>No earlier profile versions yet.</p>}
              >
                <ol class="student-versions-list">
                  <For each={revisions()}>
                    {(version, index) => (
                      <li>
                        <details>
                          <summary>
                            <strong>
                              {index() === 0 ? "Current profile" : `Version ${version.revision}`}
                            </strong>
                            <span>
                              {dateLabel(
                                field(version, "updated_at_us") || field(version, "created_at_us"),
                              )}
                            </span>
                          </summary>
                          <dl>
                            <For each={fields}>
                              {([name, label]) => (
                                <Show when={field(version, name)}>
                                  <div>
                                    <dt>{label}</dt>
                                    <dd>{field(version, name)}</dd>
                                  </div>
                                </Show>
                              )}
                            </For>
                            <div>
                              <dt>Progress</dt>
                              <dd>{progress(version)}</dd>
                            </div>
                          </dl>
                          <Show when={index() > 0}>
                            <Show
                              when={confirmIndex() === index()}
                              fallback={
                                <button
                                  class="button button-outline"
                                  type="button"
                                  disabled={props.disabled || loading()}
                                  onClick={() => setConfirmIndex(index())}
                                >
                                  Restore this version
                                </button>
                              }
                            >
                              <div class="student-versions-confirm">
                                <p>
                                  Restore profile details and progress reviews from this version?
                                </p>
                                <button
                                  class="button button-quiet"
                                  type="button"
                                  onClick={() => setConfirmIndex(null)}
                                >
                                  Cancel
                                </button>
                                <button
                                  class="button button-primary"
                                  type="button"
                                  disabled={props.disabled || loading()}
                                  onClick={() => void restore(index())}
                                >
                                  Restore version
                                </button>
                              </div>
                            </Show>
                          </Show>
                        </details>
                      </li>
                    )}
                  </For>
                </ol>
              </Show>
            </>
          )}
        </Show>
      </div>
    </details>
  );
}

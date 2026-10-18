# Student learning history

Student profiles live in the selected Tutorux archive. They store demonstrated
improvements and an optional preferred guide template alongside the existing
objectives, difficulties, and tutor notes. These fields are editable through
the CLI and appear in `student show` and JSON output.

```powershell
tutorux student create --name "Alex" `
  --demonstrated-improvements "Explains equivalent fractions" `
  --preferred-guide-template "math-worked-examples"

tutorux student update STUDENT_ID `
  --demonstrated-improvements "Shows work independently" `
  --preferred-guide-template "concise-review"
```

## Cross-session classifications

`student progress STUDENT_ID` lists human-reviewed progress classifications,
their source evidence IDs, the reviewer and review time, plus the student's
session count. `--json` returns both the session records and classifications.
Each classification is stored on the student record, and archive revisions
retain earlier edits.

Only the explicit review command creates or edits a classification:

```powershell
tutorux student progress-review STUDENT_ID `
  --skill "Equivalent fractions" `
  --classification partial-improvement `
  --evidence-ids EVIDENCE_UUID_1,EVIDENCE_UUID_2 `
  --reviewed-by "Tutor" `
  --note "Uses a visual model but still needs a prompt"
```

`student progress-edit` is an alias. Classifications are:

- `newly-observed`
- `recurring`
- `partial-improvement`
- `demonstrated-mastery`
- `unverified-improvement`
- `not-revisited`

Every classification requires at least one existing evidence-node UUID from the
same archive and student. The evidence node's session must also belong to that
student. Missing, malformed, deleted, and cross-student references are rejected.
Recurring, partial-improvement, and demonstrated-mastery require cited evidence
from at least two distinct sessions. Demonstrated-mastery additionally requires
every cited evidence node to have been marked `human-verified`. Session counts,
AI summaries, and optimistic generated text never create or promote a progress
classification. The reviewer must be named with `--reviewed-by` for every edit.
That reviewer value is a tutor-entered audit label; the local archive does not
authenticate a person's identity.

`unverified-improvement` is returned with the explicit label
`UNVERIFIED CLAIM: improvement is not established`; the label is also shown in
plain-text progress output. This keeps the claim visible without presenting it
as confirmed progress.

# External AI response import

`ai package --session UUID --template auto --output response-package.json` creates the no-key
handoff using the student's preferred template or a template inferred from the session subject.
Pass a built-in ID or custom template ID with `--template ID` to choose another template. Use
`--format markdown` for a single prompt file, `--format parts` for an ordered multi-prompt workflow,
or `--format zip` for a portable ZIP containing the canonical JSON, a short handoff guide, and
verified session asset files. The multipart workflow keeps shared session records and instructions
once, then splits transcript rows near sentence boundaries and larger time gaps; it ends with
separate evidence-consolidation and final-guide prompts. Send its prompts in order in one external
agent conversation. Asset bytes are not included in multipart text exports; attach selected files
separately. ZIP asset paths use the archive asset UUID and a sanitized filename;
`README.md` maps each ID to its path. For large sessions, the ZIP stores UTF-8-safe, ordered
JSON text parts that reconstruct the exact canonical payload when concatenated in order. ZIP
creation requires `--confirm-sensitive` because it includes
session files and media. The ZIP writer stores opaque content without extracting or executing it.
When the session has a linked student, the package also includes limited learning-profile context,
human-reviewed progress classifications, and the verified evidence records those classifications
reference. Review the package contents before sending it to an external agent.
Import a returned guide with
`ai import --session UUID --input response.json`. Add `--template ID` to pin a template when the
response did not come from a generated package. JSON responses use the versioned
`guide_response_schema` included in the package. Markdown code fences around the JSON are accepted.

ZIP handoffs include up to 6 MiB of source asset bytes and support up to 64 MiB of canonical JSON
context in ordered parts. The multipart text format supports up to 64 MiB of canonical session
context; single JSON and Markdown packages remain capped at 8 MiB. The exported-file
SHA-256 and canonical JSON SHA-256 are stored separately in the archive job.

The importer accepts a title, template ID, sections, and typed blocks. A generated package pins
the selected template ID on the imported draft and warns when the response names another template.
Blocks support paragraph,
list item, quotation, code, tutor instruction, AI recommendation, and worked example kinds. Every
block must include `source_ids`; an empty list is permitted but causes a review warning. Tutor
instructions and AI recommendations keep their labels in Markdown, HTML, DOCX, and PDF exports.

Import is bounded to 16 MiB, 32 levels of nesting, 50,000 JSON values, 500 sections, and 5,000
blocks. It rejects invalid JSON, duplicate object keys, malformed Unicode escapes, and invalid
UTF-8. Unsupported or malformed structured responses are still preserved exactly as an unstructured
proposed guide and the import job records the reason for review.

The original response bytes are stored in the archive's AI job record. A new proposed guide is
created for each import, so an existing or approved guide is never replaced. The importer validates
source IDs against the selected archive and stores validation warnings with the job. It prints a
section preview and the guide ID; use `guide show ID`, `guide validate ID`, and the edit commands to
review and correct it before approval.

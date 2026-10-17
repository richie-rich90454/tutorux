# External AI response import

`ai package --session UUID --output response-package.json` creates the no-key handoff. Import a
returned guide with `ai import --session UUID --input response.json`. JSON responses use the
versioned `guide_response_schema` included in the package. Markdown code fences around the JSON are
accepted.

The importer accepts a title, template ID, sections, and typed blocks. Blocks support paragraph,
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

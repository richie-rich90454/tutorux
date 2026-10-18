# Guide templates

Tutorux stores custom templates as settings records in the active `.tux` archive. Each template
has a name, subject, description, ordered section list, and editorial guidance. Templates never
create empty guide sections: generation skips sections that have no supporting material.

Built-in templates cover general tutoring, English, mathematics, science, programming, and
language learning. `guide generate` and `ai package` select `auto` by default. Tutorux first uses
the student's preferred template when it is available, then infers a built-in template from the
session subject, and falls back to general tutoring.

Create and edit a template with:

```text
tutorux template create --name NAME --subject SUBJECT --description TEXT \
  --sections "Session overview; Key concepts; Corrections; Practice recommendations" \
  --body "Editorial guidance for this subject."
```

Update a custom template with `template update ID --description TEXT --sections "..." --body "..."`.
Built-in templates are editable with the same command and their stable IDs (for example,
`template update mathematics --body "..."`). Use `--name` to change the display name. Changes are
stored as archive overrides; `template delete mathematics` restores the built-in defaults. Sections
may be separated by commas, semicolons, or newlines. Set a student's `--preferred-guide-template`
to a built-in ID or custom template ID/name.

Use `template export ID --output FILE` to write the portable JSON template format. This accepts a
custom template ID or built-in ID and exports the effective settings. Import that file with
`template import --input FILE`; `--name NAME` may be supplied to save it under a different name.
Plain-text imports remain supported as editorial guidance.

AI packages include the resolved template ID, ordered section names, subject, description, and
editorial guidance. Custom guidance controls organization and style only. Source attribution,
privacy, and provenance rules remain part of Tutorux's generation instructions. Imported AI
drafts retain the selected template ID and still require tutor review before approval.

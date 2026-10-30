import { randomUUID } from "node:crypto";
import { RecordType } from "../../frontend/archive/format";
import {
    approveGuideRecord,
    generateGuideDraftFromEntry,
    generateGuideDraftFromSession,
    guideRecordsWithEntryLinks,
    guideRegenerationTarget,
    makeGuideRecord,
    resolveGuideTemplates,
} from "../../frontend/domain/guides";
import { mutateArchive } from "./archive-io";
import { guideBlock, guideIndex, readGuideContext, updateGuideBlock } from "./guide-helpers";
import { CliError, emit, field, parseBoundedOption, requiredOption } from "./shared";
import { toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function guideEditAction(
    action: string,
    path: string,
    id: string,
    args: ParsedArguments,
    output: CliIo,
    json: boolean,
): Promise<number> {
    const context = await readGuideContext(path, id);
    const { current, draft, scope } = context;
    if (action === "regenerate") {
        const students = scope.records.filter((item) => item.type === RecordType.student);
        const templates = resolveGuideTemplates(scope.records);
        const entryNoteIds = new Set(
            scope.records
                .filter(
                    (item) =>
                        item.type === RecordType.settings &&
                        field(item, "record_role") === "journal-notes" &&
                        field(item, "entry_id").toLowerCase() ===
                            field(current, "entry_id").toLowerCase() &&
                        field(item, "session_id").toLowerCase() !== draft.sessionId.toLowerCase(),
                )
                .map((item) => item.id.toLowerCase()),
        );
        const alreadyIncludesEntryNotes = draft.sections.some((section) =>
            section.blocks.some((block) =>
                block.sourceIds
                    .split(/[\s,;]+/u)
                    .some((sourceId) => entryNoteIds.has(sourceId.toLowerCase())),
            ),
        );
        const includeEntryEvidence =
            args.flags.has("include-entry-evidence") ||
            (!args.flags.has("session-only") && alreadyIncludesEntryNotes);
        const regenerated = scope.session
            ? generateGuideDraftFromSession(
                  scope.session,
                  args.options.get("template") ?? draft.templateId,
                  scope.records,
                  students,
                  templates,
                  includeEntryEvidence,
              )
            : generateGuideDraftFromEntry(
                  scope.entry!,
                  args.options.get("template") ?? draft.templateId,
                  scope.records,
                  students,
                  templates,
              );
        let replacement = regenerated;
        if (args.options.has("section-index")) {
            const index = guideIndex(
                args.options.get("section-index"),
                "section-index",
                draft.sections.length,
            );
            const selected = draft.sections[index]!;
            const matching = regenerated.sections.find(
                (section) =>
                    section.heading.trim().toLocaleLowerCase() ===
                    selected.heading.trim().toLocaleLowerCase(),
            );
            if (!matching)
                throw new CliError("No current evidence maps to the selected guide section.");
            draft.sections[index] = { ...selected, blocks: matching.blocks };
            replacement = draft;
        }
        replacement.title = args.options.get("title") ?? draft.title;
        const previous = guideRegenerationTarget(current);
        const updated = makeGuideRecord(replacement, scope, previous);
        const saved =
            (
                await mutateArchive(
                    path,
                    guideRecordsWithEntryLinks(updated, previous, scope.records),
                )
            )[0] ?? updated;
        emit(output, toPlainRecord(saved), `Regenerated study guide ${saved.id}.`, json);
        return 0;
    }
    if (action === "approve") {
        const checked = makeGuideRecord(draft, scope, current);
        const approved = approveGuideRecord(checked);
        const saved =
            (
                await mutateArchive(
                    path,
                    guideRecordsWithEntryLinks(approved, current, scope.records),
                )
            )[0] ?? approved;
        emit(output, toPlainRecord(saved), `Approved study guide ${saved.id}.`, json);
        return 0;
    }

    if (action === "duplicate") {
        const copy = { ...draft, title: `${draft.title} (copy)` };
        const duplicated = makeGuideRecord(copy, scope);
        const saved =
            (
                await mutateArchive(
                    path,
                    guideRecordsWithEntryLinks(duplicated, null, scope.records),
                )
            )[0] ?? duplicated;
        emit(output, toPlainRecord(saved), `Duplicated study guide ${saved.id}.`, json);
        return 0;
    }

    if (action === "update" || action === "edit") {
        let changed = false;
        if (args.options.has("title")) {
            draft.title = args.options.get("title")!;
            changed = true;
        }
        if (args.options.has("heading")) {
            const index = guideIndex(
                args.options.get("section-index"),
                "section-index",
                draft.sections.length,
            );
            draft.sections[index]!.heading = args.options.get("heading")!;
            changed = true;
        }
        const editingBlock =
            ["text", "kind", "sources"].some((option) => args.options.has(option)) ||
            args.flags.has("clear-sources") ||
            args.flags.has("mark-reviewed");
        if (editingBlock) {
            const section =
                draft.sections[
                    guideIndex(
                        args.options.get("section-index"),
                        "section-index",
                        draft.sections.length,
                    )
                ]!;
            const block =
                section.blocks[
                    guideIndex(
                        args.options.get("block-index"),
                        "block-index",
                        section.blocks.length,
                    )
                ]!;
            updateGuideBlock(block, args);
            changed = true;
        }
        if (args.options.has("approval-state")) changed = true;
        if (!changed)
            throw new CliError(
                "Provide a title, heading, block, or approval-state change to update a guide.",
            );
    } else if (action === "add-section" || action === "section") {
        const heading = requiredOption(args, "heading");
        const blocks = args.options.has("text")
            ? [
                  guideBlock(
                      args.options.get("kind") ?? "paragraph",
                      args.options.get("text")!,
                      args.options.get("sources") ?? "",
                  ),
              ]
            : [];
        draft.sections.push({ id: randomUUID(), heading, blocks });
    } else if (action === "remove-section") {
        const index = guideIndex(
            args.options.get("section-index"),
            "section-index",
            draft.sections.length,
        );
        draft.sections.splice(index, 1);
    } else if (action === "move-section") {
        const from = guideIndex(args.options.get("from"), "from", draft.sections.length);
        const to = guideIndex(args.options.get("to"), "to", draft.sections.length);
        const [section] = draft.sections.splice(from, 1);
        draft.sections.splice(to, 0, section!);
    } else if (action === "add-block") {
        const sectionIndex = guideIndex(
            args.options.get("section-index"),
            "section-index",
            draft.sections.length,
        );
        const blocks = draft.sections[sectionIndex]!.blocks;
        const index = args.options.has("block-index")
            ? parseBoundedOption(
                  args.options.get("block-index"),
                  "block-index",
                  0,
                  0,
                  blocks.length,
              )
            : blocks.length;
        blocks.splice(
            index,
            0,
            guideBlock(
                args.options.get("kind") ?? "paragraph",
                requiredOption(args, "text"),
                args.options.get("sources") ?? "",
            ),
        );
    } else if (action === "move-block") {
        const section =
            draft.sections[
                guideIndex(
                    args.options.get("section-index"),
                    "section-index",
                    draft.sections.length,
                )
            ]!;
        const from = guideIndex(args.options.get("from"), "from", section.blocks.length);
        const to = guideIndex(args.options.get("to"), "to", section.blocks.length);
        const [block] = section.blocks.splice(from, 1);
        section.blocks.splice(to, 0, block!);
    } else if (action === "remove-block") {
        const sectionIndex = guideIndex(
            args.options.get("section-index"),
            "section-index",
            draft.sections.length,
        );
        const section = draft.sections[sectionIndex]!;
        const blockIndex = guideIndex(
            args.options.get("block-index"),
            "block-index",
            section.blocks.length,
        );
        section.blocks.splice(blockIndex, 1);
    } else if (action === "update-block") {
        const sectionIndex = guideIndex(
            args.options.get("section-index"),
            "section-index",
            draft.sections.length,
        );
        const section = draft.sections[sectionIndex]!;
        const blockIndex = guideIndex(
            args.options.get("block-index"),
            "block-index",
            section.blocks.length,
        );
        const block = section.blocks[blockIndex]!;
        updateGuideBlock(block, args);
        if (
            !args.options.has("text") &&
            !args.options.has("kind") &&
            !args.options.has("sources") &&
            !args.flags.has("mark-reviewed") &&
            !args.flags.has("clear-sources")
        ) {
            throw new CliError("Provide --text, --kind, --sources, or --mark-reviewed.");
        }
    } else {
        throw new CliError(`guide ${action} is not implemented in the TypeScript CLI yet.`);
    }

    let updated = makeGuideRecord(draft, scope, current);
    if (args.options.has("approval-state")) {
        const state = args.options.get("approval-state")!;
        if (!["draft", "proposed", "approved"].includes(state)) {
            throw new CliError("--approval-state must be draft, proposed, or approved.");
        }
        const fields = new Map(updated.fields);
        fields.set("approval_state", state);
        updated = { ...updated, fields };
    }
    const saved =
        (
            await mutateArchive(path, guideRecordsWithEntryLinks(updated, current, scope.records))
        )[0] ?? updated;
    emit(output, toPlainRecord(saved), `Study guide ${saved.id} updated.`, json);
    return 0;
}

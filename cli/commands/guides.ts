import { guideCreateAction, guideGenerateAction, guideListAction } from "./guide-crud-actions";
import { guideEditAction } from "./guide-edit-actions";
import {
    guideCompareAction,
    guideHistoryAction,
    guideShowOrExportAction,
    guideTrashAction,
    guideValidateAction,
} from "./guide-inspect-actions";
import { requiredPosition } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export {
    guideBlock,
    guideIndex,
    moveGuideToTrash,
    readGuideContext,
    readGuideEntryScope,
    readGuideScope,
    readGuideSourceRecords,
    updateGuideBlock,
    validateGuideKind,
} from "./guide-helpers";

export async function runGuideCommand(
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const json = args.flags.has("json");

    if (action === "list") return guideListAction(path, args, output, json);
    if (action === "create") return guideCreateAction(path, args, output, json);
    if (action === "generate") return guideGenerateAction(path, args, output, json);

    const id = requiredPosition(args, 0, "study guide ID");

    if (action === "validate") return guideValidateAction(path, id, args, output, json);
    if (action === "compare") return guideCompareAction(path, id, output, json);
    if (action === "show" || action === "export")
        return guideShowOrExportAction(action, path, id, args, output, json);
    if (action === "history") return guideHistoryAction(path, id, args, output, json);
    if (action === "trash" || action === "delete" || action === "restore")
        return guideTrashAction(action, path, id, output, json);

    return guideEditAction(action, path, id, args, output, json);
}

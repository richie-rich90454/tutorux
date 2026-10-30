import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { runAiAction, type AiActionOutcome } from "./ai-actions";
import { emit } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export {
    CLI_AI_MODEL_MAX_CATALOG_BYTES,
    CLI_AI_MODEL_MAX_COUNT,
    CLI_AI_MODEL_MAX_CURSOR_BYTES,
    CLI_AI_MODEL_MAX_ID_BYTES,
    CLI_AI_MODEL_MAX_PAGES,
    CLI_AI_MODEL_MAX_PAGE_BYTES,
    buildCliAiModelPageUrl,
    discoverCliAiModels,
    parseCliAiModelPage,
    readCliAiModelPage,
    sendCliAiRequest,
} from "./ai-transport";
export type { CliAiModelPage } from "./ai-transport";

export async function runAiCommand(
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const json = args.flags.has("json");
    const snapshot = await openForCommand(path);
    const generation = snapshot.commit.generation;
    const outcome = await (async (): Promise<AiActionOutcome> => {
        try {
            return await runAiAction(action, path, snapshot, args);
        } finally {
            await closeSnapshot(snapshot);
        }
    })();
    const changes = outcome.changes ?? [];
    if (changes.length) await mutateArchive(path, changes, generation);
    emit(output, outcome.result, outcome.message, json);
    return 0;
}

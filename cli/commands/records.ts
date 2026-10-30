import { runJournalRecordCommand } from "./records-journal";
import { runLifecycleRecordCommand } from "./records-lifecycle";
import { runProgressRecordCommand } from "./records-progress";
import { runSessionTransitionCommand } from "./records-session-transitions";
import { runSessionRecordCommand } from "./records-sessions";
import { runStudentRecordCommand } from "./records-students";
import type { CliIo, ParsedArguments } from "./shared";

export async function runExtendedRecordCommand(
    group: string,
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number | null> {
    return (
        (await runStudentRecordCommand(group, action, path, args, output)) ??
        (await runSessionRecordCommand(group, action, path, args, output)) ??
        (await runSessionTransitionCommand(group, action, path, args, output)) ??
        (await runProgressRecordCommand(group, action, path, args, output)) ??
        (await runJournalRecordCommand(group, action, path, args, output)) ??
        (await runLifecycleRecordCommand(group, action, path, args, output))
    );
}

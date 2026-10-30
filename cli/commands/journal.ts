import { runJournalDocumentAction } from "./journal-document";
import { runJournalOrganizerAction } from "./journal-organizer";
import { runJournalSearchAction } from "./journal-search";
import type { CliIo, ParsedArguments } from "./shared";

export {
    ensureUniqueJournalName,
    getJournalOrganizerAtPath,
    preserveUnavailableJournalLinks,
    validateJournalLinks,
} from "./journal-store";

export async function runJournalDocument(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    return runJournalDocumentAction(path, args, output);
}

export async function runJournalSearch(
    path: string,
    args: ParsedArguments,
    output: CliIo,
    requireQuery = true,
): Promise<number> {
    return runJournalSearchAction(path, args, output, requireQuery);
}

export async function runJournalOrganizerCommand(
    kind: "collection" | "tag",
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    return runJournalOrganizerAction(kind, path, args, output);
}

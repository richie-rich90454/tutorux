import type { ArchiveSnapshot } from "../frontend/archive/archive";
import { packAiContext as packSharedAiContext } from "../frontend/ai/context";

/** Preserve the CLI argument shape while sharing the Solid context packer. */
export function packAiContext(
    snapshot: ArchiveSnapshot,
    sessionId: string,
    tokenBudget: number,
    maximumItemTokens: number,
) {
    return packSharedAiContext(snapshot, sessionId, { tokenBudget, maximumItemTokens });
}

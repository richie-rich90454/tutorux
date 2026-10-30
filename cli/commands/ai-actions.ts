import type { ArchiveSnapshot } from "../../frontend/archive/archive";
import type { ArchiveRecord } from "../../frontend/archive/format";
import {
  aiCapabilitiesAction,
  aiConfigureAction,
  aiContextAction,
  aiEstimateAction,
  aiModelsAction,
} from "./ai-config-actions";
import { aiGenerateAction } from "./ai-generate-action";
import {
  aiCancelAction,
  aiImportAction,
  aiJobsAction,
  aiPackageAction,
} from "./ai-package-actions";
import { CliError } from "./shared";
import type { ParsedArguments } from "./shared";

export interface AiActionOutcome {
  changes?: ArchiveRecord[] | undefined;
  result: unknown;
  message: string;
}

export async function runAiAction(
  action: string,
  path: string,
  snapshot: ArchiveSnapshot,
  args: ParsedArguments,
): Promise<AiActionOutcome> {
  switch (action) {
    case "configure":
      return aiConfigureAction(args);
    case "context":
      return aiContextAction(snapshot, args);
    case "capabilities":
      return aiCapabilitiesAction(args);
    case "estimate":
      return aiEstimateAction(snapshot, args);
    case "models":
    case "test":
      return aiModelsAction(action, snapshot, args);
    case "package":
      return aiPackageAction(path, snapshot, args);
    case "jobs":
      return aiJobsAction(snapshot);
    case "cancel":
      return aiCancelAction(snapshot, args);
    case "import":
      return aiImportAction(snapshot, args);
    case "generate":
      return aiGenerateAction(path, snapshot, args);
    default:
      throw new CliError(`Unknown AI action: ${action}.`);
  }
}

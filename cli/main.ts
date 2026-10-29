import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { execFile } from "node:child_process";
import { link, lstat, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { availableParallelism } from "node:os";
import {
  buildArchiveDiagnosticReport,
  enumerateAudioDiagnostics,
} from "./diagnostics";
import {
  CLI_BENCHMARK_ACTIONS,
  createBenchmarkReport,
  measureArchiveIndex,
  measureAudioEnumeration,
  measureGuideExport,
  measureRendering,
  type CliBenchmarkAction,
} from "./benchmark";
import { ArchiveFormatError, RecordType, type ArchiveRecord } from "../frontend/archive/format";
import {
  appendRecords,
  backfillArchiveSecondaryIndexes,
  compactArchiveSnapshot,
  createArchiveBytes,
  createEncryptedArchiveBytes,
  openArchiveSource,
  rebuildDamagedPrimaryIndex,
  repairArchiveSnapshot,
  recoverChecksumDamagedArchiveHeader,
  recoverMagicDamagedArchiveHeader,
  recoverUnpublishedCommit,
  verifyArchiveSnapshot,
  verifyArchiveHistory,
  type ArchiveSnapshot,
} from "../frontend/archive/archive";
import {
  createSanitizedCopy,
  hasSensitiveCredentialMaterial,
  previewSanitizedCopy,
  sensitiveSettingKey,
  type SanitizedCopyCheckpoint,
  type SanitizedCopyOptions,
  type SanitizedCopyOutputOptions,
  type SanitizedCopySummary,
} from "../frontend/archive/sanitized-copy";
import {
  AI_PROVIDERS,
  createProviderConfigurationRecord,
  deterministicUuid,
  providerById,
} from "../frontend/ai/providers";
import { createAiPackageRecord } from "../frontend/ai/package";
import { createAiRequestPreview } from "../frontend/ai/request";
import { createAiGuideProposal } from "../frontend/ai/response";
import { executeAiGeneration } from "../frontend/ai/execution";
import type { AiTransportRequest, AiTransportResult } from "../frontend/platform/types";
import { packAiContext } from "./ai-context";
import { exportAiPackage } from "./ai-export";
import { appendCliAssetFile, exportCliAssetAtomically } from "./assets-stream";
import { NodeFileArchiveSource } from "../frontend/archive/node-source";
import { iterateVerifiedAssetChunks, readAssetBytes } from "../frontend/domain/assets";
import {
  evidenceSourcesAreCurrent,
  EVIDENCE_RELATIONSHIPS,
  extractSessionEvidence,
  makeEvidenceEdge,
  reviewEvidenceRecord,
} from "../frontend/domain/evidence";
import {
  GUIDE_TEMPLATES,
  approveGuideRecord,
  createGuideDraft,
  createGuideDraftFromSections,
  generateGuideDraftFromEntry,
  guideDraftFromRecord,
  guideRecordsWithEntryLinks,
  generateGuideDraftFromSession,
  GUIDE_BLOCK_KINDS,
  makeGuideRecord,
  renderGuideHtml,
  renderGuideMarkdown,
  type GuideBlockKind,
  type GuideDraft,
  type GuideSourceScope,
  type GuideExportImage,
} from "../frontend/domain/guides";
import {
  guideImageIds,
  renderGuideDocx,
  serializeGuideJson,
} from "../frontend/domain/guide-export";
import { renderGuidePdf } from "../frontend/domain/guide-pdf";
import { decodeGuideWebp } from "./guide-pdf-images";
import {
  duplicateAnnotationRecord,
  makeAnnotationRecord,
  removeAnnotationRecord,
  updateAnnotationRecord,
  validateAnnotationPriority,
  validateAnnotationType,
  type AnnotationInput,
} from "../frontend/domain/annotations";
import {
  canonicalizeProgressUuid,
  decodeStudentProgress,
  isStudentProgressClassification,
  normalizeStudentProgressSkill,
  reviewStudentProgressRecord,
  validateProgressEvidence,
} from "../frontend/domain/student-progress";
import {
  archiveJournalOrganizerRecord,
  cloneSessionRecords,
  makeJournalCollectionRecord,
  makeJournalRecords,
  makeJournalTagRecord,
  makeSessionRecords,
  makeStudentRecord,
  JOURNAL_NOTE_BLOCK_KINDS,
  notesEditState,
  moveRecordToTrash,
  restoreJournalOrganizerRecord,
  restoreRecordFromTrash,
  setSessionArchiveState,
  transitionSessionRecord,
  updateJournalOrganizerRecord,
  updateJournalRecords,
  updateOwnerNotes,
  type JournalNoteBlock,
  type JournalNoteBlockKind,
  type JournalCollectionInput,
  type JournalTagInput,
  type SessionCloneInput,
  type SessionCreateOptions,
  type SessionTransitionAction,
  updateSessionRecords,
} from "../frontend/domain/records";
import {
  loadSessionAudioTrashChanges,
  planSessionRestore,
  planSessionTrash,
} from "../frontend/domain/session-trash";
import {
  correctTranscriptRecord,
  formatTranscriptExport,
  formatTranscriptTimestampUs,
  makeTranscriptRecords,
  mergeTranscriptRecords,
  parseTranscriptSource,
  parseTranscriptTimestamp,
  resolveTranscriptFormat,
  setTranscriptSpeaker,
  setTranscriptTimestamp,
  setTranscriptVerification,
  sortTranscriptRecords,
  splitTranscriptRecord,
  type TranscriptExportFormat,
} from "../frontend/domain/transcript";
import {
  guideTemplateFromRecord,
  makeCustomGuideTemplateRecord,
  parseGuideTemplateImport,
  type GuideTemplateInput,
} from "../frontend/domain/templates";
import {
  renameRecordingTake,
  renameRecordingTrack,
  setRecordingTakeDeleted,
} from "../frontend/domain/recording-takes";
import { createSessionPackage, importSessionPackage } from "../frontend/domain/session-packages";
import { makeWaveImportRecords } from "../frontend/domain/wav";
import { buildAudioTrackWavStream, listSessionAudioTracks } from "../frontend/domain/audio";
import { summarizeWaveform } from "./recording-waveform";
import { mixRecordingTracks } from "../frontend/domain/audio-mix";
import {
  buildWaveformIndex,
  readWaveformIndex,
  waveformIndexIsCurrent,
} from "../frontend/domain/waveform-index";
import { transcribeTrack } from "./whisper";
import { prepareWavImportRecovery } from "../frontend/domain/wav-recovery";
import { prepareNativeCaptureRecovery } from "../frontend/domain/native-recording-recovery";
import { moveJournalSessionForCli } from "./journal-move";

interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

const ASSET_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;
const ASSET_IMPORT_BATCH_FILES = 128;
const archiveAccessContext = new AsyncLocalStorage<{ passphrase: string | undefined }>();

const io: CliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`),
};

const HELP = `Tutorux — local-first tutoring archive tools

Usage:
  tutorux archive init <file.tux> --name <name> [--description <text>] [--new-passphrase-env <name>]
  tutorux --passphrase-env <current-name> archive change-passphrase <file.tux> --new-passphrase-env <new-name>
  tutorux archive info <file.tux> [--json]
  tutorux archive verify <file.tux> [--history] [--passphrase-env <name>] [--json]
  tutorux archive recover <file.tux> [--apply] [--json]
  tutorux archive compact <file.tux> [--prune-unreferenced-assets] [--apply] [--json]
  tutorux archive backfill-indexes <file.tux> [--apply] [--json]
  tutorux archive repair <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux archive rebuild-index <file.tux> --output <new-copy.tux> --confirm-sensitive [--json]
    rebuilds only fully published unencrypted v1 logs with intact record headers and known record types
  tutorux archive sanitize <file.tux> --output <copy.tux> [selection options] [--new-passphrase-env <name>]
    preview first; confirm with --confirm-sensitive --expected-generation N --expected-selection SHA256 --expected-output FILE --expected-encrypted-output yes|no
    --include-students UUID,... --exclude-students UUID,... --include-sessions UUID,... --exclude-sessions UUID,...
    --include-recordings | --include-recording-tracks UUID,... | --exclude-recording-tracks UUID,...
    --include-private-annotations --include-generation-logs --include-credentials
    encrypted sources and credential-inclusive copies require --new-passphrase-env on confirmation
  tutorux --archive <file.tux> student create --name <name> [--grade <grade>] [--difficulties <text>] [--demonstrated-improvements <text>] [--preferred-guide-template <id>]
  tutorux --archive <file.tux> student list [--include-deleted] [--json]
  tutorux --archive <file.tux> student show <uuid> [--json]
  tutorux --archive <file.tux> student history <student-id> [--json]
  tutorux --archive <file.tux> student progress <student-id> [--json]
  tutorux --archive <file.tux> student progress-review <student-id> --skill <name> --classification <value> --evidence-ids <uuid,...> --reviewed-by <name> [--note <text>]
  tutorux --archive <file.tux> session create --title <title> --subject <subject> [--student <uuid>] [--entry-id <uuid>]
  tutorux --archive <file.tux> session list [--student-id <uuid>] [--entry-id <uuid>] [--from <YYYY-MM-DD>] [--to <YYYY-MM-DD>] [--archived|--unarchived] [--include-deleted] [--json]
  tutorux --archive <file.tux> session show|verify <uuid> [--json]
  tutorux --archive <file.tux> session update <uuid> [--title <title>] [--subject <subject>] [--objectives <text>] [--student-id <uuid>] [--entry-id <uuid>] [--notes <text>]
  tutorux --archive <file.tux> session clone <uuid> [--title <title>] [--type notes-only|record-audio|import-recording]
  tutorux --archive <file.tux> session export <uuid> --output <package.tux> [--force]
  tutorux --archive <file.tux> session import <package.tux>|--input <package.tux> [--student-id <uuid>]
  tutorux --archive <file.tux> session archive|unarchive <uuid>
  tutorux --archive <file.tux> session start|complete|review|resume <uuid>
  tutorux --archive <file.tux> session recover --session <uuid> [--json]
  tutorux --archive <file.tux> session delete <uuid> [--dry-run] [--confirm-scope --scope-token <token>]
  tutorux --archive <file.tux> session restore <uuid>
  tutorux --archive <file.tux> journal create --title <title> --date <YYYY-MM-DD> [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal update <entry-id> [--title <title>] [--date <YYYY-MM-DD>] [--notes <text>] [--collection-ids <uuid,...>] [--tag-ids <uuid,...>]
  tutorux --archive <file.tux> journal list [--json]
  tutorux --archive <file.tux> journal search --query <text> [--collection-id <uuid>] [--tag-id <uuid>] [--from <date>] [--to <date>] [--has-sessions true|false] [--json]
  tutorux --archive <file.tux> journal document show|update|add-block|remove-block|restore-block|move-block <document-id> [options]
  tutorux --archive <file.tux> journal collection|tag list|create|show|update|delete|restore
  tutorux --archive <file.tux> annotation add --session <uuid> --type <type> --at <time> --text <text> [--end <time>] [--priority low|normal|high|critical]
  tutorux --archive <file.tux> annotation list [--session <uuid>] [--json]
  tutorux --archive <file.tux> annotation update <id> [--text <text>] [--title <title>] [--start <time>] [--end <time>]
  tutorux --archive <file.tux> annotation remove|prioritize|duplicate <id>
  tutorux --archive <file.tux> annotation history <id> [--limit <1..10000>]
  tutorux --archive <file.tux> annotation restore <id> --revision <history-index>
  tutorux --archive <file.tux> annotation merge <id> <id> [<id>...] [--separator <text>]
  tutorux --archive <file.tux> annotation split <id> --before <text> --after <text> [--at <time>]
  tutorux --archive <file.tux> annotation link|unlink <id> --to asset|evidence --target-id <uuid>
  tutorux --archive <file.tux> asset add <file> [--session <uuid>] | import --input <file> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset import-folder <directory> [--session <uuid>]
    [--capture-source browser-microphone --consent [--capture-consent-at-us <us>]]
  tutorux --archive <file.tux> asset list [--session <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> asset show|preview|verify|remove|restore <id> [--json]
  tutorux --archive <file.tux> asset update <id> [--filename <name>] [--description <text>]
  tutorux --archive <file.tux> asset history <id> [--limit <1..10000>] [--json]
  tutorux --archive <file.tux> asset restore <id> --revision <history-index>
  tutorux --archive <file.tux> asset extract|export <id> --output <file>
  tutorux --archive <file.tux> asset link|unlink <id> --to annotation|transcript --target-id <uuid>
  tutorux --archive <file.tux> evidence extract --session <uuid>
  tutorux --archive <file.tux> evidence list|review [--session <uuid>] [--json]
  tutorux --archive <file.tux> evidence create --session <uuid> --source-segment <uuid> --type <type> --title <title> --content <text>
  tutorux --archive <file.tux> evidence approve|reject|verify|show|update|delete|restore <id>
  tutorux --archive <file.tux> evidence link --from <id> --to <id> --relationship <type>
  tutorux --archive <file.tux> evidence unlink <edge-id>
  tutorux --archive <file.tux> evidence edges --session <uuid>
  tutorux --archive <file.tux> evidence graph --session <uuid> [--json]
  tutorux --archive <file.tux> guide create --session <uuid> [--template <id>] [--title <title>]
  tutorux --archive <file.tux> guide generate (--session <uuid>|--entry-id <uuid>) [--template <id|auto>] [--title <title>] [--include-entry-evidence] [--json]
  tutorux --archive <file.tux> guide regenerate <id> [--template <id|auto>] [--title <title>] [--include-entry-evidence|--session-only] [--json]
    [--section-index <index>] regenerates only the matching section
  tutorux --archive <file.tux> guide list [--session <uuid>] [--entry-id <uuid>] [--include-deleted] [--json]
  tutorux --archive <file.tux> guide show|approve|trash|restore|history <id>
  tutorux --archive <file.tux> guide compare <id> [--json]
  tutorux --archive <file.tux> guide validate <id> [--revision <index>] [--json]
  tutorux --archive <file.tux> guide update <id> [--title <title>]
  tutorux --archive <file.tux> guide add-section <id> --heading <heading> [--text <text>]
  tutorux --archive <file.tux> guide edit <id> [--title <title>] [--section-index <index> --heading <heading>|--block-index <index> --text <text>|--kind <kind>|--sources <ids>|--clear-sources|--mark-reviewed]
  tutorux --archive <file.tux> guide move-section <id> --from <index> --to <index>
  tutorux --archive <file.tux> guide move-block <id> --section-index <index> --from <index> --to <index>
  tutorux --archive <file.tux> guide remove-section <id> --section-index <index>
  tutorux --archive <file.tux> guide add-block|update-block|remove-block <id> --section-index <index> [--block-index <index>]
  tutorux --archive <file.tux> guide export <id> --output <file> [--format markdown|html|json|docx|pdf] [--revision <index>]
  tutorux --archive <file.tux> template list|show [<id>]
  tutorux --archive <file.tux> template create --name <name> --sections <heading;heading;...>
  tutorux --archive <file.tux> template update <id> [--name <name>] [--sections <headings>]
  tutorux --archive <file.tux> template delete|restore <id>
  tutorux --archive <file.tux> template import --input <file.json>
  tutorux --archive <file.tux> template export <id> --output <file.json>
  tutorux --archive <file.tux> settings list|get <key>|set --key <key> --value <value>|reset [--key <key>]
  tutorux --archive <file.tux> settings import --input <file>|copy-to-archive --source-archive <file> [--key <key>]
  tutorux --archive <file.tux> settings credential-list|credential-remove --key <key>
    Sensitive settings require --store-credential --value-env <name> and an encrypted archive.
  tutorux ai providers [--json]
  tutorux --archive <file.tux> ai context --session <uuid> [--token-budget <n>] [--max-item-tokens <n>]
  tutorux --archive <file.tux> ai models|test --provider <id> [--refresh] [--api-key-env <name>]
  tutorux --archive <file.tux> ai capabilities --provider <id> --model <id>
  tutorux --archive <file.tux> ai configure --provider <id> [--endpoint <url>] [--model <id>]
  tutorux --archive <file.tux> ai package --session <uuid> [--template <id|auto>] [--image-ids <uuid,...>] [--output <file>]
  tutorux --archive <file.tux> ai generate --job <uuid> --provider <id> [--model <id>] [--api-key-env <name>] [--max-tokens <n>] [--request-output <file>] [--confirm-outbound --confirm-hash <sha256>]
  tutorux --archive <file.tux> ai import --session <uuid> --input <file> [--template <id>]
  tutorux --archive <file.tux> ai jobs|cancel <job-id> [--json]
  tutorux --archive <file.tux> model list|select|inspect|verify|remove-reference
  tutorux diagnostics run|archive|report [--full] | providers | graphics | audio | network
  tutorux benchmark startup|memory|cpu|indexing|rendering|export|full
  tutorux --archive <file.tux> record take-list --session <uuid> [--include-deleted] [--json]
  tutorux --archive <file.tux> record recover --session <uuid> [--json]
  tutorux --archive <file.tux> record import --session <uuid> --input <file.wav> [--additional-track]
  tutorux --archive <file.tux> record export-wav --session <uuid> --output <file.wav> [--track <uuid>] [--fill-gaps] [--overwrite]
  tutorux --archive <file.tux> record waveform --session <uuid> [--track <uuid>] [--buckets <n>]
  tutorux --archive <file.tux> record waveform-index-build --session <uuid> [--track <uuid>]
  tutorux --archive <file.tux> record waveform-index-show --session <uuid> [--track <uuid>] [--level <n>] [--json]
  tutorux --archive <file.tux> record mix --session <uuid> --take <uuid> --tracks <uuid,uuid,...> [--label <name>]
  tutorux --archive <file.tux> record take-rename --session <uuid> --take <uuid> --label <name>
  tutorux --archive <file.tux> record take-delete|take-restore --session <uuid> --take <uuid>
  tutorux --archive <file.tux> record track-rename --session <uuid> --track <uuid> --label <name>
  tutorux --archive <file.tux> transcript import --session <uuid> --input <file> [--format auto|text|srt|vtt]
  tutorux --archive <file.tux> transcript plan --session <uuid> [--track <uuid>] [--threads <n>] [--model-memory-mb <n>] [--available-memory-mb <n>]
  tutorux --archive <file.tux> annotation plan --session <uuid> [--track <uuid>] [--threads <n>] [--model-memory-mb <n>] [--available-memory-mb <n>]
  tutorux --archive <file.tux> transcript transcribe|refine --session <uuid> --track <uuid> --whisper <executable> --model <model> --consent-local-audio [--language auto|code] [--start time] [--end time] [--json]
  tutorux --archive <file.tux> transcript show --session <uuid> [--json]
  tutorux --archive <file.tux> transcript export --session <uuid> --output <file> [--format text|srt|vtt|json]
  tutorux --archive <file.tux> transcript correct <segment-id> --text <replacement>
  tutorux --archive <file.tux> transcript split <segment-id> --before <text> --after <text> [--at <time>]
  tutorux --archive <file.tux> transcript merge <segment-id> <segment-id>... [--separator <text>]
  tutorux --archive <file.tux> transcript history <segment-id> [--limit <1..10000>]
  tutorux --archive <file.tux> transcript restore <segment-id> --revision <history-index>
  tutorux --archive <file.tux> transcript timestamp <segment-id> --start <time> --end <time>
  tutorux --archive <file.tux> transcript verify <segment-id> [--state human-verified|provisional|needs-review]
  tutorux --archive <file.tux> transcript speaker <segment-id> --name <label> | --unknown

Global options:
  --archive <path>  Select the archive for record commands
  --passphrase-env <name>  Read an encrypted archive passphrase from an environment variable
  --json            Print machine-readable JSON
  --help            Show this help
  --version         Show the application version`;

export async function executeCli(
  argv: readonly string[],
  output: CliIo = io,
  signal?: AbortSignal,
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h") || argv[0] === "help") {
    output.stdout(HELP);
    return 0;
  }
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    output.stdout("Tutorux 1.0.0 (TypeScript)");
    return 0;
  }

  try {
    const args = [...argv];
    const passphraseEnvironment = takeGlobalOption(args, "passphrase-env");
    const archiveContext: { passphrase: string | undefined } = { passphrase: undefined };
    if (passphraseEnvironment !== undefined) {
      if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(passphraseEnvironment)) {
        throw new CliError("--passphrase-env requires a valid environment variable name.");
      }
      const passphrase = process.env[passphraseEnvironment];
      if (passphrase === undefined) {
        throw new CliError("The archive passphrase environment variable is not set.");
      }
      archiveContext.passphrase = passphrase;
    }
    return await archiveAccessContext.run(archiveContext, async () => {
      try {
        const jsonOutput = args.includes("--json");
        for (let index = args.length - 1; index >= 0; index -= 1) {
          if (args[index] === "--json") args.splice(index, 1);
        }
        const archivePath = takeGlobalOption(args, "archive");
        const group = args.shift();
        const action = args.shift();
        if (!group || !action)
          throw new CliError("Choose a command group and action. Run `tutorux --help` for help.");
        const parsed = parseArguments(args);
        if (jsonOutput) parsed.flags.add("json");

        if (group === "archive") return await runArchiveCommand(action, parsed, output);
        if (group === "ai" && action === "providers") {
          emit(
            output,
            AI_PROVIDERS,
            AI_PROVIDERS.map(
              (provider) => `${provider.id}  ${provider.name}  ${provider.protocol}`,
            ).join("\n"),
            parsed.flags.has("json"),
          );
          return 0;
        }
        if (group === "diagnostics")
          return runDiagnosticsCommand(action, archivePath, parsed, output, signal);
        if (group === "benchmark")
          return runBenchmarkCommand(action, archivePath, parsed, output, signal);
        if (!archivePath) throw new CliError("Record commands require --archive <path>.");
        return await runRecordCommand(group, action, archivePath, parsed, output);
      } finally {
        archiveContext.passphrase = undefined;
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "The command failed unexpectedly.";
    output.stderr(`tutorux: ${message}`);
    return error instanceof CliError ? 2 : 1;
  }
}

class CliError extends Error {}

function takeGlobalOption(args: string[], name: string): string | undefined {
  const option = `--${name}`;
  const indexes = args.flatMap((value, index) =>
    value === option || value.startsWith(`${option}=`) ? [index] : [],
  );
  if (indexes.length > 1) throw new CliError(`Choose only one ${option} value.`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  const argument = args[index]!;
  const separator = argument.indexOf("=");
  const inlineValue = separator < 0 ? undefined : argument.slice(separator + 1);
  const value = inlineValue ?? args[index + 1];
  if (!value || value.startsWith("--")) throw new CliError(`${option} requires a value.`);
  args.splice(index, inlineValue === undefined ? 2 : 1);
  return value;
}

function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [name, inlineValue] = value.slice(2).split("=", 2);
    if (!name) throw new CliError("Option names cannot be empty.");
    const next = inlineValue ?? args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      if (inlineValue === undefined) index += 1;
    } else {
      flags.add(name);
    }
  }
  return { positionals, options, flags };
}

async function runArchiveCommand(
  action: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const path = args.positionals[0];
  if (!path) throw new CliError(`archive ${action} requires a file path.`);
  if (action === "init") {
    const name = requiredOption(args, "name");
    const description = args.options.get("description") ?? "";
    const passphraseEnvironment = args.options.get("new-passphrase-env");
    if (passphraseEnvironment === undefined && args.flags.has("new-passphrase-env")) {
      throw new CliError("--new-passphrase-env requires an environment variable name.");
    }
    let bytes: Uint8Array;
    if (passphraseEnvironment === undefined) {
      bytes = await createArchiveBytes(name, description);
    } else {
      if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(passphraseEnvironment)) {
        throw new CliError("--new-passphrase-env requires a valid environment variable name.");
      }
      const passphrase = process.env[passphraseEnvironment];
      if (passphrase === undefined) {
        throw new CliError("The new archive passphrase environment variable is not set.");
      }
      bytes = await createEncryptedArchiveBytes(name, description, passphrase);
    }
    await writeBytesAtomically(resolve(path), bytes);
    emit(
      output,
      { path: resolve(path), name, bytes: bytes.byteLength, created: true },
      `${basename(path)} created (${bytes.byteLength} bytes).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "change-passphrase") {
    const newPassphraseEnvironment = args.options.get("new-passphrase-env");
    if (newPassphraseEnvironment === undefined && args.flags.has("new-passphrase-env")) {
      throw new CliError("--new-passphrase-env requires an environment variable name.");
    }
    if (newPassphraseEnvironment === undefined) {
      throw new CliError("archive change-passphrase requires --new-passphrase-env <name>.");
    }
    if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(newPassphraseEnvironment)) {
      throw new CliError("--new-passphrase-env requires a valid environment variable name.");
    }
    const newPassphrase = process.env[newPassphraseEnvironment];
    if (newPassphrase === undefined) {
      throw new CliError("The new archive passphrase environment variable is not set.");
    }

    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let current: ArchiveSnapshot | undefined;
    let next: ArchiveSnapshot | undefined;
    let verified: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError(
          "The archive changed while passphrase rotation was starting. Retry the command.",
        );
      }
      current = await unlockSnapshotForCli(await openArchiveSource(source), true);
      if (!current.encrypted) {
        throw new CliError("Passphrase changes are only available for encrypted archives.");
      }
      const currentPassphrase = archiveAccessContext.getStore()?.passphrase;
      if (currentPassphrase === undefined) {
        throw new CliError("Supply the current archive passphrase with --passphrase-env <name>.");
      }
      if (currentPassphrase === newPassphrase) {
        throw new CliError("Choose a different new passphrase from the current one.");
      }
      next = await current.changePassphrase(currentPassphrase, newPassphrase);
      verified = await (await openArchiveSource(next.source)).unlock(newPassphrase);
      await verifyArchiveSnapshot(verified);

      const currentInfo = await stat(archivePath);
      if (
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError("The archive changed during passphrase rotation. Retry the command.");
      }
      await writeSourceAtomically(archivePath, next);
      const result = {
        path: archivePath,
        previous_generation: current.commit.generation.toString(),
        generation: next.commit.generation.toString(),
        encrypted: true,
        verified: true,
        passphrase_changed: true,
      };
      emit(
        output,
        result,
        `Passphrase changed and verified for ${basename(path)} at generation ${result.generation}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      verified?.lock();
      current?.lock();
      if (next && next !== current) next.lock();
      await source.close();
    }
  }
  if (action === "recover") {
    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let snapshot: ArchiveSnapshot | undefined;
    let recovered: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while recovery was starting. Retry the command.");
      }
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
      const recovery = await recoverUnpublishedCommit(snapshot);
      recovered = recovery.snapshot;
      const applied = args.flags.has("apply");
      if (applied) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during recovery review. Retry the command.");
        }
        await writeSourceAtomically(archivePath, recovery.snapshot);
      }
      const result = {
        path: archivePath,
        previousGeneration: snapshot.commit.generation.toString(),
        recoveredGeneration: recovery.recoveredGeneration.toString(),
        recoveredGenerations: recovery.recoveredGenerations,
        discardedTrailingBytes: recovery.discardedTrailingBytes.toString(),
        recoverable: true,
        applied,
      };
      emit(
        output,
        result,
        applied
          ? `Recovered ${result.recoveredGenerations} generation(s) in ${basename(path)} through generation ${result.recoveredGeneration}; discarded ${result.discardedTrailingBytes} trailing bytes.`
          : `${result.recoveredGenerations} generation(s) through ${result.recoveredGeneration} are recoverable. Add --apply to publish them.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      recovered?.lock();
      snapshot?.lock();
      await source.close();
    }
  }
  if (action === "backfill-indexes") {
    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let snapshot: ArchiveSnapshot | undefined;
    let migrated: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError(
          "The archive changed while index migration was starting. Retry the command.",
        );
      }
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
      const migration = await backfillArchiveSecondaryIndexes(snapshot);
      migrated = migration.snapshot;
      const applied = args.flags.has("apply");
      if (applied && migration.addedEntries > 0) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError(
            "The archive changed during index migration review. Retry the command.",
          );
        }
        await writeSourceAtomically(archivePath, migrated);
      }
      const result = {
        path: archivePath,
        previousGeneration: snapshot.commit.generation.toString(),
        resultingGeneration: migrated.commit.generation.toString(),
        addedEntries: migration.addedEntries,
        conflictingEntries: migration.conflictingEntries,
        applied,
      };
      const summary = `${migration.addedEntries} missing secondary index entries; ${migration.conflictingEntries} existing conflicting aliases preserved.`;
      emit(
        output,
        result,
        applied
          ? `Index migration complete: ${summary}`
          : `Index migration preview: ${summary} Add --apply to publish changes.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      if (migrated && migrated !== snapshot) migrated.lock();
      snapshot?.lock();
      await source.close();
    }
  }
  if (action === "compact") {
    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let snapshot: ArchiveSnapshot | undefined;
    let compacted: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while compaction was starting. Retry the command.");
      }
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
      const compaction = await compactArchiveSnapshot(snapshot, {
        pruneUnreferencedAssets: args.flags.has("prune-unreferenced-assets"),
      });
      compacted = compaction.snapshot;
      const applied = args.flags.has("apply");
      if (applied) {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during compaction review. Retry the command.");
        }
        await writeSourceAtomically(archivePath, compaction.snapshot);
      }
      const result = {
        path: archivePath,
        generation: snapshot.commit.generation.toString(),
        compactedGeneration: compaction.snapshot.commit.generation.toString(),
        originalBytes: compaction.originalBytes.toString(),
        compactedBytes: compaction.compactedBytes.toString(),
        bytesSaved: (compaction.originalBytes - compaction.compactedBytes).toString(),
        recordsPreserved: compaction.preservedRecords,
        prunedAssetRecords: compaction.prunedAssetRecords,
        applied,
      };
      emit(
        output,
        result,
        applied
          ? `Compacted ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes; pruned ${result.prunedAssetRecords} unreferenced asset records.`
          : `Compaction would reduce ${basename(path)} from ${result.originalBytes} to ${result.compactedBytes} bytes and prune ${result.prunedAssetRecords} unreferenced asset records. Add --apply to replace it.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      compacted?.lock();
      snapshot?.lock();
      await source.close();
    }
  }
  if (action === "rebuild-index") {
    if (!args.flags.has("confirm-sensitive")) {
      throw new CliError(
        "An index-rebuilt copy contains private archive records. Review the destination and retry with --confirm-sensitive.",
      );
    }
    const archivePath = resolve(path);
    const requestedDestination = resolve(requiredOption(args, "output"));
    if (!requestedDestination.toLowerCase().endsWith(".tux")) {
      throw new CliError("Index-rebuilt archive copies must use the .tux extension.");
    }
    const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
      realpath(archivePath),
      realpath(dirname(requestedDestination)),
    ]);
    const destinationPath = resolve(destinationParentPath, basename(requestedDestination));
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === destinationPath.toLowerCase()
        : sourceCanonicalPath === destinationPath;
    if (samePath) throw new CliError("Index rebuild output must be a separate archive copy.");
    if (!(await stat(destinationParentPath)).isDirectory()) {
      throw new CliError("The index rebuild destination directory is unavailable.");
    }
    try {
      await lstat(destinationPath);
      throw new CliError(`Index rebuild output already exists: ${destinationPath}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!isNotFound(error)) throw error;
    }
    const openedInfo = await stat(sourceCanonicalPath);
    const source = await NodeFileArchiveSource.open(sourceCanonicalPath);
    let rebuilt: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError(
          "The archive changed while index rebuild was starting. Retry the command.",
        );
      }
      const result = await rebuildDamagedPrimaryIndex(source);
      rebuilt = result.snapshot;
      const validateBeforePublish = async (): Promise<void> => {
        const currentInfo = await stat(sourceCanonicalPath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during index rebuild. Retry the command.");
        }
      };
      await writeSourceToNewFileAtomically(
        destinationPath,
        rebuilt,
        validateBeforePublish,
        "Index rebuild",
      );
      emit(
        output,
        {
          path: sourceCanonicalPath,
          output: destinationPath,
          status: "rebuilt-index-copy",
          original_preserved: true,
          source_generation: result.sourceGeneration.toString(),
          recovered_records: result.recoveredRecords,
          recovered_revisions: result.recoveredRevisions,
          limitations:
            "Only complete published unencrypted v1 logs with known record types and intact record headers are supported; secondary aliases are reconstructed from understood schemas.",
        },
        `Index-rebuilt copy created at ${destinationPath}; the original was preserved. Recovered ${result.recoveredRecords} records and ${result.recoveredRevisions} revisions through generation ${result.sourceGeneration}. Recovery requires a complete published unencrypted v1 log with known record types and intact record headers; secondary indexes are rebuilt from understood schemas.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      rebuilt?.lock();
      await source.close();
    }
  }
  if (action === "repair") {
    if (!args.flags.has("confirm-sensitive")) {
      throw new CliError(
        "A repaired copy contains student records, recordings, annotations, and credentials. Review the destination and retry with --confirm-sensitive.",
      );
    }
    const archivePath = resolve(path);
    const destinationPath = resolve(requiredOption(args, "output"));
    if (!destinationPath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Repaired archive copies must use the .tux extension.");
    }
    const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
      realpath(archivePath),
      realpath(dirname(destinationPath)),
    ]);
    const canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
        : sourceCanonicalPath === canonicalDestinationPath;
    if (samePath) throw new CliError("Repair output must be a separate archive copy.");
    const destinationDirectory = await stat(destinationParentPath);
    if (!destinationDirectory.isDirectory()) {
      throw new CliError("The repair destination directory is unavailable.");
    }
    try {
      await stat(destinationPath);
      throw new CliError(`Repair output already exists: ${destinationPath}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!isNotFound(error)) throw error;
    }

    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let snapshot: ArchiveSnapshot | undefined;
    let repaired: ArchiveSnapshot | undefined;
    try {
      if (BigInt(openedInfo.size) !== source.size) {
        throw new CliError("The archive changed while repair was starting. Retry the command.");
      }
      try {
        snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
      } catch (error) {
        if (!(error instanceof ArchiveFormatError)) throw error;
        const passphrase = archiveAccessContext.getStore()?.passphrase;
        if (error.code === "archive_header_checksum")
          snapshot = await recoverChecksumDamagedArchiveHeader(source, passphrase);
        else if (error.code === "archive_magic_invalid")
          snapshot = await recoverMagicDamagedArchiveHeader(source, passphrase);
        else throw error;
      }
      const repair = await repairArchiveSnapshot(snapshot);
      repaired = repair.snapshot;
      const validateBeforePublish = async (): Promise<void> => {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError("The archive changed during repair. Retry the command.");
        }
      };
      await writeSourceToNewFileAtomically(destinationPath, repair.snapshot, validateBeforePublish);
      const result = {
        path: archivePath,
        output: destinationPath,
        status: "repaired-copy",
        original_preserved: true,
        selected_verified_generation: repair.selectedGeneration.toString(),
        discarded_bytes: repair.discardedTrailingBytes.toString(),
        original_bytes: repair.originalBytes.toString(),
        compacted_bytes: repair.compactedBytes.toString(),
        records_preserved: repair.preservedRecords,
      };
      emit(
        output,
        result,
        `Validated repair copy created at ${destinationPath}; the original archive was preserved. Selected verified generation ${result.selected_verified_generation}; discarded ${result.discarded_bytes} source bytes.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      repaired?.lock();
      snapshot?.lock();
      await source.close();
    }
  }
  if (action === "sanitize") {
    const archivePath = resolve(path);
    const destinationPath = resolve(requiredOption(args, "output"));
    if (!destinationPath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Sanitized archive copies must use the .tux extension.");
    }
    const selectionIds = (name: string): Set<string> => {
      const value = args.options.get(name);
      if (value === undefined) return new Set();
      const ids = new Set<string>();
      if (!value.trim()) return ids;
      for (const rawId of value.split(",").map((candidate) => candidate.trim().toLowerCase())) {
        if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(rawId)) {
          throw new CliError(`Option '--${name}' contains an invalid UUID.`);
        }
        const id = rawId;
        if (ids.has(id)) throw new CliError(`Option '--${name}' contains a duplicate UUID.`);
        ids.add(id);
      }
      return ids;
    };
    const includeRecordingTracks = selectionIds("include-recording-tracks");
    const excludeRecordingTracks = selectionIds("exclude-recording-tracks");
    const options: SanitizedCopyOptions = {
      includeStudents: selectionIds("include-students"),
      excludeStudents: selectionIds("exclude-students"),
      includeSessions: selectionIds("include-sessions"),
      excludeSessions: selectionIds("exclude-sessions"),
      includeRecordingTracks,
      excludeRecordingTracks,
      includeRecordings:
        args.flags.has("include-recordings") ||
        includeRecordingTracks.size > 0 ||
        excludeRecordingTracks.size > 0,
      includePrivateAnnotations: args.flags.has("include-private-annotations"),
      includeGenerationLogs: args.flags.has("include-generation-logs"),
      includeCredentials: args.flags.has("include-credentials"),
    };
    const newPassphraseEnvironment = args.options.get("new-passphrase-env");
    if (newPassphraseEnvironment === undefined && args.flags.has("new-passphrase-env")) {
      throw new CliError("--new-passphrase-env requires an environment variable name.");
    }
    if (
      newPassphraseEnvironment !== undefined &&
      !/^[A-Za-z_][A-Za-z\d_]*$/u.test(newPassphraseEnvironment)
    ) {
      throw new CliError("--new-passphrase-env requires a valid environment variable name.");
    }
    const sourceCanonicalPath = await realpath(archivePath);
    const destinationParentPath = await realpath(dirname(destinationPath));
    const canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
        : sourceCanonicalPath === canonicalDestinationPath;
    if (samePath) throw new CliError("Sanitized output must be a separate archive copy.");
    const destinationDirectory = await stat(destinationParentPath);
    if (!destinationDirectory.isDirectory()) {
      throw new CliError("The sanitized-copy destination directory is unavailable.");
    }
    try {
      await stat(destinationPath);
      throw new CliError(`Sanitized output already exists: ${destinationPath}`);
    } catch (error) {
      if (error instanceof CliError) throw error;
      if (!isNotFound(error)) throw error;
    }

    const reviewedOutput = args.options.get("expected-output");
    if (args.flags.has("confirm-sensitive")) {
      if (
        !args.options.has("expected-generation") ||
        !args.options.has("expected-selection") ||
        !args.options.has("expected-encrypted-output") ||
        !reviewedOutput
      ) {
        throw new CliError(
          "Confirm the reviewed preview with --expected-generation, --expected-selection, --expected-output, and --expected-encrypted-output yes|no.",
        );
      }
      const reviewedPath = resolve(reviewedOutput);
      const reviewedParent = await realpath(dirname(reviewedPath));
      const canonicalReviewedPath = resolve(reviewedParent, basename(reviewedPath));
      const pathsMatch =
        process.platform === "win32"
          ? canonicalReviewedPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
          : canonicalReviewedPath === canonicalDestinationPath;
      if (!pathsMatch)
        throw new CliError("The output path differs from the reviewed preview; preview again.");
    }

    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    let snapshot: ArchiveSnapshot | undefined;
    try {
      const currentInfo = await stat(archivePath);
      if (
        BigInt(openedInfo.size) !== source.size ||
        currentInfo.size !== openedInfo.size ||
        currentInfo.mtimeMs !== openedInfo.mtimeMs ||
        currentInfo.dev !== openedInfo.dev ||
        currentInfo.ino !== openedInfo.ino
      ) {
        throw new CliError(
          "The archive changed while sanitization was starting. Retry the command.",
        );
      }
      snapshot = await unlockSnapshotForCli(await openArchiveSource(source), true);
      const preview = await previewSanitizedCopy(snapshot, options);
      const confirmed = args.flags.has("confirm-sensitive");
      const encryptedOutput =
        snapshot.encrypted ||
        options.includeCredentials === true ||
        newPassphraseEnvironment !== undefined;
      if (!confirmed) {
        const result = sanitizedCopySummaryObject(
          preview,
          canonicalDestinationPath,
          "preview-required",
          encryptedOutput,
        );
        emit(
          output,
          result,
          `Sanitized copy preview for ${canonicalDestinationPath}:\n${formatSanitizedCopySummary(preview)}\nEncrypted output: ${encryptedOutput ? "yes (provide --new-passphrase-env when confirming)" : "no"}.\nReview the selection, encryption choice, and destination; confirm with --confirm-sensitive --expected-generation ${preview.sourceGeneration} --expected-selection ${preview.selectionFingerprint} --expected-output "${canonicalDestinationPath}" --expected-encrypted-output ${encryptedOutput ? "yes" : "no"}.`,
          args.flags.has("json"),
        );
        return 0;
      }
      const expectedGenerationText = requiredOption(args, "expected-generation");
      if (
        !/^\d+$/u.test(expectedGenerationText) ||
        BigInt(expectedGenerationText) !== preview.sourceGeneration
      ) {
        throw new CliError(
          "The source generation differs from the reviewed preview; preview again.",
        );
      }
      if (args.options.get("expected-selection") !== preview.selectionFingerprint) {
        throw new CliError("The selection differs from the reviewed preview; preview again.");
      }
      const expectedEncryptedOutput = args.options.get("expected-encrypted-output");
      if (expectedEncryptedOutput !== (encryptedOutput ? "yes" : "no")) {
        throw new CliError(
          "The output encryption choice differs from the reviewed preview; preview again.",
        );
      }
      const destinationPassphrase =
        newPassphraseEnvironment === undefined ? undefined : process.env[newPassphraseEnvironment];
      if (newPassphraseEnvironment !== undefined && destinationPassphrase === undefined) {
        throw new CliError("The new archive passphrase environment variable is not set.");
      }
      if ((snapshot.encrypted || options.includeCredentials) && !destinationPassphrase) {
        throw new CliError(
          "An encrypted output passphrase is required to preserve source protection or include credentials; provide --new-passphrase-env.",
        );
      }
      const validateBeforePublish = async (): Promise<void> => {
        const currentInfo = await stat(archivePath);
        if (
          currentInfo.size !== openedInfo.size ||
          currentInfo.mtimeMs !== openedInfo.mtimeMs ||
          currentInfo.dev !== openedInfo.dev ||
          currentInfo.ino !== openedInfo.ino
        ) {
          throw new CliError(
            "The archive changed during sanitization. Review it again before retrying.",
          );
        }
      };
      const stagingPath = join(
        dirname(canonicalDestinationPath),
        `.tutorux-${randomUUID()}.partial`,
      );
      const checkpoint: SanitizedCopyCheckpoint = async (next, previousSize) => {
        const staged = await open(stagingPath, previousSize === 0n ? "wx" : "r+", 0o600);
        try {
          const stagedInfo = await staged.stat({ bigint: true });
          if (stagedInfo.size !== previousSize) {
            throw new CliError("The sanitized-copy staging archive changed unexpectedly.");
          }
          const chunkSize = 1024 * 1024;
          for (let offset = previousSize; offset < next.source.size;) {
            const length = Number(
              next.source.size - offset > BigInt(chunkSize)
                ? BigInt(chunkSize)
                : next.source.size - offset,
            );
            const bytes = await next.source.read(offset, length);
            if (bytes.byteLength !== length) {
              throw new CliError("The generated archive source returned an incomplete read.");
            }
            let written = 0;
            while (written < bytes.length) {
              const result = await staged.write(
                bytes,
                written,
                bytes.length - written,
                Number(offset) + written,
              );
              if (result.bytesWritten === 0) {
                throw new Error("Archive output stopped accepting bytes.");
              }
              written += result.bytesWritten;
            }
            offset += BigInt(length);
          }
          await staged.sync();
        } finally {
          await staged.close();
        }
        const persistedSource = await NodeFileArchiveSource.open(stagingPath);
        try {
          return await next.openNextGeneration(persistedSource);
        } catch (error) {
          await persistedSource.close();
          throw error;
        }
      };
      let copySnapshot: ArchiveSnapshot | undefined;
      try {
        const outputOptions: SanitizedCopyOutputOptions = {
          checkpoint,
          ...(destinationPassphrase === undefined ? {} : { destinationPassphrase }),
        };
        const copy = await createSanitizedCopy(snapshot, options, preview, outputOptions);
        copySnapshot = copy.snapshot;
        copy.snapshot.lock();
        await copy.snapshot.source.close?.();
        copySnapshot = undefined;
        await publishStagedFileAtomically(
          stagingPath,
          canonicalDestinationPath,
          validateBeforePublish,
          "Sanitized copy",
        );
      } catch (error) {
        await copySnapshot?.source.close?.();
        await rm(stagingPath, { force: true });
        throw error;
      }
      emit(
        output,
        sanitizedCopySummaryObject(preview, canonicalDestinationPath, "created", encryptedOutput),
        `Sanitized ${encryptedOutput ? "encrypted " : ""}archive created at ${canonicalDestinationPath}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      snapshot?.lock();
      await source.close();
    }
  }
  if (action !== "info" && action !== "verify") {
    throw new CliError(`archive ${action} is not implemented in the TypeScript CLI yet.`);
  }
  const source = await NodeFileArchiveSource.open(resolve(path));
  let snapshot: ArchiveSnapshot | undefined;
  try {
    snapshot = await unlockSnapshotForCli(await openArchiveSource(source), action === "verify");
    const history =
      !snapshot.locked && action === "verify" && args.flags.has("history")
        ? await verifyArchiveHistory(snapshot)
        : null;
    const verification =
      history ?? (snapshot.locked ? null : await verifyArchiveSnapshot(snapshot));
    const result = {
      path: resolve(path),
      name: (await snapshot.getManifest()).displayName,
      archiveId: snapshot.header.id,
      generation: snapshot.commit.generation.toString(),
      size: snapshot.source.size.toString(),
      records: verification?.liveRecords ?? 0,
      recordsVerified: verification?.currentRecords ?? 0,
      deletedRecords: verification?.deletedRecords ?? 0,
      encrypted: snapshot.encrypted,
      locked: snapshot.locked,
      verified: verification !== null,
      historicalRevisionsVerified: history?.historicalRevisions ?? null,
      commitsVerified: history?.verifiedCommits ?? null,
      verificationScope: verification
        ? history
          ? "reachable-revisions-and-committed-generations"
          : "all-current-primary-records-and-index"
        : "header-and-index",
    };
    emit(
      output,
      result,
      snapshot.locked
        ? `${result.name}: generation ${result.generation}, encrypted records are locked.`
        : `${result.name}: generation ${result.generation}, ${result.records} live records verified (${result.deletedRecords} in Trash).`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    snapshot?.lock();
    await source.close();
  }
}

async function runRecordingAudioCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[] = [];
  let result: unknown;
  let message: string;
  try {
    let session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    const assets = await snapshot.listRecordMetadata(RecordType.assetMetadata);
    const tracks = listSessionAudioTracks(session, assets);
    if (action === "mix") {
      const takeId = canonicalizeProgressUuid(requiredOption(args, "take"));
      const trackIds = requiredOption(args, "tracks")
        .split(",")
        .map((id) => canonicalizeProgressUuid(id.trim()));
      if (!takeId || trackIds.some((id) => !id))
        throw new CliError("--take and --tracks require valid UUIDs.");
      const mixed = await mixRecordingTracks(
        snapshot,
        sessionId,
        takeId,
        trackIds as string[],
        args.options.get("label"),
      );
      changes = mixed.records;
      result = {
        session_id: sessionId,
        take_id: takeId,
        track_id: mixed.trackId,
        sample_rate_hz: mixed.sampleRateHz,
        frame_count: mixed.frameCount,
        duration_us: mixed.durationUs,
        chunk_count: mixed.chunkCount,
      };
      message = `Created mixdown track ${mixed.trackId}.`;
    } else if (action === "import") {
      const input = resolve(requiredOption(args, "input"));
      if (await sameFileIdentity(input, path))
        throw new CliError("Audio input cannot be the archive itself.");
      const capture = args.options.get("capture-source");
      if (capture) {
        if (
          !["browser-microphone", "browser-system-audio"].includes(capture) ||
          !args.flags.has("consent")
        )
          throw new CliError("Browser capture requires an accepted capture source and --consent.");
        const timestamp = requiredOption(args, "capture-consent-at-us");
        if (!/^[1-9]\d*$/u.test(timestamp))
          throw new CliError(
            "Capture consent timestamp must be a positive integer in microseconds.",
          );
        session = {
          ...session,
          fields: new Map(session.fields)
            .set("audio_import_capture_source", capture)
            .set("audio_import_capture_consent_at_us", timestamp)
            .set("audio_import_capture_consent_policy", "1"),
        };
      } else if (args.flags.has("consent") || args.options.has("capture-consent-at-us"))
        throw new CliError("Consent metadata requires --capture-source.");
      const blob = await openAsBlob(input);
      const imported = await makeWaveImportRecords(
        session,
        { name: basename(input), size: blob.size, slice: (start, end) => blob.slice(start, end) },
        args.flags.has("additional-track"),
        tracks.map((track) => track.id),
      );
      changes = imported.records;
      result = {
        session_id: sessionId,
        track_id: imported.trackId,
        take_id: imported.takeId,
        sample_rate_hz: imported.sampleRateHz,
        channel_count: imported.channelCount,
        sample_count: imported.sampleCount.toString(),
        chunk_count: imported.chunkCount,
        duration_us: imported.durationUs.toString(),
        byte_count: imported.byteCount,
        state: "completed",
      };
      message = `Imported ${imported.chunkCount} audio chunks as track ${imported.trackId}.`;
    } else {
      const trackId = args.options.get("track")?.toLowerCase() ?? tracks[0]?.id;
      if (!trackId || !tracks.some((track) => track.id === trackId))
        throw new CliError("Select an available audio track for this session.");
      if (action === "waveform-index-build") {
        const index = await buildWaveformIndex(snapshot, sessionId, trackId);
        changes = [index];
        result = {
          id: index.id,
          session_id: sessionId,
          track_id: trackId,
          level_count: field(index, "level_count"),
          base_bucket_count: field(index, "base_bucket_count"),
          timeline_frame_count: field(index, "timeline_frame_count"),
          source_fingerprint: field(index, "source_fingerprint"),
        };
        message = `Built waveform index for track ${trackId} with ${field(index, "level_count")} levels.`;
      } else if (action === "waveform-index-show") {
        const index = (await snapshot.listRecords(RecordType.waveformIndex)).find(
          (record) =>
            field(record, "record_role") === "waveform-pyramid" &&
            field(record, "session_id").toLowerCase() === sessionId &&
            field(record, "track_id").toLowerCase() === trackId,
        );
        if (!index) throw new CliError("This track has no saved waveform index. Build one first.");
        const levels = readWaveformIndex(index);
        const level = parseBoundedOption(
          args.options.get("level"),
          "level",
          0,
          0,
          levels.length - 1,
        );
        const current = await waveformIndexIsCurrent(snapshot, index);
        const buckets = levels[level]!.map((bucket) => ({
          start_frame: bucket.startFrame.toString(),
          end_frame: bucket.endFrame.toString(),
          minimum: bucket.minimum,
          maximum: bucket.maximum,
          contains_gap: bucket.containsGap,
        }));
        result = {
          id: index.id,
          session_id: sessionId,
          track_id: trackId,
          level,
          level_count: levels.length,
          current,
          buckets,
        };
        message = `Waveform index for track ${trackId}: level ${level + 1} of ${levels.length}, ${buckets.length} buckets${current ? "" : " (source changed; rebuild recommended)"}.`;
      } else if (action === "waveform") {
        const limit = parseBoundedOption(args.options.get("buckets"), "buckets", 512, 1, 8192);
        const buckets = await summarizeWaveform(snapshot, sessionId, trackId, limit);
        result = buckets;
        const levels = " .:-=+*#@";
        message = `Waveform for track ${trackId}\nAmplitude: ${buckets.map((bucket) => levels[Math.floor((Math.max(Math.abs(bucket.minimum), Math.abs(bucket.maximum)) * (levels.length - 1)) / 32768)]).join("")}\nGaps:      ${buckets.map((bucket) => (bucket.contains_gap ? "!" : " ")).join("")}`;
      } else {
        const destination = resolve(requiredOption(args, "output"));
        if (await sameFileIdentity(destination, path))
          throw new CliError("WAV output cannot replace its source archive.");
        const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
        const hasGaps = chunks.some(
          (chunk) => BigInt(field(chunk, "gap_before_samples") || "0") > 0n,
        );
        if (hasGaps && !args.flags.has("fill-gaps"))
          throw new CliError(
            "This recording contains gaps. Use --fill-gaps to insert silence explicitly.",
          );
        await writeAudioStreamAtomically(
          destination,
          await buildAudioTrackWavStream(snapshot, sessionId, trackId),
          args.flags.has("overwrite"),
        );
        result = {
          session_id: sessionId,
          track_id: trackId,
          destination,
          chunk_count: chunks.length,
          inserted_silence_for_gaps: hasGaps,
        };
        message = `Exported audio track ${trackId} to ${destination}.`;
      }
    }
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, args.flags.has("json"));
  return 0;
}

async function writeAudioStreamAtomically(
  destination: string,
  stream: ReadableStream<Uint8Array>,
  overwrite: boolean,
): Promise<void> {
  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const file = await open(temporary, "wx", 0o600);
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      await file.writeFile(chunk.value);
    }
    await file.sync();
    await file.close();
    if (overwrite) await replaceFile(temporary, destination);
    else {
      await link(temporary, destination);
      await rm(temporary, { force: true });
    }
  } catch (error) {
    await file.close().catch(() => {});
    await rm(temporary, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function runRecordingTakeCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (
    [
      "import",
      "export-wav",
      "waveform",
      "waveform-index-build",
      "waveform-index-show",
      "mix",
    ].includes(action)
  )
    return runRecordingAudioCommand(action, path, args, output);
  if (action === "take-list") {
    const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
    if (!sessionId) throw new CliError("--session must be a valid UUID.");
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const records = await snapshot.listRecordMetadata(
        RecordType.assetMetadata,
        args.flags.has("include-deleted"),
      );
      const takes = records.filter(
        (record) =>
          field(record, "record_role") === "recording-take" &&
          field(record, "session_id").toLowerCase() === sessionId,
      );
      emit(
        output,
        takes.map(toPlainRecord),
        takes.length
          ? `${takes.length} recording take${takes.length === 1 ? "" : "s"}.`
          : "No recording takes found.",
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (!["take-rename", "take-delete", "take-restore", "track-rename"].includes(action)) {
    throw new CliError(`record ${action} is not implemented in the TypeScript CLI yet.`);
  }

  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const snapshot = await openForCommand(path);
  const expectedGeneration = snapshot.commit.generation;
  let updates: ArchiveRecord[];
  try {
    await requireLiveRecord(snapshot, RecordType.session, sessionId);
    if (action === "track-rename") {
      const trackId = canonicalizeProgressUuid(requiredOption(args, "track"));
      if (!trackId) throw new CliError("--track must be a valid UUID.");
      const track = await snapshot.getRecord(RecordType.assetMetadata, trackId);
      if (
        !track ||
        field(track, "record_role") !== "audio-track" ||
        field(track, "session_id").toLowerCase() !== sessionId
      ) {
        throw new CliError("The selected track does not belong to this session.");
      }
      updates = [await renameRecordingTrack(snapshot, trackId, requiredOption(args, "label"))];
    } else {
      const takeId = canonicalizeProgressUuid(requiredOption(args, "take"));
      if (!takeId) throw new CliError("--take must be a valid UUID.");
      const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
      if (
        !take ||
        field(take, "record_role") !== "recording-take" ||
        field(take, "session_id").toLowerCase() !== sessionId
      ) {
        throw new CliError("The selected take does not belong to this session.");
      }
      updates =
        action === "take-rename"
          ? [await renameRecordingTake(snapshot, takeId, requiredOption(args, "label"))]
          : await setRecordingTakeDeleted(snapshot, takeId, action === "take-delete");
    }
  } finally {
    await closeSnapshot(snapshot);
  }

  const saved = await mutateArchive(
    path,
    updates,
    expectedGeneration,
    "The archive changed while this recording update was being prepared. Retry the command.",
  );
  const visibleRecords = saved.filter(
    (record) =>
      record.type === RecordType.assetMetadata &&
      ["recording-take", "audio-track"].includes(field(record, "record_role")),
  );
  emit(
    output,
    visibleRecords.map(toPlainRecord),
    action === "take-delete"
      ? "Recording take and its audio moved to Trash."
      : action === "take-restore"
        ? "Recording take and its audio restored."
        : action === "track-rename"
          ? "Recording track renamed."
          : "Recording take renamed.",
    json,
  );
  return 0;
}

async function runSessionAudioRecovery(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const id = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!id) throw new CliError("--session must be a valid UUID.");
  const snapshot = await openForCommand(path);
  let generation: bigint;
  let prepared: Awaited<ReturnType<typeof prepareWavImportRecovery>> | undefined;
  let native: Awaited<ReturnType<typeof prepareNativeCaptureRecovery>> | undefined;
  let trackId: string;
  try {
    generation = snapshot.commit.generation;
    const session = await requireLiveRecord(snapshot, RecordType.session, id);
    trackId = field(session, "audio_import_track_id");
    if (field(session, "recording_track_id") || field(session, "recording_track_ids")) {
      native = await prepareNativeCaptureRecovery(snapshot, session);
    } else {
      prepared = await prepareWavImportRecovery(snapshot, session);
    }
  } finally {
    await closeSnapshot(snapshot);
  }
  if (native) {
    if (native.records.length)
      await mutateArchive(
        path,
        native.records,
        generation,
        "The archive changed while recovery was being prepared. Retry the command.",
      );
    emit(
      output,
      {
        session_id: id,
        state: native.completed ? "completed" : BigInt(native.chunkCount) > 0n ? "partial" : "failed",
        duration_us: native.durationUs,
        sample_count: native.sampleCount,
        chunk_count: native.chunkCount,
        byte_count: native.byteCount,
        tracks: native.tracks,
      },
      native.message,
      args.flags.has("json"),
    );
    return native.completed ? 0 : 2;
  }
  if (!prepared) throw new CliError("No WAV import recovery is available for this session.");
  if (prepared.records.length)
    await mutateArchive(
      path,
      prepared.records,
      generation,
      "The archive changed while recovery was being prepared. Retry the command.",
    );
  emit(
    output,
    {
      session_id: id,
      track_id: trackId,
      state: prepared.state,
      sample_count: String(prepared.sampleCount),
      chunk_count: String(prepared.chunkCount),
      duration_us: String(prepared.durationUs),
      byte_count: String(prepared.byteCount),
      completed: prepared.completed,
      message: prepared.message,
    },
    prepared.message,
    args.flags.has("json"),
  );
  return prepared.completed ? 0 : 2;
}

async function runRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if ((group === "session" || group === "record") && action === "recover") {
    return runSessionAudioRecovery(path, args, output);
  }
  if (group === "ai") return runAiCommand(action, path, args, output);
  if (group === "model") return runModelCommand(action, path, args, output);
  if (group === "record") return runRecordingTakeCommand(action, path, args, output);
  if (group === "journal" && (action === "collection" || action === "tag")) {
    return runJournalOrganizerCommand(action, path, args, output);
  }
  if (group === "journal" && action === "search") return runJournalSearch(path, args, output);
  if (group === "journal" && action === "document") return runJournalDocument(path, args, output);
  if (group === "journal" && action === "entry") {
    const entryAction = args.positionals[0];
    if (!entryAction) throw new CliError("Choose a journal entry action.");
    const forwarded = { ...args, positionals: args.positionals.slice(1) };
    if (entryAction === "search" || (entryAction === "list" && args.options.has("query")))
      return runJournalSearch(path, forwarded, output);
    return runRecordCommand("journal", entryAction, path, forwarded, output);
  }
  if (group === "session" && action === "export") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const destinationPath = resolve(requiredOption(args, "output"));
    if (!destinationPath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Session packages must use the .tux extension.");
    }
    const archivePath = resolve(path);
    const sourceCanonicalPath = await realpath(archivePath);
    let canonicalDestinationPath: string;
    try {
      canonicalDestinationPath = await realpath(destinationPath);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      const destinationParentPath = await realpath(dirname(destinationPath));
      canonicalDestinationPath = resolve(destinationParentPath, basename(destinationPath));
    }
    const samePath =
      process.platform === "win32"
        ? sourceCanonicalPath.toLowerCase() === canonicalDestinationPath.toLowerCase()
        : sourceCanonicalPath === canonicalDestinationPath;
    if (samePath) throw new CliError("Session package output must be a separate file.");

    const snapshot = await openForCommand(archivePath);
    let packageSnapshot: ArchiveSnapshot | undefined;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      packageSnapshot = await createSessionPackage(snapshot, session.id);
      if (args.flags.has("force")) {
        await writeSourceAtomically(destinationPath, packageSnapshot);
      } else {
        await writeSourceToNewFileAtomically(
          destinationPath,
          packageSnapshot,
          undefined,
          "Session package",
        );
      }
      emit(
        output,
        {
          path: canonicalDestinationPath,
          session_id: session.id,
          bytes: packageSnapshot.source.size.toString(),
          created: true,
        },
        `Exported session package for ${session.id} to ${canonicalDestinationPath}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      packageSnapshot?.lock();
      await packageSnapshot?.source.close?.();
      await closeSnapshot(snapshot);
    }
  }
  if (group === "session" && action === "import") {
    const positionalPath = args.positionals[0];
    const optionPath = args.options.get("input");
    if (positionalPath && optionPath) {
      throw new CliError("Choose either a package path or --input, not both.");
    }
    const packagePath = positionalPath ?? optionPath;
    if (!packagePath) throw new CliError("session import requires a package path.");
    const canonicalPackagePath = resolve(packagePath);
    if (!canonicalPackagePath.toLowerCase().endsWith(".tux")) {
      throw new CliError("Session packages must use the .tux extension.");
    }
    const packageInfo = await lstat(canonicalPackagePath);
    if (packageInfo.isSymbolicLink() || !packageInfo.isFile()) {
      throw new CliError("The session package must be a regular, non-symlink file.");
    }
    const importState = await (async () => {
      let packageSource: NodeFileArchiveSource | undefined;
      let packageSnapshot: ArchiveSnapshot | undefined;
      let destination: ArchiveSnapshot | undefined;
      try {
        packageSource = await NodeFileArchiveSource.open(canonicalPackagePath);
        destination = await openForCommand(path);
        if (BigInt(packageInfo.size) !== packageSource.size) {
          throw new CliError(
            "The session package changed while import was starting. Retry the command.",
          );
        }
        packageSnapshot = await openArchiveSource(packageSource);
        const expectedGeneration = destination.commit.generation;
        const imported = await importSessionPackage(
          packageSnapshot,
          destination,
          args.options.get("student-id"),
        );
        return {
          importedRecords: imported.records,
          importedSessionId: imported.sessionId,
          expectedGeneration,
        };
      } finally {
        packageSnapshot?.lock();
        await packageSource?.close();
        if (destination) await closeSnapshot(destination);
      }
    })();
    const { importedRecords, importedSessionId, expectedGeneration } = importState;
    const saved = await mutateArchive(
      path,
      importedRecords,
      expectedGeneration,
      "The destination archive changed while the session package was being prepared. Retry the import.",
    );
    const importedSession =
      saved.find(
        (record) => record.type === RecordType.session && record.id === importedSessionId,
      ) ??
      importedRecords.find(
        (record) => record.type === RecordType.session && record.id === importedSessionId,
      );
    if (!importedSession) throw new CliError("The imported package has no session record.");
    emit(
      output,
      {
        session: toPlainRecord(importedSession),
        session_id: importedSessionId,
        imported_records: importedRecords.length,
      },
      `Imported session ${field(importedSession, "title", "Tutoring session")} (${importedSessionId}).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "student" && action === "create") {
    const record = makeStudentRecord({
      name: requiredOption(args, "name"),
      grade: args.options.get("grade") ?? "",
      subjects: args.options.get("subjects") ?? "",
      objectives: args.options.get("objectives") ?? "",
      tutorNotes: args.options.get("notes") ?? "",
      difficulties: args.options.get("difficulties") ?? "",
      demonstratedImprovements: args.options.get("demonstrated-improvements") ?? "",
      preferredGuideTemplate: args.options.get("preferred-guide-template") ?? "",
    });
    const [saved] = await mutateArchive(path, [record]);
    const created = saved ?? record;
    emit(
      output,
      toPlainRecord(created),
      `Created student ${field(created, "display_name")} (${created.id}).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "session" && action === "create") {
    const snapshot = await openForCommand(path);
    let expectedGeneration: bigint;
    let creationOptions: SessionCreateOptions;
    try {
      expectedGeneration = snapshot.commit.generation;
      const studentId = args.options.get("student") ?? args.options.get("student-id") ?? "";
      const student = studentId ? await snapshot.getRecord(RecordType.student, studentId) : null;
      if (studentId && (!student || field(student, "_deleted") === "true")) {
        throw new CliError(`Student ${studentId} was not found in this archive.`);
      }
      if (args.flags.has("entry-id"))
        throw new CliError("--entry-id requires a journal entry UUID.");
      const linkedEntryId = args.options.get("entry-id");
      const linkedEntry = linkedEntryId
        ? await getJournalEntry(snapshot, linkedEntryId.toLowerCase())
        : undefined;
      const settings = await snapshot.listRecords(RecordType.settings);
      creationOptions = {
        ensureJournalRoot: !settings.some((record) => field(record, "record_role") === "journal"),
        ...(linkedEntry ? { linkedEntry } : {}),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const records = makeSessionRecords(
      {
        studentId: args.options.get("student") ?? args.options.get("student-id") ?? "",
        subject: requiredOption(args, "subject"),
        title: requiredOption(args, "title"),
        objectives: args.options.get("objectives") ?? "",
        notes: args.options.get("notes") ?? "",
      },
      creationOptions,
    );
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while the new session and journal link were being prepared. Retry the command.",
    );
    const session = saved[0] ?? records[0]!;
    emit(
      output,
      {
        session: toPlainRecord(session),
        notesDocumentId: (saved[1] ?? records[1]!).id,
        entryId: field(session, "entry_id"),
      },
      `Created session ${field(session, "title")} (${session.id}) in journal entry ${field(session, "entry_id")}.`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "journal" && action === "create") {
    const collectionIds = optionIdList(args, "collection-ids");
    const tagIds = optionIdList(args, "tag-ids");
    await validateJournalLinks(path, collectionIds ?? [], "journal-collection");
    await validateJournalLinks(path, tagIds ?? [], "journal-tag");
    const records = makeJournalRecords({
      title: requiredOption(args, "title"),
      date: requiredOption(args, "date"),
      notes: args.options.get("notes") ?? "",
      ...(collectionIds === undefined ? {} : { collectionIds }),
      ...(tagIds === undefined ? {} : { tagIds }),
    });
    const saved = await mutateArchive(path, records);
    const entry = saved[0] ?? records[0]!;
    emit(
      output,
      { entry: toPlainRecord(entry), notesDocumentId: (saved[1] ?? records[1]!).id },
      `Created journal entry ${field(entry, "title")} (${entry.id}).`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (group === "transcript") return runTranscriptCommand(action, path, args, output);
  if (group === "annotation") return runAnnotationCommand(action, path, args, output);
  if (group === "asset") return runAssetCommand(action, path, args, output);
  if (group === "evidence") return runEvidenceCommand(action, path, args, output);
  if (group === "guide") return runGuideCommand(action, path, args, output);
  if (group === "template") return runTemplateCommand(action, path, args, output);
  if (group === "settings") return runSettingsCommand(action, path, args, output);
  const extended = await runExtendedRecordCommand(group, action, path, args, output);
  if (extended !== null) return extended;
  if ((group === "student" || group === "session" || group === "journal") && action === "list") {
    const type =
      group === "student"
        ? RecordType.student
        : group === "session"
          ? RecordType.session
          : RecordType.settings;
    const role = group === "journal" ? "journal-entry" : undefined;
    const snapshot = await openForCommand(path);
    try {
      let records = (await snapshot.listRecords(type, args.flags.has("include-deleted"))).filter(
        (record) => !role || field(record, "record_role") === role,
      );
      if (group === "session" && (args.flags.has("unarchived") || !args.flags.has("archived"))) {
        records = records.filter((record) => field(record, "archived") !== "true");
      }
      if (group === "session") {
        const studentId = args.options.get("student-id");
        if (studentId !== undefined) {
          records = records.filter((record) => field(record, "student_id") === studentId);
        }
        const rawEntryId = args.options.get("entry-id");
        if (rawEntryId !== undefined) {
          const entryId = canonicalizeProgressUuid(rawEntryId);
          if (!entryId) throw new CliError("--entry-id must be a valid UUID.");
          records = records.filter(
            (record) => canonicalizeProgressUuid(field(record, "entry_id")) === entryId,
          );
        }
        const from = parseSessionDateBound(args.options.get("from"), false);
        const to = parseSessionDateBound(args.options.get("to"), true);
        if (from !== undefined && to !== undefined && from > to) {
          throw new CliError("--from must not be later than --to.");
        }
        if (from !== undefined || to !== undefined) {
          records = records.filter((record) => {
            const startedAt = sessionStartedAt(record);
            return (
              (from === undefined || startedAt >= from) && (to === undefined || startedAt <= to)
            );
          });
        }
        records.sort((left, right) => {
          const leftStartedAt = sessionStartedAt(left);
          const rightStartedAt = sessionStartedAt(right);
          return leftStartedAt > rightStartedAt ? -1 : leftStartedAt < rightStartedAt ? 1 : 0;
        });
      }
      const transcriptCounts = new Map<string, number>();
      if (group === "session" && args.flags.has("json")) {
        for (const transcript of await snapshot.listRecords(RecordType.transcriptSegment)) {
          const sessionId = canonicalizeProgressUuid(field(transcript, "session_id"));
          if (sessionId)
            transcriptCounts.set(sessionId, (transcriptCounts.get(sessionId) ?? 0) + 1);
        }
      }
      const rows = records.map((record) => {
        if (group === "student") return studentProfileObject(record);
        const row = toPlainRecord(record);
        if (group !== "session") return row;
        const audioChunkCount = record.fields.get("recording_audio_chunks") ?? "0";
        const audioDuration = record.fields.get("recording_duration_us") ?? "0";
        const transcriptSegmentCount = transcriptCounts.get(record.id.toLowerCase()) ?? 0;
        return {
          ...row,
          entry_id: field(record, "entry_id"),
          notes_document_id: field(record, "notes_document_id"),
          session_id: record.id,
          title: record.fields.get("title") ?? "Untitled session",
          session_type:
            record.fields.get("session_type") ??
            (field(record, "recording_state") === "not-started" ? "notes-only" : "record-audio"),
          session_state: record.fields.get("session_state") ?? "active",
          recording_state: record.fields.get("recording_state") ?? "not-started",
          started_at_us:
            record.fields.get("started_at_us") ?? record.fields.get("created_at_us") ?? "0",
          ended_at_us: record.fields.get("ended_at_us") ?? "0",
          reviewed_at_us: record.fields.get("reviewed_at_us") ?? "0",
          audio_chunk_count: audioChunkCount,
          audio_duration_us: audioDuration,
          has_audio: audioChunkCount !== "0" || audioDuration !== "0" ? "true" : "false",
          transcript_segment_count: String(transcriptSegmentCount),
          has_transcript: transcriptSegmentCount > 0 ? "true" : "false",
        };
      });
      const sessionSummary =
        records.length === 0
          ? "No sessions in this archive."
          : records
              .map(
                (record) =>
                  `${record.id}  ${field(record, "subject")} · ${field(record, "title")}  [${field(record, "processing_state")}]`,
              )
              .join("\n");
      const studentSummary =
        records.length === 0
          ? "No students in this archive."
          : records
              .map(
                (record) =>
                  `${record.id}  ${field(record, "display_name")}  ${field(record, "grade")}`,
              )
              .join("\n");
      emit(
        output,
        rows,
        group === "session"
          ? sessionSummary
          : group === "student"
            ? studentSummary
            : rows.length === 0
              ? `No ${group} records.`
              : `${rows.length} ${group} record${rows.length === 1 ? "" : "s"}.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  throw new CliError(`${group} ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runGuideCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      let records = await snapshot.listRecords(RecordType.guide, args.flags.has("include-deleted"));
      const sessionId = args.options.get("session")?.toLowerCase();
      if (sessionId)
        records = records.filter(
          (record) => field(record, "session_id").toLowerCase() === sessionId,
        );
      const entryId = args.options.get("entry-id")?.toLowerCase();
      if (entryId) {
        const sessions = await snapshot.listRecords(RecordType.session);
        const sessionIds = new Set(
          sessions
            .filter((session) => field(session, "entry_id").toLowerCase() === entryId)
            .map((session) => session.id.toLowerCase()),
        );
        records = records.filter(
          (record) =>
            field(record, "entry_id").toLowerCase() === entryId ||
            sessionIds.has(field(record, "session_id").toLowerCase()),
        );
      }
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length
          ? `${rows.length} study guide${rows.length === 1 ? "" : "s"}.`
          : "No study guides.",
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "create") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    let changes: ArchiveRecord[];
    try {
      const scope = await readGuideScope(snapshot, sessionId);
      const requestedTemplate = args.options.get("template");
      let draft: GuideDraft;
      if (!requestedTemplate) draft = createGuideDraft(scope.session);
      else {
        const builtin = GUIDE_TEMPLATES.find((template) => template.id === requestedTemplate);
        if (builtin) draft = createGuideDraft(scope.session, builtin.id);
        else {
          const settings = await snapshot.listRecords(RecordType.settings);
          const custom = settings.find(
            (entry) =>
              field(entry, "record_role") === "guide-template" &&
              (entry.id.toLowerCase() === requestedTemplate.toLowerCase() ||
                field(entry, "name").toLocaleLowerCase() === requestedTemplate.toLocaleLowerCase()),
          );
          if (!custom) throw new CliError(`Template “${requestedTemplate}” was not found.`);
          draft = createGuideDraftFromSections(
            scope.session,
            custom.id,
            decodeStoredTemplateSections(field(custom, "sections")),
          );
        }
      }
      if (args.options.has("title")) draft.title = args.options.get("title")!;
      record = makeGuideRecord(draft, scope);
      changes = guideRecordsWithEntryLinks(record, null, scope.records);
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = (await mutateArchive(path, changes))[0] ?? record;
    emit(
      output,
      toPlainRecord(saved),
      `Created study guide ${field(saved, "title")} (${saved.id}).`,
      json,
    );
    return 0;
  }

  if (action === "generate") {
    const sessionId = args.options.get("session")?.toLowerCase();
    const entryId = args.options.get("entry-id")?.toLowerCase();
    if (Boolean(sessionId) === Boolean(entryId)) {
      throw new CliError("Provide exactly one of --session or --entry-id.");
    }
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    let changes: ArchiveRecord[];
    try {
      const scope = sessionId
        ? await readGuideScope(snapshot, sessionId)
        : await readGuideEntryScope(snapshot, entryId!);
      const students = scope.records.filter((item) => item.type === RecordType.student);
      const customTemplates = scope.records
        .filter(
          (item) =>
            item.type === RecordType.settings &&
            field(item, "record_role") === "guide-template" &&
            !field(item, "builtin_template_id"),
        )
        .map(guideTemplateFromRecord);
      const templates = [...GUIDE_TEMPLATES, ...customTemplates];
      const draft = scope.session
        ? generateGuideDraftFromSession(
            scope.session,
            args.options.get("template") ?? "auto",
            scope.records,
            students,
            templates,
            args.flags.has("include-entry-evidence"),
          )
        : generateGuideDraftFromEntry(
            scope.entry!,
            args.options.get("template") ?? "auto",
            scope.records,
            students,
            templates,
          );
      if (args.options.has("title")) draft.title = args.options.get("title")!;
      record = makeGuideRecord(draft, scope);
      changes = guideRecordsWithEntryLinks(record, null, scope.records);
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = (await mutateArchive(path, changes))[0] ?? record;
    emit(
      output,
      toPlainRecord(saved),
      `Generated study guide ${field(saved, "title")} (${saved.id}).`,
      json,
    );
    return 0;
  }

  const id = requiredPosition(args, 0, "study guide ID");

  if (action === "validate") {
    const snapshot = await openForCommand(path);
    try {
      const index = parseBoundedOption(args.options.get("revision"), "revision", 0, 0, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.guide, id, index + 1);
      const record = history[index];
      if (!record || field(record, "_deleted") === "true")
        throw new CliError("Study guide revision was not found.");
      let error = "";
      try {
        const draft = guideDraftFromRecord(record);
        const scope = draft.sessionId
          ? await readGuideScope(snapshot, draft.sessionId)
          : await readGuideEntryScope(snapshot, draft.entryId ?? "");
        makeGuideRecord(draft, scope, record);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : "Guide validation failed.";
      }
      const report = { guide_id: id, revision: index, valid: !error, error };
      emit(
        output,
        report,
        error
          ? `Guide validation failed: ${error}`
          : "Guide structure and source references are valid.",
        json,
      );
      return error ? 2 : 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "compare") {
    const snapshot = await openForCommand(path);
    try {
      const history = await snapshot.getRecordHistory(RecordType.guide, id, 2);
      const current = history[0];
      const previous = history[1];
      if (!current || !previous)
        throw new CliError("The guide needs a previous revision to compare.");
      const result = {
        current_title: field(current, "title"),
        previous_title: field(previous, "title"),
        current_revision: "0",
        previous_revision: "1",
        current_markdown: renderGuideMarkdown(current),
        previous_markdown: renderGuideMarkdown(previous),
      };
      emit(
        output,
        result,
        `Revision 0: ${result.current_title}\nRevision 1: ${result.previous_title}\n\n${result.previous_markdown}`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "show" || action === "export") {
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    const images = new Map<string, GuideExportImage>();
    const format = (args.options.get("format") ?? "markdown").toLowerCase();
    if (
      action === "export" &&
      !["markdown", "md", "html", "json", "docx", "pdf"].includes(format)
    ) {
      await closeSnapshot(snapshot);
      throw new CliError("Guide export format must be markdown, html, json, docx, or pdf.");
    }
    try {
      const index = parseBoundedOption(args.options.get("revision"), "revision", 0, 0, 10000);
      if (index === 0) record = await requireLiveRecord(snapshot, RecordType.guide, id);
      else {
        const history = await snapshot.getRecordHistory(RecordType.guide, id, index + 1);
        if (!history[index]) throw new CliError(`Guide history index ${index} was not found.`);
        record = history[index]!;
      }
      if (action === "export" && (format === "html" || format === "docx" || format === "pdf")) {
        for (const assetId of guideImageIds(record)) {
          const metadata = await requireLiveRecord(snapshot, RecordType.assetMetadata, assetId);
          const mimeType = field(metadata, "mime_type");
          if (
            !["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(mimeType)
          ) {
            throw new CliError(`Guide image ${assetId} has an unsupported image format.`);
          }
          images.set(assetId, {
            assetId,
            mimeType,
            bytes: await readAssetBytes(snapshot, metadata),
          });
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    if (action === "show") {
      if (json) emit(output, toPlainRecord(record), "", true);
      else output.stdout(renderGuideMarkdown(record));
      return 0;
    }
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, path))
      throw new CliError("Guide output cannot replace its source archive.");
    if (format === "docx") await writeBytesAtomically(destination, renderGuideDocx(record, images));
    else if (format === "pdf")
      await writeBytesAtomically(destination, await renderGuidePdf(record, images, decodeGuideWebp));
    else {
      const contents =
        format === "html"
          ? renderGuideHtml(record, images)
          : format === "json"
            ? serializeGuideJson(record)
            : renderGuideMarkdown(record);
      await writeTextAtomically(destination, contents);
    }
    emit(
      output,
      { id: record.id, output: destination, format },
      `Exported study guide to ${destination}.`,
      json,
    );
    return 0;
  }

  if (action === "history") {
    const snapshot = await openForCommand(path);
    try {
      const records = await snapshot.getRecordHistory(
        RecordType.guide,
        id,
        parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000),
      );
      const rows = records.map(toPlainRecord);
      emit(output, rows, `${rows.length} guide revision${rows.length === 1 ? "" : "s"}.`, json);
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "trash" || action === "delete" || action === "restore") {
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord | null;
    let entries: ArchiveRecord[];
    try {
      record = await snapshot.getRecord(RecordType.guide, id);
      if (!record || (action !== "restore" && field(record, "_deleted") === "true")) {
        throw new CliError(`Study guide ${id} was not found.`);
      }
      if (action === "restore" && field(record, "_deleted") !== "true") {
        throw new CliError(`Study guide ${id} is not in Trash.`);
      }
      entries = await snapshot.listRecords(RecordType.settings);
    } finally {
      await closeSnapshot(snapshot);
    }
    const changed =
      action === "restore" ? restoreRecordFromTrash(record) : moveGuideToTrash(record);
    await mutateArchive(path, guideRecordsWithEntryLinks(changed, record, entries));
    emit(
      output,
      { id: changed.id, deleted: action !== "restore" },
      action === "restore" ? "Study guide restored." : "Study guide moved to Trash.",
      json,
    );
    return 0;
  }

  const context = await readGuideContext(path, id);
  const { current, draft, scope } = context;
  if (action === "regenerate") {
    const students = scope.records.filter((item) => item.type === RecordType.student);
    const customTemplates = scope.records
      .filter(
        (item) =>
          item.type === RecordType.settings &&
          field(item, "record_role") === "guide-template" &&
          !field(item, "builtin_template_id"),
      )
      .map(guideTemplateFromRecord);
    const entryNoteIds = new Set(
      scope.records
        .filter(
          (item) =>
            item.type === RecordType.settings &&
            field(item, "record_role") === "journal-notes" &&
            field(item, "entry_id").toLowerCase() === field(current, "entry_id").toLowerCase() &&
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
    const templates = [...GUIDE_TEMPLATES, ...customTemplates];
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
      if (!matching) throw new CliError("No current evidence maps to the selected guide section.");
      draft.sections[index] = { ...selected, blocks: matching.blocks };
      replacement = draft;
    }
    replacement.title = args.options.get("title") ?? draft.title;
    const previous = field(current, "approval_state") === "approved" ? null : current;
    const updated = makeGuideRecord(replacement, scope, previous);
    const saved =
      (
        await mutateArchive(path, guideRecordsWithEntryLinks(updated, previous, scope.records))
      )[0] ?? updated;
    emit(output, toPlainRecord(saved), `Regenerated study guide ${saved.id}.`, json);
    return 0;
  }
  if (action === "approve") {
    const checked = makeGuideRecord(draft, scope, current);
    const approved = approveGuideRecord(checked);
    const saved =
      (
        await mutateArchive(path, guideRecordsWithEntryLinks(approved, current, scope.records))
      )[0] ?? approved;
    emit(output, toPlainRecord(saved), `Approved study guide ${saved.id}.`, json);
    return 0;
  }

  if (action === "duplicate") {
    const copy = { ...draft, title: `${draft.title} (copy)` };
    const duplicated = makeGuideRecord(copy, scope);
    const saved =
      (await mutateArchive(path, guideRecordsWithEntryLinks(duplicated, null, scope.records)))[0] ??
      duplicated;
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
          guideIndex(args.options.get("section-index"), "section-index", draft.sections.length)
        ]!;
      const block =
        section.blocks[
          guideIndex(args.options.get("block-index"), "block-index", section.blocks.length)
        ]!;
      updateGuideBlock(block, args);
      changed = true;
    }
    if (!changed)
      throw new CliError("Provide a title, heading, or block change to update a guide.");
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
      ? parseBoundedOption(args.options.get("block-index"), "block-index", 0, 0, blocks.length)
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
        guideIndex(args.options.get("section-index"), "section-index", draft.sections.length)
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

  const updated = makeGuideRecord(draft, scope, current);
  const saved =
    (await mutateArchive(path, guideRecordsWithEntryLinks(updated, current, scope.records)))[0] ??
    updated;
  emit(output, toPlainRecord(saved), `Study guide ${saved.id} updated.`, json);
  return 0;
}

function updateGuideBlock(
  block: GuideDraft["sections"][number]["blocks"][number],
  args: ParsedArguments,
): void {
  if (args.flags.has("clear-sources") && args.options.has("sources"))
    throw new CliError("Choose --sources or --clear-sources, not both.");
  if (args.options.has("text")) {
    block.text = args.options.get("text")!;
    block.stale = false;
    block.origin = "human-edited";
  }
  if (args.options.has("kind")) {
    block.kind = validateGuideKind(args.options.get("kind")!);
    block.stale = false;
    if (block.origin === "ai-generated") block.origin = "human-edited";
  }
  if (args.options.has("sources") || args.flags.has("clear-sources")) {
    block.sourceIds = args.options.get("sources") ?? "";
    block.stale = false;
  }
  if (args.flags.has("mark-reviewed")) block.stale = false;
}

function guideBlock(
  kind: string,
  text: string,
  sourceIds: string,
): GuideDraft["sections"][number]["blocks"][number] {
  return {
    kind: validateGuideKind(kind),
    text,
    sourceIds,
    stale: false,
    origin: "tutor-authored",
  };
}

function moveGuideToTrash(record: ArchiveRecord): ArchiveRecord {
  const removed = moveRecordToTrash(record);
  const fields = new Map(removed.fields);
  fields.set("_trash_group_id", record.id);
  return { ...removed, fields };
}

function validateGuideKind(value: string): GuideBlockKind {
  if ((GUIDE_BLOCK_KINDS as readonly string[]).includes(value)) return value as GuideBlockKind;
  throw new CliError(`Guide block kind “${value}” is not supported.`);
}

function guideIndex(raw: string | undefined, name: string, length: number): number {
  const value = parseBoundedOption(raw, name, -1, 0, Math.max(0, length - 1));
  if (value >= length) throw new CliError(`--${name} is outside the available range.`);
  return value;
}

async function runModelCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[] = [];
  let result: unknown;
  let message: string;
  let exitCode = 0;
  try {
    if (action === "list") {
      const references = (await snapshot.listRecords(RecordType.settings)).filter(
        (record) =>
          field(record, "record_role") === "model-reference" &&
          field(record, "_deleted") !== "true",
      );
      result = references.map(toPlainRecord);
      message =
        references
          .map(
            (record) =>
              `${record.id}  ${field(record, "provider")} / ${field(record, "model_id")}  ${field(record, "path")}${field(record, "active") === "true" ? "  selected" : ""}`,
          )
          .join("\n") || "No model references in this archive.";
    } else if (action === "select") {
      const provider = requiredOption(args, "provider").toLowerCase();
      const model = requiredOption(args, "model");
      const modelPath = args.options.get("path") ?? "";
      const localFile = ["whisper", "whisper.cpp", "local-whisper", "llama.cpp-embedded"].includes(
        provider,
      );
      if (localFile && !modelPath)
        throw new CliError("This provider requires --path to a selected model file.");
      if (localFile) {
        const checked = await inspectCliModel(resolve(dirname(resolve(path)), modelPath));
        if (!checked.available)
          throw new CliError("Selected model must be a regular non-symlink file.");
        if (provider === "llama.cpp-embedded" && checked.format !== "GGUF")
          throw new CliError("Select a GGUF file for the embedded model.");
      }
      const id = await deterministicUuid(`model-reference:${provider}:${model}`);
      const references = await snapshot.listRecords(RecordType.settings);
      changes = references
        .filter(
          (record) =>
            field(record, "record_role") === "model-reference" &&
            field(record, "provider") === provider &&
            field(record, "active") === "true" &&
            field(record, "_deleted") !== "true" &&
            record.id !== id,
        )
        .map((record) => ({
          ...record,
          fields: new Map(record.fields)
            .set("active", "false")
            .set("updated_at_us", timestampNow()),
        }));
      const fields = new Map([
        ["record_role", "model-reference"],
        ["provider", provider],
        ["model_id", model],
        ["path", modelPath],
        ["capabilities", args.options.get("capabilities") ?? "unknown"],
        ["active", "true"],
        ["updated_at_us", timestampNow()],
      ]);
      if (provider === "llama.cpp-embedded") {
        const context = parseBoundedOption(
          args.options.get("context-tokens"),
          "context-tokens",
          4096,
          32,
          1_048_576,
        );
        const threads = parseBoundedOption(args.options.get("threads"), "threads", 0, 0, 64);
        const maxThreads = parseBoundedOption(
          args.options.get("max-threads"),
          "max-threads",
          16,
          1,
          64,
        );
        const layers = parseBoundedOption(
          args.options.get("gpu-layers"),
          "gpu-layers",
          0,
          0,
          1_000_000,
        );
        if (threads > maxThreads) throw new CliError("--threads cannot exceed --max-threads.");
        fields.set("context_tokens", String(context));
        fields.set("cpu_threads", String(threads));
        fields.set("maximum_cpu_threads", String(maxThreads));
        fields.set("gpu_layers", String(layers));
      }
      const record: ArchiveRecord = {
        type: RecordType.settings,
        id,
        revision: 0n,
        previousOffset: 0n,
        fields,
        blob: new Uint8Array(),
      };
      changes.push(record);
      result = toPlainRecord(record);
      message = `Model reference ${id} selected.`;
    } else if (action === "remove-reference") {
      const record = await requireLiveRecord(
        snapshot,
        RecordType.settings,
        requiredPosition(args, 0, "model reference ID"),
      );
      if (field(record, "record_role") !== "model-reference")
        throw new CliError("Model reference not found.");
      changes = [{ ...record, fields: new Map(record.fields).set("_deleted", "true") }];
      result = toPlainRecord(changes[0]!);
      message = "Model reference removed from this archive.";
    } else if (action === "inspect" || action === "verify") {
      const selected = args.options.get("path") ?? requiredPosition(args, 0, "model path");
      const report = await inspectCliModel(resolve(dirname(resolve(path)), selected));
      result = report;
      if (!report.available) {
        if (action === "inspect")
          throw new CliError(
            "Selected model path is missing or is not a regular non-symlink file.",
          );
        exitCode = 2;
      }
      message = report.available
        ? `Model file: ${report.path} (${report.size_bytes} bytes; ${report.metadata}).`
        : "Selected model file is missing or not a regular non-symlink file.";
    } else throw new CliError(`Unknown model action: ${action}.`);
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, args.flags.has("json"));
  return exitCode;
}

async function inspectCliModel(path: string): Promise<{
  path: string;
  available: boolean;
  size_bytes?: number;
  format?: string;
  metadata?: string;
  gguf_version?: number;
  tensor_count?: string;
  metadata_count?: string;
}> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) return { path, available: false };
    const report: {
      path: string;
      available: boolean;
      size_bytes: number;
      format: string;
      metadata: string;
      gguf_version?: number;
      tensor_count?: string;
      metadata_count?: string;
    } = {
      path,
      available: true,
      size_bytes: info.size,
      format: path.toLowerCase().endsWith(".gguf") ? "GGUF" : "unknown",
      metadata: "not-inspected",
    };
    if (report.format === "GGUF") {
      const file = await open(path, "r");
      try {
        const header = Buffer.alloc(24);
        const read = await file.read(header, 0, 24, 0);
        if (read.bytesRead < 24 || header.toString("ascii", 0, 4) !== "GGUF")
          throw new CliError("The GGUF header is invalid.");
        const version = header.readUInt32LE(4);
        if (version !== 2 && version !== 3) throw new CliError("Unsupported GGUF version.");
        report.gguf_version = version;
        report.tensor_count = header.readBigUInt64LE(8).toString();
        report.metadata_count = header.readBigUInt64LE(16).toString();
        report.metadata = "header-inspected";
      } finally {
        await file.close();
      }
    }
    return report;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, available: false };
    throw error;
  }
}

async function runDiagnosticsCommand(
  action: string,
  path: string | undefined,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  if (action === "providers") {
    emit(
      output,
      AI_PROVIDERS,
      AI_PROVIDERS.map((provider) => `${provider.id}  ${provider.name}`).join("\n"),
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "network") {
    if (!args.options.has("provider")) {
      emit(
        output,
        { network_checked: false, reason: "provider-not-selected" },
        "No provider selected; no request sent.",
        args.flags.has("json"),
      );
      return 0;
    }
    if (!path) throw new CliError("Network diagnostics require --archive.");
    return runAiCommand("test", path, args, output);
  }
  if (action === "audio") {
    const audio = await enumerateAudioDiagnostics(signal);
    if (!audio.available) {
      const report = { status: "unavailable-in-cli", reason: audio.reason };
      emit(output, report, report.reason ?? "Audio endpoint enumeration is unavailable.", args.flags.has("json"));
      return 0;
    }
    emit(
      output,
      audio.rows,
      `Audio diagnostics inspected ${audio.rows.length} endpoint(s); no stream was started.\n${JSON.stringify(audio.rows, null, 2)}`,
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "graphics") {
    const report = {
      backend: "Tauri",
      compiled: true,
      status: "native-gui-enabled",
      reason: "No frame was rendered by this CLI process.",
      rendering_measured: false,
      rendering_reason: "run-the-benchmark-in-the-active-desktop-window",
    };
    emit(
      output,
      report,
      "Graphics diagnostics: native-gui-enabled; no frame was rendered by this CLI process.",
      args.flags.has("json"),
    );
    return 0;
  }
  if (!["run", "archive", "report"].includes(action))
    throw new CliError(`Unknown diagnostics action: ${action}.`);
  if (!path) throw new CliError("Archive diagnostics require --archive.");
  const snapshot = await openForCommand(path);
  let report: Record<string, unknown>;
  try {
    report = await buildArchiveDiagnosticReport(snapshot, {
      full: args.flags.has("full"),
      includeSystem: action !== "archive",
      ...(signal === undefined ? {} : { signal }),
    });
  } finally {
    await closeSnapshot(snapshot);
  }
  if (action === "report") {
    const destination = resolve(requiredOption(args, "output"));
    if (await sameFileIdentity(destination, path))
      throw new CliError("Diagnostic output cannot replace its source archive.");
    const contents = `${JSON.stringify(report, null, 2)}\n`;
    await writeTextAtomically(destination, contents);
    emit(
      output,
      { output: destination, status: "exported", bytes: new TextEncoder().encode(contents).byteLength },
      `Diagnostic report exported to ${destination}.`,
      args.flags.has("json"),
    );
    return 0;
  }
  const valid = report["archive_valid"] === true;
  emit(
    output,
    report,
    `Archive diagnostics: ${valid}; generation ${String(report["archive_generation"])}; ${String(report["records_checked"])} record(s) checked.\n${JSON.stringify(report, null, 2)}`,
    args.flags.has("json"),
  );
  return valid ? 0 : 2;
}

async function runBenchmarkCommand(
  action: string,
  path: string | undefined,
  args: ParsedArguments,
  output: CliIo,
  signal?: AbortSignal,
): Promise<number> {
  if (!(CLI_BENCHMARK_ACTIONS as readonly string[]).includes(action))
    throw new CliError(`Unknown benchmark: ${action}.`);
  const start = performance.now();
  const benchmark = action as CliBenchmarkAction;
  const report = createBenchmarkReport(benchmark);
  const needsArchive = benchmark === "indexing" || benchmark === "export" || benchmark === "full";
  if (needsArchive) {
    if (!path) throw new CliError(`benchmark ${action} requires --archive.`);
    const snapshot = await openForCommand(path);
    try {
      if (benchmark === "indexing" || benchmark === "full") {
        await measureArchiveIndex(report, snapshot, signal === undefined ? {} : { signal });
      }
      if (benchmark === "export") {
        const guide = await requireLiveRecord(
          snapshot,
          RecordType.guide,
          requiredOption(args, "guide"),
        );
        measureGuideExport(report, guide);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  if (benchmark === "audio" || benchmark === "full")
    await measureAudioEnumeration(report, signal === undefined ? {} : { signal });
  if (benchmark === "rendering") measureRendering(report);
  report["command_elapsed_us"] = Math.round((performance.now() - start) * 1000);
  emit(output, report, JSON.stringify(report, null, 2), args.flags.has("json"));
  return 0;
}

async function runAiCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[] = [];
  let result: unknown;
  let message: string;
  try {
    if (action === "configure") {
      if (args.options.has("api-key"))
        throw new CliError(
          "Use --api-key-env when generating; credentials are not accepted in configuration.",
        );
      const provider = providerById(requiredOption(args, "provider"));
      if (!provider) throw new CliError("Choose a supported AI provider.");
      const configuration = await createProviderConfigurationRecord({
        providerId: provider.id,
        endpoint: args.options.get("endpoint") ?? provider.defaultEndpoint,
        model: args.options.get("model") ?? "",
      });
      changes = [configuration];
      result = toPlainRecord(configuration);
      message = `Provider ${provider.name} configured.`;
    } else if (action === "context") {
      const budget = parseBoundedOption(
        args.options.get("token-budget"),
        "token-budget",
        8192,
        1,
        10_000_000,
      );
      const itemLimit = parseBoundedOption(
        args.options.get("max-item-tokens"),
        "max-item-tokens",
        budget,
        1,
        budget,
      );
      const packed = await packAiContext(
        snapshot,
        requiredOption(args, "session").toLowerCase(),
        budget,
        itemLimit,
      );
      result = packed;
      message = `Context preview: ${packed.used_tokens} / ${budget} estimated tokens; ${packed.included.length} included fragment(s), ${packed.omitted.length} omitted fragment(s).\n${packed.included.map((row) => JSON.stringify(row)).join("\n")}`;
    } else if (action === "capabilities") {
      const provider = providerById(requiredOption(args, "provider"));
      if (!provider) throw new CliError("Choose a supported AI provider.");
      const model = requiredOption(args, "model");
      result = {
        provider: provider.id,
        model,
        protocol: provider.protocol,
        local: provider.local,
        image_input_supported_by_protocol: [
          "openai",
          "openai-compatible",
          "anthropic",
          "google-gemini",
          "ollama",
        ].includes(provider.id),
        model_capabilities: "unknown",
      };
      message = `${provider.name}: ${provider.protocol}; model-specific capabilities are unknown.`;
    } else if (action === "models" || action === "test") {
      const provider = providerById(requiredOption(args, "provider"));
      if (!provider) throw new CliError("Choose a supported AI provider.");
      const cacheId = await deterministicUuid(`ai-model-cache:${provider.id}`);
      const cached = await snapshot.getRecord(RecordType.settings, cacheId);
      if (
        action === "models" &&
        !args.flags.has("refresh") &&
        !args.flags.has("refresh-if-stale")
      ) {
        if (!cached || field(cached, "_deleted") === "true")
          throw new CliError(`No cached models for ${provider.id}. Retry with --refresh.`);
        const models: unknown = JSON.parse(new TextDecoder().decode(cached.blob));
        result = models;
        message = JSON.stringify(models, null, 2);
      } else {
        const configuration = await snapshot.getRecord(
          RecordType.settings,
          await deterministicUuid(`ai-provider:${provider.id}`),
        );
        const endpoint = configuration
          ? field(configuration, "endpoint")
          : provider.defaultEndpoint;
        const validated = await createProviderConfigurationRecord({
          providerId: provider.id,
          endpoint,
          model: "",
        });
        const envName = args.options.get("api-key-env") ?? provider.credentialKey ?? "";
        if (envName && !/^[A-Za-z_][A-Za-z\d_]*$/u.test(envName))
          throw new CliError("Invalid API key environment variable name.");
        const credentials = snapshot.encrypted
          ? await snapshot.listRecords(RecordType.settings)
          : [];
        const stored = credentials.find(
          (record) =>
            field(record, "record_role") === "credential" &&
            field(record, "_deleted") !== "true" &&
            (field(record, "provider_id") === provider.id ||
              field(record, "key") === provider.credentialKey),
        );
        const credential = process.env[envName] ?? (stored ? field(stored, "value") : "");
        if (!provider.local && !credential)
          throw new CliError("A provider API key is required for model discovery.");
        const models = await discoverCliAiModels(
          provider.id,
          field(validated, "endpoint"),
          credential,
        );
        if (action === "models")
          changes = [
            {
              type: RecordType.settings,
              id: cacheId,
              revision: 0n,
              previousOffset: 0n,
              fields: new Map([
                ["record_role", "ai-model-cache"],
                ["provider_id", provider.id],
                ["updated_at_us", timestampNow()],
              ]),
              blob: new TextEncoder().encode(JSON.stringify(models)),
            },
          ];
        result =
          action === "test"
            ? { provider: provider.id, status: "connected", model_count: models.length }
            : models;
        message =
          action === "test"
            ? `Connected to ${provider.name}; ${models.length} model(s) available.`
            : models.map((model) => model.id).join("\n") || "No models returned.";
      }
    } else if (action === "package") {
      const format = args.options.get("format") ?? "json";
      if (!["json", "markdown", "md", "parts", "zip"].includes(format))
        throw new CliError("Package format must be json, markdown, parts, or zip.");
      const mode = args.options.get("mode") ?? "manual";
      if (mode !== "manual" && mode !== "local")
        throw new CliError("Package mode must be manual or local.");
      if (mode === "local" && format !== "json")
        throw new CliError("Local packages require JSON format.");
      if (format === "zip" && !args.flags.has("confirm-sensitive"))
        throw new CliError(
          "ZIP packages include session materials; use --confirm-sensitive to export them.",
        );
      const summary = await createAiPackageRecord(
        snapshot,
        requiredOption(args, "session").toLowerCase(),
        args.options.get("template") ?? "auto",
        (args.options.get("image-ids") ?? "")
          .split(",")
          .map((id) => id.trim())
          .filter(Boolean),
      );
      const packageJob = {
        ...summary.job,
        fields: new Map(summary.job.fields).set("requested_mode", mode),
      };
      const destination = args.options.get("output");
      if (destination) {
        if (await sameFileIdentity(resolve(destination), path))
          throw new CliError("Package output cannot replace its source archive.");
        await writeBytesAtomically(
          resolve(destination),
          await exportAiPackage(snapshot, summary.job, format),
        );
      }
      // Store the canonical JSON so it remains eligible for reviewed generation.
      changes = [packageJob];
      result = {
        job_id: summary.job.id,
        session_id: summary.sessionId,
        template_id: summary.guideTemplateId,
        content_hash: summary.contentHash,
        package_bytes: summary.byteLength,
        transcript_segments: summary.transcriptCount,
        annotations: summary.annotationCount,
        evidence: summary.evidenceCount,
        assets: summary.assetCount,
        output: destination ? resolve(destination) : "",
      };
      message = `AI package ${summary.job.id} prepared. SHA-256: ${summary.contentHash}.`;
    } else if (action === "jobs") {
      const jobs = await snapshot.listRecordMetadata(RecordType.aiJob);
      result = jobs.map(toPlainRecord);
      message = jobs.length
        ? jobs.map((job) => `${job.id}  ${field(job, "status")}  ${field(job, "mode")}`).join("\n")
        : "No AI jobs stored in this archive.";
    } else if (action === "cancel") {
      const job = await requireLiveRecord(
        snapshot,
        RecordType.aiJob,
        requiredPosition(args, 0, "AI job ID"),
      );
      const fields = new Map(job.fields);
      fields.set("status", "cancelled");
      changes = [{ ...job, fields }];
      result = toPlainRecord(changes[0]!);
      message = `AI job ${job.id} cancelled.`;
    } else if (action === "import") {
      const sessionId = requiredOption(args, "session").toLowerCase();
      const scope = await readGuideScope(snapshot, sessionId);
      const input = requiredOption(args, "input");
      const bytes = await readFile(resolve(input));
      if (!bytes.byteLength || bytes.byteLength > 16 * 1024 * 1024)
        throw new CliError("Response must be between 1 byte and 16 MiB.");
      const responseText = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      let responseTemplate = "general";
      try {
        const parsed: unknown = JSON.parse(responseText);
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          "template_id" in parsed &&
          typeof parsed.template_id === "string"
        )
          responseTemplate = parsed.template_id;
      } catch {
        /* Unstructured responses are preserved for review. */
      }
      const proposal = createAiGuideProposal(
        responseText,
        sessionId,
        args.options.get("template") ?? responseTemplate,
      );
      if (args.options.has("title")) proposal.draft.title = args.options.get("title")!;
      let guide: ArchiveRecord;
      let sourceValidation = "passed";
      try {
        guide = makeGuideRecord(proposal.draft, scope);
      } catch {
        sourceValidation = "failed";
        proposal.warnings.push(
          "Some source links need correction; the original response was kept as editable text.",
        );
        guide = makeGuideRecord(
          {
            title: "AI response — review required",
            sessionId,
            templateId: proposal.draft.templateId,
            sections: [
              {
                id: randomUUID(),
                heading: "Generated response — review required",
                blocks: [
                  {
                    kind: "paragraph",
                    text: responseText,
                    sourceIds: "",
                    stale: false,
                    origin: "ai-generated",
                  },
                ],
              },
            ],
          },
          scope,
        );
      }
      if (
        sourceValidation === "passed" &&
        !proposal.draft.sections.some((section) =>
          section.blocks.some((block) => block.sourceIds.trim()),
        )
      )
        sourceValidation = "missing-evidence";
      const status =
        proposal.schemaValid && sourceValidation === "passed"
          ? "response-imported"
          : "response-needs-correction";
      const job: ArchiveRecord = {
        type: RecordType.aiJob,
        id: randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        fields: new Map([
          ["session_id", sessionId],
          ["mode", "manual"],
          ["status", status],
          ["schema_valid", String(proposal.schemaValid)],
          ["source_validation", sourceValidation],
          ["import_warnings", proposal.warnings.join("\n")],
          ["guide_id", guide.id],
          ["original_filename", basename(input)],
          ["content_hash", createHash("sha256").update(bytes).digest("hex")],
          ["created_at_us", timestampNow()],
        ]),
        blob: new Uint8Array(bytes),
      };
      changes = guideRecordsWithEntryLinks(guide, null, scope.records).concat(job);
      result = {
        job_id: job.id,
        guide_id: guide.id,
        status,
        schema_valid: proposal.schemaValid,
        source_validation: sourceValidation,
        warnings: proposal.warnings,
      };
      message = `Imported response as unapproved guide ${guide.id} (${status}).`;
    } else if (action === "generate") {
      const job = await requireLiveRecord(snapshot, RecordType.aiJob, requiredOption(args, "job"));
      const provider = providerById(requiredOption(args, "provider"));
      if (!provider) throw new CliError("Choose a supported AI provider.");
      if (field(job, "requested_mode") === "local" && !provider.local)
        throw new CliError("A local package can only be sent to a local provider.");
      const config = await requireLiveRecord(
        snapshot,
        RecordType.settings,
        await deterministicUuid(`ai-provider:${provider.id}`),
      );
      const model = args.options.get("model");
      const configuration =
        model === undefined
          ? config
          : { ...config, fields: new Map(config.fields).set("selected_model", model) };
      const tokenValue = args.options.get("max-tokens");
      const tokens = tokenValue === undefined ? undefined : Number(tokenValue);
      const envName = args.options.get("api-key-env");
      if (envName && !/^[A-Za-z_][A-Za-z\d_]*$/u.test(envName))
        throw new CliError("Invalid API key environment variable name.");
      const credentialRecords = snapshot.encrypted
        ? await snapshot.listRecords(RecordType.settings)
        : [];
      const storedCredential = credentialRecords.find(
        (record) =>
          field(record, "record_role") === "credential" &&
          field(record, "_deleted") !== "true" &&
          (field(record, "provider_id") === provider.id ||
            field(record, "key") === provider.credentialKey),
      );
      const credential = envName
        ? (process.env[envName] ?? "")
        : storedCredential
          ? field(storedCredential, "value")
          : "";
      const preview = await createAiRequestPreview(
        job,
        configuration,
        tokens,
        [],
        Boolean(credential),
        snapshot,
      );
      const requestOutput = args.options.get("request-output");
      if (requestOutput) {
        if (await sameFileIdentity(resolve(requestOutput), path))
          throw new CliError("Request output cannot replace its source archive.");
        await writeTextAtomically(resolve(requestOutput), preview.requestBody);
      }
      result = {
        provider: preview.providerId,
        endpoint: preview.endpoint,
        model: preview.model,
        package_hash: preview.packageHash,
        request_body_hash: preview.requestBodyHash,
        request_bytes: preview.requestBytes,
        local_only: preview.localOnly,
        credential_available: preview.credentialAvailable,
      };
      if (!args.flags.has("confirm-outbound") && !preview.localOnly) {
        message = `Review request to ${preview.endpoint}. Request SHA-256: ${preview.requestBodyHash}. Retry with --confirm-outbound --confirm-hash ${preview.requestBodyHash}.`;
      } else {
        if (
          !preview.localOnly &&
          (!credential || args.options.get("confirm-hash") !== preview.requestBodyHash)
        )
          throw new CliError("Provide a provider API key and confirm the exact request hash.");
        const scope = await readGuideScope(snapshot, field(job, "session_id"));
        const execution = await executeAiGeneration({
          packageJob: job,
          expectedTemplateId: preview.guideTemplateId ?? "general",
          preview,
          confirmedEndpoint: preview.endpoint,
          confirmedBodyHash: preview.requestBodyHash,
          credential,
          session: scope.session,
          sourceRecords: scope.records,
          send: sendCliAiRequest,
          onProgress: () => {},
        });
        changes = execution.guide
          ? [execution.job, ...guideRecordsWithEntryLinks(execution.guide, null, scope.records)]
          : [execution.job];
        result = execution.summary;
        message = `AI job ${execution.job.id}: ${execution.summary.status}.`;
      }
    } else throw new CliError(`Unknown AI action: ${action}.`);
  } finally {
    await closeSnapshot(snapshot);
  }
  if (changes.length) await mutateArchive(path, changes, generation);
  emit(output, result, message, json);
  return 0;
}

const CLI_AI_MODEL_MAX_PAGES = 50;
const CLI_AI_MODEL_MAX_COUNT = 50_000;
const CLI_AI_MODEL_MAX_PAGE_BYTES = 8 * 1024 * 1024;
const CLI_AI_MODEL_MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const CLI_AI_MODEL_MAX_ID_BYTES = 1024;
const CLI_AI_MODEL_MAX_CURSOR_BYTES = 8 * 1024;

interface CliAiModelPage {
  models: { id: string }[];
  nextCursor: string | undefined;
}

function buildCliAiModelPageUrl(
  providerId: string,
  endpoint: string,
  cursor: string | undefined,
): string {
  const parameters = new URLSearchParams();
  let path: string;
  if (providerId === "ollama") {
    path = "/api/tags";
  } else if (providerId === "anthropic") {
    path = "/v1/models";
    parameters.set("limit", "1000");
    if (cursor) parameters.set("after_id", cursor);
  } else if (providerId === "cohere") {
    path = "/v1/models";
    parameters.set("page_size", "1000");
    parameters.set("endpoint", "chat");
    if (cursor) parameters.set("page_token", cursor);
  } else if (providerId === "google-gemini") {
    path = "/models";
    parameters.set("pageSize", "1000");
    if (cursor) parameters.set("pageToken", cursor);
  } else {
    path = "/models";
    if (cursor) parameters.set("after", cursor);
  }
  const query = parameters.toString();
  return `${endpoint}${path}${query ? `?${query}` : ""}`;
}

function parseCliAiModelPage(providerId: string, data: unknown): CliAiModelPage {
  if (!data || typeof data !== "object")
    throw new CliError("Provider returned an invalid model catalog.");
  const root = data as Record<string, unknown>;
  const entries = root["data"] ?? root["models"];
  if (!Array.isArray(entries)) throw new CliError("Provider returned an invalid model list.");
  const models = entries.flatMap((item: unknown) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const id = row["id"] ?? row["name"] ?? row["model"];
    if (typeof id !== "string" || !id) return [];
    if (new TextEncoder().encode(id).byteLength > CLI_AI_MODEL_MAX_ID_BYTES)
      throw new CliError("Provider model catalog contains an invalid model ID.");
    return [{ id }];
  });

  let nextCursor: string | undefined;
  if (providerId === "anthropic") {
    if (root["has_more"] !== undefined && typeof root["has_more"] !== "boolean")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (root["has_more"] === true) {
      const cursor = root["last_id"];
      if (typeof cursor !== "string" || !cursor)
        throw new CliError("Provider model pagination cursor is invalid.");
      nextCursor = cursor;
    }
  } else if (providerId === "cohere") {
    const cursor = root["next_page_token"];
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (typeof cursor === "string" && cursor) nextCursor = cursor;
  } else if (providerId === "google-gemini") {
    const cursor = root["nextPageToken"];
    if (cursor !== undefined && cursor !== null && typeof cursor !== "string")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (typeof cursor === "string" && cursor) nextCursor = cursor;
  } else if (providerId !== "ollama") {
    if (root["has_more"] !== undefined && typeof root["has_more"] !== "boolean")
      throw new CliError("Provider model catalog has invalid pagination metadata.");
    if (root["has_more"] === true) {
      const rootCursor = root["last_id"];
      const cursor =
        typeof rootCursor === "string" && rootCursor
          ? rootCursor
          : (models.at(-1)?.id ?? "");
      if (!cursor) throw new CliError("Provider model pagination cursor is invalid.");
      nextCursor = cursor;
    }
  }
  if (
    nextCursor &&
    new TextEncoder().encode(nextCursor).byteLength > CLI_AI_MODEL_MAX_CURSOR_BYTES
  )
    throw new CliError("Provider model pagination cursor is invalid.");

  return { models, nextCursor };
}

async function readCliAiModelPage(response: Response): Promise<{ data: unknown; bytes: number }> {
  const reader = response.body?.getReader();
  if (!reader) throw new CliError("Provider returned an empty model catalog.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > CLI_AI_MODEL_MAX_PAGE_BYTES) {
      await reader.cancel();
      throw new CliError("Provider model catalog page exceeds 8 MiB.");
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    data: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown,
    bytes: size,
  };
}

async function discoverCliAiModels(
  providerId: string,
  endpoint: string,
  credential: string,
): Promise<{ id: string }[]> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (credential) {
    const header =
      providerId === "anthropic"
        ? "x-api-key"
        : providerId === "google-gemini"
          ? "x-goog-api-key"
          : "authorization";
    headers[header] = header === "authorization" ? `Bearer ${credential}` : credential;
  }
  if (providerId === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const signal = AbortSignal.timeout(30_000);
  const models: { id: string }[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let totalBytes = 0;
  for (let pageNumber = 0; pageNumber < CLI_AI_MODEL_MAX_PAGES; pageNumber += 1) {
    const response = await fetch(buildCliAiModelPageUrl(providerId, endpoint, cursor), {
      headers,
      redirect: "error",
      signal,
    });
    if (!response.ok)
      throw new CliError(`Provider model discovery returned HTTP ${response.status}.`);
    const pageResponse = await readCliAiModelPage(response);
    totalBytes += pageResponse.bytes;
    if (totalBytes > CLI_AI_MODEL_MAX_CATALOG_BYTES)
      throw new CliError("Provider model catalog exceeds 8 MiB across all pages.");
    const page = parseCliAiModelPage(providerId, pageResponse.data);
    for (const model of page.models) {
      if (seenIds.has(model.id)) continue;
      seenIds.add(model.id);
      models.push(model);
      if (models.length > CLI_AI_MODEL_MAX_COUNT)
        throw new CliError("Provider model catalog exceeds 50,000 models.");
    }
    if (!page.nextCursor) return models;
    if (seenCursors.has(page.nextCursor))
      throw new CliError("Provider model pagination cursor is invalid.");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new CliError("Provider model catalog exceeded 50 pages.");
}

async function sendCliAiRequest(
  request: AiTransportRequest,
  onChunk: (chunk: Uint8Array) => void,
): Promise<AiTransportResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: request.accept,
  };
  if (request.credential) {
    const header =
      request.providerId === "anthropic"
        ? "x-api-key"
        : request.providerId === "google-gemini"
          ? "x-goog-api-key"
          : "authorization";
    headers[header] =
      header === "authorization" ? `Bearer ${request.credential}` : request.credential;
  }
  if (request.providerId === "anthropic") headers["anthropic-version"] = "2023-06-01";
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers,
    body: request.requestBody,
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  const reader = response.body?.getReader();
  let total = 0;
  let complete = true;
  if (reader) {
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        onChunk(chunk.value);
        if (total > 16 * 1024 * 1024) {
          complete = false;
          await reader.cancel();
          break;
        }
      }
    } catch {
      complete = false;
    }
  }
  return {
    status: response.status,
    contentType: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
    responseBytes: total,
    complete,
  };
}

async function readGuideScope(
  snapshot: ArchiveSnapshot,
  sessionId: string,
): Promise<GuideSourceScope & { session: ArchiveRecord }> {
  const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
  return { session, records: await readGuideSourceRecords(snapshot) };
}

async function readGuideEntryScope(
  snapshot: ArchiveSnapshot,
  entryId: string,
): Promise<GuideSourceScope & { entry: ArchiveRecord }> {
  const entry = await requireLiveRecord(snapshot, RecordType.settings, entryId);
  if (field(entry, "record_role") !== "journal-entry")
    throw new CliError(`Journal entry ${entryId} was not found.`);
  return { entry, records: await readGuideSourceRecords(snapshot) };
}

async function readGuideSourceRecords(snapshot: ArchiveSnapshot): Promise<ArchiveRecord[]> {
  const [students, sessions, settings, transcripts, annotations, assets, evidence] =
    await Promise.all([
      snapshot.listRecords(RecordType.student),
      snapshot.listRecords(RecordType.session),
      snapshot.listRecords(RecordType.settings),
      snapshot.listRecords(RecordType.transcriptSegment),
      snapshot.listRecords(RecordType.annotation),
      snapshot.listRecords(RecordType.assetMetadata),
      snapshot.listRecords(RecordType.evidenceNode),
    ]);
  return [
    ...students,
    ...sessions,
    ...settings,
    ...transcripts,
    ...annotations,
    ...assets,
    ...evidence,
  ];
}

async function readGuideContext(
  path: string,
  id: string,
): Promise<{ current: ArchiveRecord; draft: GuideDraft; scope: GuideSourceScope }> {
  const snapshot = await openForCommand(path);
  try {
    const current = await requireLiveRecord(snapshot, RecordType.guide, id);
    const draft = guideDraftFromRecord(current);
    const scope = draft.sessionId
      ? await readGuideScope(snapshot, draft.sessionId)
      : draft.entryId
        ? await readGuideEntryScope(snapshot, draft.entryId)
        : null;
    if (!scope) throw new CliError("This guide has no journal entry or session scope.");
    return { current, draft, scope };
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runSettingsCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  const snapshot = await openForCommand(path);
  let changes: ArchiveRecord[];
  let summary: string;
  let credentialWrite = false;
  const generation = snapshot.commit.generation;
  try {
    const records = await snapshot.listRecords(RecordType.settings);
    const settings = records.filter((record) => field(record, "record_role") === "setting");
    const credentials = records.filter((record) => field(record, "record_role") === "credential");

    if (action === "list") {
      const visible = settings.filter((record) => !hasSensitiveCredentialMaterial(record));
      emit(
        output,
        visible.map(toPlainRecord),
        visible.length
          ? visible
              .map((record) => `${field(record, "key")} = ${field(record, "value")}`)
              .join("\n")
          : "No archive-specific settings.",
        json,
      );
      return 0;
    }
    if (action === "credential-list") {
      const metadata = credentials.map((record) => ({
        key: field(record, "key"),
        provider_id: field(record, "provider_id"),
        updated_at_us: field(record, "updated_at_us"),
      }));
      emit(
        output,
        metadata,
        metadata.length
          ? metadata.map((record) => record.key).join("\n")
          : "No encrypted credentials are stored in this archive.",
        json,
      );
      return 0;
    }
    if (action === "get") {
      const key = validateArchiveSettingKey(args.positionals[0] ?? requiredOption(args, "key"));
      if (sensitiveSettingKey(key)) throw new CliError("Credential values cannot be read here.");
      const id = await deterministicUuid(`setting:${key}`);
      const record = settings.find((item) => item.id === id);
      if (!record) throw new CliError("Setting was not found in this archive.");
      if (hasSensitiveCredentialMaterial(record))
        throw new CliError("This setting contains sensitive material and cannot be displayed.");
      emit(output, toPlainRecord(record), `${key} = ${field(record, "value")}`, json);
      return 0;
    }
    if (action === "set") {
      const key = validateArchiveSettingKey(requiredOption(args, "key"));
      const sensitive = sensitiveSettingKey(key);
      const environmentName = args.options.get("value-env");
      const hasValue = args.options.has("value");
      if (sensitive) {
        if (!args.flags.has("store-credential"))
          throw new CliError(
            "Sensitive settings require --store-credential and an encrypted archive.",
          );
        if (!snapshot.encrypted)
          throw new CliError("Encrypt the archive before storing credentials.");
        if (hasValue || !environmentName)
          throw new CliError(
            "Use --value-env NAME for credentials; command-line values are not accepted.",
          );
      } else if (args.flags.has("store-credential")) {
        throw new CliError("--store-credential is only for sensitive keys.");
      }
      if (hasValue && environmentName)
        throw new CliError("Provide only one of --value and --value-env.");
      const value = environmentName
        ? settingEnvironmentValue(environmentName)
        : hasValue
          ? args.options.get("value")!
          : undefined;
      if (value === undefined) throw new CliError("Provide --value or --value-env.");
      changes = [await makeCliSettingRecord(key, value, sensitive)];
      credentialWrite = sensitive;
      summary = sensitive ? "Encrypted credential saved." : "Setting saved in the archive.";
    } else if (action === "reset") {
      const key = args.options.get("key");
      const selected =
        key === undefined ? settings : settings.filter((record) => field(record, "key") === key);
      if (key !== undefined && !selected.length) throw new CliError("Setting was not found.");
      changes = selected.map(moveRecordToTrash);
      summary = `Reset ${changes.length} setting${changes.length === 1 ? "" : "s"}.`;
    } else if (action === "credential-remove") {
      const key = validateArchiveSettingKey(requiredOption(args, "key"));
      const id = await deterministicUuid(`credential:${key}`);
      const credential = credentials.find((record) => record.id === id);
      if (!credential) throw new CliError("Encrypted credential was not found.");
      const removed = moveRecordToTrash(credential);
      const fields = new Map(removed.fields);
      fields.delete("value");
      changes = [{ ...removed, fields }];
      credentialWrite = true;
      summary = "Encrypted credential removed.";
    } else if (action === "import") {
      const inputPath = resolve(
        args.options.get("input") ?? requiredPosition(args, 0, "settings input file"),
      );
      const inputInfo = await stat(inputPath);
      if (inputInfo.size > 1024 * 1024) throw new CliError("Settings input exceeds 1 MiB.");
      const contents = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(inputPath));
      const imported = new Map<string, ArchiveRecord>();
      for (const [index, line] of contents.split(/\r?\n/u).entries()) {
        if (!line || line.startsWith("#")) continue;
        const separator = line.indexOf("=");
        if (separator <= 0) throw new CliError(`Expected key=value on line ${index + 1}.`);
        const key = validateArchiveSettingKey(line.slice(0, separator));
        if (sensitiveSettingKey(key))
          throw new CliError("Sensitive values cannot be imported from plaintext settings files.");
        const record = await makeCliSettingRecord(key, line.slice(separator + 1), false);
        if (imported.has(record.id)) throw new CliError(`The settings file repeats key “${key}”.`);
        imported.set(record.id, record);
      }
      changes = [...imported.values()];
      summary = `Imported ${changes.length} archive setting${changes.length === 1 ? "" : "s"}.`;
    } else if (action === "copy-to-archive") {
      const sourcePath = resolve(requiredOption(args, "source-archive"));
      const sourcePassphraseName = args.options.get("source-passphrase-env");
      const sourcePassphrase = sourcePassphraseName
        ? settingEnvironmentValue(sourcePassphraseName)
        : archiveAccessContext.getStore()?.passphrase;
      const source = await archiveAccessContext.run({ passphrase: sourcePassphrase }, () =>
        openForCommand(sourcePath),
      );
      try {
        const key = args.options.get("key");
        const sourceRecords = await source.listRecords(RecordType.settings);
        const selected = sourceRecords.filter(
          (record) =>
            field(record, "record_role") === "setting" &&
            (key === undefined || field(record, "key") === key),
        );
        if (selected.some(hasSensitiveCredentialMaterial))
          throw new CliError("Sensitive settings cannot be copied as ordinary archive settings.");
        changes = selected.map((record) => ({ ...record, revision: 0n, previousOffset: 0n }));
      } finally {
        await closeSnapshot(source);
      }
      summary = `Copied ${changes.length} archive setting${changes.length === 1 ? "" : "s"}.`;
    } else {
      throw new CliError(`settings ${action} is not implemented in the TypeScript CLI yet.`);
    }
  } finally {
    await closeSnapshot(snapshot);
  }

  const saved = changes.length ? await mutateArchive(path, changes, generation) : [];
  const result = credentialWrite
    ? { changed: saved.length, credential: true }
    : action === "set" && saved[0]
      ? toPlainRecord(saved[0])
      : { changed: saved.length };
  emit(output, result, summary, json);
  return 0;
}

function validateArchiveSettingKey(key: string): string {
  if (
    !key.trim() ||
    [...key].some((character) => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })
  )
    throw new CliError("Setting keys must be nonempty and contain no control characters.");
  if (new TextEncoder().encode(key).byteLength > 512)
    throw new CliError("Setting keys must be 512 UTF-8 bytes or fewer.");
  return key;
}

function settingEnvironmentValue(name: string): string {
  if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(name))
    throw new CliError("The environment variable name is invalid.");
  const value = process.env[name];
  if (value === undefined) throw new CliError("The requested environment variable is not set.");
  return value;
}

async function makeCliSettingRecord(
  key: string,
  value: string,
  credential: boolean,
): Promise<ArchiveRecord> {
  const maximum = credential ? 4096 : 1024 * 1024;
  if (value.includes("\0") || new TextEncoder().encode(value).byteLength > maximum)
    throw new CliError(`Setting value must be at most ${maximum} UTF-8 bytes and contain no NUL.`);
  if (credential && !value) throw new CliError("Credential values cannot be empty.");
  const fields = new Map([
    ["record_role", credential ? "credential" : "setting"],
    ["key", key],
    ["value", value],
    ["updated_at_us", (BigInt(Date.now()) * 1000n).toString()],
  ]);
  const provider = AI_PROVIDERS.find((item) => item.credentialKey === key);
  if (credential && provider) fields.set("provider_id", provider.id);
  return {
    type: RecordType.settings,
    id: await deterministicUuid(`${credential ? "credential" : "setting"}:${key}`),
    revision: 0n,
    previousOffset: 0n,
    fields,
    blob: new Uint8Array(),
  };
}

async function runTemplateCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const stored = await snapshot.listRecords(RecordType.settings);
      const rows: Record<string, unknown>[] = GUIDE_TEMPLATES.map((template) => ({
        id: template.id,
        name: template.name,
        origin: "built-in",
        subject: template.subject,
        description: template.description,
        sections: [...template.sections],
        body: template.body,
      }));
      for (const record of stored) {
        if (
          field(record, "record_role") !== "guide-template" ||
          field(record, "builtin_template_id")
        )
          continue;
        rows.push({
          ...toPlainRecord(record),
          origin: "custom",
          sections: decodeStoredTemplateSections(field(record, "sections")),
        });
      }
      emit(
        output,
        rows,
        `${rows.length} study-guide template${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "show" || action === "export") {
    const idOrName = requiredPosition(args, 0, "template ID or name");
    const snapshot = await openForCommand(path);
    let template: Record<string, unknown>;
    try {
      const builtin = GUIDE_TEMPLATES.find((item) => item.id === idOrName);
      if (builtin) {
        template = {
          id: builtin.id,
          name: builtin.name,
          origin: "built-in",
          subject: builtin.subject,
          description: builtin.description,
          sections: [...builtin.sections],
          body: builtin.body,
        };
      } else {
        const stored = await snapshot.listRecords(RecordType.settings);
        const record = stored.find(
          (item) =>
            field(item, "record_role") === "guide-template" &&
            (item.id.toLowerCase() === idOrName.toLowerCase() ||
              field(item, "name").toLocaleLowerCase() === idOrName.toLocaleLowerCase()),
        );
        if (!record) throw new CliError(`Template “${idOrName}” was not found.`);
        template = customTemplateValue(record);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    if (action === "show") {
      if (json) emit(output, template, "", true);
      else {
        output.stdout(
          `${String(template["name"])}\n${String(template["description"] ?? "")}\n\n${(template["sections"] as string[]).join("\n")}`,
        );
      }
      return 0;
    }
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, path))
      throw new CliError("Template output cannot replace its source archive.");
    const exported = {
      format: "tutorux-guide-template-v1",
      name: template["name"],
      subject: template["subject"],
      description: template["description"],
      sections: template["sections"],
      body: template["body"],
    };
    await writeTextAtomically(destination, `${JSON.stringify(exported, null, 2)}\n`);
    emit(
      output,
      { id: template["id"], output: destination },
      `Exported template to ${destination}.`,
      json,
    );
    return 0;
  }

  if (action === "create" || action === "import") {
    const imported =
      action === "import" ? await readTemplateImport(requiredOption(args, "input")) : null;
    const name = args.options.get("name")?.trim() || imported?.name || "";
    if (!name) throw new CliError("--name is required.");
    const sections = args.options.has("sections")
      ? parseTemplateSectionArgument(args.options.get("sections")!)
      : (imported?.sections ?? []);
    if (!sections.length)
      throw new CliError("Provide at least one template section with --sections.");
    const record = makeCustomGuideTemplateRecord({
      name,
      subject: args.options.get("subject") ?? imported?.subject ?? "general",
      description: args.options.get("description") ?? imported?.description ?? "",
      sections,
      body: args.options.get("body") ?? imported?.body ?? "",
    });
    const saved = (await mutateArchive(path, [record]))[0] ?? record;
    emit(
      output,
      toPlainRecord(saved),
      `Created template ${field(saved, "name")} (${saved.id}).`,
      json,
    );
    return 0;
  }

  if (action === "update" || action === "delete" || action === "restore") {
    const id = requiredPosition(args, 0, "template ID");
    const snapshot = await openForCommand(path);
    let current: ArchiveRecord;
    try {
      const candidate = await snapshot.getRecord(RecordType.settings, id);
      if (!candidate || field(candidate, "record_role") !== "guide-template") {
        throw new CliError(`Template ${id} was not found.`);
      }
      if (action === "delete" && field(candidate, "_deleted") === "true")
        throw new CliError(`Template ${id} is already in Trash.`);
      if (action === "restore" && field(candidate, "_deleted") !== "true")
        throw new CliError(`Template ${id} is not in Trash.`);
      if (action === "update" && field(candidate, "_deleted") === "true")
        throw new CliError(`Template ${id} is in Trash. Restore it before updating.`);
      current = candidate;
    } finally {
      await closeSnapshot(snapshot);
    }
    let updated: ArchiveRecord;
    if (action === "delete") updated = moveRecordToTrash(current);
    else if (action === "restore") updated = restoreRecordFromTrash(current);
    else {
      const fields = new Map(current.fields);
      if (args.options.has("name"))
        fields.set("name", validateUpdatedField("title", requiredOption(args, "name")));
      if (args.options.has("subject"))
        fields.set(
          "subject",
          validateEvidenceText(args.options.get("subject")!, "Template subject", 128),
        );
      if (args.options.has("description"))
        fields.set(
          "description",
          validateEvidenceText(args.options.get("description")!, "Template description", 4_096),
        );
      if (args.options.has("sections")) {
        const sections = validateTemplateSections(
          parseTemplateSectionArgument(args.options.get("sections")!),
        );
        if (!sections.length) throw new CliError("A template must contain at least one section.");
        fields.set("sections", sections.join("\n"));
      }
      if (args.options.has("body"))
        fields.set(
          "body",
          validateEvidenceText(args.options.get("body")!, "Template body", 100_000),
        );
      if (
        !["name", "subject", "description", "sections", "body"].some((key) => args.options.has(key))
      ) {
        throw new CliError("Provide a template field to update.");
      }
      fields.set("updated_at_us", timestampNow());
      updated = { ...current, fields };
    }
    const saved = (await mutateArchive(path, [updated]))[0] ?? updated;
    const message =
      action === "delete"
        ? "Template moved to Trash."
        : action === "restore"
          ? "Template restored."
          : "Template updated.";
    emit(output, toPlainRecord(saved), message, json);
    return 0;
  }

  throw new CliError(`template ${action} is not implemented in the TypeScript CLI yet.`);
}

function parseTemplateSectionArgument(value: string): string[] {
  return value
    .split(/[\r\n,;]/u)
    .map((heading) => heading.trim())
    .filter(Boolean);
}

function decodeStoredTemplateSections(value: string): string[] {
  const sections = /[\r\n]/u.test(value) ? value.split(/\r\n|\r|\n/u) : [value];
  return sections.map((heading) => heading.trim()).filter(Boolean);
}

function validateTemplateSections(sections: readonly string[]): string[] {
  if (sections.length > 250) throw new CliError("A template can contain at most 250 sections.");
  return sections.map((heading, index) => {
    const value = validateEvidenceText(heading, `Template section ${index + 1}`, 256).trim();
    if (!value) throw new CliError("Every template section needs a heading.");
    return value;
  });
}

function customTemplateValue(record: ArchiveRecord): Record<string, unknown> {
  return {
    id: record.id,
    name: field(record, "name"),
    origin: field(record, "builtin_template_id") ? "built-in override" : "custom",
    subject: field(record, "subject"),
    description: field(record, "description"),
    sections: decodeStoredTemplateSections(field(record, "sections")),
    body: field(record, "body"),
  };
}

async function sameFileIdentity(firstPath: string, secondPath: string): Promise<boolean> {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  if (
    first === second ||
    (process.platform === "win32" && first.toLowerCase() === second.toLowerCase())
  ) {
    return true;
  }
  try {
    const [firstStat, secondStat] = await Promise.all([stat(first), stat(second)]);
    if (
      firstStat.dev === secondStat.dev &&
      firstStat.ino !== 0 &&
      firstStat.ino === secondStat.ino
    ) {
      return true;
    }
  } catch {
    // A missing output path is expected; canonical path comparison still handles aliases.
  }
  try {
    const [firstRealPath, secondRealPath] = await Promise.all([realpath(first), realpath(second)]);
    return process.platform === "win32"
      ? firstRealPath.toLowerCase() === secondRealPath.toLowerCase()
      : firstRealPath === secondRealPath;
  } catch {
    return false;
  }
}

async function readTemplateImport(inputPath: string): Promise<GuideTemplateInput> {
  const absolutePath = resolve(inputPath);
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink())
    throw new CliError("Template input must be a regular, non-symlink file.");
  if (info.size > 1024 * 1024) throw new CliError("Template input exceeds the 1 MiB limit.");
  return parseGuideTemplateImport(await readFile(absolutePath, "utf8"));
}

async function runAssetCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "import" || action === "add" || action === "import-folder") {
    const singleImport = action === "import" || action === "add";
    let inputPaths: string[];
    if (singleImport) {
      const inputValue =
        action === "add" ? args.positionals[0] : (args.options.get("input") ?? args.positionals[0]);
      if (!inputValue) {
        throw new CliError(action === "add" ? "Source file is required." : "--input is required.");
      }
      inputPaths = [resolve(inputValue)];
    } else {
      const inputDirectory = resolve(requiredPosition(args, 0, "source directory"));
      const directoryInfo = await stat(inputDirectory);
      if (!directoryInfo.isDirectory()) {
        throw new CliError("Import source must be a directory.");
      }
      const entries = await readdir(inputDirectory, { withFileTypes: true });
      inputPaths = [];
      for (const entry of entries) {
        const entryPath = join(inputDirectory, entry.name);
        const fileInfo = await lstat(entryPath);
        if (fileInfo.isFile() && !fileInfo.isSymbolicLink()) inputPaths.push(entryPath);
        if (inputPaths.length > 10_000) {
          throw new CliError("Folder import is limited to 10,000 regular files.");
        }
      }
      inputPaths.sort((left, right) => {
        const leftName = basename(left);
        const rightName = basename(right);
        return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      });
    }
    const sessionId = args.options.get("session") ?? "";
    const captureSource = args.options.get("capture-source");
    if (captureSource !== undefined && captureSource !== "browser-microphone") {
      throw new CliError("Captured assets support the browser-microphone source label.");
    }
    if (captureSource && !args.flags.has("consent")) {
      throw new CliError(
        "Confirm microphone recording consent with --consent before importing a browser capture.",
      );
    }
    if (captureSource && !sessionId) {
      throw new CliError("A browser microphone capture must be associated with a session.");
    }
    let captureConsentAtUs: string | undefined;
    if (args.options.has("capture-consent-at-us")) {
      const rawConsentTime = args.options.get("capture-consent-at-us") ?? "";
      if (!captureSource || !/^\d+$/u.test(rawConsentTime)) {
        throw new CliError("Capture consent time requires a valid browser microphone source.");
      }
      const parsedConsentTime = BigInt(rawConsentTime);
      if (parsedConsentTime <= 0n || parsedConsentTime > 18_446_744_073_709_551_615n) {
        throw new CliError("Capture consent time requires a valid browser microphone source.");
      }
      captureConsentAtUs = parsedConsentTime.toString();
    }
    const importedAssets: Array<{
      readonly metadata: ArchiveRecord;
      readonly deduplicated: boolean;
      readonly chunkCount: number;
    }> = [];
    let snapshot: ArchiveSnapshot | undefined;
    let staged: ArchiveSnapshot | undefined;
    let pendingBytes = 0;
    let pendingFiles = 0;
    const flushBatch = async (): Promise<void> => {
      const base = snapshot;
      const current = staged;
      if (!base || !current || current === base) return;
      await writeSourceAtomically(resolve(path), current);
      base.lock();
      current.lock();
      await current.source.close?.();
      snapshot = undefined;
      staged = undefined;
      snapshot = await openForCommand(path);
      staged = snapshot;
      pendingBytes = 0;
      pendingFiles = 0;
    };

    try {
      snapshot = await openForCommand(path);
      staged = snapshot;
      if (sessionId) await requireLiveRecord(snapshot, RecordType.session, sessionId);
      for (const inputPath of inputPaths) {
        const current = staged;
        if (!current) throw new Error("The archive snapshot could not be opened.");
        const imported = await appendCliAssetFile(
          current,
          path,
          inputPath,
          sessionId,
          captureSource
            ? (record) => {
                const metadataFields = new Map(record.fields);
                const mimeType = field(record, "mime_type");
                const browserWebmAudio =
                  mimeType === "video/webm" && inputPath.toLowerCase().endsWith(".webm");
                if (!mimeType.startsWith("audio/") && !browserWebmAudio) {
                  throw new CliError(
                    "A browser microphone capture must contain a recognized audio file.",
                  );
                }
                if (browserWebmAudio) metadataFields.set("mime_type", "audio/webm");
                metadataFields.set("capture_source", captureSource);
                metadataFields.set("capture_consent_at_us", captureConsentAtUs ?? timestampNow());
                metadataFields.set("capture_consent_policy", "1");
                return { ...record, fields: metadataFields };
              }
            : undefined,
        );
        const next = imported.snapshot;
        staged = next;
        current.lock();
        const saved = await next.getRecord(RecordType.assetMetadata, imported.metadata.id);
        importedAssets.push({
          metadata: saved ?? imported.metadata,
          deduplicated: imported.deduplicated,
          chunkCount: imported.chunkCount,
        });
        if (!imported.deduplicated)
          pendingBytes += Number(field(imported.metadata, "byte_size"));
        pendingFiles += 1;
        if (pendingBytes >= ASSET_IMPORT_BATCH_BYTES || pendingFiles >= ASSET_IMPORT_BATCH_FILES)
          await flushBatch();
      }
      await flushBatch();
    } finally {
      const base = snapshot;
      const current = staged;
      if (base && current && base !== current) {
        base.lock();
        current.lock();
        await current.source.close?.();
      } else if (base) {
        await closeSnapshot(base);
      }
    }
    if (singleImport) {
      const imported = importedAssets[0]!;
      emit(
        output,
        {
          material: toPlainRecord(imported.metadata),
          deduplicated: imported.deduplicated,
          chunk_count: String(imported.chunkCount),
        },
        `${field(imported.metadata, "filename") || "Material"} imported${imported.deduplicated ? " (content deduplicated)" : ""}.`,
        json,
      );
    } else {
      emit(
        output,
        importedAssets.map(({ metadata }) => toPlainRecord(metadata)),
        `Imported ${importedAssets.length} asset${importedAssets.length === 1 ? "" : "s"} into the archive.`,
        json,
      );
    }
    return 0;
  }

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const records = await snapshot.listRecords(
        RecordType.assetMetadata,
        args.flags.has("include-deleted"),
      );
      const sessionId = args.options.get("session")?.toLowerCase();
      const internalRoles = new Set([
        "audio-track",
        "recording-take",
        "waveform-pyramid",
        "sparse-timestamp-seek-index",
        "asset-blob-manifest",
        "asset-blob-chunk",
      ]);
      const rows = records
        .filter((record) => !internalRoles.has(field(record, "record_role")))
        .filter((record) => sessionId === undefined || field(record, "session_id") === sessionId)
        .map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length === 0
          ? "No materials."
          : `${rows.length} material${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "show" || action === "preview") {
    const id = requiredPosition(args, 0, "material ID");
    const record = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
    emit(output, toPlainRecord(record), `Material ${id}.`, json);
    return 0;
  }

  if (action === "restore" && args.flags.has("revision"))
    throw new CliError("--revision requires a history index.");
  if (
    action === "update" ||
    action === "history" ||
    (action === "restore" && args.options.has("revision"))
  ) {
    const id = requiredPosition(args, 0, "material ID").toLowerCase();
    const snapshot = await openForCommand(path);
    const generation = snapshot.commit.generation;
    let changed: ArchiveRecord | undefined;
    let historyRows: ArchiveRecord[] = [];
    let restoredIndex: number | undefined;
    try {
      const current = await requireLiveRecord(snapshot, RecordType.assetMetadata, id);
      if (
        [
          "audio-track",
          "recording-take",
          "waveform-pyramid",
          "sparse-timestamp-seek-index",
          "asset-blob-manifest",
          "asset-blob-chunk",
        ].includes(field(current, "record_role"))
      )
        throw new CliError("Choose a material, rather than an internal recording or asset record.");
      if (action === "history") {
        historyRows = await snapshot.getRecordHistory(
          RecordType.assetMetadata,
          id,
          parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000),
        );
      } else if (action === "update") {
        if (!args.options.has("filename") && !args.options.has("description"))
          throw new CliError("Provide --filename or --description to update material details.");
        changed = editMaterialMetadata(
          current,
          args.options.get("filename") ?? field(current, "filename"),
          args.options.get("description") ?? field(current, "description"),
        );
      } else {
        restoredIndex = parseBoundedOption(args.options.get("revision"), "revision", 0, 0, 10_000);
        const revision = (
          await snapshot.getRecordHistory(RecordType.assetMetadata, id, restoredIndex + 1)
        )[restoredIndex];
        if (!revision || field(revision, "_deleted") === "true")
          throw new CliError("That material revision is unavailable or deleted.");
        changed = editMaterialMetadata(
          current,
          field(revision, "filename"),
          field(revision, "description"),
        );
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    if (action === "history") {
      const rows = historyRows.map((record, index) => ({
        history_index: index,
        ...toPlainRecord(record),
      }));
      emit(
        output,
        rows,
        historyRows
          .map(
            (record, index) =>
              `${index}  revision ${record.revision}  ${field(record, "filename")}`,
          )
          .join("\n") || "No material history.",
        json,
      );
      return 0;
    }
    const saved = (await mutateArchive(path, [changed!], generation))[0] ?? changed!;
    emit(
      output,
      toPlainRecord(saved),
      restoredIndex === undefined
        ? "Material details updated."
        : `Material details restored from history index ${restoredIndex}.`,
      json,
    );
    return 0;
  }

  if (action === "remove") {
    const id = requiredPosition(args, 0, "material ID");
    const current = await getLiveRecordAtPath(path, RecordType.assetMetadata, id);
    const fields = new Map(current.fields);
    fields.set("_deleted", "true");
    const [saved] = await mutateArchive(path, [
      { ...current, revision: 0n, previousOffset: 0n, fields },
    ]);
    emit(
      output,
      toPlainRecord(saved ?? { ...current, fields }),
      "Material reference removed; immutable blob remains until archive compaction.",
      json,
    );
    return 0;
  }

  if (action === "restore") {
    const id = requiredPosition(args, 0, "material ID");
    const current = await getRecordAtPath(path, RecordType.assetMetadata, id);
    if (field(current, "_deleted") !== "true") {
      throw new CliError("Material is not in Trash.");
    }
    const fields = new Map(current.fields);
    fields.delete("_deleted");
    fields.set("restored_at_us", timestampNow());
    const [saved] = await mutateArchive(path, [
      { ...current, revision: 0n, previousOffset: 0n, fields },
    ]);
    emit(
      output,
      toPlainRecord(saved ?? { ...current, fields }),
      "Material restored from Trash.",
      json,
    );
    return 0;
  }

  if (action === "verify") {
    const id = requiredPosition(args, 0, "material ID");
    const snapshot = await openForCommand(path);
    try {
      const asset = await snapshot.getRecord(RecordType.assetMetadata, id);
      if (!asset || field(asset, "_deleted") === "true") {
        throw new CliError(`Material ${id} was not found in this archive.`);
      }
      let valid = true;
      try {
        const chunks = iterateVerifiedAssetChunks(snapshot, asset);
        while (!(await chunks.next()).done) {
          // Consume every verified chunk so the final digest check runs.
        }
      } catch (error) {
        if (
          !(error instanceof ArchiveFormatError) ||
          error.code !== "asset_content_integrity_failed"
        ) {
          throw error;
        }
        valid = false;
      }
      emit(
        output,
        { asset_id: asset.id, valid, sha256: field(asset, "content_hash") },
        valid ? "Asset content hash is valid." : "Asset content hash mismatch.",
        json,
      );
      return valid ? 0 : 2;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "export" || action === "extract") {
    const id = requiredPosition(args, 0, "material ID");
    const outputPath = args.options.get("output");
    if (!outputPath) throw new CliError("--output is required.");
    const archivePath = resolve(path);
    const destination = resolve(outputPath);
    if (await sameFileIdentity(destination, archivePath))
      throw new CliError("Material output cannot replace its source archive.");
    const snapshot = await openForCommand(path);
    try {
      const record = await snapshot.getRecord(RecordType.assetMetadata, id);
      if (!record || record.fields.get("_deleted") === "true") {
        throw new CliError(`Material ${id} was not found in this archive.`);
      }
      const byteCount = await exportCliAssetAtomically(snapshot, record, destination);
      emit(
        output,
        { id: record.id, output: destination, bytes: byteCount },
        `Exported ${field(record, "filename") || id} to ${destination}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  if (action === "link" || action === "unlink") {
    const assetId = requiredPosition(args, 0, "material ID");
    const targetName = requiredOption(args, "to").toLowerCase();
    const targetId = requiredOption(args, "target-id");
    const targetType =
      targetName === "annotation"
        ? RecordType.annotation
        : targetName === "transcript"
          ? RecordType.transcriptSegment
          : null;
    if (targetType === null) {
      throw new CliError("Assets can currently link to annotations or transcript segments.");
    }

    const asset = await getLiveRecordAtPath(path, RecordType.assetMetadata, assetId);
    const target = await getLiveRecordAtPath(path, targetType, targetId);
    const assetSession = field(asset, "session_id");
    const targetSession = field(target, "session_id");
    if (assetSession && assetSession !== targetSession) {
      throw new CliError("An asset cannot link to a record from a different session.");
    }

    const canonicalAssetId = asset.id.toLowerCase();
    const linkedAssetIds = field(target, "linked_asset_ids")
      .split(",")
      .filter((id) => id.length > 0);
    const existingIndex = linkedAssetIds.indexOf(canonicalAssetId);
    if (action === "link" && existingIndex === -1) linkedAssetIds.push(canonicalAssetId);
    if (action === "unlink" && existingIndex !== -1) linkedAssetIds.splice(existingIndex, 1);

    const fields = new Map(target.fields);
    fields.set("linked_asset_ids", linkedAssetIds.join(","));
    if (targetType === RecordType.transcriptSegment) {
      fields.set("human_edited_at_us", timestampNow());
    }
    const [saved] = await mutateArchive(path, [
      { ...target, revision: 0n, previousOffset: 0n, fields },
    ]);
    const result = saved ?? { ...target, fields };
    emit(
      output,
      toPlainRecord(result),
      action === "link" ? "Asset linked to target." : "Asset unlinked from target.",
      json,
    );
    return 0;
  }
  throw new CliError(`asset ${action} is not implemented in the TypeScript CLI yet.`);
}

function editMaterialMetadata(
  record: ArchiveRecord,
  filename: string,
  description: string,
): ArchiveRecord {
  const name = filename.trim();
  const invalidControls = (value: string, multiline: boolean) =>
    [...value].some((character) => {
      const code = character.codePointAt(0)!;
      return code === 127 || (code < 32 && !(multiline && (code === 9 || code === 10)));
    });
  const encoder = new TextEncoder();
  if (!name || encoder.encode(name).length > 1024 || invalidControls(name, false))
    throw new CliError("Use a file name of up to 1024 bytes without control characters.");
  if (encoder.encode(description).length > 16_384 || invalidControls(description, true))
    throw new CliError("The description is too long or contains unsupported characters.");
  const fields = new Map(record.fields)
    .set("filename", name)
    .set("description", description)
    .set("updated_at_us", timestampNow());
  return { ...record, fields };
}

async function runEvidenceCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  if (action === "extract") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = await extractSessionEvidence(snapshot, session);
    } finally {
      await closeSnapshot(snapshot);
    }
    if (records.length === 0) {
      emit(output, [], "No new evidence was found for this session.", json);
      return 0;
    }
    const saved = await mutateArchive(path, records);
    const rows = saved.map(toPlainRecord);
    emit(
      output,
      rows,
      `Added ${rows.length} evidence item(s). Transcript candidates need human review.`,
      json,
    );
    return 0;
  }

  if (action === "create") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const segmentId = requiredOption(args, "source-segment").toLowerCase();
    const type = validateEvidenceText(requiredOption(args, "type"), "Evidence type", 128);
    const title = validateEvidenceText(requiredOption(args, "title"), "Evidence title", 512);
    const content = validateEvidenceText(
      requiredOption(args, "content"),
      "Evidence content",
      16 * 1024 * 1024,
    );
    if (type.length === 0 || title.length === 0 || content.length === 0) {
      throw new CliError("Evidence needs a type, title, and content.");
    }
    const snapshot = await openForCommand(path);
    let record: ArchiveRecord;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const segment = await requireLiveRecord(snapshot, RecordType.transcriptSegment, segmentId);
      if (field(segment, "session_id") !== sessionId) {
        throw new CliError("Choose a transcript segment from the selected session.");
      }
      const priority = args.options.get("priority") ?? "normal";
      if (!"low normal high critical".split(" ").includes(priority)) {
        throw new CliError("Priority must be low, normal, high, or critical.");
      }
      const createdAt = timestampNow();
      record = {
        type: RecordType.evidenceNode,
        id: randomUUID(),
        revision: 0n,
        previousOffset: 0n,
        blob: new Uint8Array(),
        fields: new Map([
          ["session_id", sessionId],
          ["student_id", field(session, "student_id")],
          ["type", type.trim().toLowerCase()],
          ["title", title],
          ["content", content],
          ["priority", priority],
          ["origin", "tutor-authored"],
          ["source_annotation_id", ""],
          ["source_segment_ids", segment.id],
          ["source_segment_revision", segment.revision.toString()],
          ["source_segment_revisions", `${segment.id}=${segment.revision}`],
          ["source_asset_ids", ""],
          ["source_speaker_label", field(segment, "speaker_label")],
          ["start_time_us", field(segment, "start_time_us") || "0"],
          ["end_time_us", field(segment, "end_time_us") || "0"],
          ["verification_state", "needs-review"],
          ["created_at_us", createdAt],
        ]),
      };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [record]);
    emit(output, toPlainRecord(saved ?? record), "Evidence added to review.", json);
    return 0;
  }

  if (action === "list" || action === "review") {
    const sessionId = args.options.get("session")?.toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      let records = await snapshot.listRecords(
        RecordType.evidenceNode,
        args.flags.has("include-deleted"),
      );
      if (sessionId)
        records = records.filter((record) => field(record, "session_id") === sessionId);
      if (action === "review") {
        records = records.filter(
          (record) => field(record, "verification_state") !== "human-verified",
        );
      }
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length === 0
          ? action === "review"
            ? "No evidence needs review."
            : "No evidence found."
          : `${rows.length} evidence item${rows.length === 1 ? "" : "s"}.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "graph") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const nodes = (await snapshot.listRecords(RecordType.evidenceNode)).filter(
        (node) => field(node, "session_id").toLowerCase() === sessionId,
      );
      const nodeIds = new Set(nodes.map((node) => node.id.toLowerCase()));
      for (const node of nodes) {
        if (!field(node, "content")) {
          throw new CliError(`Evidence ${node.id} needs a statement.`);
        }
      }
      const edges = await snapshot.listRecords(RecordType.evidenceEdge);
      const contradictions = new Map<
        string,
        { first_evidence_id: string; second_evidence_id: string }
      >();
      let edgeCount = 0;
      for (const edge of edges) {
        const from = field(edge, "from_id").toLowerCase();
        const to = field(edge, "to_id").toLowerCase();
        const fromHere = nodeIds.has(from);
        const toHere = nodeIds.has(to);
        if (!fromHere && !toHere) continue;
        if (!fromHere || !toHere) {
          throw new CliError(
            "An evidence relationship connects a session node to a missing or cross-session node.",
          );
        }
        const relationship = field(edge, "relationship");
        if (from === to || !(EVIDENCE_RELATIONSHIPS as readonly string[]).includes(relationship)) {
          throw new CliError(`Evidence relationship ${edge.id} has invalid endpoints or type.`);
        }
        edgeCount += 1;
        if (relationship === "contradicts") {
          const [first, second] = [from, to].sort();
          contradictions.set(`${first}:${second}`, {
            first_evidence_id: first!,
            second_evidence_id: second!,
          });
        }
      }
      const pairs = [...contradictions.values()].sort(
        (a, b) =>
          a.first_evidence_id.localeCompare(b.first_evidence_id) ||
          a.second_evidence_id.localeCompare(b.second_evidence_id),
      );
      const report = {
        session_id: sessionId,
        node_count: nodes.length,
        edge_count: edgeCount,
        contradiction_count: pairs.length,
        contradictions: pairs,
        valid: true,
      };
      const details = pairs
        .map((pair) => `  ${pair.first_evidence_id} contradicts ${pair.second_evidence_id}`)
        .join("\n");
      emit(
        output,
        report,
        `Evidence graph: ${nodes.length} node(s), ${edgeCount} relationship(s), ${pairs.length} explicit contradiction(s).${details ? `\n${details}` : ""}`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "edges") {
    const sessionId = requiredOption(args, "session").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const nodes = await snapshot.listRecords(RecordType.evidenceNode);
      const nodeById = new Map(
        nodes
          .filter((node) => field(node, "session_id") === sessionId)
          .map((node) => [node.id, node]),
      );
      const edges = (await snapshot.listRecords(RecordType.evidenceEdge)).filter(
        (edge) => nodeById.has(field(edge, "from_id")) && nodeById.has(field(edge, "to_id")),
      );
      const rows = edges.map((edge) => {
        const from = nodeById.get(field(edge, "from_id"))!;
        const to = nodeById.get(field(edge, "to_id"))!;
        return {
          ...toPlainRecord(edge),
          from_title: field(from, "title") || field(from, "type") || "Evidence",
          to_title: field(to, "title") || field(to, "type") || "Evidence",
        };
      });
      emit(output, rows, `${rows.length} evidence relationship(s).`, json);
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "link") {
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      edge = await makeEvidenceEdge(
        snapshot,
        requiredOption(args, "from"),
        requiredOption(args, "to"),
        requiredOption(args, "relationship"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship created.", json);
    return 0;
  }

  if (
    action === "show" ||
    action === "update" ||
    action === "approve" ||
    action === "reject" ||
    action === "verify" ||
    action === "delete" ||
    action === "restore"
  ) {
    const id = requiredPosition(args, 0, "Evidence ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let current: ArchiveRecord;
    let changes: ArchiveRecord[] = [];
    try {
      const record = await snapshot.getRecord(RecordType.evidenceNode, id);
      if (!record || (field(record, "_deleted") === "true" && action !== "restore")) {
        throw new CliError(`Evidence ${id} was not found in this archive.`);
      }
      current = record;
      if (action === "show") {
        emit(output, toPlainRecord(current), `Evidence ${id}.`, json);
        return 0;
      }
      if (action === "verify") {
        const valid = await evidenceSourcesAreCurrent(snapshot, current);
        emit(
          output,
          { evidence_id: id, source_valid: valid },
          valid
            ? "Evidence sources are current."
            : "Evidence sources are missing, stale, or cross-session.",
          json,
        );
        return valid ? 0 : 2;
      }
      if (action === "approve" || action === "reject") {
        changes = [
          await reviewEvidenceRecord(
            snapshot,
            current,
            action === "approve" ? "human-verified" : "rejected",
          ),
        ];
      } else if (action === "update") {
        const fields = new Map(current.fields);
        const updates = ["title", "content", "type", "priority"] as const;
        let changed = false;
        for (const key of updates) {
          const value = args.options.get(key);
          if (value === undefined) continue;
          const maximumBytes = key === "content" ? 16 * 1024 * 1024 : key === "title" ? 512 : 128;
          const clean = validateEvidenceText(value, `Evidence ${key}`, maximumBytes);
          if (clean.length === 0) throw new CliError(`Evidence ${key} cannot be empty.`);
          fields.set(key, key === "type" ? clean.trim().toLowerCase() : clean);
          changed = true;
        }
        if (!changed) throw new CliError("Provide a title, content, type, or priority to update.");
        const priority = args.options.get("priority");
        if (priority && !"low normal high critical".split(" ").includes(priority)) {
          throw new CliError("Priority must be low, normal, high, or critical.");
        }
        fields.set("verification_state", "needs-review");
        fields.set("reviewed_at_us", "");
        fields.set("updated_at_us", timestampNow());
        changes = [{ ...current, fields }];
      } else if (action === "delete") {
        const deletedAt = timestampNow();
        const fields = new Map(current.fields);
        fields.set("_deleted", "true");
        fields.set("_trash_group_id", id);
        fields.set("deleted_at_us", deletedAt);
        changes.push({ ...current, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge);
        for (const edge of edges) {
          if (field(edge, "from_id") !== id && field(edge, "to_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.set("_deleted", "true");
          edgeFields.set("_trash_group_id", id);
          edgeFields.set("deleted_at_us", deletedAt);
          changes.push({ ...edge, fields: edgeFields });
        }
      } else {
        if (field(current, "_deleted") !== "true") throw new CliError("Evidence is not in Trash.");
        const fields = new Map(current.fields);
        fields.delete("_deleted");
        fields.delete("_trash_group_id");
        fields.set("restored_at_us", timestampNow());
        changes.push({ ...current, fields });
        const edges = await snapshot.listRecords(RecordType.evidenceEdge, true);
        for (const edge of edges) {
          if (field(edge, "_deleted") !== "true" || field(edge, "_trash_group_id") !== id) continue;
          const edgeFields = new Map(edge.fields);
          edgeFields.delete("_deleted");
          edgeFields.delete("_trash_group_id");
          edgeFields.set("restored_at_us", timestampNow());
          changes.push({ ...edge, fields: edgeFields });
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes);
    const result = saved.find((record) => record.type === RecordType.evidenceNode) ?? changes[0]!;
    emit(output, toPlainRecord(result), `Evidence ${action} complete.`, json);
    return 0;
  }

  if (action === "unlink") {
    const id = requiredPosition(args, 0, "Evidence relationship ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let edge: ArchiveRecord;
    try {
      const current = await snapshot.getRecord(RecordType.evidenceEdge, id);
      if (!current || field(current, "_deleted") === "true") {
        throw new CliError(`Evidence relationship ${id} was not found.`);
      }
      const fields = new Map(current.fields);
      fields.set("_deleted", "true");
      fields.set("_trash_group_id", id);
      fields.set("deleted_at_us", timestampNow());
      edge = { ...current, fields };
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [edge]);
    emit(output, toPlainRecord(saved ?? edge), "Evidence relationship moved to Trash.", json);
    return 0;
  }

  throw new CliError(`evidence ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runJournalDocument(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const action = args.positionals[0] ?? "";
  const id = args.positionals[1]?.toLowerCase();
  if (
    !id ||
    !["show", "update", "add-block", "remove-block", "restore-block", "move-block"].includes(action)
  )
    throw new CliError("Choose a journal document action and provide a document ID.");
  const snapshot = await openForCommand(path);
  const generation = snapshot.commit.generation;
  let changes: ArchiveRecord[];
  let result: unknown;
  try {
    let document = await requireLiveRecord(snapshot, RecordType.settings, id);
    if (field(document, "record_role") !== "journal-notes")
      throw new CliError("Journal notes document was not found.");
    const revision = args.options.get("revision");
    if (revision !== undefined) {
      if (action !== "show")
        throw new CliError("--revision is only supported when showing a document.");
      const index = parseBoundedOption(revision, "revision", -1, 1, 10_000) - 1;
      const history = await snapshot.getRecordHistory(RecordType.settings, id, index + 1);
      if (!history[index]) throw new CliError("Document revision was not found.");
      document = history[index]!;
    }
    const state = notesEditState(document);
    if (!state.editable) throw new CliError("This document uses unsupported structured notes.");
    const blocks = state.blocks.map((block) => ({ ...block }));
    if (action === "show") {
      const shown = {
        document_id: document.id,
        entry_id: field(document, "entry_id"),
        session_id: field(document, "session_id"),
        revision: document.revision.toString(),
        text: blocks.map((block) => block.text).join("\n"),
        blocks,
      };
      emit(output, shown, blocks.map((block) => block.text).join("\n"), args.flags.has("json"));
      return 0;
    }
    type Removed = { block: JournalNoteBlock; index: number };
    const removed: Removed[] = [];
    const count = parseBoundedOption(
      field(document, "removed_block_count") || undefined,
      "removed block count",
      0,
      0,
      256,
    );
    for (let index = 0; index < count; index++) {
      const prefix = `removed_block_${index}_`;
      const blockId = field(document, `${prefix}id`);
      const kind = field(document, `${prefix}kind`);
      const position = field(document, `${prefix}index`);
      if (
        !blockId ||
        !(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind) ||
        !/^\d+$/u.test(position)
      )
        throw new CliError("Removed block recovery data is invalid.");
      removed.push({
        block: {
          id: blockId,
          kind: kind as JournalNoteBlockKind,
          text: field(document, `${prefix}text`),
        },
        index: Number(position),
      });
    }
    if (!removed.length && field(document, "last_removed_block_id")) {
      const kind = field(document, "last_removed_block_kind");
      const index = field(document, "last_removed_block_index");
      if (!(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind) || !/^\d+$/u.test(index))
        throw new CliError("Legacy block recovery data is invalid.");
      removed.push({
        block: {
          id: field(document, "last_removed_block_id"),
          kind: kind as JournalNoteBlockKind,
          text: field(document, "last_removed_block_text"),
        },
        index: Number(index),
      });
    }
    const readKind = (): JournalNoteBlockKind => {
      const kind = requiredOption(args, "kind");
      if (!(JOURNAL_NOTE_BLOCK_KINDS as readonly string[]).includes(kind))
        throw new CliError("Unsupported note block kind.");
      return kind as JournalNoteBlockKind;
    };
    if (action === "add-block") {
      const index = parseBoundedOption(
        args.options.get("block-index"),
        "block-index",
        blocks.length,
        0,
        blocks.length,
      );
      blocks.splice(index, 0, {
        id: randomUUID(),
        kind: readKind(),
        text: requiredOption(args, "text"),
      });
    } else if (action === "remove-block") {
      const index = blocks.findIndex((block) => block.id === requiredOption(args, "block-id"));
      if (index < 0) throw new CliError("Note block was not found.");
      if (removed.length >= 256)
        throw new CliError("Restore a removed block before deleting more.");
      removed.push({ block: blocks.splice(index, 1)[0]!, index });
    } else if (action === "restore-block") {
      const blockId = requiredOption(args, "block-id");
      const last = removed.at(-1);
      if (!last || last.block.id !== blockId)
        throw new CliError("Restore removed note blocks in reverse order.");
      if (blocks.some((block) => block.id === blockId))
        throw new CliError("The block is already present.");
      removed.pop();
      blocks.splice(Math.min(last.index, blocks.length), 0, last.block);
    } else if (action === "move-block") {
      if (!blocks.length) throw new CliError("There are no note blocks to move.");
      const from = parseBoundedOption(args.options.get("from"), "from", -1, 0, blocks.length - 1);
      const to = parseBoundedOption(args.options.get("to"), "to", -1, 0, blocks.length - 1);
      if (from < 0 || to < 0) throw new CliError("--from and --to are required.");
      blocks.splice(to, 0, blocks.splice(from, 1)[0]!);
    } else {
      const block = blocks.find((item) => item.id === requiredOption(args, "block-id"));
      if (!block) throw new CliError("Note block was not found.");
      block.text = requiredOption(args, "text");
      if (args.options.has("kind")) block.kind = readKind();
    }
    const sessionId = field(document, "session_id");
    const ownerId = sessionId || field(document, "entry_id");
    const owner = await requireLiveRecord(
      snapshot,
      sessionId ? RecordType.session : RecordType.settings,
      ownerId,
    );
    changes = updateOwnerNotes(owner, document, blocks);
    const updated = changes.find((record) => record.id === document.id);
    if (!updated) throw new CliError("Unable to update the notes document.");
    const fields = new Map(updated.fields);
    for (const key of fields.keys())
      if (key.startsWith("removed_block_") || key.startsWith("last_removed_block_"))
        fields.delete(key);
    fields.set("removed_block_count", String(removed.length));
    removed.forEach((item, index) => {
      const prefix = `removed_block_${index}_`;
      fields.set(`${prefix}id`, item.block.id);
      fields.set(`${prefix}kind`, item.block.kind);
      fields.set(`${prefix}text`, item.block.text);
      fields.set(`${prefix}index`, String(item.index));
    });
    const last = removed.at(-1);
    if (last) {
      fields.set("last_removed_block_id", last.block.id);
      fields.set("last_removed_block_kind", last.block.kind);
      fields.set("last_removed_block_text", last.block.text);
      fields.set("last_removed_block_index", String(last.index));
    }
    const replacement = { ...updated, fields };
    changes = changes.map((record) => (record.id === updated.id ? replacement : record));
    result = toPlainRecord(replacement);
  } finally {
    await closeSnapshot(snapshot);
  }
  await mutateArchive(path, changes, generation);
  emit(output, result, "Journal notes document updated.", args.flags.has("json"));
  return 0;
}

async function runJournalSearch(
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const query = requiredOption(args, "query");
  if (!query.trim()) throw new CliError("Provide non-empty --query text.");
  const foldedQuery = query.toLocaleLowerCase();
  const filterId = (name: string): string | undefined => {
    const value = args.options.get(name);
    if (!value) return undefined;
    const id = canonicalizeProgressUuid(value);
    if (!id) throw new CliError(`--${name} must be a valid UUID.`);
    return id;
  };
  const collectionId = filterId("collection-id");
  const tagId = filterId("tag-id");
  const from = args.options.get("from");
  const to = args.options.get("to");
  for (const [name, date] of [
    ["from", from],
    ["to", to],
  ] as const) {
    if (
      date &&
      (!/^\d{4}-\d{2}-\d{2}$/u.test(date) ||
        !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
        new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)
    ) {
      throw new CliError(`--${name} must be a valid YYYY-MM-DD date.`);
    }
  }
  if (from && to && from > to) throw new CliError("--from must not be later than --to.");
  const hasSessions = args.options.get("has-sessions");
  if (hasSessions !== undefined && hasSessions !== "true" && hasSessions !== "false")
    throw new CliError("--has-sessions must be true or false.");
  const snapshot = await openForCommand(path);
  try {
    const [settings, sessions, transcripts, guides] = await Promise.all([
      snapshot.listRecords(RecordType.settings),
      snapshot.listRecords(RecordType.session),
      snapshot.listRecords(RecordType.transcriptSegment),
      snapshot.listRecords(RecordType.guide),
    ]);
    const entries = settings.filter((record) => field(record, "record_role") === "journal-entry");
    const notes = settings.filter((record) => field(record, "record_role") === "journal-notes");
    const rows: { record: ArchiveRecord; source: string; excerpt: string; sessionIds: string[] }[] =
      [];
    for (const entry of entries) {
      const id = entry.id.toLowerCase();
      const linkedSessions = sessions.filter(
        (session) => field(session, "entry_id").toLowerCase() === id,
      );
      const sessionIds = linkedSessions.map((session) => session.id.toLowerCase());
      const idSet = new Set(sessionIds);
      const ids = (key: string) =>
        field(entry, key)
          .split(",")
          .map((value) => value.trim().toLowerCase());
      if (
        (collectionId && !ids("collection_ids").includes(collectionId)) ||
        (tagId && !ids("tag_ids").includes(tagId))
      )
        continue;
      const date = field(entry, "entry_date");
      if (
        (from && date < from) ||
        (to && date > to) ||
        (hasSessions === "true" && !sessionIds.length) ||
        (hasSessions === "false" && sessionIds.length)
      )
        continue;
      const candidates: { source: string; text: string }[] = [
        { source: "title", text: field(entry, "title") },
      ];
      for (const note of notes) {
        if (
          field(note, "entry_id").toLowerCase() !== id &&
          !idSet.has(field(note, "session_id").toLowerCase())
        )
          continue;
        for (const [key, text] of note.fields)
          if (/^block\.\d+\.text$/u.test(key)) candidates.push({ source: "notes", text });
      }
      for (const cue of transcripts)
        if (idSet.has(field(cue, "session_id").toLowerCase()))
          candidates.push({ source: "transcript", text: field(cue, "text") });
      for (const guide of guides) {
        if (
          field(guide, "entry_id").toLowerCase() !== id &&
          !idSet.has(field(guide, "session_id").toLowerCase())
        )
          continue;
        const draft = guideDraftFromRecord(guide);
        candidates.push({ source: "guide", text: draft.title });
        for (const section of draft.sections) {
          candidates.push({ source: "guide", text: section.heading });
          for (const block of section.blocks)
            candidates.push({ source: "guide", text: block.text });
        }
      }
      const match = candidates.find((candidate) =>
        candidate.text.toLocaleLowerCase().includes(foldedQuery),
      );
      if (!match) continue;
      const offset = match.text.toLocaleLowerCase().indexOf(foldedQuery);
      const characters = Array.from(match.text);
      const start = Array.from(match.text.slice(0, offset)).length;
      rows.push({
        record: entry,
        source: match.source,
        excerpt: characters.slice(Math.max(0, start - 48), Math.max(0, start - 48) + 180).join(""),
        sessionIds,
      });
    }
    rows.sort((a, b) => {
      const left = parseIntegerField(field(a.record, "created_at_us"));
      const right = parseIntegerField(field(b.record, "created_at_us"));
      return left === right ? a.record.id.localeCompare(b.record.id) : left > right ? -1 : 1;
    });
    const result = rows.map((row) => ({
      ...toPlainRecord(row.record),
      session_ids: row.sessionIds.join(","),
      session_count: String(row.sessionIds.length),
      match_source: row.source,
      excerpt: row.excerpt,
    }));
    emit(
      output,
      result,
      rows.length
        ? rows
            .map(
              (row) =>
                `${row.record.id}  ${field(row.record, "title")}  ${field(row.record, "entry_date")}  ${row.sessionIds.length} session(s)  [${row.source}] ${row.excerpt}`,
            )
            .join("\n")
        : "No journal entries matched the search.",
      args.flags.has("json"),
    );
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runJournalOrganizerCommand(
  kind: "collection" | "tag",
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const action = args.positionals[0];
  const isCollection = kind === "collection";
  const role = isCollection ? "journal-collection" : "journal-tag";
  const label = isCollection ? "Collection" : "Tag";
  const recordId = args.positionals[1];
  const json = args.flags.has("json");

  if (action === "list") {
    const snapshot = await openForCommand(path);
    try {
      const records = (
        await snapshot.listRecords(RecordType.settings, args.flags.has("include-deleted"))
      )
        .filter((record) => field(record, "record_role") === role)
        .sort((left, right) => field(left, "name").localeCompare(field(right, "name")));
      const rows = records.map(toPlainRecord);
      emit(
        output,
        rows,
        rows.length
          ? rows.map((row) => `${row["id"]}  ${row["name"]}`).join("\n")
          : `No ${kind}s in this archive.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "create") {
    const name = requiredOption(args, "name");
    await ensureUniqueJournalName(path, role, name);
    const input: JournalCollectionInput | JournalTagInput = isCollection
      ? {
          name,
          description: args.options.get("description") ?? "",
          color: args.options.get("color") ?? "",
        }
      : { name, color: args.options.get("color") ?? "" };
    const record = isCollection
      ? makeJournalCollectionRecord(input as JournalCollectionInput)
      : makeJournalTagRecord(input as JournalTagInput);
    const [saved] = await mutateArchive(path, [record]);
    const result = saved ?? record;
    emit(
      output,
      toPlainRecord(result),
      `Created ${kind} ${field(result, "name")} (${result.id}).`,
      json,
    );
    return 0;
  }

  if (action === "show") {
    if (!recordId) throw new CliError(`${kind} show requires a ${kind} ID.`);
    const record = await getJournalOrganizerAtPath(path, recordId, role);
    emit(output, toPlainRecord(record), `${field(record, "name")} (${record.id})`, json);
    return 0;
  }

  if (action === "update") {
    if (!recordId) throw new CliError(`${kind} update requires a ${kind} ID.`);
    if (
      !["name", "color", ...(isCollection ? ["description"] : [])].some((key) =>
        args.options.has(key),
      )
    ) {
      throw new CliError("Provide at least one supported field to update.");
    }
    const current = await getJournalOrganizerAtPath(path, recordId, role);
    const name = args.options.get("name") ?? field(current, "name");
    await ensureUniqueJournalName(path, role, name, current.id);
    const input: JournalCollectionInput | JournalTagInput = isCollection
      ? {
          name,
          description: args.options.get("description") ?? field(current, "description"),
          color: args.options.get("color") ?? field(current, "color"),
        }
      : { name, color: args.options.get("color") ?? field(current, "color") };
    const updated = updateJournalOrganizerRecord(current, input);
    const [saved] = await mutateArchive(path, [updated]);
    const result = saved ?? updated;
    emit(
      output,
      toPlainRecord(result),
      `Updated ${kind} ${field(result, "name")} (${result.id}).`,
      json,
    );
    return 0;
  }

  if (action === "delete" || action === "restore") {
    if (!recordId) throw new CliError(`${kind} ${action} requires a ${kind} ID.`);
    const current = await getJournalOrganizerAtPath(path, recordId, role, action === "restore");
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    try {
      const settings = await snapshot.listRecords(RecordType.settings, true);
      const entries = settings.filter((record) => field(record, "record_role") === "journal-entry");
      changes =
        action === "delete"
          ? archiveJournalOrganizerRecord(current, entries)
          : restoreJournalOrganizerRecord(current, entries);
    } finally {
      await closeSnapshot(snapshot);
    }
    await mutateArchive(path, changes);
    emit(
      output,
      { status: action === "delete" ? "deleted" : "restored", id: recordId },
      `${label} ${action === "delete" ? "archived and detached from entries" : "restored with its prior entry links"}.`,
      json,
    );
    return 0;
  }

  throw new CliError(`journal ${kind} ${action ?? ""} is not implemented.`);
}

async function getJournalOrganizerAtPath(
  path: string,
  id: string,
  role: "journal-collection" | "journal-tag",
  includeDeleted = false,
): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    const record = await snapshot.getRecord(RecordType.settings, id);
    if (
      !record ||
      field(record, "record_role") !== role ||
      (!includeDeleted && field(record, "_deleted") === "true") ||
      (includeDeleted && field(record, "_deleted") !== "true")
    )
      throw new CliError(`${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`);
    return record;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function ensureUniqueJournalName(
  path: string,
  role: "journal-collection" | "journal-tag",
  name: string,
  exceptId = "",
): Promise<void> {
  const normalized = name.trim().toLocaleLowerCase();
  if (!normalized) throw new CliError("Journal label name cannot be empty.");
  const snapshot = await openForCommand(path);
  try {
    const records = await snapshot.listRecords(RecordType.settings);
    if (
      records.some(
        (record) =>
          field(record, "record_role") === role &&
          record.id !== exceptId &&
          field(record, "name").trim().toLocaleLowerCase() === normalized,
      )
    )
      throw new CliError(
        `${role === "journal-tag" ? "Tag" : "Collection"} name already exists in this archive.`,
      );
  } finally {
    await closeSnapshot(snapshot);
  }
}

function optionIdList(args: ParsedArguments, name: string): string[] | undefined {
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (!value.trim()) return [];
  const ids = value.split(",").map((id) => id.trim().toLowerCase());
  if (ids.some((id) => !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(id))) {
    throw new CliError(`--${name} must contain comma-separated archive IDs.`);
  }
  return [...new Set(ids)];
}

async function validateJournalLinks(
  path: string,
  ids: readonly string[],
  role: "journal-collection" | "journal-tag",
): Promise<void> {
  if (!ids.length) return;
  const snapshot = await openForCommand(path);
  try {
    for (const id of ids) {
      const record = await snapshot.getRecord(RecordType.settings, id);
      if (
        !record ||
        field(record, "record_role") !== role ||
        field(record, "_deleted") === "true"
      ) {
        throw new CliError(`${role === "journal-tag" ? "Tag" : "Collection"} ${id} was not found.`);
      }
    }
  } finally {
    await closeSnapshot(snapshot);
  }
}

/** Match the Solid editor: replace selected live labels while retaining unavailable legacy IDs. */
async function preserveUnavailableJournalLinks(
  path: string,
  requestedIds: readonly string[],
  existingIds: string,
  role: "journal-collection" | "journal-tag",
): Promise<string[]> {
  const snapshot = await openForCommand(path);
  try {
    const liveIds = new Set(
      (await snapshot.listRecords(RecordType.settings, true))
        .filter(
          (record) => field(record, "record_role") === role && field(record, "_deleted") !== "true",
        )
        .map((record) => record.id.toLowerCase()),
    );
    const unavailableIds = existingIds
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id && !liveIds.has(id));
    return [...new Set([...requestedIds, ...unavailableIds])];
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runTranscriptionPlan(
  path: string,
  args: ParsedArguments,
  output: CliIo,
  detailed: boolean,
): Promise<number> {
  const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
  if (!sessionId) throw new CliError("--session must be a valid UUID.");
  const trackValue = args.options.get("track");
  const trackId = trackValue ? canonicalizeProgressUuid(trackValue) : undefined;
  if (trackValue && !trackId) throw new CliError("--track must be a valid UUID.");
  const threads = parseBoundedOption(
    args.options.get("threads"),
    "threads",
    0,
    detailed ? 1 : 0,
    64,
  );
  const modelMemory = parseBoundedOption(
    args.options.get("model-memory-mb"),
    "model-memory-mb",
    detailed ? 0 : 512,
    detailed ? 1 : 0,
    1_048_576,
  );
  const availableMemory = parseBoundedOption(
    args.options.get("available-memory-mb"),
    "available-memory-mb",
    0,
    detailed ? 1 : 0,
    1_048_576,
  );
  const hardware = Math.max(1, availableParallelism());
  const snapshot = await openForCommand(path);
  try {
    const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    if (!detailed) {
      const effectiveThreads = threads || Math.min(8, hardware);
      const estimatedMemory = modelMemory + 128 + effectiveThreads * 16;
      const feasible = availableMemory === 0 || estimatedMemory <= availableMemory;
      const result = {
        session_id: sessionId,
        track_id: trackId ?? "",
        duration_us: field(session, "audio_duration_us") || "0",
        threads: effectiveThreads,
        model_memory_mb: modelMemory,
        estimated_memory_mb: estimatedMemory,
        available_memory_mb: availableMemory,
        available_known: availableMemory !== 0,
        feasible,
      };
      emit(
        output,
        result,
        `Transcription plan: ${effectiveThreads} thread(s), ${estimatedMemory} MB estimated working memory${availableMemory ? `, ${feasible ? "within" : "above"} the available ${availableMemory} MB` : "; available memory not supplied"}.`,
        args.flags.has("json"),
      );
      return 0;
    }
    let workers = Math.min(Math.max(1, hardware - 1), threads || hardware);
    if (!modelMemory || !availableMemory) workers = 1;
    else {
      const memoryWorkers = Math.floor(availableMemory / modelMemory);
      if (!memoryWorkers)
        throw new CliError("The transcription model exceeds the available memory budget.");
      workers = Math.min(workers, memoryWorkers);
    }
    const assets = await snapshot.listRecordMetadata(RecordType.assetMetadata);
    const tracks = listSessionAudioTracks(session, assets).filter(
      (track) => !trackId || track.id.toLowerCase() === trackId,
    );
    const work: {
      work_id: string;
      track_id: string;
      start_time_us: string;
      end_time_us: string;
      priority: number;
      provisional: boolean;
    }[] = [];
    let count = 0;
    let estimated = 0n;
    for (const track of tracks) {
      const chunks = await snapshot.listAudioChunkMetadata(sessionId, track.id);
      let duration = 0n;
      for (const chunk of chunks) {
        const raw = field(chunk, "timeline_end_us") || "0";
        if (!/^\d+$/u.test(raw)) throw new CliError("Audio timeline metadata is invalid.");
        const end = BigInt(raw);
        if (end > duration) duration = end;
      }
      if (!duration) continue;
      count += 1;
      const elapsed = (duration + BigInt(workers) - 1n) / BigInt(workers);
      if (elapsed > estimated) estimated = elapsed;
      if ((duration + 29_999_999n) / 30_000_000n > BigInt(100_000 - work.length))
        throw new CliError("Transcription plan exceeds the 100,000 work item limit.");
      for (let start = 0n; start < duration; start += 30_000_000n) {
        const end = start + 30_000_000n < duration ? start + 30_000_000n : duration;
        work.push({
          work_id: `${sessionId}:${track.id}:${start}`,
          track_id: track.id,
          start_time_us: start.toString(),
          end_time_us: end.toString(),
          priority: 2,
          provisional: true,
        });
      }
    }
    if (!count) throw new CliError("The session has no audio chunks for the selected track.");
    const result = {
      session_id: sessionId,
      track_count: count,
      chunk_count: work.length,
      worker_count: workers,
      estimated_work_duration_us: estimated.toString(),
      work,
    };
    emit(
      output,
      result,
      `Transcription plan: ${count} track(s), ${work.length} bounded work item(s), ${workers} worker(s), estimated ${estimated} µs elapsed.\n${work.map((item) => `  ${item.track_id} [${item.start_time_us}, ${item.end_time_us})`).join("\n")}`,
      args.flags.has("json"),
    );
    return 0;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function runTranscriptCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  const json = args.flags.has("json");
  const sessionId = args.options.get("session") ?? "";

  if (action === "plan") return runTranscriptionPlan(path, args, output, false);

  if (action === "transcribe" || action === "refine") {
    if (!args.flags.has("consent-local-audio")) {
      throw new CliError(
        "Use --consent-local-audio to authorize processing this recording with the selected local executable.",
      );
    }
    const selectedSession = requiredOption(args, "session");
    const trackId = requiredOption(args, "track");
    const executable = requiredOption(args, "whisper");
    const model = requiredOption(args, "model");
    const language = args.options.get("language") ?? "auto";
    const startUs = args.options.has("start")
      ? parseTranscriptTimestamp(requiredOption(args, "start"))
      : 0n;
    const endUs = args.options.has("end")
      ? parseTranscriptTimestamp(requiredOption(args, "end"))
      : undefined;
    const snapshot = await openForCommand(path);
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, selectedSession);
      const generation = snapshot.commit.generation;
      const result = await transcribeTrack({
        snapshot,
        sessionId: selectedSession,
        trackId,
        executable,
        model,
        language,
        startUs,
        ...(endUs === undefined ? {} : { endUs }),
        refine: action === "refine",
        progress: (message) => {
          if (!json) output.stderr(message);
        },
      });
      if (result.changes.length) {
        const fields = new Map(session.fields);
        fields.set("processing_state", "review-required");
        fields.set(
          "processing_detail",
          "Local transcription is provisional and ready for tutor review.",
        );
        fields.set("processing_updated_at_us", timestampNow());
        await mutateArchive(
          path,
          [...result.changes, { ...session, fields }],
          generation,
          "The archive changed during transcription. Review it and try again.",
        );
      }
      emit(
        output,
        {
          session_id: selectedSession,
          track_id: trackId,
          generated: result.generated,
          superseded: result.superseded,
          skipped: result.skipped,
          windows: result.windows,
        },
        `Generated ${result.generated} provisional cue(s), replaced ${result.superseded}, skipped ${result.skipped}. Review generated cues before reuse.`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (action === "import") {
    if (!sessionId) throw new CliError("--session is required.");
    const inputPath = args.options.get("input") ?? args.positionals[0];
    if (!inputPath) throw new CliError("--input is required.");
    const inputAbsolutePath = resolve(inputPath);
    const metadata = await lstat(inputAbsolutePath);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new CliError("Transcript input must be a regular, non-symlink file.");
    if (metadata.size > 256 * 1024 * 1024)
      throw new CliError("Transcript source exceeds the configured 256 MiB limit.");
    const bytes = await readFile(inputAbsolutePath);
    let source: string;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CliError("Transcript source must be valid UTF-8.");
    }
    const format = resolveTranscriptFormat(args.options.get("format") ?? "auto", inputAbsolutePath);
    const cues = parseTranscriptSource(source, format);
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    try {
      session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const changes = makeTranscriptRecords(sessionId, cues, format, basename(inputAbsolutePath));
    if (changes.length > 0) {
      const fields = new Map(session.fields);
      fields.set("processing_state", "review-required");
      fields.set(
        "processing_detail",
        "Imported transcript is provisional and ready for tutor review.",
      );
      fields.set("processing_updated_at_us", timestampNow());
      changes.push({ ...session, fields });
      await mutateArchive(path, changes);
    }
    emit(
      output,
      {
        session_id: sessionId,
        source_format: format,
        imported_segment_count: String(cues.length),
        verification_state: "provisional",
      },
      `Imported ${cues.length} transcript segment(s) from ${format}; all imported text is provisional pending tutor review.`,
      json,
    );
    return 0;
  }

  if (action === "history" || action === "restore") {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.transcriptSegment, id, limit);
      if (history.length === 0) throw new CliError(`Transcript segment was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toFlatTranscriptRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No transcript revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Transcript history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestampNow());
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored]);
      emit(
        output,
        toFlatTranscriptRecord(saved ?? restored),
        `Transcript revision ${revision} restored as a new revision.`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  if (["show", "search", "export"].includes(action)) {
    if (!sessionId) throw new CliError("--session is required.");
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
      records = (await snapshot.listRecords(RecordType.transcriptSegment)).filter(
        (record) => field(record, "session_id") === sessionId,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const query = args.options.get("query");
    if (action === "search" && !query)
      throw new CliError("--query is required for transcript search.");
    if (query !== undefined)
      records = records.filter((record) => field(record, "text").includes(query));
    records = sortTranscriptRecords(records);
    if (action === "export") {
      const format = args.options.get("format") ?? "text";
      if (format !== "text" && format !== "srt" && format !== "vtt" && format !== "json") {
        throw new CliError("Transcript export format must be text, srt, vtt, or json.");
      }
      const destination = resolve(requiredOption(args, "output"));
      const text = formatTranscriptExport(records, format as TranscriptExportFormat);
      await writeTextAtomically(destination, text);
      emit(
        output,
        { output: destination, format, segment_count: String(records.length) },
        `Exported ${format} transcript to ${destination}.`,
        json,
      );
      return 0;
    }
    if (json) {
      emit(
        output,
        records.map(toFlatTranscriptRecord),
        `${records.length} transcript segment(s).`,
        true,
      );
    } else {
      const lines = records.map(
        (record) => `[${transcriptTimeRange(record)}] ${field(record, "text")}`,
      );
      output.stdout(lines.length ? lines.join("\n") : "No transcript segments found.");
    }
    return 0;
  }

  if (action === "split" || action === "merge") {
    const ids =
      action === "split" ? [requiredPosition(args, 0, "transcript segment ID")] : args.positionals;
    if (action === "merge" && ids.length < 2) {
      throw new CliError("Provide at least two transcript segment IDs to merge.");
    }
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint;
    try {
      generation = snapshot.commit.generation;
      const records: ArchiveRecord[] = [];
      for (const id of ids) {
        records.push(await requireLiveRecord(snapshot, RecordType.transcriptSegment, id));
      }
      if (action === "split") {
        const before = args.options.get("before");
        const after = args.options.get("after");
        if (before === undefined || after === undefined) {
          throw new CliError("--before and --after are required.");
        }
        changes = splitTranscriptRecord(records[0]!, before, after, args.options.get("at"));
      } else {
        changes = mergeTranscriptRecords(records, args.options.get("separator") ?? " ");
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(path, changes, generation);
    const result = action === "split" ? (saved[1] ?? changes[1]!) : (saved[0] ?? changes[0]!);
    emit(
      output,
      toFlatTranscriptRecord(result),
      action === "split"
        ? `Transcript segment split into ${changes[0]!.id} and ${changes[1]!.id}.`
        : `Merged ${ids.length} transcript segments.`,
      json,
    );
    return 0;
  }

  if (["correct", "timestamp", "verify", "speaker"].includes(action)) {
    const id = requiredPosition(args, 0, "transcript segment ID");
    const current = await getLiveRecordAtPath(path, RecordType.transcriptSegment, id);
    let updated: ArchiveRecord;
    if (action === "correct") {
      const text = args.options.get("text");
      if (text === undefined || text.length === 0) throw new CliError("--text is required.");
      updated = correctTranscriptRecord(current, text);
    } else if (action === "timestamp") {
      const start = args.options.get("start");
      const end = args.options.get("end");
      if (!start || !end) throw new CliError("--start and --end are required.");
      updated = setTranscriptTimestamp(current, start, end);
    } else if (action === "verify") {
      const state = args.options.get("state") ?? "human-verified";
      if (state !== "human-verified" && state !== "provisional" && state !== "needs-review") {
        throw new CliError(
          "Verification state must be human-verified, provisional, or needs-review.",
        );
      }
      updated = setTranscriptVerification(current, state);
    } else {
      const label = args.options.get("name");
      if (args.flags.has("unknown") && label)
        throw new CliError("Use either --unknown or --name, not both.");
      if (args.flags.has("unknown")) {
        updated = setTranscriptSpeaker(current, null);
      } else if (label) {
        updated = setTranscriptSpeaker(current, label);
      } else throw new CliError("Provide --name <label> or --unknown.");
    }
    const [saved] = await mutateArchive(path, [updated]);
    emit(
      output,
      toFlatTranscriptRecord(saved ?? updated),
      `Updated transcript segment ${id}.`,
      json,
    );
    return 0;
  }

  throw new CliError(`transcript ${action} is not implemented in the TypeScript CLI yet.`);
}

async function runAnnotationCommand(
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (action === "plan") return runTranscriptionPlan(path, args, output, true);
  const json = args.flags.has("json");
  if (action === "add") {
    const sessionId = requiredOption(args, "session");
    const start = requiredOption(args, "at");
    const content = args.options.get("text");
    if (content === undefined) throw new CliError("--text is required.");
    const snapshot = await openForCommand(path);
    try {
      await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const record = makeAnnotationRecord({
      sessionId,
      start,
      end: args.options.get("end") ?? start,
      type: validateAnnotationType(requiredOption(args, "type")),
      priority: validateAnnotationPriority(args.options.get("priority") ?? "normal"),
      title: args.options.get("title") ?? "",
      content,
    });
    const [saved] = await mutateArchive(path, [record]);
    const savedRecord = saved ?? record;
    emit(
      output,
      toPlainRecord(savedRecord),
      `Added ${field(savedRecord, "type")} annotation (${savedRecord.id}).`,
      json,
    );
    return 0;
  }

  if (action === "list") {
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    try {
      records = await snapshot.listRecords(
        RecordType.annotation,
        args.flags.has("include-deleted"),
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const sessionId = args.options.get("session");
    if (sessionId)
      records = records.filter((record) => field(record, "session_id") === sessionId.toLowerCase());
    records.sort((left, right) => {
      const a = parseIntegerField(field(left, "start_time_us"));
      const b = parseIntegerField(field(right, "start_time_us"));
      return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
    });
    const rows = records.map(toPlainRecord);
    emit(output, rows, `${rows.length} annotation${rows.length === 1 ? "" : "s"}.`, json);
    return 0;
  }

  if (action === "link" || action === "unlink") {
    const id = requiredPosition(args, 0, "annotation ID");
    const targetType = requiredOption(args, "to").toLowerCase();
    const targetId = requiredOption(args, "target-id");
    const targetRecordType =
      targetType === "asset"
        ? RecordType.assetMetadata
        : targetType === "evidence"
          ? RecordType.evidenceNode
          : null;
    if (targetRecordType === null) {
      throw new CliError("Annotations can link to assets or evidence nodes.");
    }
    const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
    const target = await getLiveRecordAtPath(path, targetRecordType, targetId);
    const annotationSession = field(current, "session_id");
    const targetSession = field(target, "session_id");
    if (targetSession && annotationSession !== targetSession) {
      throw new CliError("An annotation cannot link to a record from a different session.");
    }
    const fieldName = targetType === "asset" ? "linked_asset_ids" : "linked_evidence_ids";
    const linked = new Set(
      field(current, fieldName)
        .split(",")
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    );
    if (action === "link") linked.add(targetId.toLowerCase());
    else linked.delete(targetId.toLowerCase());
    const fields = new Map(current.fields);
    fields.set(fieldName, [...linked].join(","));
    const updated = { ...current, fields };
    const [saved] = await mutateArchive(path, [updated]);
    emit(
      output,
      toPlainRecord(saved ?? updated),
      action === "link" ? "Annotation link added." : "Annotation link removed.",
      json,
    );
    return 0;
  }

  if (action === "merge") {
    const ids = args.positionals;
    if (ids.length < 2) throw new CliError("Provide at least two annotation IDs to merge.");
    const uniqueIds = new Set(ids.map((value) => value.toLowerCase()));
    if (uniqueIds.size !== ids.length)
      throw new CliError("Each annotation ID may appear only once in a merge.");
    const snapshot = await openForCommand(path);
    let annotations: ArchiveRecord[];
    try {
      annotations = [];
      for (const id of ids) {
        const record = await snapshot.getRecord(RecordType.annotation, id);
        if (!record || field(record, "_deleted") === "true") {
          throw new CliError(`Annotation was not found: ${id}`);
        }
        annotations.push(record);
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const first = annotations[0]!;
    const sessionId = field(first, "session_id");
    const type = field(first, "type");
    const priority = field(first, "priority");
    const contents: string[] = [];
    const titles: string[] = [];
    const mergedLinks = new Map<string, Set<string>>([
      ["linked_asset_ids", new Set()],
      ["linked_evidence_ids", new Set()],
      ["source_segment_ids", new Set()],
    ]);
    let latestEnd = parseIntegerField(field(first, "end_time_us"));
    let previousStart = -1n;
    for (const record of annotations) {
      if (field(record, "session_id") !== sessionId) {
        throw new CliError("All annotations must belong to the same session.");
      }
      if (field(record, "type") !== type || field(record, "priority") !== priority) {
        throw new CliError("Annotations must have the same type and priority to merge.");
      }
      const start = parseIntegerField(field(record, "start_time_us"));
      if (start < previousStart) throw new CliError("Provide annotations in chronological order.");
      previousStart = start;
      latestEnd =
        latestEnd > parseIntegerField(field(record, "end_time_us"))
          ? latestEnd
          : parseIntegerField(field(record, "end_time_us"));
      contents.push(field(record, "content"));
      const title = field(record, "title");
      if (title && !titles.includes(title)) titles.push(title);
      for (const [key, values] of mergedLinks) {
        for (const value of field(record, key)
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)) {
          values.add(value);
        }
      }
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const mergedFields = new Map(first.fields);
    mergedFields.set("content", contents.join(args.options.get("separator") ?? "\n"));
    mergedFields.set("start_time_us", parseIntegerField(field(first, "start_time_us")).toString());
    mergedFields.set("end_time_us", latestEnd.toString());
    mergedFields.set("merged_titles", titles.join("\n"));
    mergedFields.set("source_annotation_ids", ids.map((value) => value.toLowerCase()).join(","));
    for (const [key, values] of mergedLinks) mergedFields.set(key, [...values].join(","));
    mergedFields.set("updated_at_us", timestamp);
    const changes: ArchiveRecord[] = [{ ...first, fields: mergedFields }];
    for (const record of annotations.slice(1)) {
      changes.push(removeAnnotationRecord(record));
    }
    const [saved] = await mutateArchive(path, changes);
    const resultRecord = saved ?? { ...first, fields: mergedFields };
    emit(output, toPlainRecord(resultRecord), `Merged ${annotations.length} annotations.`, json);
    return 0;
  }

  const id = requiredPosition(args, 0, "annotation ID");
  if (action === "history" || action === "restore") {
    const snapshot = await openForCommand(path);
    let snapshotClosed = false;
    try {
      const limit = parseBoundedOption(args.options.get("limit"), "limit", 100, 1, 10_000);
      const history = await snapshot.getRecordHistory(RecordType.annotation, id, limit);
      if (history.length === 0) throw new CliError(`Annotation was not found: ${id}`);
      if (action === "history") {
        const rows = history.map((record, historyIndex) => ({
          history_index: historyIndex,
          ...toPlainRecord(record),
        }));
        const summary = history
          .map(
            (record, historyIndex) =>
              `${historyIndex}: revision ${record.revision.toString()}${field(record, "_deleted") === "true" ? " (removed)" : ""}`,
          )
          .join("\n");
        emit(output, rows, summary || "No annotation revisions found.", json);
        return 0;
      }

      const revision = parseBoundedOption(args.options.get("revision"), "revision", -1, 1, 10_000);
      const selected = history[revision];
      if (!selected) throw new CliError(`Annotation history index ${revision} was not found.`);
      const fields = new Map(selected.fields);
      fields.delete("_deleted");
      fields.delete("deleted_at_us");
      const timestamp = (BigInt(Date.now()) * 1000n).toString();
      fields.set("restored_from_revision", revision.toString());
      fields.set("updated_at_us", timestamp);
      fields.set("human_edited_at_us", timestamp);
      const restored = { ...selected, fields };
      await closeSnapshot(snapshot);
      snapshotClosed = true;
      const [saved] = await mutateArchive(path, [restored]);
      emit(
        output,
        toPlainRecord(saved ?? restored),
        `Annotation revision ${revision} restored (${(saved ?? restored).id}).`,
        json,
      );
      return 0;
    } finally {
      if (!snapshotClosed) await closeSnapshot(snapshot);
    }
  }

  const current = await getLiveRecordAtPath(path, RecordType.annotation, id);
  if (action === "split") {
    const before = args.options.get("before");
    const after = args.options.get("after");
    if (before === undefined || after === undefined) {
      throw new CliError("--before and --after are required.");
    }
    if (!before || !after || before + after !== field(current, "content")) {
      throw new CliError(
        "The before and after text must be non-empty and exactly preserve the original annotation.",
      );
    }
    const originalStart = parseIntegerField(field(current, "start_time_us"));
    const originalEnd = parseIntegerField(field(current, "end_time_us"));
    const requestedTime = args.options.get("at");
    if (!requestedTime && originalStart !== originalEnd) {
      throw new CliError("Splitting a time range requires --at within the annotation.");
    }
    const splitTime = requestedTime ? parseTranscriptTimestamp(requestedTime) : originalStart;
    if (
      splitTime < originalStart ||
      splitTime > originalEnd ||
      (originalStart !== originalEnd && (splitTime === originalStart || splitTime === originalEnd))
    ) {
      throw new CliError("The split time must be inside the annotation range.");
    }
    const timestamp = (BigInt(Date.now()) * 1000n).toString();
    const firstFields = new Map(current.fields);
    firstFields.set("content", before);
    firstFields.set("end_time_us", splitTime.toString());
    firstFields.set("updated_at_us", timestamp);
    const first: ArchiveRecord = { ...current, fields: firstFields };
    const duplicate = duplicateAnnotationRecord(current);
    const secondFields = new Map(duplicate.fields);
    secondFields.set("content", after);
    secondFields.set("start_time_us", splitTime.toString());
    secondFields.set("end_time_us", originalEnd.toString());
    secondFields.set("created_at_us", timestamp);
    secondFields.set("updated_at_us", timestamp);
    const second: ArchiveRecord = { ...duplicate, fields: secondFields };
    const saved = await mutateArchive(path, [first, second]);
    const savedFirst = saved[0] ?? first;
    const savedSecond = saved[1] ?? second;
    emit(
      output,
      { first: toPlainRecord(savedFirst), second: toPlainRecord(savedSecond) },
      `Annotation split into ${savedFirst.id} and ${savedSecond.id}.`,
      json,
    );
    return 0;
  }
  if (action === "show") {
    emit(output, toPlainRecord(current), `${field(current, "type")} (${current.id})`, json);
    return 0;
  }
  let updated: ArchiveRecord;
  if (action === "remove") {
    updated = removeAnnotationRecord(current);
  } else if (action === "duplicate") {
    updated = duplicateAnnotationRecord(current);
  } else if (action === "prioritize" || action === "update") {
    const options =
      action === "prioritize"
        ? ["priority"]
        : ["text", "title", "priority", "type", "at", "start", "end"];
    if (!options.some((name) => args.options.has(name))) {
      throw new CliError(`Provide an annotation field to ${action}.`);
    }
    const currentStart = parseIntegerField(field(current, "start_time_us"));
    const currentEnd = parseIntegerField(field(current, "end_time_us"));
    const at = args.options.get("at");
    const input: AnnotationInput = {
      sessionId: args.options.get("session") ?? field(current, "session_id"),
      start: args.options.get("start") ?? at ?? formatTranscriptTimestampUs(currentStart),
      end: args.options.get("end") ?? at ?? formatTranscriptTimestampUs(currentEnd),
      type: validateAnnotationType(args.options.get("type") ?? field(current, "type")),
      priority: validateAnnotationPriority(
        args.options.get("priority") ?? field(current, "priority"),
      ),
      title: args.options.get("title") ?? field(current, "title"),
      content: args.options.get("text") ?? field(current, "content"),
    };
    updated = updateAnnotationRecord(current, input);
  } else {
    throw new CliError(`annotation ${action} is not implemented in the TypeScript CLI yet.`);
  }
  const [saved] = await mutateArchive(path, [updated]);
  emit(
    output,
    toPlainRecord(saved ?? updated),
    `Annotation ${action} completed (${(saved ?? updated).id}).`,
    json,
  );
  return 0;
}

async function runExtendedRecordCommand(
  group: string,
  action: string,
  path: string,
  args: ParsedArguments,
  output: CliIo,
): Promise<number | null> {
  const id = args.positionals[0];
  const json = args.flags.has("json");
  const recordType =
    group === "student"
      ? RecordType.student
      : group === "session"
        ? RecordType.session
        : RecordType.settings;

  if (group === "student" && action === "show") {
    const studentId = requiredPosition(args, 0, "student ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let student: ArchiveRecord;
    try {
      student = await requireLiveRecord(snapshot, RecordType.student, studentId);
    } finally {
      await closeSnapshot(snapshot);
    }
    emit(output, studentProfileObject(student), readableStudentRecord(student), json);
    return 0;
  }

  if (group === "session" && action === "show") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let session: ArchiveRecord;
    try {
      session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
    } finally {
      await closeSnapshot(snapshot);
    }
    const response = {
      ...toPlainRecord(session),
      entry_id: field(session, "entry_id"),
      notes_document_id: field(session, "notes_document_id"),
      session_state: session.fields.get("session_state") ?? "active",
      session_type:
        session.fields.get("session_type") ??
        (field(session, "recording_state") === "not-started" ? "notes-only" : "record-audio"),
      started_at_us:
        session.fields.get("started_at_us") ?? session.fields.get("created_at_us") ?? "0",
      ended_at_us: session.fields.get("ended_at_us") ?? "0",
      reviewed_at_us: session.fields.get("reviewed_at_us") ?? "0",
    };
    emit(output, response, readableSessionRecord(session), json);
    return 0;
  }

  if (group === "session" && action === "verify") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const [annotations, transcripts, assets] = await Promise.all([
        snapshot.listRecords(RecordType.annotation),
        snapshot.listRecords(RecordType.transcriptSegment),
        snapshot.listRecords(RecordType.assetMetadata),
      ]);
      const countForSession = (
        records: ArchiveRecord[],
        include: (record: ArchiveRecord) => boolean = () => true,
      ) =>
        records.filter(
          (record) =>
            canonicalizeProgressUuid(field(record, "session_id")) ===
              canonicalizeProgressUuid(session.id) && include(record),
        ).length;
      const summary = {
        session_id: session.id,
        annotations: String(countForSession(annotations)),
        transcript_segments: String(countForSession(transcripts)),
        assets: String(
          countForSession(
            assets,
            (record) =>
              ![
                "audio-track",
                "recording-take",
                "waveform-pyramid",
                "sparse-timestamp-seek-index",
                "asset-blob-manifest",
                "asset-blob-chunk",
              ].includes(field(record, "record_role")),
          ),
        ),
      };
      emit(
        output,
        summary,
        `Session references are internally readable.\n${JSON.stringify(summary, null, 2)}`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "session" && action === "delete") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint | undefined;
    let scope: Awaited<ReturnType<typeof planSessionTrash>> | undefined;
    try {
      const session = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      try {
        scope = await planSessionTrash(snapshot, session);
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : "Unable to review the session deletion scope.",
        );
      }
      generation = snapshot.commit.generation;
      changes = scope.changes;
    } finally {
      await closeSnapshot(snapshot);
    }
    if (!scope || generation === undefined) {
      throw new CliError("Unable to prepare the session deletion scope.");
    }

    const scopeMaterial = scope.scopeRecords
      .map((record) => `${record.type}:${record.id.toLowerCase()}:${record.revision}`)
      .sort()
      .map((part) => `${part}\n`)
      .join("");
    const scopeToken = createHash("sha256").update(scopeMaterial).digest("hex");
    const summary = {
      status: "confirmation-required",
      session_id: sessionId,
      scope_token: scopeToken,
      audio_chunks: String(scope.counts.audioChunks),
      waveform_indices: String(scope.counts.waveformIndices),
      session_notes: String(scope.counts.sessionNotes),
      transcript_segments: String(scope.counts.transcriptSegments),
      annotations: String(scope.counts.annotations),
      guides: String(scope.counts.guides),
      assets: String(scope.counts.assets),
      entries_updated: String(scope.counts.entriesUpdated),
      evidence_nodes: String(scope.counts.evidenceNodes),
      evidence_edges: String(scope.counts.evidenceEdges),
      total_records: String(scope.counts.totalRecords),
    };
    const recordsMoved = scope.counts.totalRecords - scope.counts.entriesUpdated;
    if (args.flags.has("dry-run") || !args.flags.has("confirm-scope")) {
      emit(
        output,
        summary,
        `Deleting this session would affect ${scope.counts.totalRecords} records: move ${recordsMoved} to Trash, including ${scope.counts.audioChunks} audio chunks, ${scope.counts.guides} guides, and ${scope.counts.assets} materials; detach ${scope.counts.entriesUpdated} journal entries. Review the scope, then repeat with --confirm-scope --scope-token ${scopeToken}.`,
        json,
      );
      return 0;
    }
    if (args.options.get("scope-token") !== scopeToken) {
      throw new CliError(
        "Deletion scope confirmation is missing or stale. Review the current scope and confirm it with the returned --scope-token.",
      );
    }
    const audioSnapshot = await openForCommand(path);
    try {
      if (audioSnapshot.commit.generation !== generation) {
        throw new CliError(
          "The archive changed after this operation was reviewed. Review it again before retrying.",
        );
      }
      changes = [
        ...changes,
        ...(await loadSessionAudioTrashChanges(audioSnapshot, sessionId, scope.audioChunkRecords)),
      ];
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        error instanceof Error ? error.message : "Unable to load the reviewed recording chunks.",
      );
    } finally {
      await closeSnapshot(audioSnapshot);
    }
    await mutateArchive(path, changes, generation);
    emit(
      output,
      { ...summary, status: "deleted" },
      "Session and associated records moved to recoverable Trash.",
      json,
    );
    return 0;
  }

  if (group === "session" && action === "restore") {
    const sessionId = requiredPosition(args, 0, "session ID").toLowerCase();
    const snapshot = await openForCommand(path);
    let changes: ArchiveRecord[];
    let generation: bigint | undefined;
    try {
      const session = await snapshot.getRecord(RecordType.session, sessionId);
      if (!session || field(session, "_deleted") !== "true") {
        throw new CliError(`Session ${sessionId} is not in Trash.`);
      }
      try {
        changes = await planSessionRestore(snapshot, session);
      } catch (error) {
        throw new CliError(
          error instanceof Error ? error.message : "Unable to restore the session group.",
        );
      }
      generation = snapshot.commit.generation;
    } finally {
      await closeSnapshot(snapshot);
    }
    if (generation === undefined) throw new CliError("Unable to prepare the session restore.");
    await mutateArchive(path, changes, generation);
    emit(
      output,
      { status: "restored", session_id: sessionId, restored_records: String(changes.length) },
      `Restored session ${sessionId} and ${Math.max(0, changes.length - 1)} associated records.`,
      json,
    );
    return 0;
  }

  if (group === "student" && (action === "history" || action === "progress")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const snapshot = await openForCommand(path);
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = (await snapshot.listRecords(RecordType.session)).filter(
        (session) =>
          canonicalizeProgressUuid(field(session, "student_id")) ===
          canonicalizeProgressUuid(student.id),
      );
      sessions.sort((left, right) => {
        const a = parseIntegerField(field(right, "started_at_us"));
        const b = parseIntegerField(field(left, "started_at_us"));
        return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
      });

      if (action === "history") {
        const rows = sessions.map(toPlainRecord);
        emit(
          output,
          rows,
          rows.length === 0
            ? `No sessions recorded for ${field(student, "display_name") || "this student"}.`
            : `${rows.length} session${rows.length === 1 ? "" : "s"} in ${field(student, "display_name") || "student"} history.`,
          json,
        );
        return 0;
      }

      const progress = decodeStudentProgress(field(student, "progress_classifications"));
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      const classifications = progress.map((item) => {
        let sourceStatus = "valid";
        try {
          validateProgressEvidence(
            student.id,
            item.evidenceSourceIds,
            sessions,
            evidence,
            item.classification,
          );
        } catch {
          sourceStatus = "invalid-or-unavailable";
        }
        return {
          skill: item.skill,
          classification: item.classification,
          evidence_source_ids: item.evidenceSourceIds.join(","),
          reviewed_by: item.reviewedBy,
          reviewed_at_us: item.reviewedAtUs,
          note: item.note,
          claim_label:
            item.classification === "unverified-improvement"
              ? "UNVERIFIED CLAIM: improvement is not established"
              : "Human-reviewed classification",
          human_reviewed: "true",
          source_status: sourceStatus,
        };
      });
      if (json) {
        emit(
          output,
          { student_id: student.id, sessions: sessions.map(toPlainRecord), classifications },
          `${classifications.length} progress classification(s).`,
          true,
        );
      } else {
        const lines = [
          `Progress classifications for ${field(student, "display_name") || "student"}:`,
        ];
        if (classifications.length === 0) {
          lines.push("  No progress classifications have been human-reviewed.");
        }
        for (const item of classifications) {
          lines.push(
            `  ${item.skill} — ${item.classification}${item.classification === "unverified-improvement" ? " [UNVERIFIED CLAIM: improvement is not established]" : ""}${item.source_status === "valid" ? "" : " [SOURCE REFERENCES INVALID OR UNAVAILABLE]"}`,
            `    Evidence: ${item.evidence_source_ids.split(",").join(", ")}`,
            `    Human review: ${item.reviewed_by} at ${item.reviewed_at_us}`,
          );
          if (item.note) lines.push(`    Note: ${item.note}`);
        }
        lines.push("  Sessions:");
        if (sessions.length === 0) lines.push("    No sessions recorded yet.");
        for (const session of sessions) {
          lines.push(
            `    ${session.id}  ${field(session, "subject")} · ${field(session, "title")}`,
          );
        }
        output.stdout(lines.join("\n"));
      }
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "student" && (action === "progress-review" || action === "progress-edit")) {
    const studentId = requiredPosition(args, 0, "student ID").toLocaleLowerCase();
    const skill = requiredOption(args, "skill");
    const classificationValue = requiredOption(args, "classification");
    if (!isStudentProgressClassification(classificationValue)) {
      throw new CliError(
        "Classification must be newly-observed, recurring, partial-improvement, demonstrated-mastery, unverified-improvement, or not-revisited.",
      );
    }
    const rawIds = requiredOption(args, "evidence-ids");
    const evidenceSourceIds = rawIds.split(",").map((id) => id.trim().toLocaleLowerCase());
    if (evidenceSourceIds.some((id) => !id)) {
      throw new CliError("Evidence IDs must be a comma-separated list without empty items.");
    }
    const reviewedBy = requiredOption(args, "reviewed-by");
    const note = args.options.get("note") ?? "";
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    try {
      const student = await requireLiveRecord(snapshot, RecordType.student, studentId);
      const sessions = await snapshot.listRecords(RecordType.session);
      const evidence = await snapshot.listRecords(RecordType.evidenceNode);
      updated = reviewStudentProgressRecord(
        student,
        { skill, classification: classificationValue, evidenceSourceIds, reviewedBy, note },
        sessions,
        evidence,
      );
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(path, [updated]);
    const savedRecord = saved ?? updated;
    const savedItem = decodeStudentProgress(field(savedRecord, "progress_classifications")).find(
      (item) => normalizeStudentProgressSkill(item.skill) === normalizeStudentProgressSkill(skill),
    );
    if (!savedItem) throw new CliError("The saved progress review could not be read back.");
    emit(
      output,
      {
        skill: savedItem.skill,
        classification: savedItem.classification,
        evidence_source_ids: savedItem.evidenceSourceIds.join(","),
        reviewed_by: savedItem.reviewedBy,
        reviewed_at_us: savedItem.reviewedAtUs,
        note: savedItem.note,
        claim_label:
          savedItem.classification === "unverified-improvement"
            ? "UNVERIFIED CLAIM: improvement is not established"
            : "Human-reviewed classification",
        human_reviewed: "true",
        source_status: "valid",
      },
      `Human-reviewed progress saved for ${savedItem.skill}.`,
      json,
    );
    return 0;
  }

  if ((group === "student" || group === "session" || group === "journal") && action === "show") {
    if (!id) throw new CliError(`${group} show requires a record ID.`);
    const snapshot = await openForCommand(path);
    try {
      const record =
        group === "journal"
          ? await getJournalEntry(snapshot, id)
          : await requireLiveRecord(snapshot, recordType, id);
      emit(
        output,
        toPlainRecord(record),
        `${field(record, "title") || field(record, "display_name")} (${record.id})`,
        json,
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }

  if (group === "student" && action === "update") {
    const record = await updateRecord(
      path,
      RecordType.student,
      requiredPosition(args, 0, "student ID"),
      {
        name: "display_name",
        grade: "grade",
        subjects: "subjects",
        objectives: "learning_objectives",
        "learning-objectives": "learning_objectives",
        difficulties: "known_difficulties",
        "demonstrated-improvements": "demonstrated_improvements",
        "tutor-notes": "tutor_notes",
        "preferred-guide-template": "preferred_guide_template",
      },
      args,
    );
    emit(
      output,
      toPlainRecord(record),
      `Updated student ${field(record, "display_name")} (${record.id}).`,
      json,
    );
    return 0;
  }

  if (group === "session" && action === "update") {
    const sessionId = requiredPosition(args, 0, "session ID");
    const metadataOptions = [
      "title",
      "subject",
      "objectives",
      "learning-objectives",
      "student-id",
      "entry-id",
    ];
    const updateNotes = args.options.has("notes");
    if (!updateNotes && !metadataOptions.some((option) => args.options.has(option))) {
      throw new CliError("Provide a session field to update.");
    }
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const studentId = args.options.get("student-id") ?? field(current, "student_id", "anonymous");
      if (args.options.has("student-id") && studentId !== "anonymous") {
        await requireLiveRecord(snapshot, RecordType.student, studentId);
      }
      const notesDocumentId = field(current, "notes_document_id");
      const notesDocument =
        updateNotes && notesDocumentId
          ? ((await snapshot.getRecord(RecordType.settings, notesDocumentId)) ?? null)
          : null;
      records = updateSessionRecords(
        current,
        {
          studentId,
          subject: args.options.get("subject") ?? field(current, "subject"),
          title: args.options.get("title") ?? field(current, "title", "Untitled session"),
          objectives:
            args.options.get("objectives") ??
            args.options.get("learning-objectives") ??
            field(current, "learning_objectives"),
          notes: args.options.get("notes") ?? "",
        },
        notesDocument,
        updateNotes,
      );
      const destinationId = args.options.get("entry-id");
      if (destinationId !== undefined) {
        const canonical = canonicalizeProgressUuid(destinationId);
        if (!canonical) throw new CliError("--entry-id must be a valid UUID.");
        const destination = await requireLiveRecord(snapshot, RecordType.settings, canonical);
        if (field(destination, "record_role") !== "journal-entry")
          throw new CliError("Destination journal entry was not found.");
        if (field(current, "entry_id").toLowerCase() !== canonical) {
          const sources = await readGuideSourceRecords(snapshot);
          const replacements = new Map(
            records.map((record) => [`${record.type}:${record.id.toLowerCase()}`, record]),
          );
          const projectedSources = sources.map(
            (record) => replacements.get(`${record.type}:${record.id.toLowerCase()}`) ?? record,
          );
          for (const record of records)
            if (
              !projectedSources.some(
                (existing) =>
                  existing.type === record.type &&
                  existing.id.toLowerCase() === record.id.toLowerCase(),
              )
            )
              projectedSources.push(record);
          const guides = await snapshot.listRecords(RecordType.guide);
          const moved = moveJournalSessionForCli(
            destination,
            records[0]!,
            projectedSources,
            guides,
          );
          const movedKeys = new Set(
            moved.map((record) => `${record.type}:${record.id.toLowerCase()}`),
          );
          records = [
            ...moved.filter((record) => record.type === RecordType.session),
            ...moved.filter((record) => record.type !== RecordType.session),
            ...records.filter(
              (record) => !movedKeys.has(`${record.type}:${record.id.toLowerCase()}`),
            ),
          ];
        }
      }
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while this session edit was being prepared. Retry the update.",
    );
    const record = saved[0] ?? records[0]!;
    emit(
      output,
      toPlainRecord(record),
      `Updated session ${field(record, "title")} (${record.id}).`,
      json,
    );
    return 0;
  }

  if (group === "journal" && action === "update") {
    const current = await getJournalEntryAtPath(
      path,
      requiredPosition(args, 0, "journal entry ID"),
    );
    let collectionIds = optionIdList(args, "collection-ids");
    let tagIds = optionIdList(args, "tag-ids");
    await validateJournalLinks(path, collectionIds ?? [], "journal-collection");
    await validateJournalLinks(path, tagIds ?? [], "journal-tag");
    if (collectionIds !== undefined) {
      collectionIds = await preserveUnavailableJournalLinks(
        path,
        collectionIds,
        field(current, "collection_ids"),
        "journal-collection",
      );
    }
    if (tagIds !== undefined) {
      tagIds = await preserveUnavailableJournalLinks(
        path,
        tagIds,
        field(current, "tag_ids"),
        "journal-tag",
      );
    }
    const hasMetadataChanges =
      args.options.has("title") ||
      args.options.has("date") ||
      collectionIds !== undefined ||
      tagIds !== undefined;
    let record: ArchiveRecord;
    if (hasMetadataChanges) {
      record = updateJournalRecords(
        current,
        {
          title: args.options.get("title") ?? field(current, "title"),
          date: args.options.get("date") ?? field(current, "entry_date"),
          notes: "",
          ...(collectionIds === undefined ? {} : { collectionIds }),
          ...(tagIds === undefined ? {} : { tagIds }),
        },
        null,
        false,
      )[0]!;
    } else {
      const fields = new Map(current.fields);
      if (args.options.has("notes")) fields.set("updated_at_us", timestampNow());
      record = { ...current, fields };
    }
    const changes = [record];
    const notes = args.options.get("notes");
    if (notes !== undefined) {
      const snapshot = await openForCommand(path);
      try {
        const notesId = field(current, "notes_document_id");
        if (notesId) {
          const noteRecord = await snapshot.getRecord(RecordType.settings, notesId);
          if (noteRecord) changes.push(updateJournalNote(noteRecord, notes));
        }
      } finally {
        await closeSnapshot(snapshot);
      }
    }
    if (!hasMetadataChanges && notes === undefined) {
      throw new CliError("Provide at least one supported journal field to update.");
    }
    const saved = await mutateArchive(path, changes);
    const savedRecord = saved.find((item) => item.id === record.id) ?? record;
    emit(
      output,
      toPlainRecord(savedRecord),
      `Updated journal entry ${field(savedRecord, "title")} (${savedRecord.id}).`,
      json,
    );
    return 0;
  }

  if (["student", "session", "journal"].includes(group) && action === "delete") {
    if (!id) throw new CliError(`${group} delete requires a record ID.`);
    const current =
      group === "journal"
        ? await getJournalEntryAtPath(path, id)
        : await getLiveRecordAtPath(path, recordType, id);
    const deleted = updateFields(current, {}, args, {
      _deleted: "true",
      deleted_at_us: timestampNow(),
      updated_at_us: timestampNow(),
    });
    const [saved] = await mutateArchive(path, [deleted]);
    emit(output, toPlainRecord(saved ?? deleted), `Moved ${group} record ${id} to Trash.`, json);
    return 0;
  }

  if (["student", "session", "journal"].includes(group) && action === "restore") {
    if (!id) throw new CliError(`${group} restore requires a record ID.`);
    const current = await getRecordAtPath(path, recordType, id);
    if (field(current, "_deleted") !== "true") throw new CliError(`Record ${id} is not in Trash.`);
    const restored = updateFields(current, {}, args, {
      _deleted: "false",
      restored_at_us: timestampNow(),
      updated_at_us: timestampNow(),
    });
    const [saved] = await mutateArchive(path, [restored]);
    emit(output, toPlainRecord(saved ?? restored), `Restored ${group} record ${id}.`, json);
    return 0;
  }

  if (group === "session" && action === "clone") {
    const sessionId = requiredPosition(args, 0, "session ID");
    const snapshot = await openForCommand(path);
    let records: ArchiveRecord[];
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      const linkedEntryId = field(current, "entry_id");
      const linkedEntry = linkedEntryId ? await getJournalEntry(snapshot, linkedEntryId) : null;
      const settings = await snapshot.listRecords(RecordType.settings);
      const hasJournalRoot = settings.some(
        (record) =>
          field(record, "record_role") === "journal" && field(record, "_deleted") !== "true",
      );
      const input: SessionCloneInput = {
        ...(args.options.has("title") ? { title: args.options.get("title")! } : {}),
        ...(args.options.has("type") ? { sessionType: args.options.get("type")! } : {}),
        ensureJournalRoot: !hasJournalRoot,
      };
      records = cloneSessionRecords(current, linkedEntry, input);
    } finally {
      await closeSnapshot(snapshot);
    }
    const saved = await mutateArchive(
      path,
      records,
      expectedGeneration,
      "The archive changed while this session copy was being prepared. Retry the clone.",
    );
    const session = saved[0] ?? records[0]!;
    emit(
      output,
      toPlainRecord(session),
      `Cloned session ${sessionId} as ${field(session, "title")} (${session.id}).`,
      json,
    );
    return 0;
  }

  if (group === "session" && (action === "archive" || action === "unarchive")) {
    const sessionId = requiredPosition(args, 0, "session ID");
    const snapshot = await openForCommand(path);
    let updated: ArchiveRecord;
    let expectedGeneration: bigint;
    try {
      expectedGeneration = snapshot.commit.generation;
      const current = await requireLiveRecord(snapshot, RecordType.session, sessionId);
      updated = setSessionArchiveState(current, action === "archive");
    } finally {
      await closeSnapshot(snapshot);
    }
    const [saved] = await mutateArchive(
      path,
      [updated],
      expectedGeneration,
      "The archive changed while this session archive state was being updated. Retry the command.",
    );
    const session = saved ?? updated;
    emit(
      output,
      toPlainRecord(session),
      action === "archive"
        ? `Archived session ${sessionId}.`
        : `Returned session ${sessionId} to current sessions.`,
      json,
    );
    return 0;
  }

  if (group === "session" && ["start", "resume", "complete", "review"].includes(action)) {
    const sessionId = requiredPosition(args, 0, "session ID");
    const transition = action as SessionTransitionAction;
    const current = await getLiveRecordAtPath(path, RecordType.session, sessionId);
    const updated = transitionSessionRecord(current, transition);
    const [session] = await mutateArchive(path, [updated]);
    const actionMessage: Record<SessionTransitionAction, string> = {
      start: "started",
      complete: "completed",
      review: "marked reviewed",
      resume: "resumed",
    };
    emit(
      output,
      toPlainRecord(session ?? updated),
      `Session ${sessionId} ${actionMessage[transition]}.`,
      json,
    );
    return 0;
  }

  return null;
}

async function updateRecord(
  path: string,
  type: number,
  id: string,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): Promise<ArchiveRecord> {
  const current = await getLiveRecordAtPath(path, type, id);
  const updated = updateFields(current, allowedOptions, args, fixedFields);
  const [saved] = await mutateArchive(path, [updated]);
  return saved ?? updated;
}

function updateFields(
  current: ArchiveRecord,
  allowedOptions: Readonly<Record<string, string>>,
  args: ParsedArguments,
  fixedFields: Readonly<Record<string, string>> = {},
): ArchiveRecord {
  const fields = new Map(current.fields);
  let changed = false;
  for (const [option, fieldName] of Object.entries(allowedOptions)) {
    const value = args.options.get(option);
    if (value === undefined) continue;
    fields.set(fieldName, validateUpdatedField(fieldName, value));
    changed = true;
  }
  for (const [fieldName, value] of Object.entries(fixedFields)) {
    fields.set(fieldName, value);
    changed = true;
  }
  if (!changed) throw new CliError("Provide at least one supported field to update.");
  if (fields.has("updated_at_us") && !Object.hasOwn(fixedFields, "updated_at_us")) {
    fields.set("updated_at_us", timestampNow());
  }
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

async function getLiveRecordAtPath(path: string, type: number, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await requireLiveRecord(snapshot, type, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function getRecordAtPath(path: string, type: number, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    const record = await snapshot.getRecord(type, id);
    if (!record) throw new CliError(`Record ${id} was not found in this archive.`);
    return record;
  } finally {
    await closeSnapshot(snapshot);
  }
}

async function requireLiveRecord(
  snapshot: ArchiveSnapshot,
  type: number,
  id: string,
): Promise<ArchiveRecord> {
  const record = await snapshot.getRecord(type, id);
  if (!record || field(record, "_deleted") === "true")
    throw new CliError(`Record ${id} was not found in this archive.`);
  return record;
}

async function getJournalEntry(snapshot: ArchiveSnapshot, id: string): Promise<ArchiveRecord> {
  const record = await requireLiveRecord(snapshot, RecordType.settings, id);
  if (field(record, "record_role") !== "journal-entry")
    throw new CliError(`Journal entry ${id} was not found in this archive.`);
  return record;
}

async function getJournalEntryAtPath(path: string, id: string): Promise<ArchiveRecord> {
  const snapshot = await openForCommand(path);
  try {
    return await getJournalEntry(snapshot, id);
  } finally {
    await closeSnapshot(snapshot);
  }
}

function updateJournalNote(current: ArchiveRecord, text: string): ArchiveRecord {
  // eslint-disable-next-line no-control-regex -- Reject control bytes in imported note content.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
    throw new CliError("Journal notes contain unsupported control characters.");
  }
  if (text.length > 100_000)
    throw new CliError("Journal notes must be 100,000 characters or fewer.");
  const fields = new Map(
    [...current.fields].filter(([key]) => !/^block\.\d+\.(id|kind|text)$/u.test(key)),
  );
  const note = text.trim();
  fields.set("block_count", note ? "1" : "0");
  if (note) {
    fields.set("block.0.id", randomUUID());
    fields.set("block.0.kind", "paragraph");
    fields.set("block.0.text", note);
  }
  fields.set("updated_at_us", timestampNow());
  return { ...current, revision: 0n, previousOffset: 0n, fields };
}

function sanitizedCopySummaryObject(
  summary: SanitizedCopySummary,
  output: string,
  status: string,
  encryptedOutput = false,
): Record<string, string | number | boolean> {
  return {
    status,
    output,
    encrypted_output: encryptedOutput,
    source_generation: summary.sourceGeneration.toString(),
    selection_fingerprint: summary.selectionFingerprint,
    students: summary.students,
    sessions: summary.sessions,
    annotations: summary.annotations,
    assets: summary.assets,
    evidence_items: summary.evidenceItems,
    guides: summary.guides,
    recording_tracks: summary.recordingTracks,
    recording_chunks: summary.recordings,
    generation_logs: summary.generationLogs,
    credentials: summary.credentials,
    warning:
      "Review included records and destination before confirming; excluded data is omitted from the new archive.",
  };
}

function formatSanitizedCopySummary(summary: SanitizedCopySummary): string {
  return [
    `  Students: ${summary.students}`,
    `  Sessions: ${summary.sessions}`,
    `  Annotations: ${summary.annotations}`,
    `  Assets: ${summary.assets}`,
    `  Evidence items: ${summary.evidenceItems}`,
    `  Guides: ${summary.guides}`,
    `  Recording tracks: ${summary.recordingTracks}`,
    `  Recording chunks: ${summary.recordings}`,
    `  Generation logs: ${summary.generationLogs}`,
    `  Credentials: ${summary.credentials}`,
  ].join("\n");
}

function timestampNow(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

function validateUpdatedField(fieldName: string, rawValue: string): string {
  const limits: Readonly<Record<string, number>> = {
    display_name: 200,
    grade: 80,
    subjects: 1_000,
    learning_objectives: 4_000,
    tutor_notes: 20_000,
    title: 240,
    subject: 200,
    student_id: 36,
    entry_date: 10,
  };
  const value = rawValue.trim();
  const maximum = limits[fieldName] ?? 100_000;
  if (value.length > maximum)
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} must be ${maximum.toLocaleString()} characters or fewer.`,
    );
  // eslint-disable-next-line no-control-regex -- Prevent control bytes from entering the archive.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new CliError(
      `${fieldName.replaceAll("_", " ")} contains unsupported control characters.`,
    );
  }
  if ((fieldName === "display_name" || fieldName === "title") && !value) {
    throw new CliError(`${fieldName.replaceAll("_", " ")} is required.`);
  }
  if (
    fieldName === "entry_date" &&
    (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
  ) {
    throw new CliError("Choose a valid journal date.");
  }
  return value;
}

function requiredPosition(args: ParsedArguments, index: number, label: string): string {
  const value = args.positionals[index]?.trim();
  if (!value) throw new CliError(`${label} is required.`);
  return value;
}

function validateEvidenceText(value: string, label: string, maximumBytes: number): string {
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    throw new CliError(`${label} must be ${maximumBytes} UTF-8 bytes or fewer.`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x7f ||
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d)
    ) {
      throw new CliError(`${label} contains unsupported control characters.`);
    }
  }
  return value;
}

async function openForCommand(path: string): Promise<ArchiveSnapshot> {
  const source = await NodeFileArchiveSource.open(resolve(path));
  let snapshot: ArchiveSnapshot | undefined;
  try {
    snapshot = await openArchiveSource(source);
    return await unlockSnapshotForCli(snapshot, true);
  } catch (error) {
    snapshot?.lock();
    await source.close();
    throw error;
  }
}

async function unlockSnapshotForCli(
  snapshot: ArchiveSnapshot,
  required: boolean,
): Promise<ArchiveSnapshot> {
  if (!snapshot.encrypted || !snapshot.locked) return snapshot;
  const passphrase = archiveAccessContext.getStore()?.passphrase;
  if (passphrase === undefined) {
    if (!required) return snapshot;
    throw new CliError("This archive is encrypted. Supply --passphrase-env <name> to unlock it.");
  }
  try {
    return await snapshot.unlock(passphrase);
  } catch (error) {
    snapshot.lock();
    throw error;
  }
}

async function closeSnapshot(snapshot: ArchiveSnapshot): Promise<void> {
  const source = snapshot.source;
  snapshot.lock();
  if (source instanceof NodeFileArchiveSource) await source.close();
}

async function mutateArchive(
  path: string,
  changes: readonly ArchiveRecord[],
  expectedGeneration?: bigint,
  generationConflictMessage = "The archive changed after this operation was reviewed. Review it again before retrying.",
): Promise<ArchiveRecord[]> {
  const archivePath = resolve(path);
  const source = await NodeFileArchiveSource.open(archivePath);
  let current: ArchiveSnapshot | undefined;
  let next: ArchiveSnapshot | undefined;
  try {
    current = await unlockSnapshotForCli(await openArchiveSource(source), true);
    if (expectedGeneration !== undefined && current.commit.generation !== expectedGeneration) {
      throw new CliError(generationConflictMessage);
    }
    next = await appendRecords(current, changes);
    await writeSourceAtomically(archivePath, next);
    const savedRecords: ArchiveRecord[] = [];
    for (const change of changes) {
      const saved = await next.getRecord(change.type, change.id);
      if (saved) savedRecords.push(saved);
    }
    return savedRecords;
  } finally {
    current?.lock();
    if (next && next !== current) next.lock();
    await source.close();
  }
}

async function writeSourceAtomically(path: string, snapshot: ArchiveSnapshot): Promise<void> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await replaceFile(temporary, path);
}

async function writeSourceToNewFileAtomically(
  path: string,
  snapshot: ArchiveSnapshot,
  validateBeforePublish?: () => Promise<void>,
  purpose = "Repair",
): Promise<void> {
  const destination = resolve(path);
  try {
    await stat(destination);
    throw new CliError(`${purpose} output already exists: ${destination}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }

  const temporary = join(dirname(destination), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  let closed = false;
  try {
    const chunkSize = 1024 * 1024;
    for (let offset = 0n; offset < snapshot.source.size;) {
      const length = Number(
        snapshot.source.size - offset > BigInt(chunkSize)
          ? BigInt(chunkSize)
          : snapshot.source.size - offset,
      );
      const bytes = await snapshot.source.read(offset, length);
      if (bytes.byteLength !== length) {
        throw new CliError("The generated archive source returned an incomplete read.");
      }
      let written = 0;
      while (written < bytes.length) {
        const result = await output.write(bytes, written, bytes.length - written);
        if (result.bytesWritten === 0) throw new Error("Archive output stopped accepting bytes.");
        written += result.bytesWritten;
      }
      offset += BigInt(length);
    }
    await output.sync();
    await output.close();
    closed = true;
  } catch (error) {
    if (!closed) await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await publishStagedFileAtomically(temporary, destination, validateBeforePublish, purpose);
}

async function publishStagedFileAtomically(
  temporary: string,
  path: string,
  validateBeforePublish?: () => Promise<void>,
  purpose = "Archive",
): Promise<void> {
  const destination = resolve(path);
  try {
    await stat(destination);
    throw new CliError(`${purpose} output already exists: ${destination}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }
  try {
    await validateBeforePublish?.();
    if (process.platform === "win32") {
      const script = [
        "$ErrorActionPreference = 'Stop'",
        "$source = [Environment]::GetEnvironmentVariable('TUTORUX_PUBLISH_TEMP')",
        "$target = [Environment]::GetEnvironmentVariable('TUTORUX_PUBLISH_DESTINATION')",
        "[System.IO.File]::Move($source, $target)",
      ].join("\n");
      const encodedCommand = Buffer.from(script, "utf16le").toString("base64");
      await new Promise<void>((resolvePromise, rejectPromise) => {
        execFile(
          "powershell.exe",
          ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
          {
            windowsHide: true,
            env: {
              ...process.env,
              TUTORUX_PUBLISH_TEMP: temporary,
              TUTORUX_PUBLISH_DESTINATION: destination,
            },
          },
          (error) => (error ? rejectPromise(error) : resolvePromise()),
        );
      });
    } else {
      await link(temporary, destination);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new CliError(`${purpose} output already exists: ${destination}`);
    }
    try {
      await stat(destination);
      throw new CliError(`${purpose} output already exists: ${destination}`);
    } catch (destinationError) {
      if (destinationError instanceof CliError) throw destinationError;
      if (!isNotFound(destinationError)) throw destinationError;
    }
    throw error;
  }
  if (process.platform !== "win32") {
    try {
      const directory = await open(dirname(destination), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown filesystem error";
      throw new CliError(
        `${purpose} exists at ${destination}, but its directory could not be durably flushed: ${detail}`,
      );
    }
  }
}

async function writeBytesAtomically(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await stat(path);
    throw new CliError(`Refusing to overwrite the existing file: ${path}`);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (!isNotFound(error)) throw error;
  }
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(bytes);
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function writeTextAtomically(path: string, text: string): Promise<void> {
  const temporary = join(dirname(path), `.tutorux-${randomUUID()}.partial`);
  const output = await open(temporary, "wx", 0o600);
  try {
    await output.writeFile(text, { encoding: "utf8" });
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await output.close();
  await replaceFile(temporary, path);
}

async function replaceFile(temporary: string, target: string): Promise<void> {
  const backup = `${target}.${randomUUID()}.backup`;
  let hadTarget = false;
  try {
    await stat(target);
    hadTarget = true;
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
  try {
    if (hadTarget) await rename(target, backup);
    await rename(temporary, target);
    if (hadTarget) await rm(backup, { force: true });
  } catch (error) {
    if (hadTarget) await rename(backup, target).catch(() => undefined);
    await rm(temporary, { force: true });
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function requiredOption(args: ParsedArguments, name: string): string {
  const value = args.options.get(name)?.trim();
  if (!value) throw new CliError(`--${name} is required.`);
  return value;
}

function field(record: ArchiveRecord, name: string, fallback = ""): string {
  return record.fields.get(name) ?? fallback;
}

function studentProfileObject(record: ArchiveRecord): Record<string, unknown> {
  const fields = Object.fromEntries(record.fields);
  delete fields["progress_classifications"];
  return {
    id: record.id.toLowerCase(),
    type: "student",
    revision: record.revision.toString(),
    ...fields,
  };
}

function readableStudentRecord(record: ArchiveRecord): string {
  return [
    `student ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .filter(([key]) => key !== "progress_classifications")
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

function readableSessionRecord(record: ArchiveRecord): string {
  return [
    `session ${record.id} (revision ${record.revision})`,
    ...[...record.fields]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `  ${key}: ${value}`),
  ].join("\n");
}

function parseIntegerField(value: string): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

function parseSessionDateBound(
  value: string | undefined,
  inclusiveEnd: boolean,
): bigint | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year === 0 || month < 1 || month > 12 || day < 1 || day > monthLengths[month - 1]!) {
    throw new CliError("Use a valid calendar date in YYYY-MM-DD format.");
  }
  const start = new Date(0);
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCFullYear(year, month - 1, day);
  if (!inclusiveEnd) return BigInt(start.getTime()) * 1000n;
  start.setUTCDate(start.getUTCDate() + 1);
  return BigInt(start.getTime()) * 1000n - 1n;
}

function sessionStartedAt(record: ArchiveRecord): bigint {
  const startedAt = field(record, "started_at_us");
  if (/^-?\d+$/u.test(startedAt)) return BigInt(startedAt);
  return parseIntegerField(field(record, "created_at_us"));
}

function parseBoundedOption(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined && fallback >= minimum) return fallback;
  if (!raw || !/^\d+$/u.test(raw)) {
    throw new CliError(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CliError(`--${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function toPlainRecord(record: ArchiveRecord): Record<string, unknown> {
  return {
    type: record.type,
    id: record.id,
    revision: record.revision.toString(),
    fields: Object.fromEntries(record.fields),
  };
}

function toFlatTranscriptRecord(record: ArchiveRecord): Record<string, string> {
  return {
    id: record.id,
    type: "transcript",
    revision: record.revision.toString(),
    ...Object.fromEntries(record.fields),
  };
}

function transcriptTimeRange(record: ArchiveRecord): string {
  if (field(record, "timestamp_state") === "not-timestamped") return "time not provided";
  const parse = (name: string): bigint => {
    const raw = field(record, name);
    return /^-?\d+$/u.test(raw) ? BigInt(raw) : 0n;
  };
  const start = parse("start_time_us");
  const end = parse("end_time_us");
  const format = (value: bigint): string => {
    const seconds = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
    const hours = seconds / 3600n;
    const minutes = (seconds / 60n) % 60n;
    const remainder = seconds % 60n;
    return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}${fraction ? `.${fraction}` : ""}`;
  };
  return `${format(start)}${end > start ? `–${format(end)}` : ""}`;
}

function emit(output: CliIo, data: unknown, summary: string, json: boolean): void {
  output.stdout(json ? JSON.stringify(data, null, 2) : summary);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await executeCli(process.argv.slice(2));
}

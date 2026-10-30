import { randomUUID } from "node:crypto";
import { open, realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { openArchiveSource, type ArchiveSnapshot } from "../../frontend/archive/archive";
import {
    createSanitizedCopy,
    previewSanitizedCopy,
    type SanitizedCopyCheckpoint,
    type SanitizedCopyOptions,
    type SanitizedCopyOutputOptions,
} from "../../frontend/archive/sanitized-copy";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import { publishStagedFileAtomically, unlockSnapshotForCli } from "./archive-io";
import { CliError, emit, isNotFound, requiredOption } from "./shared";
import { formatSanitizedCopySummary, sanitizedCopySummaryObject } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runArchiveSanitizeCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
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
            newPassphraseEnvironment === undefined
                ? undefined
                : process.env[newPassphraseEnvironment];
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
                        throw new CliError(
                            "The generated archive source returned an incomplete read.",
                        );
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
            sanitizedCopySummaryObject(
                preview,
                canonicalDestinationPath,
                "created",
                encryptedOutput,
            ),
            `Sanitized ${encryptedOutput ? "encrypted " : ""}archive created at ${canonicalDestinationPath}.`,
            args.flags.has("json"),
        );
        return 0;
    } finally {
        snapshot?.lock();
        await source.close();
    }
}

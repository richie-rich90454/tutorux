import { randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import { realpath, rm, stat } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
    createArchiveBytes,
    createEncryptedArchiveBytes,
    openArchiveSource,
    verifyArchiveHistory,
    verifyArchiveSnapshot,
    type ArchiveSnapshot,
} from "../../frontend/archive/archive";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";
import {
    publishStagedFileAtomically,
    replaceFile,
    stageBytesForPublication,
    unlockSnapshotForCli,
    writeSourceAtomically,
    writeSourceToNewFileAtomically,
} from "./archive-io";
import { CliError, archiveAccessContext, emit, requiredOption } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";

export async function runArchiveInitCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const name = args.options.get("name")?.trim() || basename(path, extname(path));
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
    const archivePath = resolve(path);
    const temporary = await stageBytesForPublication(archivePath, bytes);
    await publishStagedFileAtomically(temporary, archivePath, undefined, "Archive");
    emit(
        output,
        { path: resolve(path), name, bytes: bytes.byteLength, created: true },
        `${basename(path)} created (${bytes.byteLength} bytes).`,
        args.flags.has("json"),
    );
    return 0;
}

export async function runArchiveEncryptCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const newPassphraseEnvironment =
        args.options.get("new-passphrase-env") ?? args.options.get("passphrase-env");
    let newPassphrase: string | undefined;
    if (newPassphraseEnvironment === undefined) {
        newPassphrase = archiveAccessContext.getStore()?.passphrase;
        if (newPassphrase === undefined) {
            throw new CliError(
                "archive encrypt requires --new-passphrase-env <name> or --passphrase-env <name>.",
            );
        }
    } else {
        if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(newPassphraseEnvironment)) {
            throw new CliError("--new-passphrase-env requires a valid environment variable name.");
        }
        newPassphrase = process.env[newPassphraseEnvironment];
        if (newPassphrase === undefined) {
            throw new CliError("The new archive passphrase environment variable is not set.");
        }
    }

    const archivePath = resolve(path);
    const openedInfo = await stat(archivePath);
    const source = await NodeFileArchiveSource.open(archivePath);
    const stagePath = join(dirname(archivePath), `.tutorux-${randomUUID()}.encrypt.partial`);
    let sourceClosed = false;
    let current: ArchiveSnapshot | undefined;
    let next: ArchiveSnapshot | undefined;
    let stagedSource: NodeFileArchiveSource | undefined;
    let staged: ArchiveSnapshot | undefined;
    let verified: ArchiveSnapshot | undefined;
    let archiveId = "";
    let sourceGeneration = 0n;
    let resultingGeneration: bigint;
    const sameSourceIdentity = (info: Stats): boolean =>
        info.size === openedInfo.size &&
        info.mtimeMs === openedInfo.mtimeMs &&
        info.ctimeMs === openedInfo.ctimeMs &&
        info.dev === openedInfo.dev &&
        info.ino === openedInfo.ino;
    const ensureSourceUnchanged = async (): Promise<void> => {
        const beforeOpen = await stat(archivePath);
        if (!sameSourceIdentity(beforeOpen)) {
            throw new CliError("The archive changed during encryption. Retry the command.");
        }
        const checkSource = await NodeFileArchiveSource.open(archivePath);
        let checkSnapshot: ArchiveSnapshot | undefined;
        try {
            if (BigInt(beforeOpen.size) !== checkSource.size) {
                throw new CliError("The archive changed during encryption. Retry the command.");
            }
            checkSnapshot = await openArchiveSource(checkSource);
            if (
                checkSnapshot.header.id.toLowerCase() !== archiveId.toLowerCase() ||
                checkSnapshot.commit.generation !== sourceGeneration ||
                checkSnapshot.encrypted ||
                checkSnapshot.source.size !== checkSnapshot.publishedEndOffset
            ) {
                throw new CliError("The archive changed during encryption. Retry the command.");
            }
            await verifyArchiveHistory(checkSnapshot);
        } finally {
            checkSnapshot?.lock();
            await checkSource.close();
        }
        const afterOpen = await stat(archivePath);
        if (!sameSourceIdentity(afterOpen)) {
            throw new CliError("The archive changed during encryption. Retry the command.");
        }
    };
    try {
        if (BigInt(openedInfo.size) !== source.size) {
            throw new CliError(
                "The archive changed while encryption was starting. Retry the command.",
            );
        }
        current = await openArchiveSource(source);
        if (current.encrypted) {
            throw new CliError("Only unencrypted archives can be encrypted with this command.");
        }
        if (current.source.size !== current.publishedEndOffset) {
            throw new CliError(
                "The archive has unpublished trailing data. Recover or discard it before encryption.",
            );
        }
        archiveId = current.header.id;
        sourceGeneration = current.commit.generation;
        const sourceHistory = await verifyArchiveHistory(current);
        next = await current.enableEncryption(newPassphrase);
        if (
            next.header.id.toLowerCase() !== archiveId.toLowerCase() ||
            next.source.size !== next.publishedEndOffset
        ) {
            throw new CliError(
                "Encrypted archive staging did not preserve the source archive identity.",
            );
        }
        await writeSourceAtomically(stagePath, next);

        stagedSource = await NodeFileArchiveSource.open(stagePath);
        const stagedInfo = await stat(stagePath);
        if (BigInt(stagedInfo.size) !== stagedSource.size) {
            throw new CliError("The staged encrypted archive changed before verification.");
        }
        staged = await openArchiveSource(stagedSource);
        if (
            !staged.encrypted ||
            staged.header.id.toLowerCase() !== archiveId.toLowerCase() ||
            staged.source.size !== staged.publishedEndOffset
        ) {
            throw new CliError(
                "The staged archive did not retain its identity and encryption state.",
            );
        }
        verified = await staged.unlock(newPassphrase);
        resultingGeneration = verified.commit.generation;
        const stagedHistory = await verifyArchiveHistory(verified);
        if (
            stagedHistory.currentRecords !== sourceHistory.currentRecords + 1 ||
            stagedHistory.historicalRevisions !== sourceHistory.historicalRevisions
        ) {
            throw new CliError(
                "The staged encrypted archive did not preserve every record revision.",
            );
        }

        verified.lock();
        verified = undefined;
        staged.lock();
        staged = undefined;
        await stagedSource.close();
        stagedSource = undefined;
        current.lock();
        current = undefined;
        next.lock();
        next = undefined;
        await ensureSourceUnchanged();
        await source.upgradeLock();
        if (!(await source.stillMatchesPath())) {
            throw new CliError("The archive changed during encryption. Retry the command.");
        }
        await source.closeReadHandle();
        await source.prepareLockReplacement(stagePath);
        await replaceFile(stagePath, archivePath);
        await source.adoptLockReplacement();
        await source.close();
        sourceClosed = true;

        const result = {
            path: archivePath,
            archive_id: archiveId,
            previous_generation: sourceGeneration.toString(),
            generation: resultingGeneration.toString(),
            encrypted: true,
            verified: true,
            preserved_historical_revisions: sourceHistory.historicalRevisions,
        };
        emit(
            output,
            result,
            `Encrypted and verified ${basename(path)} while preserving ${sourceHistory.historicalRevisions} historical record revisions.`,
            args.flags.has("json"),
        );
        return 0;
    } finally {
        verified?.lock();
        staged?.lock();
        current?.lock();
        if (next && next !== current) next.lock();
        if (stagedSource) await stagedSource.close().catch(() => undefined);
        if (!sourceClosed) await source.close().catch(() => undefined);
        await rm(stagePath, { force: true }).catch(() => undefined);
    }
}

export async function runArchiveChangePassphraseCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
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
            throw new CliError(
                "Supply the current archive passphrase with --passphrase-env <name>.",
            );
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
            throw new CliError(
                "The archive changed during passphrase rotation. Retry the command.",
            );
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

export async function runArchiveBackupCommand(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    if (!args.flags.has("confirm-sensitive")) {
        throw new CliError(
            "A full archive copy may contain student histories, recordings, private annotations, and credentials. Review the destination and retry with --confirm-sensitive.",
        );
    }

    const archivePath = resolve(path);
    const requestedDestinationPath = resolve(requiredOption(args, "output"));
    const [sourceCanonicalPath, destinationParentPath] = await Promise.all([
        realpath(archivePath),
        realpath(dirname(requestedDestinationPath)),
    ]);
    const destinationPath = resolve(destinationParentPath, basename(requestedDestinationPath));
    const samePath =
        process.platform === "win32"
            ? sourceCanonicalPath.toLowerCase() === destinationPath.toLowerCase()
            : sourceCanonicalPath === destinationPath;
    if (samePath) throw new CliError("Backup destination must differ from the archive.");
    if (!(await stat(destinationParentPath)).isDirectory()) {
        throw new CliError("Backup destination directory is unavailable.");
    }

    const openedInfo = await stat(sourceCanonicalPath);
    const source = await NodeFileArchiveSource.open(sourceCanonicalPath);
    let snapshot: ArchiveSnapshot | undefined;
    try {
        if (BigInt(openedInfo.size) !== source.size) {
            throw new CliError("The archive changed while backup was starting. Retry the command.");
        }
        snapshot = await openArchiveSource(source);
        const validateBeforePublish = async (): Promise<void> => {
            const currentInfo = await stat(sourceCanonicalPath);
            if (
                currentInfo.size !== openedInfo.size ||
                currentInfo.mtimeMs !== openedInfo.mtimeMs ||
                currentInfo.ctimeMs !== openedInfo.ctimeMs ||
                currentInfo.dev !== openedInfo.dev ||
                currentInfo.ino !== openedInfo.ino
            ) {
                throw new CliError("The archive changed during backup. Retry the command.");
            }
        };
        await writeSourceToNewFileAtomically(
            destinationPath,
            snapshot,
            validateBeforePublish,
            "Backup",
        );
        emit(
            output,
            {
                path: sourceCanonicalPath,
                output: destinationPath,
                bytes: snapshot.source.size.toString(),
                status: "created",
                encrypted: snapshot.encrypted,
                original_preserved: true,
            },
            `Backup created at ${destinationPath}; the original archive was preserved.`,
            args.flags.has("json"),
        );
        return 0;
    } finally {
        snapshot?.lock();
        await source.close();
    }
}

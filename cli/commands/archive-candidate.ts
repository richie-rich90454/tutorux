import { lstat, open } from "node:fs/promises";
import { resolve } from "node:path";
import {
    ArchiveFormatError,
    inspectArchiveVersion,
    RecordType,
} from "../../frontend/archive/format";
import { openArchiveSource, type ArchiveSnapshot } from "../../frontend/archive/archive";
import { NodeFileArchiveSource } from "../../frontend/archive/node-source";

export async function inspectCliArchiveCandidate(
    archivePath: string,
    displayFilename: string,
): Promise<Record<string, unknown> | null> {
    const candidatePath = resolve(archivePath);
    let fallbackSize: string;
    try {
        const fileInfo = await lstat(candidatePath, { bigint: true });
        if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) return null;
        fallbackSize = fileInfo.size.toString();
    } catch {
        return null;
    }

    const writable = await canOpenArchiveWritable(candidatePath);
    let source: NodeFileArchiveSource | undefined;
    let snapshot: ArchiveSnapshot | undefined;
    try {
        source = await NodeFileArchiveSource.open(candidatePath);
        try {
            snapshot = await openArchiveSource(source);
        } catch (error) {
            let health = archiveCandidateHealth(error);
            if (
                error instanceof ArchiveFormatError &&
                (error.code === "archive_version_unsupported" ||
                    error.code === "archive_capability_unsupported")
            ) {
                try {
                    const version = inspectArchiveVersion(
                        await source.read(0n, Number(source.size < 64n ? source.size : 64n)),
                    );
                    return {
                        path: candidatePath,
                        name: displayFilename.slice(0, -4),
                        size_bytes: source.size.toString(),
                        format_major: String(version.major),
                        format_minor: String(version.minor),
                        health:
                            error.code === "archive_capability_unsupported"
                                ? "unsupported-capability"
                                : "unsupported-version",
                        writable,
                        metadata_only: true,
                    };
                } catch (headerError) {
                    health = archiveCandidateHealth(headerError);
                }
            }
            return {
                path: candidatePath,
                name: displayFilename.slice(0, -4),
                size_bytes: source.size.toString(),
                format_major: "0",
                format_minor: "0",
                health,
                writable,
            };
        }

        const manifest = await snapshot
            .getRecord(RecordType.settings, snapshot.header.id)
            .catch(() => null);
        const fileSize = source.size;
        const locked = snapshot.locked;
        const health = locked
            ? "locked"
            : fileSize > snapshot.publishedEndOffset
              ? "recovery-required"
              : "healthy";
        return {
            path: candidatePath,
            name: manifest?.fields.get("display_name") ?? displayFilename.slice(0, -4),
            description: manifest?.fields.get("description") ?? "",
            id: snapshot.header.id,
            generation: snapshot.commit.generation.toString(),
            size_bytes: fileSize.toString(),
            student_count: parseArchiveCounter(manifest?.fields.get("student_count")),
            session_count: parseArchiveCounter(manifest?.fields.get("session_count")),
            created_at_us: snapshot.header.createdAtUs.toString(),
            format_major: String(snapshot.header.majorVersion),
            format_minor: String(snapshot.header.minorVersion),
            writable,
            health,
        };
    } catch (error) {
        return {
            path: candidatePath,
            name: displayFilename.slice(0, -4),
            size_bytes: fallbackSize,
            format_major: "0",
            format_minor: "0",
            health: archiveCandidateHealth(error),
            writable,
        };
    } finally {
        snapshot?.lock();
        await source?.close().catch(() => undefined);
    }
}

export function archiveCandidateHealth(error: unknown): string {
    if (error instanceof ArchiveFormatError) return error.code;
    if (error && typeof error === "object" && "code" in error) {
        const code = error.code;
        if (typeof code === "string" && code) return code;
    }
    return "archive_open_failed";
}

export function parseArchiveCounter(value: string | undefined): string {
    if (value === undefined || !/^\d+$/u.test(value)) return "0";
    const normalized = value.replace(/^0+(?=\d)/u, "");
    if (normalized.length > 20) return "0";
    const parsed = BigInt(normalized);
    return parsed <= 0xffff_ffff_ffff_ffffn ? parsed.toString() : "0";
}

export async function canOpenArchiveWritable(path: string): Promise<boolean> {
    try {
        const handle = await open(path, "r+");
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { verifyArchiveSnapshot } from "../../frontend/archive/archive";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { inspectCliArchiveCandidate } from "./archive-candidate";
import { CliError, emit, requiredOption } from "./shared";
import type { CliIo, ParsedArguments } from "./shared";
import {
  runArchiveBackupCommand,
  runArchiveChangePassphraseCommand,
  runArchiveEncryptCommand,
  runArchiveInitCommand,
} from "./archive-crypto";
import {
  runArchiveBackfillIndexesCommand,
  runArchiveCompactCommand,
  runArchiveRebuildIndexCommand,
  runArchiveRecoverCommand,
  runArchiveRepairCommand,
} from "./archive-recovery";
import { runArchiveSanitizeCommand } from "./archive-sanitize";
import { runArchiveInfoCommand } from "./archive-info";

export async function runArchiveDiscoveryCommand(
  args: ParsedArguments,
  output: CliIo,
): Promise<number> {
  if (args.flags.has("directory")) {
    throw new CliError("--directory requires a path.");
  }
  if (args.positionals.length) {
    throw new CliError("archive discover does not accept an archive path; use --directory.");
  }
  const directory = resolve(args.options.get("directory") ?? process.cwd());
  const directoryInfo = await stat(directory).catch(() => null);
  if (!directoryInfo?.isDirectory()) {
    throw new CliError("Archive discovery path is not a directory.");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.name.toLowerCase().endsWith(".tux"))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const archives: Record<string, unknown>[] = [];
  for (const entry of candidates) {
    const archive = await inspectCliArchiveCandidate(join(directory, entry.name), entry.name);
    if (archive) archives.push(archive);
  }
  const summary = archives.length
    ? archives.map(archiveDiscoveryText).join("\n")
    : "No valid .tux archives found in this directory.";
  emit(output, archives, summary, args.flags.has("json"));
  return 0;
}

export function archiveDiscoveryText(archive: Record<string, unknown>): string {
  const name = basename(String(archive["path"] ?? archive["name"] ?? "Archive"));
  const format = `${String(archive["format_major"] ?? "0")}.${String(archive["format_minor"] ?? "0")}`;
  const size = String(archive["size_bytes"] ?? "0");
  const access = archive["writable"] === true ? "Read/Write" : "Read-only";
  const health = String(archive["health"] ?? "unknown");
  const lines = [name, `  Format: ${format}`, `  Size: ${size} bytes`, `  Access: ${access}`];
  if (archive["metadata_only"] === true) {
    lines.push(`  Health: ${health} (header metadata only)`);
    lines.push("  This application cannot safely read records in this archive.");
    return lines.join("\n");
  }
  lines.push(`  Name: ${String(archive["name"] ?? name)}`);
  if (typeof archive["id"] === "string") lines.push(`  ID: ${archive["id"]}`);
  if (typeof archive["generation"] === "string")
    lines.push(`  Generation: ${archive["generation"]}`);
  if (typeof archive["student_count"] === "string")
    lines.push(`  Students: ${archive["student_count"]}`);
  if (typeof archive["session_count"] === "string")
    lines.push(`  Sessions: ${archive["session_count"]}`);
  if (health !== "healthy") lines.push(`  Health: ${health}`);
  if (typeof archive["description"] === "string" && archive["description"])
    lines.push(`  Description: ${archive["description"]}`);
  return lines.join("\n");
}

export async function runArchiveCommand(
  action: string,
  args: ParsedArguments,
  output: CliIo,
  selectedArchivePath?: string,
): Promise<number> {
  if (action === "discover" || action === "list") {
    return runArchiveDiscoveryCommand(args, output);
  }
  const path = args.positionals[0] ?? (action === "unlock" ? selectedArchivePath : undefined);
  if (!path) throw new CliError(`archive ${action} requires a file path.`);
  if (action === "unlock") {
    const snapshot = await openForCommand(path);
    try {
      await verifyArchiveSnapshot(snapshot);
      const result = {
        path: resolve(path),
        encrypted: snapshot.encrypted,
        generation: snapshot.commit.generation.toString(),
        status: snapshot.encrypted ? "unlocked" : "not-encrypted",
        verified: true,
      };
      emit(
        output,
        result,
        snapshot.encrypted
          ? `Archive unlocked and verified at generation ${result.generation}.`
          : `Archive is not encrypted; generation ${result.generation} was verified.`,
        args.flags.has("json"),
      );
      return 0;
    } finally {
      await closeSnapshot(snapshot);
    }
  }
  if (action === "init") {
    return runArchiveInitCommand(path, args, output);
  }
  if (action === "rename") {
    const name = requiredOption(args, "name");
    const snapshot = await openForCommand(path);
    let changedManifest: ArchiveRecord;
    const generation = snapshot.commit.generation;
    try {
      const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
      if (!manifest) throw new CliError("Archive manifest is missing.");
      const fields = new Map(manifest.fields);
      fields.set("display_name", name);
      changedManifest = { ...manifest, fields };
    } finally {
      await closeSnapshot(snapshot);
    }
    await mutateArchive(
      path,
      [changedManifest],
      generation,
      "The archive changed while its name update was being prepared. Retry the command.",
    );
    emit(
      output,
      { name, status: "updated" },
      "Archive display name updated.",
      args.flags.has("json"),
    );
    return 0;
  }
  if (action === "encrypt") {
    return runArchiveEncryptCommand(path, args, output);
  }
  if (action === "change-passphrase") {
    return runArchiveChangePassphraseCommand(path, args, output);
  }
  if (action === "backup" || action === "copy") {
    return runArchiveBackupCommand(path, args, output);
  }
  if (action === "recover") {
    return runArchiveRecoverCommand(path, args, output);
  }
  if (action === "backfill-indexes") {
    return runArchiveBackfillIndexesCommand(path, args, output);
  }
  if (action === "compact") {
    return runArchiveCompactCommand(path, args, output);
  }
  if (action === "rebuild-index") {
    return runArchiveRebuildIndexCommand(path, args, output);
  }
  if (action === "repair") {
    return runArchiveRepairCommand(path, args, output);
  }
  if (action === "sanitize") {
    return runArchiveSanitizeCommand(path, args, output);
  }
  if (action !== "info" && action !== "verify") {
    throw new CliError(`archive ${action} is not implemented in the TypeScript CLI yet.`);
  }
  return runArchiveInfoCommand(action, path, args, output);
}

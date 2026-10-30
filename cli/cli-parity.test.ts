import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "./main";
import {
  appendRecords,
  createArchiveBytes,
  openArchiveBytes,
  verifyArchiveSnapshot,
} from "../frontend/archive/archive";
import { crc32, newUuid, RecordType, type ArchiveRecord } from "../frontend/archive/format";

function cliRecord(
  type: ArchiveRecord["type"],
  id: string,
  fields: readonly (readonly [string, string])[],
  blob = new Uint8Array(),
): ArchiveRecord {
  return {
    type,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(fields),
    blob,
  };
}

async function writeAudioArchive(path: string, sessionId: string, trackId: string, chunkId: string) {
  const pcm = new Uint8Array([0x34, 0x12, 0xcc, 0xed]);
  const base = await openArchiveBytes(await createArchiveBytes("Parity audio"));
  const archive = await appendRecords(base, [
    cliRecord(RecordType.session, sessionId, [
      ["title", "Audio parity"],
      ["recording_track_ids", trackId],
      ["recording_track_id", trackId],
      ["recording_track_count", "1"],
    ]),
    cliRecord(RecordType.assetMetadata, trackId, [
      ["record_role", "audio-track"],
      ["session_id", sessionId],
      ["track_id", trackId],
      ["state", "completed"],
    ]),
    cliRecord(
      RecordType.audioChunk,
      chunkId,
      [
        ["session_id", sessionId],
        ["track_id", trackId],
        ["sequence_number", "0"],
        ["first_sample_index", "0"],
        ["sample_count", "2"],
        ["sample_rate_hz", "8000"],
        ["channel_count", "1"],
        ["sample_format", "pcm_s16le"],
        ["codec", "none"],
        ["payload_checksum", String(crc32(pcm))],
      ],
      pcm,
    ),
  ]);
  await verifyArchiveSnapshot(archive);
  await writeFile(path, await archive.source.read(0n, Number(archive.source.size)));
}

describe("CLI legacy parity", () => {
  it("uses flat record JSON, default journal fields, and document block preservation", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-parity-journal-"));
    const archivePath = join(directory, "journal.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const run = async (args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await executeCli(["--json", "--archive", archivePath, ...args], io);
      return { code, value: stdout.length ? JSON.parse(stdout.at(-1)!) : undefined, stderr };
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Parity"], io),
      ).toBe(0);
      const created = await run(["journal", "create"]);
      expect(created.code).toBe(0);
      const entry = created.value as Record<string, string>;
      expect(entry["type"]).toBe("settings");
      expect(entry["record_role"]).toBe("journal-entry");
      expect(entry["title"]).toBe("Untitled entry");
      expect(entry["entry_date"]).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
      expect(entry["revision"]).toBe("1");

      const notesId = entry["notes_document_id"]!;
      expect(
        (await run(["journal", "document", "update", notesId, "--text", "Alpha\n\nBeta"])).code,
      ).toBe(0);
      const first = await run(["journal", "document", "show", notesId]);
      expect(first.code).toBe(0);
      expect(typeof first.value["blocks_json"]).toBe("string");
      expect(typeof first.value["created_at_us"]).toBe("string");
      expect(typeof first.value["updated_at_us"]).toBe("string");
      const firstBlocks = JSON.parse(first.value["blocks_json"] as string) as Array<{
        id: string;
        text: string;
      }>;
      expect(firstBlocks.map((block) => block.text)).toEqual(["Alpha", "Beta"]);

      expect(
        (await run(["journal", "document", "update", notesId, "--text", "Alpha\n\nGamma"])).code,
      ).toBe(0);
      const second = await run(["journal", "document", "show", notesId]);
      const secondBlocks = second.value["blocks"] as Array<{ id: string; text: string }>;
      expect(secondBlocks[0]!.id).toBe(firstBlocks[0]!.id);
      expect(secondBlocks[1]!.id).toBe(firstBlocks[1]!.id);
      expect(secondBlocks.map((block) => block.text)).toEqual(["Alpha", "Gamma"]);

      const shown = await run(["journal", "show", entry["id"]!]);
      expect(shown.code).toBe(0);
      expect(shown.value["notes_text"]).toBe("Alpha\nGamma");
      expect(shown.value["session_count"]).toBe("0");
      expect(shown.value["session_ids"]).toBe("");
      expect(shown.value["id"]).toBe(entry["id"]);

      const cleared = await run(["journal", "update", entry["id"]!, "--clear-date"]);
      expect(cleared.code).toBe(0);
      expect(cleared.value["entry_date"]).toBe("");
      const conflict = await run([
        "journal",
        "update",
        entry["id"]!,
        "--date",
        "2026-10-26",
        "--clear-date",
      ]);
      expect(conflict.code).toBe(2);
      expect(stderr.at(-1)).toContain("--date or --clear-date");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("trashes and restores the journal entry and its notes as one group", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-parity-trash-"));
    const archivePath = join(directory, "journal.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const run = async (args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await executeCli(["--json", "--archive", archivePath, ...args], io);
      return { code, value: stdout.length ? JSON.parse(stdout.at(-1)!) : undefined };
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Trash"], io),
      ).toBe(0);
      const created = await run(["journal", "create", "--title", "Trash me"]);
      const entry = created.value as Record<string, string>;
      const notesId = entry["notes_document_id"]!;
      expect((await run(["journal", "update", entry["id"]!, "--notes", "Hello notes"])).code).toBe(0);

      const deleted = await run(["journal", "delete", entry["id"]!]);
      expect(deleted.code).toBe(0);
      expect(deleted.value["_deleted"]).toBe("true");
      const trashed = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      const trashedNotes = await trashed.getRecord(RecordType.settings, notesId);
      expect(trashedNotes?.fields.get("_deleted")).toBe("true");
      expect(trashedNotes?.fields.get("_trash_group_id")).toBe(entry["id"]);

      const restored = await run(["journal", "restore", entry["id"]!]);
      expect(restored.code).toBe(0);
      expect(restored.value["_deleted"]).toBeUndefined();
      const live = await openArchiveBytes(new Uint8Array(await readFile(archivePath)));
      const liveNotes = await live.getRecord(RecordType.settings, notesId);
      expect(liveNotes?.fields.get("_deleted")).toBeUndefined();

      const linked = await run(["journal", "create", "--title", "Linked"]);
      expect(linked.code).toBe(0);
      const linkedEntry = linked.value as Record<string, string>;
      expect(
        (
          await run([
            "session",
            "create",
            "--title",
            "Linked session",
            "--entry-id",
            linkedEntry["id"]!,
          ])
        ).code,
      ).toBe(0);
      const blocked = await run(["journal", "delete", linkedEntry["id"]!]);
      expect(blocked.code).toBe(2);
      expect(stderr.at(-1)).toContain("linked session");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports benchmark index scalars and audio export metadata as legacy strings", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-parity-audio-"));
    const archivePath = join(directory, "audio.tux");
    const sessionId = newUuid();
    const trackId = newUuid();
    await writeAudioArchive(archivePath, sessionId, trackId, newUuid());
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const run = async (args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await executeCli(["--json", "--archive", archivePath, ...args], io);
      return { code, value: stdout.length ? JSON.parse(stdout.at(-1)!) : undefined };
    };

    try {
      const benchmark = await run(["benchmark", "indexing"]);
      expect(benchmark.code).toBe(0);
      expect(typeof benchmark.value["index_records"]).toBe("string");
      expect(typeof benchmark.value["index_elapsed_us"]).toBe("string");
      expect(typeof benchmark.value["archive_generation"]).toBe("string");

      const waveform = await run(["record", "waveform", "--session", sessionId, "--buckets", "2"]);
      expect(waveform.code).toBe(0);
      expect(waveform.value).toHaveLength(2);
      expect(waveform.value[0]).toMatchObject({
        track_id: trackId,
        sample_rate_hz: "8000",
        channel_count: "1",
        bucket: "0",
        start_frame: "0",
        end_frame: "1",
      });

      const destination = join(directory, "export.wav");
      const exported = await run([
        "record",
        "export-wav",
        "--session",
        sessionId,
        "--output",
        destination,
      ]);
      expect(exported.code).toBe(0);
      expect(exported.value).toMatchObject({
        sample_rate_hz: "8000",
        channel_count: "1",
        sample_count: "2",
        chunk_count: "1",
        duration_us: "250",
        data_bytes: "4",
        container: "RIFF/WAVE",
      });

      const generate = await run(["transcript", "generate", "--session", sessionId]);
      expect(generate.code).toBe(2);
      expect(stderr.at(-1)).toContain("Whisper model");
      expect(stderr.at(-1)).not.toContain("consent");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("overwrites an existing asset export destination atomically", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-cli-parity-asset-"));
    const archivePath = join(directory, "asset.tux");
    const sourcePath = join(directory, "material.txt");
    const destination = join(directory, "material-out.txt");
    await writeFile(sourcePath, "material payload");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };
    const run = async (args: string[]) => {
      stdout.length = 0;
      stderr.length = 0;
      const code = await executeCli(["--json", "--archive", archivePath, ...args], io);
      return { code, value: stdout.length ? JSON.parse(stdout.at(-1)!) : undefined };
    };

    try {
      expect(
        await executeCli(["archive", "init", archivePath, "--name", "Assets"], io),
      ).toBe(0);
      const imported = await run(["asset", "add", sourcePath]);
      expect(imported.code).toBe(0);
      const assetId = imported.value[0].id as string;

      expect((await run(["asset", "export", assetId, "--output", destination])).code).toBe(0);
      expect(await readFile(destination, "utf8")).toBe("material payload");
      await writeFile(destination, "stale bytes");
      expect((await run(["asset", "extract", assetId, "--output", destination])).code).toBe(0);
      expect(await readFile(destination, "utf8")).toBe("material payload");
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

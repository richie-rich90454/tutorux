import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeCli } from "../main";
import { appendRecords, createArchiveBytes, openArchiveBytes } from "../../frontend/archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "../../frontend/archive/format";

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function u64(value: number | bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

function ggufString(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([u64(bytes.length), bytes]);
}

function ggufStringEntry(key: string, value: string): Buffer {
  return Buffer.concat([ggufString(key), u32(8), ggufString(value)]);
}

function ggufUintEntry(key: string, value: number): Buffer {
  return Buffer.concat([ggufString(key), u32(4), u32(value)]);
}

function legacyRecord(id: string, fields: Record<string, string>): ArchiveRecord {
  return {
    type: RecordType.settings,
    id,
    revision: 0n,
    previousOffset: 0n,
    fields: new Map(Object.entries(fields)),
    blob: new Uint8Array(),
  };
}

function minimalGguf(): Buffer {
  const entries = [
    ggufStringEntry("general.architecture", "llama"),
    ggufStringEntry("general.name", "CLI Fixture Model"),
    ggufStringEntry("general.description", "A tiny metadata fixture."),
    ggufUintEntry("llama.context_length", 8192),
    ggufUintEntry("llama.embedding_length", 4096),
    ggufUintEntry("llama.block_count", 32),
  ];
  return Buffer.concat([
    Buffer.from("GGUF", "ascii"),
    u32(3),
    u64(1),
    u64(entries.length),
    ...entries,
  ]);
}

describe("AI CLI parity", () => {
  it("returns the legacy provider schema with the catalog as an additive field", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    expect(await executeCli(["--json", "ai", "providers"], io)).toBe(0);
    const rows = JSON.parse(stdout.at(-1)!) as {
      provider_id: string;
      provider: string;
      status: string;
      catalog: { id: string; protocol: string };
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toMatchObject({
      provider_id: expect.any(String),
      provider: expect.any(String),
      status: expect.any(String),
    });
    const ollama = rows.find((row) => row.provider_id === "ollama");
    expect(ollama).toMatchObject({
      provider: "Ollama (local)",
      status: "native-ollama-api",
      catalog: { id: "ollama", protocol: "Ollama Chat" },
    });
    expect(stderr).toEqual([]);
  });

  it("lists the built-in template catalog without an archive", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    expect(await executeCli(["--json", "template", "list"], io)).toBe(0);
    const rows = JSON.parse(stdout.at(-1)!) as { id: string; origin: string }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.origin === "built-in")).toBe(true);
    expect(rows.some((row) => row.id === "general")).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("returns cached legacy catalog metadata with freshness and TTL", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-ai-catalog-"));
    const archivePath = join(directory, "catalog.tux");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      expect(await executeCli(["archive", "init", archivePath, "--name", "Catalog"], io)).toBe(0);
      const checkedAtUs = String(BigInt(Date.now()) * 1000n);
      const base = await openArchiveBytes(await createArchiveBytes("Catalog fixture"));
      const updated = await appendRecords(base, [
        legacyRecord(newUuid(), {
          record_role: "model-catalog-state",
          provider_id: "openai",
          catalog_checked_at_us: checkedAtUs,
          catalog_source: "provider-api",
          catalog_status: "fresh",
          catalog_ttl_seconds: "3600",
        }),
        legacyRecord(newUuid(), {
          record_role: "model-catalog",
          provider_id: "openai",
          model_id: "gpt-4.1",
          owner: "OpenAI",
          catalog_state: "listed",
          protocol_family: "openai-chat-completions",
          context_window: "1047576",
          maximum_output_tokens: "32768",
          input_modalities: "text,image",
          output_modalities: "text",
          structured_output_support: "supported",
          streaming_support: "supported",
          tool_support: "supported",
          tokenizer_information: "o200k_base",
          pricing_information: "input=2;output=8",
          availability_status: "available",
          verification_status: "unverified",
          catalog_source: "provider-api",
          metadata_source: "provider-api",
          discovered_at_us: checkedAtUs,
          capabilities: "structured=supported;streaming=supported;tools=supported",
          api_family: "openai-chat-completions",
        }),
      ]);
      await writeFile(archivePath, await updated.source.read(0n, Number(updated.source.size)));

      expect(
        await executeCli(["--json", "--archive", archivePath, "ai", "models", "--provider", "openai"], io),
      ).toBe(0);
      const rows = JSON.parse(stdout.at(-1)!) as Record<string, string>[];
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider_id: "openai",
        model_id: "gpt-4.1",
        owner: "OpenAI",
        capabilities: "structured=supported;streaming=supported;tools=supported",
        protocol_family: "openai-chat-completions",
        context_window: "1047576",
        maximum_output_tokens: "32768",
        input_modalities: "text,image",
        output_modalities: "text",
        structured_output_support: "supported",
        streaming_support: "supported",
        tool_support: "supported",
        tokenizer_information: "o200k_base",
        pricing_information: "input=2;output=8",
        availability_status: "available",
        catalog_freshness: "fresh",
        catalog_ttl_seconds: "3600",
        catalog_status: "fresh",
      });
      expect(Number(rows[0]?.["catalog_age_seconds"])).toBeGreaterThanOrEqual(0);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("inspects an embedded GGUF locally and never routes ai test to HTTP discovery", async () => {
    const directory = await mkdtemp(join(process.cwd(), "tmp", "tutorux-ai-parity-"));
    const archivePath = join(directory, "ai.tux");
    const modelPath = join(directory, "fixture.gguf");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = {
      stdout: (value: string) => stdout.push(value),
      stderr: (value: string) => stderr.push(value),
    };

    try {
      await writeFile(modelPath, minimalGguf());
      expect(await executeCli(["archive", "init", archivePath, "--name", "AI parity"], io)).toBe(0);

      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "model",
            "select",
            "--provider",
            "llama.cpp-embedded",
            "--model",
            "fixture",
            "--path",
            "fixture.gguf",
          ],
          io,
        ),
      ).toBe(0);

      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "ai", "models", "--provider", "llama.cpp-embedded"],
          io,
        ),
      ).toBe(0);
      const models = JSON.parse(stdout.at(-1)!) as {
        provider_id: string;
        model_id: string;
        path: string;
        catalog_state: string;
        active: string;
        architecture: string;
        context_window: string;
        catalog_freshness: string;
      }[];
      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        provider_id: "llama.cpp-embedded",
        model_id: "fixture",
        path: "fixture.gguf",
        catalog_state: "user-selected",
        active: "true",
        architecture: "llama",
        context_window: "4096",
        catalog_freshness: "local",
      });

      expect(
        await executeCli(
          ["--json", "--archive", archivePath, "ai", "test", "--provider", "llama.cpp-embedded"],
          io,
        ),
      ).toBe(0);
      const testResult = JSON.parse(stdout.at(-1)!) as Record<string, string>;
      expect(testResult).toMatchObject({
        provider: "llama.cpp-embedded",
        model_id: "fixture",
        status: "model-file-valid",
        network_request_sent: "false",
        model_loaded: "false",
        architecture: "llama",
        available_memory_bytes: "unknown",
      });
      expect(testResult["estimated_memory_bytes_upper_bound"]).toMatch(/^\d+$/u);
      expect(testResult["memory_estimate_overflowed"]).toBe("false");

      expect(
        await executeCli(
          [
            "--json",
            "--archive",
            archivePath,
            "model",
            "inspect",
            "--path",
            "fixture.gguf",
          ],
          io,
        ),
      ).toBe(0);
      const inspected = JSON.parse(stdout.at(-1)!) as Record<string, string>;
      expect(inspected).toMatchObject({
        format: "GGUF",
        architecture: "llama",
        name: "CLI Fixture Model",
        description: "A tiny metadata fixture.",
        training_context_tokens: "8192",
        embedding_length: "4096",
        layer_count: "32",
        tensor_count: "1",
        memory_estimate_overflowed: "false",
      });
      expect(inspected["estimated_memory_bytes_upper_bound"]).toMatch(/^\d+$/u);
      expect(stderr).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

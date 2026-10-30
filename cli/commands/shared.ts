import { AsyncLocalStorage } from "node:async_hooks";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { type ArchiveRecord } from "../../frontend/archive/format";

export class CliError extends Error {}

export const archiveAccessContext = new AsyncLocalStorage<{ passphrase: string | undefined }>();

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface ParsedArguments {
  positionals: string[];
  options: Map<string, string>;
  flags: Set<string>;
}

export function takeGlobalOption(args: string[], name: string): string | undefined {
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

export function parseArguments(args: readonly string[]): ParsedArguments {
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

export function emit(output: CliIo, data: unknown, summary: string, json: boolean): void {
  output.stdout(json ? JSON.stringify(data, null, 2) : summary);
}

export function requiredOption(args: ParsedArguments, name: string): string {
  const value = args.options.get(name)?.trim();
  if (!value) throw new CliError(`--${name} is required.`);
  return value;
}

export function requiredPosition(args: ParsedArguments, index: number, label: string): string {
  const value = args.positionals[index]?.trim();
  if (!value) throw new CliError(`${label} is required.`);
  return value;
}

export function optionIdList(args: ParsedArguments, name: string): string[] | undefined {
  const value = args.options.get(name);
  if (value === undefined) return undefined;
  if (!value.trim()) return [];
  const ids = value.split(",").map((id) => id.trim().toLowerCase());
  if (ids.some((id) => !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u.test(id))) {
    throw new CliError(`--${name} must contain comma-separated archive IDs.`);
  }
  return [...new Set(ids)];
}

export function parseBoundedOption(
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

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function field(record: ArchiveRecord, name: string, fallback = ""): string {
  return record.fields.get(name) ?? fallback;
}

export function timestampNow(): string {
  return (BigInt(Date.now()) * 1000n).toString();
}

export function parseIntegerField(value: string): bigint {
  try {
    return BigInt(value || "0");
  } catch {
    return 0n;
  }
}

export async function sameFileIdentity(firstPath: string, secondPath: string): Promise<boolean> {
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

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export const ASSET_IMPORT_BATCH_BYTES = 64 * 1024 * 1024;

export const ASSET_IMPORT_BATCH_FILES = 128;

export const RECORDING_WORKER_ID_ENVIRONMENT = "TUTORUX_CLI_RECORD_WORKER_ID";

export const RECORDING_WORKER_PASSPHRASE_ENVIRONMENT = "TUTORUX_CLI_RECORD_WORKER_PASSPHRASE";

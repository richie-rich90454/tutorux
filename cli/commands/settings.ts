import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import {
  hasSensitiveCredentialMaterial,
  sensitiveSettingKey,
} from "../../frontend/archive/sanitized-copy";
import { AI_PROVIDERS, deterministicUuid } from "../../frontend/ai/providers";
import { moveRecordToTrash } from "../../frontend/domain/records";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import {
  CliError,
  archiveAccessContext,
  emit,
  field,
  requiredOption,
  requiredPosition,
} from "./shared";
import { toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";

export async function runSettingsCommand(
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

export function validateArchiveSettingKey(key: string): string {
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

export function settingEnvironmentValue(name: string): string {
  if (!/^[A-Za-z_][A-Za-z\d_]*$/u.test(name))
    throw new CliError("The environment variable name is invalid.");
  const value = process.env[name];
  if (value === undefined) throw new CliError("The requested environment variable is not set.");
  return value;
}

export async function makeCliSettingRecord(
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

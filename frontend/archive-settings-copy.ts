import { hasSensitiveCredentialMaterial, sensitiveSettingKey } from "./archive/sanitized-copy";
import { type ArchiveRecord, RecordType } from "./archive/format";

export interface ArchiveSettingsCopyPlan {
    records: ArchiveRecord[];
    additions: number;
    replacements: number;
    withheldSensitive: number;
    keys: string[];
}

const field = (record: ArchiveRecord, name: string): string => record.fields.get(name) ?? "";

/** Prepare ordinary settings for transfer without carrying source archive history or credentials. */
export function prepareArchiveSettingsCopy(
    sourceRecords: readonly ArchiveRecord[],
    targetRecords: readonly ArchiveRecord[],
): ArchiveSettingsCopyPlan {
    const targetKeys = new Set(
        targetRecords
            .filter(
                (record) =>
                    record.type === RecordType.settings &&
                    field(record, "record_role") === "setting" &&
                    field(record, "_deleted") !== "true" &&
                    !hasSensitiveCredentialMaterial(record),
            )
            .map((record) => field(record, "key")),
    );
    const records: ArchiveRecord[] = [];
    const keys = new Set<string>();
    let withheldSensitive = 0;

    for (const source of sourceRecords) {
        if (
            source.type !== RecordType.settings ||
            field(source, "record_role") !== "setting" ||
            field(source, "_deleted") === "true"
        ) {
            continue;
        }

        const key = field(source, "key");
        if (sensitiveSettingKey(key) || hasSensitiveCredentialMaterial(source)) {
            withheldSensitive += 1;
            continue;
        }
        if (
            !key.trim() ||
            [...key].some((character) => {
                const code = character.codePointAt(0)!;
                return code < 0x20 || code === 0x7f;
            }) ||
            new TextEncoder().encode(key).byteLength > 512
        ) {
            throw new Error("The source archive contains an invalid ordinary settings key.");
        }
        const value = field(source, "value");
        if (value.includes("\0") || new TextEncoder().encode(value).byteLength > 1024 * 1024) {
            throw new Error(`The source setting “${key}” exceeds the supported value size.`);
        }
        if (keys.has(key)) {
            throw new Error(`The source archive contains more than one setting named “${key}”.`);
        }
        keys.add(key);
        records.push({
            ...source,
            revision: 0n,
            previousOffset: 0n,
            blob: new Uint8Array(),
        });
    }

    records.sort((left, right) => field(left, "key").localeCompare(field(right, "key")));
    const replacements = records.filter((record) => targetKeys.has(field(record, "key"))).length;
    return {
        records,
        additions: records.length - replacements,
        replacements,
        withheldSensitive,
        keys: records.map((record) => field(record, "key")),
    };
}

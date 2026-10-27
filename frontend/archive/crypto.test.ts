import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { openArchiveBytes, type ArchiveSnapshot } from "./archive";
import {
  decodeLz4Block,
  decodeRecordFrame,
  decodeRecordFrameHeader,
  decodeRecordPayload,
  encodeRecordPayload,
  newUuid,
  RecordType,
  RECORD_HEADER_SIZE,
} from "./format";
import { ArchiveDataKey, encryptionEnvelopeFromRecord, encryptionEnvelopeToRecord } from "./crypto";

async function readFrame(snapshot: ArchiveSnapshot, offset: bigint) {
  const header = decodeRecordFrameHeader(await snapshot.source.read(offset, RECORD_HEADER_SIZE));
  const padding = (8 - (header.payloadLength % 8)) % 8;
  const frameBytes = await snapshot.source.read(
    offset,
    RECORD_HEADER_SIZE + header.payloadLength + padding,
  );
  return decodeRecordFrame(frameBytes);
}

describe("Tutorux archive encryption primitives", () => {
  it("wraps the data key and authenticates v1 record and metadata bytes", async () => {
    const archiveId = newUuid();
    const key = await ArchiveDataKey.createRandom();
    const envelope = await key.wrap("correct horse battery staple", archiveId);
    const envelopeRecord = encryptionEnvelopeToRecord(envelope, archiveId);
    const parsedEnvelope = encryptionEnvelopeFromRecord(envelopeRecord, archiveId);
    const unlockedKey = await ArchiveDataKey.unwrap(
      "correct horse battery staple",
      parsedEnvelope,
      archiveId,
    );
    const context = {
      archiveId,
      type: RecordType.student,
      recordId: newUuid(),
      revision: 7n,
      previousOffset: 120n,
      codec: 1 as const,
    };
    const plaintext = new TextEncoder().encode("Cross-platform encrypted archive payload.");
    const ciphertext = await key.encryptRecordPayload(plaintext, context);
    await expect(unlockedKey.decryptRecordPayload(ciphertext, context)).resolves.toEqual(plaintext);

    const manifestPayload = new TextEncoder().encode("authenticated manifest bytes");
    const authentication = await key.authenticateBytes("TUTORUX-MANIFEST-V1", manifestPayload);
    await expect(
      unlockedKey.authenticationMatches("TUTORUX-MANIFEST-V1", manifestPayload, authentication),
    ).resolves.toBe(true);
    await expect(
      unlockedKey.authenticationMatches(
        "TUTORUX-MANIFEST-V1",
        new TextEncoder().encode("altered manifest bytes"),
        authentication,
      ),
    ).resolves.toBe(false);

    const tampered = ciphertext.slice();
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await expect(unlockedKey.decryptRecordPayload(tampered, context)).rejects.toMatchObject({
      code: "archive_record_authentication_failed",
    });
    await expect(
      unlockedKey.decryptRecordPayload(ciphertext, { ...context, revision: 8n }),
    ).rejects.toMatchObject({ code: "archive_record_authentication_failed" });

    expect(envelopeRecord.type).toBe(RecordType.encryption);
    expect(envelopeRecord.fields.get("kdf")).toBe("argon2id13");
    expect(envelopeRecord.fields.get("aead")).toBe("xchacha20-poly1305-ietf");
    expect(parsedEnvelope.salt).toHaveLength(16);
    expect(parsedEnvelope.nonce).toHaveLength(24);
    expect(parsedEnvelope.wrappedKey).toHaveLength(48);
    expect(parsedEnvelope.opsLimit).toBeGreaterThanOrEqual(2);
    expect(parsedEnvelope.memoryLimit).toBeGreaterThanOrEqual(64 * 1024 * 1024);

    key.dispose();
    unlockedKey.dispose();
    expect(() => key.dispose()).not.toThrow();
    await expect(key.authenticateBytes("TUTORUX-COMMIT-V1", manifestPayload)).rejects.toMatchObject(
      {
        code: "archive_key_disposed",
      },
    );
  });

  it("rejects unsafe KDF limits and short new passphrases", async () => {
    const archiveId = newUuid();
    const key = await ArchiveDataKey.createRandom();
    const envelope = await key.wrap("a passphrase long enough", archiveId);
    expect(() =>
      encryptionEnvelopeToRecord({ ...envelope, memoryLimit: Number.MAX_SAFE_INTEGER }, archiveId),
    ).toThrowError(expect.objectContaining({ code: "archive_encryption_parameters_invalid" }));
    const validRecord = encryptionEnvelopeToRecord(envelope, archiveId);
    const malformedRecord = { ...validRecord, fields: new Map(validRecord.fields) };
    malformedRecord.fields.set("memlimit", "9".repeat(21));
    expect(() => encryptionEnvelopeFromRecord(malformedRecord, archiveId)).toThrowError(
      expect.objectContaining({ code: "archive_encryption_metadata_invalid" }),
    );
    await expect(key.wrap("short", archiveId)).rejects.toMatchObject({
      code: "archive_passphrase_too_short",
    });
    key.dispose();
  });

  it("opens encryption metadata, protected records, and MACs written by the C++ archive", async () => {
    const fixture = new URL("../../tests/fixtures/encrypted-v1.tux", import.meta.url);
    const snapshot = await openArchiveBytes(new Uint8Array(await readFile(fixture)));
    expect(snapshot.encrypted).toBe(true);
    expect(snapshot.locked).toBe(true);

    const envelopeRecord = await snapshot.getRecord(RecordType.encryption, snapshot.header.id);
    expect(envelopeRecord).not.toBeNull();
    const envelope = encryptionEnvelopeFromRecord(envelopeRecord!, snapshot.header.id);
    const key = await ArchiveDataKey.unwrap(
      "Tutorux cross-language fixture phrase 2026",
      envelope,
      snapshot.header.id,
    );
    await expect(
      ArchiveDataKey.unwrap("incorrect fixture phrase", envelope, snapshot.header.id),
    ).rejects.toMatchObject({ code: "archive_passphrase_invalid" });

    const manifest = await snapshot.getRecord(RecordType.settings, snapshot.header.id);
    expect(manifest).not.toBeNull();
    const manifestFields = new Map(manifest!.fields);
    const manifestAuthentication = Uint8Array.from(
      (manifestFields.get("manifest_auth")!.match(/../gu) ?? []).map((byte) =>
        Number.parseInt(byte, 16),
      ),
    );
    manifestFields.delete("manifest_auth");
    const unsignedManifest = encodeRecordPayload({ ...manifest!, fields: manifestFields });
    await expect(
      key.authenticationMatches("TUTORUX-MANIFEST-V1", unsignedManifest, manifestAuthentication),
    ).resolves.toBe(true);

    const studentEntry = [...snapshot.allIndexEntries()].find(([indexKey]) =>
      indexKey.startsWith("STUDENT:"),
    );
    expect(studentEntry).toBeDefined();
    const studentFrame = await readFrame(snapshot, studentEntry![1]);
    expect(studentFrame.flags & 1).toBe(1);
    const storedPayload = await key.decryptRecordPayload(studentFrame.storedPayload, {
      archiveId: snapshot.header.id,
      type: studentFrame.type,
      recordId: studentFrame.id,
      revision: studentFrame.revision,
      previousOffset: studentFrame.previousOffset,
      codec: studentFrame.codec,
    });
    const payload = studentFrame.codec === 0 ? storedPayload : decodeLz4Block(storedPayload);
    const student = decodeRecordPayload(
      studentFrame.type,
      studentFrame.id,
      studentFrame.revision,
      studentFrame.previousOffset,
      payload,
    );
    expect(student.fields.get("display_name")).toBe("Interop Student");

    const commitFrame = await readFrame(snapshot, snapshot.commit.offset);
    expect(commitFrame.storedPayload).toHaveLength(124);
    await expect(
      key.authenticationMatches(
        "TUTORUX-COMMIT-V1",
        commitFrame.storedPayload.subarray(0, 92),
        commitFrame.storedPayload.subarray(92),
      ),
    ).resolves.toBe(true);
    const indexFrame = await readFrame(snapshot, snapshot.commit.rootOffset);
    await expect(
      key.authenticationMatches(
        "TUTORUX-INDEX-PAGE-V1",
        indexFrame.storedPayload.subarray(0, -32),
        indexFrame.storedPayload.subarray(-32),
      ),
    ).resolves.toBe(true);
    key.dispose();
  });
});

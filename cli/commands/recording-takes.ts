import { RecordType, type ArchiveRecord } from "../../frontend/archive/format";
import { canonicalizeProgressUuid } from "../../frontend/domain/student-progress";
import {
    renameRecordingTake,
    renameRecordingTrack,
    setRecordingTakeDeleted,
} from "../../frontend/domain/recording-takes";
import { type RecordingControlWorker } from "../recording-control";
import { prepareWavImportRecovery } from "../../frontend/domain/wav-recovery";
import { prepareNativeCaptureRecovery } from "../../frontend/domain/native-recording-recovery";
import { closeSnapshot, mutateArchive, openForCommand } from "./archive-io";
import { makeCliSettingRecord } from "./settings";
import { CliError, emit, field, requiredOption } from "./shared";
import { requireLiveRecord, toPlainRecord } from "./record-helpers";
import type { CliIo, ParsedArguments } from "./shared";
import { runRecordingAudioCommand } from "./recording-audio";
import { runRecordingControlCommand } from "./recording-control-command";
import { runLiveRecordingCommand } from "./recording-live";
import { runRecordingPlaybackCommand } from "./recording-playback";

export async function runRecordingTakeCommand(
    action: string,
    path: string,
    args: ParsedArguments,
    output: CliIo,
    signal?: AbortSignal,
    recordingControl?: RecordingControlWorker,
): Promise<number> {
    const json = args.flags.has("json");
    if (action === "play") return runRecordingPlaybackCommand(path, args, output, signal);
    if (action === "start")
        return runLiveRecordingCommand(path, args, output, signal, recordingControl);
    if (action === "status" || action === "pause" || action === "resume" || action === "stop") {
        return await runRecordingControlCommand(action, path, args, output);
    }
    if (action === "configure") {
        for (const name of ["microphone", "playback", "durability"]) {
            if (args.flags.has(name)) throw new CliError(`--${name} requires a value.`);
        }
        const microphone = args.options.get("microphone");
        const playback = args.options.get("playback");
        const durability = args.options.get("durability");
        if (microphone === "")
            throw new CliError("The '--microphone' device value cannot be empty.");
        if (playback === "") throw new CliError("The '--playback' device value cannot be empty.");
        if (
            durability !== undefined &&
            durability !== "default" &&
            durability !== "maximum" &&
            durability !== "reduced-write"
        ) {
            throw new CliError("Durability must be 'default', 'maximum', or 'reduced-write'.");
        }
        if (args.positionals.length)
            throw new CliError("record configure does not accept positional arguments.");

        const snapshot = await openForCommand(path);
        let generation: bigint;
        let configured: {
            microphone_device_id: string;
            playback_device_id: string;
            durability: string;
        };
        try {
            generation = snapshot.commit.generation;
            const settings = await snapshot.listRecords(RecordType.settings);
            const read = (key: string): string =>
                settings
                    .find(
                        (record) =>
                            field(record, "record_role") === "setting" &&
                            field(record, "key") === key,
                    )
                    ?.fields.get("value") ?? "default";
            configured = {
                microphone_device_id: microphone ?? read("recording.microphone_device_id"),
                playback_device_id: playback ?? read("recording.playback_device_id"),
                durability: durability ?? read("recording.durability"),
            };
        } finally {
            await closeSnapshot(snapshot);
        }

        const changes: ArchiveRecord[] = [];
        if (microphone !== undefined)
            changes.push(
                await makeCliSettingRecord("recording.microphone_device_id", microphone, false),
            );
        if (playback !== undefined)
            changes.push(
                await makeCliSettingRecord("recording.playback_device_id", playback, false),
            );
        if (durability !== undefined)
            changes.push(await makeCliSettingRecord("recording.durability", durability, false));
        if (changes.length) {
            await mutateArchive(
                path,
                changes,
                generation,
                "The archive changed while recording configuration was being prepared. Retry the command.",
            );
        }
        emit(
            output,
            configured,
            `Recording configuration saved in the active archive.\nMicrophone: ${configured.microphone_device_id}\nPlayback: ${configured.playback_device_id}\nDurability: ${configured.durability}`,
            json,
        );
        return 0;
    }
    if (
        [
            "import",
            "export-wav",
            "waveform",
            "waveform-index-build",
            "waveform-index-show",
            "mix",
        ].includes(action)
    )
        return runRecordingAudioCommand(action, path, args, output);
    if (action === "take-list") {
        const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
        if (!sessionId) throw new CliError("--session must be a valid UUID.");
        const snapshot = await openForCommand(path);
        try {
            await requireLiveRecord(snapshot, RecordType.session, sessionId);
            const records = await snapshot.listRecordMetadata(
                RecordType.assetMetadata,
                args.flags.has("include-deleted"),
            );
            const takes = records.filter(
                (record) =>
                    field(record, "record_role") === "recording-take" &&
                    field(record, "session_id").toLowerCase() === sessionId,
            );
            emit(
                output,
                takes.map(toPlainRecord),
                takes.length
                    ? `${takes.length} recording take${takes.length === 1 ? "" : "s"}.`
                    : "No recording takes found.",
                json,
            );
            return 0;
        } finally {
            await closeSnapshot(snapshot);
        }
    }

    if (!["take-rename", "take-delete", "take-restore", "track-rename"].includes(action)) {
        throw new CliError(`record ${action} is not implemented in the TypeScript CLI yet.`);
    }

    const sessionId = canonicalizeProgressUuid(requiredOption(args, "session"));
    if (!sessionId) throw new CliError("--session must be a valid UUID.");
    const snapshot = await openForCommand(path);
    const expectedGeneration = snapshot.commit.generation;
    let updates: ArchiveRecord[];
    try {
        await requireLiveRecord(snapshot, RecordType.session, sessionId);
        if (action === "track-rename") {
            const trackId = canonicalizeProgressUuid(requiredOption(args, "track"));
            if (!trackId) throw new CliError("--track must be a valid UUID.");
            const track = await snapshot.getRecord(RecordType.assetMetadata, trackId);
            if (
                !track ||
                field(track, "record_role") !== "audio-track" ||
                field(track, "session_id").toLowerCase() !== sessionId
            ) {
                throw new CliError("The selected track does not belong to this session.");
            }
            updates = [
                await renameRecordingTrack(snapshot, trackId, requiredOption(args, "label")),
            ];
        } else {
            const takeId = canonicalizeProgressUuid(requiredOption(args, "take"));
            if (!takeId) throw new CliError("--take must be a valid UUID.");
            const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
            if (
                !take ||
                field(take, "record_role") !== "recording-take" ||
                field(take, "session_id").toLowerCase() !== sessionId
            ) {
                throw new CliError("The selected take does not belong to this session.");
            }
            updates =
                action === "take-rename"
                    ? [await renameRecordingTake(snapshot, takeId, requiredOption(args, "label"))]
                    : await setRecordingTakeDeleted(snapshot, takeId, action === "take-delete");
        }
    } finally {
        await closeSnapshot(snapshot);
    }

    const saved = await mutateArchive(
        path,
        updates,
        expectedGeneration,
        "The archive changed while this recording update was being prepared. Retry the command.",
    );
    const visibleRecords = saved.filter(
        (record) =>
            record.type === RecordType.assetMetadata &&
            ["recording-take", "audio-track"].includes(field(record, "record_role")),
    );
    emit(
        output,
        visibleRecords.map(toPlainRecord),
        action === "take-delete"
            ? "Recording take and its audio moved to Trash."
            : action === "take-restore"
              ? "Recording take and its audio restored."
              : action === "track-rename"
                ? "Recording track renamed."
                : "Recording take renamed.",
        json,
    );
    return 0;
}

export async function runSessionAudioRecovery(
    path: string,
    args: ParsedArguments,
    output: CliIo,
): Promise<number> {
    const id = canonicalizeProgressUuid(requiredOption(args, "session"));
    if (!id) throw new CliError("--session must be a valid UUID.");
    const snapshot = await openForCommand(path);
    let generation: bigint;
    let prepared: Awaited<ReturnType<typeof prepareWavImportRecovery>> | undefined;
    let native: Awaited<ReturnType<typeof prepareNativeCaptureRecovery>> | undefined;
    let trackId: string;
    try {
        generation = snapshot.commit.generation;
        const session = await requireLiveRecord(snapshot, RecordType.session, id);
        trackId = field(session, "audio_import_track_id");
        if (field(session, "recording_track_id") || field(session, "recording_track_ids")) {
            native = await prepareNativeCaptureRecovery(snapshot, session);
        } else {
            prepared = await prepareWavImportRecovery(snapshot, session);
        }
    } finally {
        await closeSnapshot(snapshot);
    }
    if (native) {
        if (native.records.length)
            await mutateArchive(
                path,
                native.records,
                generation,
                "The archive changed while recovery was being prepared. Retry the command.",
            );
        emit(
            output,
            {
                session_id: id,
                state: native.completed
                    ? "completed"
                    : BigInt(native.chunkCount) > 0n
                      ? "partial"
                      : "failed",
                duration_us: native.durationUs,
                sample_count: native.sampleCount,
                chunk_count: native.chunkCount,
                byte_count: native.byteCount,
                tracks: native.tracks,
            },
            native.message,
            args.flags.has("json"),
        );
        return native.completed ? 0 : 2;
    }
    if (!prepared) throw new CliError("No WAV import recovery is available for this session.");
    if (prepared.records.length)
        await mutateArchive(
            path,
            prepared.records,
            generation,
            "The archive changed while recovery was being prepared. Retry the command.",
        );
    emit(
        output,
        {
            session_id: id,
            track_id: trackId,
            state: prepared.state,
            sample_count: String(prepared.sampleCount),
            chunk_count: String(prepared.chunkCount),
            duration_us: String(prepared.durationUs),
            byte_count: String(prepared.byteCount),
            completed: prepared.completed,
            message: prepared.message,
        },
        prepared.message,
        args.flags.has("json"),
    );
    return prepared.completed ? 0 : 2;
}

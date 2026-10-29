import { createEffect, createSignal, onCleanup, For, Show, untrack } from "solid-js";
import { isTauri } from "@tauri-apps/api/core";
import type { ArchiveSnapshot } from "./archive/archive";
import { newUuid, RecordType, type ArchiveRecord } from "./archive/format";
import {
  makeMicrophoneCaptureChunkRecords,
  makeMicrophoneCaptureFinishRecords,
  makeMicrophoneCaptureStateRecords,
  makeMicrophoneCaptureStartRecords,
  makeMicrophoneRecordingRecords,
  type MicrophoneCaptureIdentity,
} from "./domain/microphone-recording";
import { setRecordingTakeDeleted } from "./domain/recording-takes";
import { prepareNativeCaptureRecovery } from "./domain/native-recording-recovery";
import {
  startMicrophoneCapture,
  type ActiveMicrophoneCapture,
  type MicrophoneArchiveCaptureHooks,
} from "./platform/audio-capture";
import {
  hasDesktopArchiveCapability,
  persistMicrophoneArchiveGeneration,
} from "./platform/tauri";

interface Props {
  snapshot: ArchiveSnapshot;
  session: ArchiveRecord;
  trackIds: readonly string[];
  disabled: boolean;
  onSave: (
    records: ArchiveRecord[],
    message: string,
    snapshot: ArchiveSnapshot,
  ) => Promise<boolean>;
}

interface PendingCapture {
  file: File;
  archiveId: string;
  sessionId: string;
  startedAtUs: string;
  consentAtUs: string;
  pauseCount: number;
  pausedDurationUs: string;
  warning?: string;
}

interface ResumeCapture {
  trackId: string;
  takeId: string;
  sampleRateHz: number;
  startedAtUs: string;
  consentAtUs: string;
  nextSequence: number;
  firstSampleIndex: string;
  sampleCount: string;
  pauseCount: string;
  pausedDurationUs: string;
}

interface RecoverableMicrophoneTake {
  trackId: string;
  takeId: string;
  label: string;
  state: string;
}

/** Capture a microphone take and save it as ordinary archive PCM tracks. */
export function MicrophoneTrackRecorder(props: Props) {
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [state, setState] = createSignal<
    "idle" | "requesting" | "recording" | "pausing" | "paused" | "resuming" | "stopping" | "saving"
  >("idle");
  const [pending, setPending] = createSignal<PendingCapture>();
  const [recoverable, setRecoverable] = createSignal<RecoverableMicrophoneTake>();
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  let recorder: ActiveMicrophoneCapture | undefined;
  let consentAtUs = "";
  let sessionId = "";
  let archiveId = "";
  let captureIdentity: MicrophoneCaptureIdentity | undefined;
  let captureBaseSampleCount = 0n;
  let disposed = false;
  let recoveryScan = 0;
  const refreshDevices = async () => {
    try {
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "audioinput",
        ),
      );
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  createEffect(() => {
    const snapshot = props.snapshot;
    const session = props.session;
    if (
      !isTauri() ||
      state() !== "idle" ||
      !snapshot.canMutate ||
      !hasDesktopArchiveCapability(snapshot.source)
    ) {
      setRecoverable(undefined);
      return;
    }
    const scan = ++recoveryScan;
    void (async () => {
      try {
        const metadata = await snapshot.listRecordMetadata(RecordType.assetMetadata, true);
        const candidates = metadata
          .filter(
            (record) =>
              record.fields.get("_deleted") !== "true" &&
              record.fields.get("record_role") === "audio-track" &&
              record.fields.get("source") === "microphone" &&
              record.fields.get("session_id")?.toLowerCase() === session.id.toLowerCase() &&
              ["recording", "paused", "interrupted"].includes(record.fields.get("state") ?? ""),
          )
          .sort((left, right) => {
            const a = BigInt(left.fields.get("updated_at_us") ?? "0");
            const b = BigInt(right.fields.get("updated_at_us") ?? "0");
            return a > b ? -1 : a < b ? 1 : 0;
          });
        let candidate: RecoverableMicrophoneTake | undefined;
        for (const track of candidates) {
          const takeId = track.fields.get("recording_take_id")?.toLowerCase() ?? "";
          if (!takeId) continue;
          const take = await snapshot.getRecord(RecordType.assetMetadata, takeId);
          if (
            take &&
            take.fields.get("_deleted") !== "true" &&
            take.fields.get("record_role") === "recording-take"
          ) {
            candidate = {
              trackId: track.id.toLowerCase(),
              takeId,
              label: take.fields.get("label") || "Microphone recording",
              state: track.fields.get("state") ?? "interrupted",
            };
            break;
          }
        }
        if (
          scan === recoveryScan &&
          snapshot === props.snapshot &&
          session.id.toLowerCase() === props.session.id.toLowerCase()
        ) {
          setRecoverable(candidate);
        }
      } catch {
        if (scan === recoveryScan) setRecoverable(undefined);
      }
    })();
  });
  onCleanup(() => {
    disposed = true;
    const active = recorder;
    recorder = undefined;
    if (active?.durability === "archive") void active.stop();
    else void active?.discard();
  });

  const commitCaptureRecords = async (records: ArchiveRecord[], message: string) => {
    const snapshot = props.snapshot;
    if (
      snapshot.header.id !== archiveId ||
      !snapshot.canMutate ||
      props.session.id.toLowerCase() !== sessionId.toLowerCase()
    ) {
      throw new Error("Reopen the original unlocked archive and session to continue this take.");
    }
    if (!(await props.onSave(records, message, snapshot))) {
      throw new Error("The microphone checkpoint could not be committed to the archive.");
    }
    const committed = props.snapshot;
    if (
      committed.header.id.toLowerCase() !== archiveId.toLowerCase() ||
      committed.commit.generation !== snapshot.commit.generation + 1n ||
      committed.source.size <= snapshot.source.size
    ) {
      throw new Error("The microphone checkpoint was not published as one complete archive generation.");
    }
    const deltaSize = committed.source.size - snapshot.source.size;
    if (deltaSize > 8n * 1024n * 1024n || deltaSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("The microphone checkpoint exceeds the supported archive generation size.");
    }
    const generationBytes = await committed.source.read(snapshot.source.size, Number(deltaSize));
    if (generationBytes.byteLength !== Number(deltaSize)) {
      throw new Error("The microphone checkpoint could not be read back from the archive writer.");
    }
    await persistMicrophoneArchiveGeneration(
      committed.source,
      generationBytes,
      committed.commit.generation,
    );
  };

  const archiveCaptureHooks = (resume?: ResumeCapture): MicrophoneArchiveCaptureHooks => ({
    async onStarted(capture) {
      const snapshot = props.snapshot;
      if (
        snapshot.header.id !== archiveId ||
        !snapshot.canMutate ||
        !hasDesktopArchiveCapability(snapshot.source)
      )
        throw new Error("Unlock the original archive before recording a recoverable take.");
      const session = await snapshot.getRecord(RecordType.session, sessionId);
      if (!session || session.fields.get("_deleted") === "true")
        throw new Error("The selected session is no longer available for recording.");
      if (resume) {
        if (capture.sampleRateHz !== resume.sampleRateHz) {
          throw new Error("The microphone sample rate changed; this saved take cannot be resumed safely.");
        }
        const [track, take] = await Promise.all([
          snapshot.getRecord(RecordType.assetMetadata, resume.trackId),
          snapshot.getRecord(RecordType.assetMetadata, resume.takeId),
        ]);
        if (
          !track ||
          !take ||
          track.fields.get("record_role") !== "audio-track" ||
          track.fields.get("recording_take_id")?.toLowerCase() !== resume.takeId ||
          track.fields.get("state") !== "interrupted" ||
          track.fields.get("sample_count") !== resume.sampleCount ||
          track.fields.get("chunk_count") !== String(resume.nextSequence) ||
          take.fields.get("record_role") !== "recording-take" ||
          take.fields.get("_deleted") === "true"
        ) {
          throw new Error("The recovered microphone take changed before recording could resume.");
        }
        const timestamp = (BigInt(Date.now()) * 1000n).toString();
        const trackFields = new Map(track.fields);
        trackFields.set("state", "recording");
        trackFields.set("resume_count", incrementCounter(trackFields.get("resume_count")));
        trackFields.set("last_resumed_at_us", timestamp);
        trackFields.set("last_capture_consent_at_us", capture.consentAtUs);
        trackFields.set("recovery_error", "");
        trackFields.set("updated_at_us", timestamp);
        const takeFields = new Map(take.fields);
        takeFields.set("state", "recording");
        takeFields.set("resume_count", incrementCounter(takeFields.get("resume_count")));
        takeFields.set("last_resumed_at_us", timestamp);
        takeFields.set("last_capture_consent_at_us", capture.consentAtUs);
        takeFields.set("updated_at_us", timestamp);
        const sessionFields = new Map(session.fields);
        sessionFields.set("recording_state", "recording");
        sessionFields.set("recording_error", "");
        sessionFields.set("recording_last_resumed_at_us", timestamp);
        sessionFields.set("recording_last_consent_at_us", capture.consentAtUs);
        sessionFields.set("updated_at_us", timestamp);
        await commitCaptureRecords(
          [
            { ...track, fields: trackFields },
            { ...take, fields: takeFields },
            { ...session, fields: sessionFields },
          ],
          "Resumed the recovered microphone take from its last verified checkpoint.",
        );
        captureIdentity = {
          trackId: resume.trackId,
          takeId: resume.takeId,
          startedAtUs: resume.startedAtUs,
          consentAtUs: capture.consentAtUs,
          sampleRateHz: resume.sampleRateHz,
        };
        captureBaseSampleCount = BigInt(resume.sampleCount);
        return {
          sequence: resume.nextSequence,
          firstSampleIndex: resume.firstSampleIndex,
        };
      }
      captureIdentity = {
        trackId: newUuid(),
        takeId: newUuid(),
        startedAtUs: capture.startedAtUs,
        consentAtUs: capture.consentAtUs,
        sampleRateHz: capture.sampleRateHz,
      };
      captureBaseSampleCount = 0n;
      await commitCaptureRecords(
        makeMicrophoneCaptureStartRecords(session, captureIdentity, props.trackIds),
        "Microphone take started. Committed audio appears as a recoverable partial take.",
      );
      return { sequence: 0, firstSampleIndex: "0" };
    },
    async onChunk(chunk) {
      const identity = captureIdentity;
      if (!identity) throw new Error("The microphone recovery record was not initialized.");
      const snapshot = props.snapshot;
      const [session, track] = await Promise.all([
        snapshot.getRecord(RecordType.session, sessionId),
        snapshot.getRecord(RecordType.assetMetadata, identity.trackId),
      ]);
      if (!session || !track) throw new Error("The active microphone recovery records are missing.");
      const records = makeMicrophoneCaptureChunkRecords({
        session,
        track,
        chunk,
        sampleRateHz: identity.sampleRateHz,
      });
      await commitCaptureRecords(records, "A microphone audio checkpoint was added to the archive.");
    },
    async onPaused() {
      await saveCaptureState("paused");
    },
    async onResumed() {
      await saveCaptureState("recording");
    },
    async onFinished(capture) {
      const identity = captureIdentity;
      if (!identity) return;
      const snapshot = props.snapshot;
      const [session, track, take] = await Promise.all([
        snapshot.getRecord(RecordType.session, sessionId),
        snapshot.getRecord(RecordType.assetMetadata, identity.trackId),
        snapshot.getRecord(RecordType.assetMetadata, identity.takeId),
      ]);
      if (!session || !track || !take)
        throw new Error("The microphone take metadata could not be finalized.");
      if (
        BigInt(track.fields.get("sample_count") ?? "0") - captureBaseSampleCount !==
        BigInt(capture.sampleCount)
      ) {
        capture.interruptedReason ??=
          "The capture host and committed archive sample counts did not match.";
      }
      const records = makeMicrophoneCaptureFinishRecords({
        session,
        track,
        take,
        pauseCount: capture.pauseCount,
        pausedDurationUs: capture.pausedDurationUs,
        ...(capture.interruptedReason ? { interruptedReason: capture.interruptedReason } : {}),
      });
      await commitCaptureRecords(
        records,
        capture.interruptedReason
          ? "A partial microphone take was preserved and can be recovered or moved to Trash."
          : "Microphone take saved to the session and ready for playback and transcription.",
      );
    },
    async onDiscard() {
      const identity = captureIdentity;
      captureIdentity = undefined;
      if (!identity || props.snapshot.header.id !== archiveId) return;
      const snapshot = props.snapshot;
      const take = await snapshot.getRecord(RecordType.assetMetadata, identity.takeId);
      if (!take) return;
      await commitCaptureRecords(
        await setRecordingTakeDeleted(snapshot, identity.takeId, true),
        "Microphone take moved to Trash.",
      );
    },
  });

  const saveCaptureState = async (captureState: "recording" | "paused") => {
    const identity = captureIdentity;
    if (!identity) throw new Error("The microphone recovery record was not initialized.");
    const snapshot = props.snapshot;
    const [session, track, take] = await Promise.all([
      snapshot.getRecord(RecordType.session, sessionId),
      snapshot.getRecord(RecordType.assetMetadata, identity.trackId),
      snapshot.getRecord(RecordType.assetMetadata, identity.takeId),
    ]);
    if (!session || !track || !take)
      throw new Error("The active microphone recovery records are missing.");
    await commitCaptureRecords(
      makeMicrophoneCaptureStateRecords(session, track, take, captureState),
      captureState === "paused" ? "Microphone take paused." : "Microphone take resumed.",
    );
  };

  const save = async (capture: PendingCapture) => {
    if (
      props.disabled ||
      props.snapshot.header.id !== capture.archiveId ||
      props.session.id.toLowerCase() !== capture.sessionId.toLowerCase()
    ) {
      setError("Open the original archive and select the original session to save this recording.");
      return;
    }
    setState("saving");
    setError("");
    try {
      const snapshot = props.snapshot;
      const session = props.session;
      const result = await makeMicrophoneRecordingRecords({
        session,
        file: capture.file,
        knownTrackIds: props.trackIds,
        startedAtUs: capture.startedAtUs,
        consentAtUs: capture.consentAtUs,
        pauseCount: capture.pauseCount,
        pausedDurationUs: capture.pausedDurationUs,
      });
      if (props.snapshot !== snapshot || props.session !== session)
        throw new Error(
          "The archive changed while preparing this recording. Save again to use the latest session.",
        );
      if (await props.onSave(result.records, "Microphone take saved to the session.", snapshot)) {
        setPending(undefined);
        setStatus(
          capture.warning
            ? `${capture.warning} The captured portion was saved and is ready for playback and transcription.`
            : "Microphone take saved. It is ready for playback and transcription.",
        );
      } else setError("The recording could not be saved. It remains available to retry.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setState("idle");
    }
  };

  const stop = async (reason = "") => {
    if (!recorder || !["recording", "pausing", "paused", "resuming"].includes(state())) return;
    const active = recorder;
    recorder = undefined;
    setState("stopping");
    try {
      const result = await active.stop(reason);
      if (disposed) return;
      if (result.archiveCommitted) {
        captureIdentity = undefined;
        setStatus(
          reason || result.warning
            ? "A partial microphone take was preserved. Use Recover saved recording to verify it, or move it to Trash."
            : "Microphone take saved to the session. It is ready for playback and transcription.",
        );
        return;
      }
      if (!result.file) throw new Error("The microphone recording did not produce a saved take.");
      const capture = {
        ...result,
        file: result.file,
        archiveId,
        sessionId,
        ...(!result.warning && reason ? { warning: reason } : {}),
      };
      setPending(capture);
      setStatus(reason);
      await save(capture);
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && state() === "stopping") setState("idle");
    }
  };

  const discardActive = async () => {
    const active = recorder;
    if (!active) return;
    recorder = undefined;
    setState("stopping");
    setError("");
    try {
      await active.discard();
      if (!disposed) setStatus("Microphone take moved to Trash.");
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed) setState("idle");
    }
  };

  const togglePause = async () => {
    const active = recorder;
    const previous = state();
    if (!active || (previous !== "recording" && previous !== "paused")) return;
    setError("");
    setState(previous === "recording" ? "pausing" : "resuming");
    try {
      if (previous === "recording") await active.pause();
      else await active.resume();
      if (!disposed && recorder === active)
        setState(previous === "recording" ? "paused" : "recording");
    } catch (cause) {
      if (!disposed && recorder === active) {
        setState(previous);
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
  };

  const beginCapture = async (resume?: ResumeCapture) => {
    const active = await startMicrophoneCapture({
      consentConfirmed: consent(),
      consentAtUs,
      ...(resume ? { sampleRateHz: resume.sampleRateHz } : {}),
      deviceId: deviceId(),
      onLimit: () => void untrack(() => stop("Recording stopped at the 128 MiB limit.")),
      onDeviceEnded: () =>
        void untrack(() => stop("Microphone disconnected; saving captured audio.")),
      archive: archiveCaptureHooks(resume),
    });
    if (
      disposed ||
      props.session.id.toLowerCase() !== sessionId.toLowerCase() ||
      props.snapshot.header.id.toLowerCase() !== archiveId.toLowerCase() ||
      props.disabled
    ) {
      if (resume)
        await active.stop("The session changed before the resumed take could continue.").catch(() => undefined);
      else await active.discard();
      if (!disposed) setError("The session changed before microphone access was granted.");
      return;
    }
    recorder = active;
    setState("recording");
    if (resume) setStatus("Recording resumed from the last verified, durable archive checkpoint.");
    else if (active.durability === "archive")
      setStatus("Audio checkpoints are being committed to the archive for crash recovery.");
    void refreshDevices();
  };

  const start = async () => {
    if (!consent() || props.disabled || pending()) return;
    if (isTauri() && !hasDesktopArchiveCapability(props.snapshot.source)) {
      setError("Save the archive to a local file before starting a crash-recoverable recording.");
      return;
    }
    setState("requesting");
    setError("");
    setStatus("");
    sessionId = props.session.id;
    archiveId = props.snapshot.header.id;
    consentAtUs = (BigInt(Date.now()) * 1000n).toString();
    try {
      await beginCapture();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && state() === "requesting") setState("idle");
    }
  };

  const resumeSaved = async () => {
    const candidate = recoverable();
    if (
      !candidate ||
      !consent() ||
      props.disabled ||
      pending() ||
      !isTauri() ||
      !hasDesktopArchiveCapability(props.snapshot.source)
    )
      return;
    setState("requesting");
    setError("");
    setStatus("Verifying the saved microphone checkpoints before resuming…");
    sessionId = props.session.id;
    archiveId = props.snapshot.header.id;
    consentAtUs = (BigInt(Date.now()) * 1000n).toString();
    try {
      const original = props.snapshot;
      const session = await original.getRecord(RecordType.session, sessionId);
      if (!session) throw new Error("The original tutoring session is no longer available.");
      const recovery = await prepareNativeCaptureRecovery(original, session);
      const report = recovery.tracks.find(
        (track) => track.trackId.toLowerCase() === candidate.trackId,
      );
      if (
        !report ||
        report.state !== "interrupted" ||
        BigInt(report.sampleCount) === 0n ||
        report.errorMessage !== "Committed audio was verified; the capture did not reach completion."
      ) {
        throw new Error(
          report?.errorMessage || "The saved microphone track has no verified audio to resume.",
        );
      }
      await commitCaptureRecords(recovery.records, recovery.message);
      const recoveredSnapshot = props.snapshot;
      const [track, take] = await Promise.all([
        recoveredSnapshot.getRecord(RecordType.assetMetadata, candidate.trackId),
        recoveredSnapshot.getRecord(RecordType.assetMetadata, candidate.takeId),
      ]);
      if (
        !track ||
        !take ||
        track.fields.get("state") !== "interrupted" ||
        take.fields.get("_deleted") === "true"
      ) {
        throw new Error("The recovered microphone take changed before it could be resumed.");
      }
      const sampleRateHz = Number(track.fields.get("sample_rate_hz"));
      const nextSequence = Number(track.fields.get("chunk_count"));
      const firstSampleIndex = track.fields.get("timeline_sample_count") ?? "";
      const sampleCount = track.fields.get("sample_count") ?? "";
      if (
        !Number.isSafeInteger(sampleRateHz) ||
        sampleRateHz < 8_000 ||
        sampleRateHz > 192_000 ||
        !Number.isSafeInteger(nextSequence) ||
        nextSequence < 1 ||
        !/^\d+$/u.test(firstSampleIndex) ||
        !/^\d+$/u.test(sampleCount)
      ) {
        throw new Error("The recovered microphone track has invalid sample metadata.");
      }
      await beginCapture({
        trackId: candidate.trackId,
        takeId: candidate.takeId,
        sampleRateHz,
        startedAtUs: track.fields.get("started_at_us") ?? "",
        consentAtUs,
        nextSequence,
        firstSampleIndex,
        sampleCount,
        pauseCount: track.fields.get("capture_pause_count") ?? "0",
        pausedDurationUs: track.fields.get("capture_paused_duration_us") ?? "0",
      });
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && state() === "requesting") setState("idle");
    }
  };

  const discardSaved = async () => {
    const candidate = recoverable();
    if (!candidate || props.disabled) return;
    setState("saving");
    setError("");
    try {
      const snapshot = props.snapshot;
      await commitCaptureRecords(
        await setRecordingTakeDeleted(snapshot, candidate.takeId, true),
        "Recovered microphone take moved to Trash.",
      );
      setStatus("Recovered microphone take moved to Trash. Its chunks remain recoverable there.");
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed) setState("idle");
    }
  };

  return (
    <section class="transcript-capture-panel" aria-label="Record a session track">
      <div class="transcript-capture-copy">
        <strong>Record a microphone track</strong>
        <p>Save a recording as a session take for playback, mixing, and transcription.</p>
        <label>
          Microphone{" "}
          <select
            value={deviceId()}
            disabled={state() !== "idle"}
            onChange={(event) => setDeviceId(event.currentTarget.value)}
          >
            <option value="">System default</option>
            <For each={devices()}>
              {(device, index) => (
                <option value={device.deviceId}>
                  {device.label || `Microphone ${index() + 1}`}
                </option>
              )}
            </For>
          </select>
        </label>
        <button
          class="button button-outline"
          type="button"
          disabled={state() !== "idle"}
          onClick={() => void refreshDevices()}
        >
          Refresh microphones
        </button>
        <label class="transcript-capture-consent">
          <input
            type="checkbox"
            checked={consent()}
            disabled={state() !== "idle"}
            onChange={(event) => setConsent(event.currentTarget.checked)}
          />{" "}
          Everyone being recorded has agreed.
        </label>
      </div>
      <div class="transcript-capture-actions">
        <Show when={state() === "idle" && !pending()}>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || !consent()}
            onClick={() => void start()}
          >
            {recoverable() ? "Start a new recording" : "Start recording"}
          </button>
        </Show>
        <Show when={state() === "idle" && !pending() && recoverable()}>
          <div class="transcript-capture-recovery" role="group" aria-label="Recover microphone take">
            <span>
              {recoverable()?.label} has saved audio checkpoints. Verify them to resume, or move the
              take to Trash.
            </span>
            <button
              class="button button-outline"
              type="button"
              disabled={props.disabled || !consent()}
              onClick={() => void resumeSaved()}
            >
              Verify and resume take
            </button>
            <button
              class="button button-outline"
              type="button"
              disabled={props.disabled}
              onClick={() => void discardSaved()}
            >
              Move saved take to Trash
            </button>
          </div>
        </Show>
        <Show when={state() === "recording" || state() === "paused"}>
          <button class="button button-outline" type="button" onClick={() => void togglePause()}>
            {state() === "paused" ? "Resume recording" : "Pause recording"}
          </button>
          <button class="button button-outline" type="button" onClick={() => void stop()}>
            Stop and save
          </button>
          <button class="button button-outline" type="button" onClick={() => void discardActive()}>
            Discard take
          </button>
        </Show>
        <Show when={state() === "paused"}>
          <span role="status">Recording paused; microphone muted.</span>
        </Show>
        <Show when={state() === "pausing" || state() === "resuming"}>
          <span role="status">Changing recording state…</span>
        </Show>
        <Show when={state() === "requesting"}>
          <span role="status">Waiting for microphone permission…</span>
        </Show>
        <Show when={state() === "stopping" || state() === "saving"}>
          <span role="status">Preparing recording…</span>
        </Show>
        <Show when={state() === "idle" && pending()}>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled}
            onClick={() => {
              const capture = pending();
              if (capture) void save(capture);
            }}
          >
            Retry saving
          </button>
          <button
            class="button button-outline"
            type="button"
            onClick={() => {
              setPending(undefined);
              setError("");
            }}
          >
            Discard recording
          </button>
        </Show>
      </div>
      <Show when={status()}>
        <p role="status">{status()}</p>
      </Show>
      <Show when={error()}>
        <p role="alert">{error()}</p>
      </Show>
    </section>
  );
}

function incrementCounter(value: string | undefined): string {
  if (value === undefined || value === "") return "1";
  if (!/^\d+$/u.test(value)) throw new Error("The saved microphone resume count is invalid.");
  const current = BigInt(value);
  if (current >= 18_446_744_073_709_551_615n)
    throw new Error("The saved microphone resume count exceeds the supported range.");
  return (current + 1n).toString();
}

import { createSignal, onCleanup, Show, untrack } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import { makeMicrophoneRecordingRecords } from "./domain/microphone-recording";
import { startMicrophoneCapture, type ActiveMicrophoneCapture } from "./platform/audio-capture";

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

/** Capture a microphone take and save it as ordinary archive PCM tracks. */
export function MicrophoneTrackRecorder(props: Props) {
  const [consent, setConsent] = createSignal(false);
  const [state, setState] = createSignal<
    "idle" | "requesting" | "recording" | "pausing" | "paused" | "resuming" | "stopping" | "saving"
  >("idle");
  const [pending, setPending] = createSignal<PendingCapture>();
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  let recorder: ActiveMicrophoneCapture | undefined;
  let consentAtUs = "";
  let sessionId = "";
  let archiveId = "";
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    void recorder?.discard();
  });

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
      const result = await active.stop();
      if (disposed) return;
      const capture = {
        ...result,
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

  const start = async () => {
    if (!consent() || props.disabled || pending()) return;
    setState("requesting");
    setError("");
    setStatus("");
    sessionId = props.session.id;
    archiveId = props.snapshot.header.id;
    consentAtUs = (BigInt(Date.now()) * 1000n).toString();
    try {
      const active = await startMicrophoneCapture({
        consentConfirmed: consent(),
        consentAtUs,
        onLimit: () => void untrack(() => stop("Recording stopped at the memory limit.")),
        onDeviceEnded: () =>
          void untrack(() => stop("Microphone disconnected; saving captured audio.")),
      });
      if (
        disposed ||
        props.session.id !== sessionId ||
        props.snapshot.header.id !== archiveId ||
        props.disabled
      ) {
        await active.discard();
        if (!disposed) setError("The session changed before microphone access was granted.");
        return;
      }
      recorder = active;
      setState("recording");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && state() === "requesting") setState("idle");
    }
  };

  return (
    <section class="transcript-capture-panel" aria-label="Record a session track">
      <div class="transcript-capture-copy">
        <strong>Record a microphone track</strong>
        <p>Save a recording as a session take for playback, mixing, and transcription.</p>
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
            Start recording
          </button>
        </Show>
        <Show when={state() === "recording" || state() === "paused"}>
          <button class="button button-outline" type="button" onClick={() => void togglePause()}>
            {state() === "paused" ? "Resume recording" : "Pause recording"}
          </button>
          <button class="button button-outline" type="button" onClick={() => void stop()}>
            Stop and save
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

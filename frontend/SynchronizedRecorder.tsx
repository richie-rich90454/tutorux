import { createSignal, For, onCleanup, Show, untrack } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import {
  makeSynchronizedRecordingRecords,
  SynchronizedRecording,
} from "./domain/synchronized-recording";

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
interface Pending {
  files: [File, File];
  sessionId: string;
  archiveId: string;
  startedAtUs: string;
  consentAtUs: string;
}

/** Capture two aligned sources into a single session take. */
export function SynchronizedRecorder(props: Props) {
  const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = createSignal("");
  const [consent, setConsent] = createSignal(false);
  const [state, setState] = createSignal<"idle" | "requesting" | "recording" | "saving">("idle");
  const [pending, setPending] = createSignal<Pending>();
  const [error, setError] = createSignal("");
  const [status, setStatus] = createSignal("");
  let active: SynchronizedRecording | undefined;
  let disposed = false;
  let capture: Omit<Pending, "files">;
  onCleanup(() => {
    disposed = true;
    void active?.discard();
  });
  const refresh = async () => {
    try {
      setDevices(
        (await navigator.mediaDevices.enumerateDevices()).filter(
          (device) => device.kind === "audioinput",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const save = async (item: Pending) => {
    if (
      props.disabled ||
      props.session.id !== item.sessionId ||
      props.snapshot.header.id !== item.archiveId
    ) {
      setError("Select the original archive and session to save this recording.");
      return;
    }
    setState("saving");
    setError("");
    try {
      const snapshot = props.snapshot;
      const session = props.session;
      const records = await makeSynchronizedRecordingRecords({
        session,
        files: item.files,
        knownTrackIds: props.trackIds,
        startedAtUs: item.startedAtUs,
        consentAtUs: item.consentAtUs,
      });
      if (props.snapshot !== snapshot || props.session !== session)
        throw new Error(
          "The archive changed while preparing the recording. Save again to use the latest session.",
        );
      if (await props.onSave(records, "Synchronized recording saved.", snapshot)) {
        setPending(undefined);
        setStatus("Both tracks were saved in one recording take.");
      } else
        setError("The recording could not be saved. Retry saving while this view remains open.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed) setState("idle");
    }
  };
  const stop = async (message = "") => {
    if (!active || state() !== "recording") return;
    const recorder = active;
    active = undefined;
    setState("saving");
    try {
      const files = await recorder.stop();
      if (disposed) return;
      const item = { ...capture, files };
      setPending(item);
      setStatus(message);
      await save(item);
    } catch (cause) {
      if (!disposed) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("idle");
      }
    }
  };
  const start = async () => {
    if (!consent() || props.disabled || pending()) return;
    setState("requesting");
    setError("");
    setStatus("");
    capture = {
      sessionId: props.session.id,
      archiveId: props.snapshot.header.id,
      consentAtUs: (BigInt(Date.now()) * 1000n).toString(),
      startedAtUs: "",
    };
    try {
      const recorder = await SynchronizedRecording.start(
        deviceId(),
        () => void untrack(() => stop("Capture reached its memory limit.")),
        () => void untrack(() => stop("A source stopped; saving captured audio.")),
      );
      if (
        disposed ||
        props.disabled ||
        props.session.id !== capture.sessionId ||
        props.snapshot.header.id !== capture.archiveId
      ) {
        await recorder.discard();
        if (!disposed) setError("The session changed before capture started.");
        return;
      }
      active = recorder;
      capture.startedAtUs = (BigInt(Date.now()) * 1000n).toString();
      setState("recording");
      void refresh();
    } catch (cause) {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!disposed && state() === "requesting") setState("idle");
    }
  };
  return (
    <section class="transcript-capture-panel" aria-label="Synchronized audio recording">
      <div class="transcript-capture-copy">
        <strong>Record microphone and shared audio</strong>
        <p>
          Capture two aligned tracks. Choose a screen or window and enable audio sharing when
          prompted. Video is not saved.
        </p>
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
          onClick={() => void refresh()}
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
            disabled={!consent() || props.disabled}
            onClick={() => void start()}
          >
            Start synchronized recording
          </button>
        </Show>
        <Show when={state() === "recording"}>
          <button class="button button-outline" type="button" onClick={() => void stop()}>
            Stop and save
          </button>
        </Show>
        <Show when={state() === "requesting"}>
          <span role="status">Waiting for source permissions…</span>
        </Show>
        <Show when={state() === "saving"}>
          <span role="status">Preparing recording…</span>
        </Show>
        <Show when={state() === "idle" && pending()}>
          <button
            class="button button-primary"
            type="button"
            onClick={() => {
              const item = pending();
              if (item) void save(item);
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

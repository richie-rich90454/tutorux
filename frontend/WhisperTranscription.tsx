import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createSignal, Show } from "solid-js";
import type { ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import type { AudioPreview } from "./domain/audio";
import { makeWhisperRecords, whisperAudio } from "./domain/whisper";

interface Props {
  snapshot: ArchiveSnapshot;
  preview: AudioPreview;
  sessionId: string;
  trackId: string;
  records: readonly ArchiveRecord[];
  disabled: boolean;
  onSave: (
    records: ArchiveRecord[],
    message: string,
    snapshot: ArchiveSnapshot,
  ) => Promise<boolean>;
}

/** Transcribe the currently loaded audio preview using a locally supplied Whisper runtime. */
export function WhisperTranscription(props: Props) {
  const [executable, setExecutable] = createSignal("");
  const [model, setModel] = createSignal("");
  const [language, setLanguage] = createSignal("auto");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  const choose = async (kind: "executable" | "model") => {
    try {
      const path = await open({
        multiple: false,
        directory: false,
        title: kind === "model" ? "Choose a Whisper model" : "Choose the whisper.cpp executable",
      });
      if (typeof path === "string") (kind === "model" ? setModel : setExecutable)(path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const transcribe = async () => {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const preview = props.preview;
      const snapshot = props.snapshot;
      const sessionId = props.sessionId;
      const trackId = props.trackId;
      const output = await invoke<{ json: string; modelName: string }>("transcribe_whisper", {
        executable: executable(),
        model: model(),
        wav: Array.from(whisperAudio(preview)),
        language: language().trim(),
      });
      if (
        props.snapshot !== snapshot ||
        props.preview !== preview ||
        props.sessionId !== sessionId ||
        props.trackId !== trackId
      ) {
        throw new Error("The selected audio changed during transcription. Load it again to retry.");
      }
      const result = makeWhisperRecords({
        json: output.json,
        sessionId,
        trackId,
        modelName: output.modelName,
        language: language().trim(),
        preview,
        existing: props.records,
      });
      if (!result.records.length) {
        setMessage(
          `No new cues were found${result.skipped ? `; ${result.skipped} overlapped protected or out-of-range audio` : ""}.`,
        );
        return;
      }
      if (
        await props.onSave(
          result.records,
          `Saved ${result.records.length} provisional Whisper cues.`,
          snapshot,
        )
      ) {
        setMessage(
          `Saved ${result.records.length} provisional cues${result.skipped ? `; skipped ${result.skipped} protected or out-of-range cues` : ""}. Review them before reuse.`,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="transcript-whisper">
      <strong>Local transcription</strong>
      <Show
        when={isTauri()}
        fallback={<p>Local Whisper transcription is available in the desktop app.</p>}
      >
        <p>
          Transcribe the loaded preview on this device using your whisper.cpp executable and model.
          Review the resulting cues.
        </p>
        <div class="transcript-whisper-actions">
          <button
            class="button button-outline"
            type="button"
            disabled={busy()}
            onClick={() => void choose("executable")}
          >
            {executable() ? "Change Whisper executable" : "Choose Whisper executable"}
          </button>
          <button
            class="button button-outline"
            type="button"
            disabled={busy()}
            onClick={() => void choose("model")}
          >
            {model() ? "Change model" : "Choose model"}
          </button>
          <label>
            Language{" "}
            <input
              value={language()}
              disabled={busy()}
              onInput={(event) => setLanguage(event.currentTarget.value)}
              aria-label="Whisper language code"
            />
          </label>
          <button
            class="button button-primary"
            type="button"
            disabled={props.disabled || busy() || !executable() || !model()}
            onClick={() => void transcribe()}
          >
            {busy() ? "Transcribing…" : "Transcribe preview"}
          </button>
        </div>
        <Show when={message()}>
          <p role="status">{message()}</p>
        </Show>
        <Show when={error()}>
          <p role="alert">{error()}</p>
        </Show>
      </Show>
    </div>
  );
}

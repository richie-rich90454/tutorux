import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { createSignal, onCleanup, Show } from "solid-js";
import { newUuid } from "./archive/format";
import type { ArchiveRecord } from "./archive/format";
import type { ArchiveSnapshot } from "./archive/archive";
import { buildAudioPreview, type AudioPreview } from "./domain/audio";
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
  const [fullTrack, setFullTrack] = createSignal(false);
  const [refine, setRefine] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [error, setError] = createSignal("");
  let runId: string | undefined;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    if (runId) void invoke("cancel_whisper_run", { runId }).catch(() => undefined);
  };
  onCleanup(cancel);
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
    cancelled = false;
    try {
      const preview = props.preview;
      const snapshot = props.snapshot;
      const sessionId = props.sessionId;
      const trackId = props.trackId;
      const selectedLanguage = language().trim();
      const selectedExecutable = executable();
      const selectedModel = model();
      const replacement = refine();
      const wholeTrack = fullTrack();
      const existing = props.records;
      const provenanceRunId = newUuid();
      let endUs = 0n;
      let windowUs = 20_000_000n;
      if (wholeTrack) {
        const chunks = await snapshot.listAudioChunkMetadata(sessionId, trackId);
        const last = chunks.at(-1);
        const firstFrame = last?.fields.get("first_sample_index") ?? "";
        const frameCount = last?.fields.get("sample_count") ?? "";
        const rate = last?.fields.get("sample_rate_hz") ?? "";
        const channels = last?.fields.get("channel_count") ?? "";
        if (
          !/^\d+$/.test(firstFrame) ||
          !/^\d+$/.test(frameCount) ||
          !/^\d+$/.test(rate) ||
          !/^\d+$/.test(channels) ||
          BigInt(rate) === 0n ||
          BigInt(channels) === 0n
        ) {
          throw new Error("The selected recording has invalid audio metadata.");
        }
        endUs =
          ((BigInt(firstFrame) + BigInt(frameCount)) * 1_000_000n + BigInt(rate) - 1n) /
          BigInt(rate);
        const seconds = (28n * 1024n * 1024n) / (BigInt(rate) * BigInt(channels) * 2n);
        if (seconds < 1n)
          throw new Error("This recording format exceeds the transcription window limit.");
        windowUs = (seconds < 20n ? seconds : 20n) * 1_000_000n;
      }
      runId = await invoke<string>("begin_whisper_run");
      if (cancelled) {
        await invoke("cancel_whisper_run", { runId });
        throw new Error("Transcription cancelled.");
      }
      const changes = new Map<string, ArchiveRecord>();
      let skipped = 0;
      let cursor = 0n;
      let windows = 0;
      do {
        if (cancelled) throw new Error("Transcription cancelled.");
        const current = wholeTrack
          ? await buildAudioPreview(snapshot, sessionId, trackId, cursor, cursor + windowUs)
          : preview;
        const output = await invoke<{ json: string; modelName: string }>("transcribe_whisper", {
          runId,
          executable: selectedExecutable,
          model: selectedModel,
          wav: Array.from(whisperAudio(current)),
          language: selectedLanguage,
        });
        if (cancelled) throw new Error("Transcription cancelled.");
        if (
          props.snapshot !== snapshot ||
          props.preview !== preview ||
          props.sessionId !== sessionId ||
          props.trackId !== trackId
        ) {
          throw new Error(
            "The selected audio or archive changed during transcription. Load it again to retry.",
          );
        }
        const result = makeWhisperRecords({
          json: output.json,
          sessionId,
          trackId,
          modelName: output.modelName,
          language: selectedLanguage,
          preview: current,
          existing,
          replaceProvisional: replacement,
          runId: provenanceRunId,
        });
        for (const record of result.records) changes.set(record.id, record);
        if (changes.size > 100_000)
          throw new Error("The transcription produced too many cues for one operation.");
        skipped += result.skipped;
        windows++;
        cursor += windowUs;
        if (wholeTrack)
          setMessage(
            `Processed ${windows} audio windows. Results will be saved together when complete.`,
          );
      } while (wholeTrack && cursor < endUs);
      const records = [...changes.values()];
      if (!records.length) {
        setMessage(
          `No new cues were found${skipped ? `; ${skipped} overlapped protected or out-of-range audio` : ""}.`,
        );
        return;
      }
      if (await props.onSave(records, `Saved local transcription.`, snapshot)) {
        setMessage(
          `Saved transcription${skipped ? `; skipped ${skipped} protected or out-of-range cues` : ""}. Review provisional cues before reuse.`,
        );
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      if (runId) await invoke("end_whisper_run", { runId }).catch(() => undefined);
      runId = undefined;
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
          Transcribe locally using your whisper.cpp executable and model. Review the resulting cues.
        </p>
        <div class="transcript-whisper-actions">
          <label>
            <input
              type="checkbox"
              checked={fullTrack()}
              disabled={busy()}
              onChange={(event) => setFullTrack(event.currentTarget.checked)}
            />{" "}
            Entire track
          </label>
          <label>
            <input
              type="checkbox"
              checked={refine()}
              disabled={busy()}
              onChange={(event) => setRefine(event.currentTarget.checked)}
            />{" "}
            Replace provisional Whisper cues
          </label>
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
            {busy() ? "Transcribing…" : fullTrack() ? "Transcribe track" : "Transcribe preview"}
          </button>
          <Show when={busy()}>
            <button class="button button-outline" type="button" onClick={cancel}>
              Cancel transcription
            </button>
          </Show>
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

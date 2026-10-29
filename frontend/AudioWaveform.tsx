import { createMemo, createSignal, For } from "solid-js";
import type { AudioPreview } from "./domain/audio";
import "./audio-waveform.css";

interface AudioWaveformProps {
  preview: AudioPreview;
  url: string;
  onPlayer: (player: HTMLAudioElement) => void;
}

/** Show the audio already loaded for the bounded transcript preview. */
export function AudioWaveform(props: AudioWaveformProps) {
  let player: HTMLAudioElement | undefined;
  const [position, setPosition] = createSignal(0);
  const peaks = createMemo(() => {
    const preview = props.preview;
    const count = Math.min(180, preview.frameCount);
    if (!count || !preview.channelCount) return [];
    const samples = new DataView(
      preview.wav.buffer,
      preview.wav.byteOffset,
      preview.wav.byteLength,
    );
    const result = new Array<number>(count).fill(0);
    for (let frame = 0; frame < preview.frameCount; frame++) {
      const bucket = Math.min(count - 1, Math.floor((frame * count) / preview.frameCount));
      for (let channel = 0; channel < preview.channelCount; channel++) {
        const offset = 44 + (frame * preview.channelCount + channel) * 2;
        if (offset + 2 > samples.byteLength) break;
        result[bucket] = Math.max(
          result[bucket]!,
          Math.abs(samples.getInt16(offset, true)) / 32768,
        );
      }
    }
    return result;
  });
  const duration = () => Number(props.preview.durationUs) / 1_000_000;

  return (
    <div class="audio-waveform">
      <div class="audio-waveform-visual" aria-hidden="true">
        <For each={peaks()}>
          {(peak, index) => (
            <span
              classList={{ played: index() / peaks().length < position() / (duration() || 1) }}
              style={{ height: `${Math.max(5, peak * 100)}%` }}
            />
          )}
        </For>
      </div>
      <input
        class="audio-waveform-seek"
        type="range"
        min="0"
        max={duration() || 0}
        step="1"
        value={Math.min(position(), duration())}
        aria-label="Seek through audio preview"
        aria-keyshortcuts="ArrowLeft ArrowDown ArrowRight ArrowUp Shift+ArrowLeft Shift+ArrowDown Shift+ArrowRight Shift+ArrowUp"
        title="Use arrow keys to seek; Shift + arrow keys moves 10 seconds."
        onKeyDown={(event) => {
          if (!event.shiftKey) return;
          const direction =
            event.key === "ArrowLeft" || event.key === "ArrowDown"
              ? -1
              : event.key === "ArrowRight" || event.key === "ArrowUp"
                ? 1
                : 0;
          if (direction === 0) return;
          event.preventDefault();
          const time = Math.max(
            0,
            Math.min(duration(), Number(event.currentTarget.value) + direction * 10),
          );
          event.currentTarget.value = String(time);
          if (player) player.currentTime = time;
          setPosition(time);
        }}
        onInput={(event) => {
          const time = Number(event.currentTarget.value);
          if (player) player.currentTime = time;
          setPosition(time);
        }}
      />
      <audio
        ref={(element) => {
          player = element;
          props.onPlayer(element);
        }}
        src={props.url}
        controls
        preload="metadata"
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onSeeked={(event) => setPosition(event.currentTarget.currentTime)}
      >
        Audio playback is not supported by this WebView.
      </audio>
    </div>
  );
}

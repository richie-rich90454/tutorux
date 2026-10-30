import { For, createSignal, type JSX } from "solid-js";
import type { PcmWavAssetWaveform } from "./domain/asset-waveform";

export function MaterialAudioPreview(props: {
    waveform: PcmWavAssetWaveform;
    url: string;
}): JSX.Element {
    const [position, setPosition] = createSignal(0);
    let player: HTMLAudioElement | undefined;
    const duration = () => props.waveform.durationSeconds;
    const timeLabel = (time: number) => {
        const wholeSeconds = Math.max(0, Math.floor(time));
        const minutes = Math.floor(wholeSeconds / 60);
        return `${minutes}:${String(wholeSeconds % 60).padStart(2, "0")}`;
    };
    const seek = (time: number) => {
        const next = Math.max(0, Math.min(duration(), time));
        if (player) player.currentTime = next;
        setPosition(next);
    };

    return (
        <div class="material-audio-preview">
            <div class="material-audio-waveform" aria-hidden="true">
                <For each={props.waveform.buckets}>
                    {(bucket) => (
                        <span
                            classList={{ played: bucket.position < position() / (duration() || 1) }}
                            style={{
                                height: `${Math.max(5, Math.max(Math.abs(bucket.minimum), Math.abs(bucket.maximum)) * 100)}%`,
                            }}
                        />
                    )}
                </For>
            </div>
            <input
                class="material-audio-seek"
                type="range"
                min="0"
                max={duration()}
                step="0.1"
                value={Math.min(position(), duration())}
                aria-label="Seek through material audio"
                aria-valuetext={`${timeLabel(position())} of ${timeLabel(duration())}`}
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
                    seek(Number(event.currentTarget.value) + direction * 10);
                }}
                onInput={(event) => seek(Number(event.currentTarget.value))}
            />
            <audio
                ref={(element) => (player = element)}
                src={props.url}
                controls
                preload="metadata"
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onSeeked={(event) => setPosition(event.currentTarget.currentTime)}
                onEnded={() => setPosition(duration())}
            >
                Audio playback is not supported by this WebView.
            </audio>
            <p class="material-audio-metadata">
                PCM WAV · {props.waveform.sampleRateHz.toLocaleString()} Hz ·{" "}
                {props.waveform.channelCount}{" "}
                {props.waveform.channelCount === 1 ? "channel" : "channels"} ·{" "}
                {props.waveform.bitsPerSample} bit · {timeLabel(duration())}
                {props.waveform.silent ? " · This audio is silent." : ""}
            </p>
        </div>
    );
}

import { createMemo, createSignal, For, Show } from "solid-js";
import type { AudioPreview } from "./domain/audio";
import { Icon } from "./shared-ui";
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
    const [playing, setPlaying] = createSignal(false);
    const [muted, setMuted] = createSignal(false);
    const [volume, setVolume] = createSignal(1);
    const [error, setError] = createSignal("");
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
    const timeLabel = (time: number) => {
        const seconds = Math.max(0, Math.floor(time));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    };

    return (
        <div class="audio-waveform">
            <div class="audio-waveform-visual" aria-hidden="true">
                <For each={peaks()}>
                    {(peak, index) => (
                        <span
                            classList={{
                                played: index() / peaks().length < position() / (duration() || 1),
                            }}
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
            <div class="audio-waveform-controls">
                <button
                    class="audio-waveform-play"
                    type="button"
                    aria-label={playing() ? "Pause audio preview" : "Play audio preview"}
                    onClick={() => {
                        if (!player) return;
                        if (player.paused) {
                            setError("");
                            void player.play().catch(() => {
                                setPlaying(false);
                                setError("Audio preview playback could not start.");
                            });
                        } else player.pause();
                    }}
                >
                    <Icon name={playing() ? "pause" : "play"} />
                </button>
                <span class="audio-waveform-time">{timeLabel(position())}</span>
                <span class="audio-waveform-time">{timeLabel(duration())}</span>
                <button
                    class="audio-waveform-volume-toggle"
                    type="button"
                    aria-label={muted() || volume() === 0 ? "Unmute" : "Mute"}
                    aria-pressed={muted()}
                    onClick={() => {
                        const wasMuted = muted();
                        if (wasMuted && volume() === 0) {
                            setVolume(0.5);
                            if (player) player.volume = 0.5;
                        }
                        setMuted(!wasMuted);
                        if (player) player.muted = !wasMuted;
                    }}
                >
                    <Icon name={muted() || volume() === 0 ? "volumeMuted" : "volume"} />
                </button>
                <input
                    class="audio-waveform-volume"
                    type="range"
                    min="0"
                    max="1"
                    step="0.05"
                    value={volume()}
                    aria-label="Volume"
                    onInput={(event) => {
                        const next = Number(event.currentTarget.value);
                        setVolume(next);
                        setMuted(next === 0);
                        if (player) {
                            player.volume = next;
                            player.muted = next === 0;
                        }
                    }}
                />
            </div>
            <audio
                class="audio-waveform-source"
                ref={(element) => {
                    player = element;
                    element.volume = volume();
                    element.muted = muted();
                    props.onPlayer(element);
                }}
                src={props.url}
                preload="metadata"
                aria-hidden="true"
                tabIndex={-1}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onSeeked={(event) => setPosition(event.currentTarget.currentTime)}
                onEnded={() => setPlaying(false)}
                onError={() => setError("Audio preview could not be decoded for playback.")}
            />
            <Show when={error()}>
                <p class="audio-waveform-error" role="alert">
                    {error()}
                </p>
            </Show>
        </div>
    );
}

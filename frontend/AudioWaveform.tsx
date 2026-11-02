import { cn } from "./ui";
import { createMemo, createSignal, For, Show } from "solid-js";
import type { AudioPreview } from "./domain/audio";
import { Icon } from "./shared-ui";

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
        <div class={cn("audio-waveform", "grid gap-[0.5rem] min-w-[min(100%,_18rem)]")}>
            <div
                class={cn(
                    "audio-waveform-visual",
                    "items-center bg-surface-inset rounded-[5px] flex gap-px h-[3.5rem] overflow-hidden p-[0.35rem]",
                )}
                aria-hidden="true"
            >
                <For each={peaks()}>
                    {(peak, index) => (
                        <span
                            class="bg-line-strong rounded-[5px] flex-1 min-w-[1px] [.audio-waveform-visual_span&:where(.played)]:bg-accent"
                            classList={{
                                played: index() / peaks().length < position() / (duration() || 1),
                            }}
                            style={{ height: `${Math.max(5, peak * 100)}%` }}
                        />
                    )}
                </For>
            </div>
            <input
                class={cn(
                    "audio-waveform-seek",
                    "accent-accent m-0 w-full focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)]",
                )}
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
            <div
                class={cn(
                    "audio-waveform-controls",
                    "max-[520px]:grid-cols-[32px_auto_minmax(24px,_1fr)_30px] items-center grid gap-2 grid-cols-[32px_auto_minmax(28px,_1fr)_30px_68px] min-h-[38px]",
                )}
            >
                <button
                    class={cn(
                        "audio-waveform-play",
                        "bg-surface rounded-[7px] border border-line cursor-pointer grid h-[30px] p-0 place-items-center w-[30px] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                    )}
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
                <span class={cn("audio-waveform-time", "text-muted text-[11px] tabular-nums")}>
                    {timeLabel(position())}
                </span>
                <span class={cn("audio-waveform-time", "text-muted text-[11px] tabular-nums")}>
                    {timeLabel(duration())}
                </span>
                <button
                    class={cn(
                        "audio-waveform-volume-toggle",
                        "bg-transparent rounded-[7px] border border-transparent cursor-pointer grid h-[30px] p-0 place-items-center w-[30px] hover:bg-accent-soft hover:text-[var(--accent-deep)] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                    )}
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
                    class={cn(
                        "audio-waveform-volume",
                        "max-[520px]:hidden accent-accent h-[4px] m-0 min-w-0 w-full focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)]",
                    )}
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
                class={cn(
                    "audio-waveform-source",
                    "[clip-path:inset(50%)] h-[1px] overflow-hidden absolute whitespace-nowrap w-[1px]",
                )}
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
                <p class={cn("audio-waveform-error", "text-danger text-xs m-0")} role="alert">
                    {error()}
                </p>
            </Show>
        </div>
    );
}

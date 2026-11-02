import { For, Show, createSignal, type JSX } from "solid-js";
import type { PcmWavAssetWaveform } from "./domain/asset-waveform";
import { Icon } from "./shared-ui";
import { cn, errorText, mutedText } from "./ui";

export function MaterialAudioPreview(props: {
    waveform: PcmWavAssetWaveform;
    url: string;
}): JSX.Element {
    const [position, setPosition] = createSignal(0);
    const [playing, setPlaying] = createSignal(false);
    const [muted, setMuted] = createSignal(false);
    const [volume, setVolume] = createSignal(1);
    const [error, setError] = createSignal("");
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
        <div class="material-audio-preview grid w-full max-w-[680px] gap-2.5">
            <div
                class="material-audio-waveform flex h-[74px] items-center justify-between gap-0.5 overflow-hidden rounded-[5px] border border-line bg-surface p-2.5"
                aria-hidden="true"
            >
                <For each={props.waveform.buckets}>
                    {(bucket) => {
                        const played = () => bucket.position < position() / (duration() || 1);
                        return (
                            <span
                                class={cn(
                                    "min-w-0.5 flex-1 rounded-[5px] transition-colors",
                                    played() ? "played bg-accent" : "bg-line-strong",
                                )}
                                style={{
                                    height: `${Math.max(5, Math.max(Math.abs(bucket.minimum), Math.abs(bucket.maximum)) * 100)}%`,
                                }}
                            />
                        );
                    }}
                </For>
            </div>
            <input
                class="material-audio-seek w-full accent-accent"
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
            <div class="audio-waveform-controls grid min-h-[38px] grid-cols-[32px_auto_minmax(28px,1fr)_30px_68px] items-center gap-2 max-[520px]:grid-cols-[32px_auto_minmax(24px,1fr)_30px]">
                <button
                    class="audio-waveform-play grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-line bg-surface text-accent transition-colors hover:bg-surface-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    type="button"
                    aria-label={playing() ? "Pause material audio" : "Play material audio"}
                    onClick={() => {
                        if (!player) return;
                        if (player.paused) {
                            setError("");
                            void player.play().catch(() => {
                                setPlaying(false);
                                setError("Material audio playback could not start.");
                            });
                        } else player.pause();
                    }}
                >
                    <Icon name={playing() ? "pause" : "play"} />
                </button>
                <span class="audio-waveform-time text-xs tabular-nums text-muted">
                    {timeLabel(position())}
                </span>
                <span class="audio-waveform-time text-xs tabular-nums text-muted">
                    {timeLabel(duration())}
                </span>
                <button
                    class="audio-waveform-volume-toggle grid h-[30px] w-[30px] place-items-center rounded-[5px] border border-transparent text-muted transition-colors hover:bg-surface-subtle hover:text-ink aria-pressed:bg-accent-soft aria-pressed:text-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                    class="audio-waveform-volume w-full min-w-0 accent-accent max-[520px]:hidden"
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
                class="audio-waveform-source sr-only"
                ref={(element) => {
                    player = element;
                    element.volume = volume();
                    element.muted = muted();
                }}
                src={props.url}
                preload="metadata"
                aria-hidden="true"
                tabIndex={-1}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                onSeeked={(event) => setPosition(event.currentTarget.currentTime)}
                onEnded={() => {
                    setPosition(duration());
                    setPlaying(false);
                }}
                onError={() => setError("This audio could not be decoded for playback.")}
            />
            <Show when={error()}>
                <p class={cn("audio-waveform-error m-0", errorText)} role="alert">
                    {error()}
                </p>
            </Show>
            <p class={cn("material-audio-metadata m-0 text-center", mutedText)}>
                PCM WAV · {props.waveform.sampleRateHz.toLocaleString("en-US")} Hz ·{" "}
                {props.waveform.channelCount}{" "}
                {props.waveform.channelCount === 1 ? "channel" : "channels"} ·{" "}
                {props.waveform.bitsPerSample} bit · {timeLabel(duration())}
                {props.waveform.silent ? " · This audio is silent." : ""}
            </p>
        </div>
    );
}

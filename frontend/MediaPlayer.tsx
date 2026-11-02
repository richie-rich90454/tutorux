import { cn } from "./ui";
import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "./shared-ui";

interface MediaPlayerProps {
    src: string;
    kind: "audio" | "video";
    label: string;
    autoPlay?: boolean;
}

function formatTime(seconds: number): string {
    const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const hours = Math.floor(wholeSeconds / 3600);
    const minutes = Math.floor((wholeSeconds % 3600) / 60);
    const remainder = wholeSeconds % 60;
    return hours > 0
        ? hours + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0")
        : minutes + ":" + String(remainder).padStart(2, "0");
}

export function MediaPlayer(props: MediaPlayerProps): JSX.Element {
    const [position, setPosition] = createSignal(0);
    const [duration, setDuration] = createSignal(0);
    const [playing, setPlaying] = createSignal(false);
    const [muted, setMuted] = createSignal(false);
    const [volume, setVolume] = createSignal(1);
    const [error, setError] = createSignal("");
    let media: HTMLAudioElement | HTMLVideoElement | undefined;
    let disposed = false;

    onCleanup(() => {
        disposed = true;
        media?.pause();
    });

    createEffect(() => {
        const source = props.src;
        setPosition(0);
        setDuration(0);
        setPlaying(false);
        setError("");
        if (media) {
            media.pause();
            media.currentTime = 0;
            if (media.getAttribute("src") !== source) media.src = source;
            if (props.autoPlay) {
                void media.play().catch((reason: unknown) => {
                    if (!disposed) setError(mediaError(reason));
                });
            }
        }
    });

    async function togglePlayback(): Promise<void> {
        if (!media) return;
        if (media.paused) {
            setError("");
            try {
                await media.play();
            } catch (reason) {
                setError(mediaError(reason));
            }
        } else {
            media.pause();
        }
    }

    function seek(value: number): void {
        if (!media) return;
        const next = Math.max(0, Math.min(duration(), value));
        media.currentTime = next;
        setPosition(next);
    }

    function setPlayer(element: HTMLAudioElement | HTMLVideoElement): void {
        media = element;
        element.volume = volume();
        element.muted = muted();
    }

    function updateDuration(value: number): void {
        setDuration(Number.isFinite(value) ? Math.max(0, value) : 0);
    }

    return (
        <div class={cn("media-player media-player-" + props.kind, "grid gap-[9px] min-w-0")}>
            <Show
                when={props.kind === "audio"}
                fallback={
                    <video
                        ref={(element) => setPlayer(element)}
                        src={props.src}
                        preload="metadata"
                        playsinline
                        aria-label={props.label}
                        onLoadedMetadata={(event) => updateDuration(event.currentTarget.duration)}
                        onDurationChange={(event) => updateDuration(event.currentTarget.duration)}
                        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                        onEnded={() => setPlaying(false)}
                        onError={() => setError("This video could not be played.")}
                        class="bg-[#0b1010] rounded-lg max-h-[min(62vh,_560px)] object-contain w-full"
                    />
                }
            >
                <audio
                    ref={(element) => setPlayer(element)}
                    src={props.src}
                    preload="metadata"
                    aria-hidden="true"
                    tabIndex={-1}
                    onLoadedMetadata={(event) => updateDuration(event.currentTarget.duration)}
                    onDurationChange={(event) => updateDuration(event.currentTarget.duration)}
                    onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
                    onPlay={() => setPlaying(true)}
                    onPause={() => setPlaying(false)}
                    onEnded={() => {
                        setPosition(duration());
                        setPlaying(false);
                    }}
                    onError={() => setError("This audio could not be played.")}
                    class="[clip-path:inset(50%)] h-[1px] overflow-hidden absolute whitespace-nowrap w-[1px]"
                />
            </Show>
            <div
                class={cn(
                    "media-player-controls",
                    "max-[520px]:grid-cols-[34px_auto_minmax(44px,_1fr)_auto_30px] items-center bg-surface rounded-lg border border-line-soft grid gap-2 grid-cols-[34px_auto_minmax(60px,_1fr)_auto_30px_72px] min-h-[42px] min-w-0 py-1 px-2",
                )}
                role="group"
                aria-label={props.label + " controls"}
            >
                <button
                    class={cn(
                        "media-player-play",
                        "focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] hover:bg-accent-soft hover:text-[var(--accent-deep)] aria-pressed:bg-accent-soft aria-pressed:text-[var(--accent-deep)] bg-transparent rounded-md border-0 cursor-pointer grid h-[32px] p-0 place-items-center w-[32px] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                    )}
                    type="button"
                    aria-label={(playing() ? "Pause " : "Play ") + props.kind}
                    onClick={() => void togglePlayback()}
                >
                    <Icon name={playing() ? "pause" : "play"} />
                </button>
                <span
                    class={cn(
                        "media-player-time",
                        "text-muted text-[11px] tabular-nums min-w-[34px] text-center",
                    )}
                    aria-live="off"
                >
                    {formatTime(position())}
                </span>
                <input
                    class={cn(
                        "media-player-seek",
                        "[&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[2px] [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--accent)] [&::-moz-range-thumb]:h-[9px] [&::-moz-range-thumb]:w-[9px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[2px] [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--accent)] [&::-webkit-slider-thumb]:h-[12px] [&::-webkit-slider-thumb]:w-[12px] appearance-none bg-line-strong rounded-[99px] cursor-pointer h-[4px] m-0 min-w-0 w-full disabled:opacity-45 focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)]",
                    )}
                    type="range"
                    min="0"
                    max={duration() || 0}
                    step="0.1"
                    value={Math.min(position(), duration())}
                    aria-label={"Seek through " + props.kind}
                    aria-valuetext={formatTime(position()) + " of " + formatTime(duration())}
                    disabled={!duration()}
                    onInput={(event) => seek(Number(event.currentTarget.value))}
                />
                <span
                    class={cn(
                        "media-player-time",
                        "text-muted text-[11px] tabular-nums min-w-[34px] text-center",
                    )}
                >
                    {formatTime(duration())}
                </span>
                <button
                    class={cn(
                        "media-player-volume-toggle",
                        "focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] hover:bg-accent-soft hover:text-[var(--accent-deep)] aria-pressed:bg-accent-soft aria-pressed:text-[var(--accent-deep)] bg-transparent rounded-md border-0 cursor-pointer grid h-[32px] p-0 place-items-center w-[32px] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                    )}
                    type="button"
                    aria-label={muted() || volume() === 0 ? "Unmute" : "Mute"}
                    aria-pressed={muted()}
                    onClick={() => {
                        const wasMuted = muted();
                        if (wasMuted && volume() === 0) setVolume(0.5);
                        const nextMuted = !wasMuted;
                        setMuted(nextMuted);
                        if (media) {
                            if (wasMuted && media.volume === 0) media.volume = 0.5;
                            media.muted = nextMuted;
                        }
                    }}
                >
                    <Icon name={muted() || volume() === 0 ? "volumeMuted" : "volume"} />
                </button>
                <input
                    class={cn(
                        "media-player-volume",
                        "[&::-moz-range-thumb]:bg-accent [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[2px] [&::-moz-range-thumb]:border-surface [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--accent)] [&::-moz-range-thumb]:h-[9px] [&::-moz-range-thumb]:w-[9px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:bg-accent [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[2px] [&::-webkit-slider-thumb]:border-surface [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--accent)] [&::-webkit-slider-thumb]:h-[12px] [&::-webkit-slider-thumb]:w-[12px] max-[520px]:hidden appearance-none bg-line-strong rounded-[99px] cursor-pointer h-[4px] m-0 min-w-0 w-full focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)]",
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
                        if (media) {
                            media.volume = next;
                            media.muted = next === 0;
                        }
                    }}
                />
            </div>
            <Show when={error()}>
                <p class={cn("media-player-error", "text-danger text-xs m-0")} role="alert">
                    {error()}
                </p>
            </Show>
        </div>
    );
}

function mediaError(reason: unknown): string {
    return reason instanceof Error ? reason.message : "Playback could not start.";
}

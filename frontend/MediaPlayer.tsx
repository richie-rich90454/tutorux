import { createEffect, createSignal, onCleanup, Show, type JSX } from "solid-js";
import { Icon } from "./shared-ui";
import "./media-player.css";

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
        <div class={"media-player media-player-" + props.kind}>
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
                />
            </Show>
            <div class="media-player-controls" role="group" aria-label={props.label + " controls"}>
                <button
                    class="media-player-play"
                    type="button"
                    aria-label={(playing() ? "Pause " : "Play ") + props.kind}
                    onClick={() => void togglePlayback()}
                >
                    <Icon name={playing() ? "pause" : "play"} />
                </button>
                <span class="media-player-time" aria-live="off">
                    {formatTime(position())}
                </span>
                <input
                    class="media-player-seek"
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
                <span class="media-player-time">{formatTime(duration())}</span>
                <button
                    class="media-player-volume-toggle"
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
                    class="media-player-volume"
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
                <p class="media-player-error" role="alert">
                    {error()}
                </p>
            </Show>
        </div>
    );
}

function mediaError(reason: unknown): string {
    return reason instanceof Error ? reason.message : "Playback could not start.";
}

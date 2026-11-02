import { buttonOutline, cn } from "./ui";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import { RecordType, type ArchiveRecord } from "./archive/format";
import { formatTranscriptTimestampUs } from "./domain/transcript";
import {
    buildWaveformIndex,
    readWaveformIndex,
    waveformIndexIsCurrent,
    type WaveformBucket,
} from "./domain/waveform-index";

interface Props {
    snapshot: ArchiveSnapshot;
    sessionId: string;
    trackId: string;
    disabled: boolean;
    onSave: (record: ArchiveRecord, snapshot: ArchiveSnapshot) => Promise<boolean>;
    onSelectTime?: (timeUs: bigint) => void;
}

type IndexStatus = "loading" | "missing" | "stale" | "ready" | "invalid";

/** Display and regenerate a persisted, source-checked overview of an entire track. */
export function FullTrackWaveform(props: Props) {
    const [status, setStatus] = createSignal<IndexStatus>("loading");
    const [levels, setLevels] = createSignal<WaveformBucket[][]>([]);
    const [rate, setRate] = createSignal(0);
    const [progress, setProgress] = createSignal<number>();
    const [error, setError] = createSignal("");
    const [selection, setSelection] = createSignal(0);
    let generation = 0;
    let controller: AbortController | undefined;

    createEffect(() => {
        const snapshot = props.snapshot;
        const sessionId = props.sessionId.toLowerCase();
        const trackId = props.trackId.toLowerCase();
        const operation = ++generation;
        controller?.abort();
        setProgress(undefined);
        setStatus("loading");
        setLevels([]);
        setError("");
        setSelection(0);
        void (async () => {
            try {
                const indexes = await snapshot.listRecords(RecordType.waveformIndex);
                const index = indexes.find(
                    (candidate) =>
                        candidate.fields.get("record_role") === "waveform-pyramid" &&
                        candidate.fields.get("session_id")?.toLowerCase() === sessionId &&
                        candidate.fields.get("track_id")?.toLowerCase() === trackId,
                );
                if (generation !== operation) return;
                if (!index) {
                    setStatus("missing");
                    return;
                }
                const current = await waveformIndexIsCurrent(snapshot, index);
                if (generation !== operation) return;
                if (!current) {
                    setStatus("stale");
                    return;
                }
                const sampleRate = Number(index.fields.get("sample_rate_hz"));
                if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0)
                    throw new Error("Waveform sample rate is invalid.");
                const pyramid = readWaveformIndex(index);
                if (generation !== operation) return;
                setRate(sampleRate);
                setLevels(pyramid);
                setStatus("ready");
            } catch (cause) {
                if (generation !== operation) return;
                setStatus("invalid");
                setError(cause instanceof Error ? cause.message : String(cause));
            }
        })();
        onCleanup(() => {
            generation++;
            controller?.abort();
        });
    });

    const buckets = createMemo(() => {
        const pyramid = levels();
        if (!pyramid.length) return [];
        let chosen = pyramid[0]!;
        for (const level of pyramid) {
            if (level.length < 192) break;
            chosen = level;
        }
        return chosen;
    });
    const durationUs = () => {
        const last = levels()[0]?.at(-1);
        return last && rate() ? (last.endFrame * 1_000_000n) / BigInt(rate()) : 0n;
    };

    const generate = async () => {
        const snapshot = props.snapshot;
        const sessionId = props.sessionId;
        const trackId = props.trackId;
        const operation = generation;
        const abort = new AbortController();
        controller = abort;
        setProgress(0);
        setError("");
        try {
            const record = await buildWaveformIndex(snapshot, sessionId, trackId, {
                signal: abort.signal,
                onProgress: (fraction) => {
                    if (generation === operation && !abort.signal.aborted) setProgress(fraction);
                },
            });
            if (
                abort.signal.aborted ||
                generation !== operation ||
                props.snapshot !== snapshot ||
                props.sessionId !== sessionId ||
                props.trackId !== trackId
            )
                throw new Error("The selected recording changed. Generate its waveform again.");
            if (!(await props.onSave(record, snapshot)) && generation === operation) {
                setError("The waveform could not be saved. Try again with the current archive.");
            }
        } catch (cause) {
            if (generation === operation)
                setError(
                    abort.signal.aborted
                        ? "Waveform generation canceled."
                        : cause instanceof Error
                          ? cause.message
                          : String(cause),
                );
        } finally {
            if (controller === abort) controller = undefined;
            if (generation === operation) setProgress(undefined);
        }
    };

    return (
        <section
            class={cn(
                "full-track-waveform col-span-full min-w-0 w-full rounded-panel border border-line bg-surface-subtle p-4",
                "rounded-[5px] grid gap-3 p-px",
            )}
            aria-label="Full recording waveform"
        >
            <div
                class={cn(
                    "full-track-waveform-header",
                    "max-[640px]:items-stretch max-[640px]:flex-col items-center flex gap-px justify-between",
                )}
            >
                <div>
                    <strong>Full recording waveform</strong>
                    <p class="text-muted text-[0.8rem] mt-[0.3rem] mr-0 mb-0 ml-0">
                        <Show
                            when={status() === "ready"}
                            fallback={
                                status() === "loading"
                                    ? "Checking waveform…"
                                    : status() === "stale"
                                      ? "The saved waveform is out of date."
                                      : status() === "invalid"
                                        ? "The saved waveform could not be read."
                                        : "Generate a waveform overview for this track."
                            }
                        >
                            {formatTranscriptTimestampUs(durationUs())} · {levels()[0]?.length ?? 0}{" "}
                            detail points
                        </Show>
                    </p>
                </div>
                <Show
                    when={progress() === undefined}
                    fallback={
                        <button
                            class={cn("button button-outline", buttonOutline)}
                            type="button"
                            onClick={() => controller?.abort()}
                        >
                            Cancel
                        </button>
                    }
                >
                    <button
                        class={cn("button button-outline", buttonOutline)}
                        type="button"
                        disabled={props.disabled || props.snapshot.locked || status() === "loading"}
                        onClick={() => void generate()}
                    >
                        {status() === "ready" ? "Rebuild waveform" : "Generate waveform"}
                    </button>
                </Show>
            </div>
            <Show when={progress() !== undefined}>
                <div
                    class={cn(
                        "full-track-waveform-progress",
                        "items-center text-muted flex text-[0.8rem] gap-[0.7rem]",
                    )}
                >
                    <progress
                        max="1"
                        value={progress()}
                        aria-label="Waveform generation progress"
                        class="accent-accent flex-1"
                    />
                    <span>{Math.round((progress() ?? 0) * 100)}%</span>
                </div>
            </Show>
            <Show when={status() === "ready" && buckets().length > 0}>
                <svg
                    class={cn(
                        "full-track-waveform-graphic",
                        "bg-surface-inset rounded-[5px] fill-accent h-[5rem] w-full",
                    )}
                    viewBox={`0 0 ${buckets().length} 100`}
                    preserveAspectRatio="none"
                    role="img"
                    aria-label="Full recording waveform; gaps are highlighted"
                >
                    <For each={buckets()}>
                        {(bucket, index) => (
                            <rect
                                x={index()}
                                y={Math.max(0, 50 - bucket.maximum / 655.36)}
                                width="0.8"
                                height={Math.max(1, (bucket.maximum - bucket.minimum) / 655.36)}
                                class="[.full-track-waveform-graphic_rect&:where(.gap)]:fill-[var(--warning)]"
                                classList={{ gap: bucket.containsGap }}
                            />
                        )}
                    </For>
                </svg>
                <Show when={props.onSelectTime}>
                    <div
                        class={cn(
                            "full-track-waveform-navigation",
                            "max-[640px]:items-stretch max-[640px]:flex-col items-center text-muted flex text-[0.8rem] gap-[0.7rem]",
                        )}
                    >
                        <label class="items-center flex flex-1 gap-[0.5rem]">
                            Position{" "}
                            <input
                                type="range"
                                min="0"
                                max="999"
                                value={selection()}
                                onInput={(event) => setSelection(Number(event.currentTarget.value))}
                                class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] accent-accent w-full"
                            />
                        </label>
                        <span>
                            {formatTranscriptTimestampUs(
                                (durationUs() * BigInt(selection())) / 1000n,
                            )}
                        </span>
                        <button
                            class={cn("button button-outline", buttonOutline)}
                            type="button"
                            onClick={() =>
                                props.onSelectTime?.((durationUs() * BigInt(selection())) / 1000n)
                            }
                        >
                            Open audio here
                        </button>
                    </div>
                </Show>
            </Show>
            <Show when={error()}>
                <p
                    class={cn("full-track-waveform-error", "text-danger text-[0.85rem] m-0")}
                    role="alert"
                >
                    {error()}
                </p>
            </Show>
        </section>
    );
}

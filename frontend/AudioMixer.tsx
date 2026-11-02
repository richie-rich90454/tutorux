import { buttonOutline, cn, eyebrow, labelBase } from "./ui";
import { For, Show, createEffect, createSignal, type JSX } from "solid-js";
import type { ArchiveSnapshot } from "./archive/archive";
import type { ArchiveRecord } from "./archive/format";
import type { AudioTrackDescriptor } from "./domain/audio";
import { mixRecordingTracks } from "./domain/audio-mix";
import { splitRecordingTrackIds } from "./domain/recording-takes";

interface AudioMixerProps {
    snapshot: ArchiveSnapshot;
    sessionId: string;
    takes: ArchiveRecord[];
    tracks: AudioTrackDescriptor[];
    disabled: boolean;
    /** Save only if the workspace still uses the snapshot that was mixed. */
    onSave: (
        snapshot: ArchiveSnapshot,
        records: ArchiveRecord[],
        message: string,
    ) => Promise<boolean>;
}

/** Create a new archive track from the synchronized tracks of one recording take. */
export function AudioMixer(props: AudioMixerProps): JSX.Element {
    const [takeId, setTakeId] = createSignal("");
    const [selected, setSelected] = createSignal<string[]>([]);
    const [label, setLabel] = createSignal("Mixdown");
    const [working, setWorking] = createSignal(false);
    const [error, setError] = createSignal("");
    const [status, setStatus] = createSignal("");
    const availableTakes = () =>
        props.takes.filter(
            (take) =>
                take.fields.get("_deleted") !== "true" &&
                take.fields.get("session_id")?.toLowerCase() === props.sessionId.toLowerCase(),
        );
    const currentTake = () => availableTakes().find((take) => take.id === takeId());
    const availableTracks = () => {
        const ids = new Set(splitRecordingTrackIds(currentTake()?.fields.get("track_ids")));
        return props.tracks.filter(
            (track) =>
                track.sessionId === props.sessionId.toLowerCase() &&
                ids.has(track.id.toLowerCase()),
        );
    };
    createEffect(() => {
        const takes = availableTakes();
        setTakeId((id) => (takes.some((take) => take.id === id) ? id : (takes[0]?.id ?? "")));
    });
    createEffect(() => {
        const ids = new Set(availableTracks().map((track) => track.id));
        setSelected((selection) => selection.filter((id) => ids.has(id)));
    });
    async function mix(): Promise<void> {
        const snapshot = props.snapshot;
        const sessionId = props.sessionId;
        const take = takeId();
        setError("");
        setStatus("");
        setWorking(true);
        try {
            const result = await mixRecordingTracks(snapshot, sessionId, take, selected(), label());
            if (props.snapshot !== snapshot || props.sessionId !== sessionId)
                throw new Error(
                    "The workspace changed during mixing. Try again with the current archive.",
                );
            if (await props.onSave(snapshot, result.records, "Mixed recording track saved.")) {
                setSelected([]);
                setStatus(
                    `Mix saved as a track in this take (${result.sampleRateHz.toLocaleString("en-US")} Hz).`,
                );
            }
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
        } finally {
            setWorking(false);
        }
    }
    return (
        <section
            class={cn("audio-mixer", "bg-surface rounded-[5px] border border-line mt-4.5 p-5")}
        >
            <div>
                <span class={cn("eyebrow", eyebrow)}>Listen together</span>
                <h3 class="my-[5px] mx-0">Mix recording tracks</h3>
                <p class="text-muted">
                    Combine two to eight tracks from one take into a new stereo track. The original
                    recordings remain available.
                </p>
            </div>
            <Show
                when={availableTakes().length}
                fallback={
                    <p class="text-muted">
                        Recording takes will appear here when they have been saved.
                    </p>
                }
            >
                <label class={cn("form-field", labelBase)}>
                    Recording take
                    <select
                        value={takeId()}
                        disabled={props.disabled || working()}
                        onChange={(event) => {
                            setTakeId(event.currentTarget.value);
                            setSelected([]);
                            setError("");
                            setStatus("");
                        }}
                        class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] focus-visible:border-accent focus-visible:shadow-none bg-surface-subtle rounded-[5px] border border-line text-ink text-xs font-normal h-[35px] min-w-0 outline-none py-[9px] px-2.5 transition-colors w-full"
                    >
                        <For each={availableTakes()}>
                            {(take) => (
                                <option value={take.id}>
                                    {take.fields.get("label") || "Recording take"}
                                </option>
                            )}
                        </For>
                    </select>
                </label>
                <fieldset disabled={props.disabled || working()} class="border-0 my-4.5 mx-0 p-0">
                    <legend class="font-semibold mb-2">Tracks</legend>
                    <Show
                        when={availableTracks().length}
                        fallback={<p class="text-muted">No saved tracks in this take.</p>}
                    >
                        <div class={cn("audio-mixer-tracks", "flex flex-wrap gap-y-2.5 gap-x-4.5")}>
                            <For each={availableTracks()}>
                                {(track) => (
                                    <label class="items-center inline-flex gap-2">
                                        <input
                                            type="checkbox"
                                            checked={selected().includes(track.id)}
                                            disabled={
                                                !selected().includes(track.id) &&
                                                selected().length >= 8
                                            }
                                            onChange={(event) =>
                                                setSelected((ids) =>
                                                    event.currentTarget.checked
                                                        ? [...ids, track.id]
                                                        : ids.filter((id) => id !== track.id),
                                                )
                                            }
                                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)]"
                                        />
                                        <span>{track.label}</span>
                                    </label>
                                )}
                            </For>
                        </div>
                    </Show>
                </fieldset>
                <div class={cn("audio-mixer-controls", "items-end flex flex-wrap gap-3")}>
                    <label class={cn("form-field", labelBase)}>
                        Mix name
                        <input
                            value={label()}
                            maxlength="120"
                            disabled={props.disabled || working()}
                            onInput={(event) => setLabel(event.currentTarget.value)}
                            class="focus-visible:outline-offset-0.5 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] placeholder:text-faint focus-visible:border-accent focus-visible:shadow-none bg-surface-subtle rounded-[5px] border border-line text-ink text-xs font-normal h-[35px] min-w-0 outline-none py-[9px] px-2.5 transition-colors w-full"
                        />
                    </label>
                    <button
                        class={cn("button button-outline", buttonOutline)}
                        type="button"
                        disabled={props.disabled || working() || selected().length < 2}
                        onClick={() => void mix()}
                    >
                        {working() ? "Mixing…" : "Create mix"}
                    </button>
                </div>
            </Show>
            <Show when={error()}>
                <p class={cn("audio-mixer-error", "text-muted")} role="alert">
                    {error()}
                </p>
            </Show>
            <Show when={status()}>
                <p role="status" class="text-muted">
                    {status()}
                </p>
            </Show>
        </section>
    );
}

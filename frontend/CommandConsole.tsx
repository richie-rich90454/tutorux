import { buttonDanger, buttonOutline, buttonPrimary, cn, iconButton } from "./ui";
import { For, Show, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js";
import type { ArchiveByteSource } from "./archive/source";
import { platform } from "@platform";
import type { CommandConsoleResult, CommandConsoleRun } from "./platform/command-console";

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;

export interface CommandConsoleArchive {
    readonly source: ArchiveByteSource;
    readonly name: string;
    readonly location: string | null;
    readonly dirty: boolean;
    readonly locked: boolean;
}

interface CommandConsoleProps {
    archive: CommandConsoleArchive | null;
    onClose(): void;
    onArchiveChanged(source: ArchiveByteSource, location: string | null): Promise<void>;
}

interface OutputLine {
    id: number;
    text: string;
    tone: "stdout" | "stderr" | "notice";
}

function utf8Length(value: string): number {
    return new TextEncoder().encode(value).byteLength;
}

function trimUtf8Start(value: string, maximumBytes: number): string {
    const encoder = new TextEncoder();
    let start = 0;
    let length = encoder.encode(value).byteLength;
    while (length > maximumBytes && start < value.length) {
        const codePoint = value.codePointAt(start);
        if (codePoint === undefined) break;
        const next = String.fromCodePoint(codePoint);
        length -= encoder.encode(next).byteLength;
        start += next.length;
    }
    return value.slice(start);
}

export function CommandConsole(props: CommandConsoleProps): JSX.Element {
    const [availability, setAvailability] = createSignal("Checking the command runtime…");
    const [available, setAvailable] = createSignal(false);
    const [command, setCommand] = createSignal("");
    const [passphrase, setPassphrase] = createSignal("");
    const [newPassphrase, setNewPassphrase] = createSignal("");
    const [output, setOutput] = createSignal<OutputLine[]>([]);
    const [outputBytes, setOutputBytes] = createSignal(0);
    const [running, setRunning] = createSignal(false);
    const [stopping, setStopping] = createSignal(false);
    const [error, setError] = createSignal("");
    const [exitCode, setExitCode] = createSignal<number | null>(null);
    let dialogElement!: HTMLDialogElement;
    let commandElement!: HTMLTextAreaElement;
    let activeRun: CommandConsoleRun | null = null;
    let cancelRequested = false;
    let disposed = false;
    let nextOutputId = 0;
    let outputElement: HTMLOutputElement | undefined;

    onMount(() => {
        dialogElement.showModal();
        commandElement.focus({ preventScroll: true });
        void platform.commandConsoleAvailability?.().then(
            (status) => {
                if (disposed) return;
                setAvailable(status.available);
                setAvailability(status.message);
            },
            (cause: unknown) => {
                if (disposed) return;
                setAvailable(false);
                setAvailability(
                    cause instanceof Error ? cause.message : "The command runtime is unavailable.",
                );
            },
        );
    });

    onCleanup(() => {
        disposed = true;
        cancelRequested = true;
        if (activeRun) void activeRun.cancel().catch(() => undefined);
        setPassphrase("");
        setNewPassphrase("");
        if (dialogElement?.open) dialogElement.close();
    });

    function appendOutput(text: string, tone: OutputLine["tone"]): void {
        if (!text) return;
        const existing = output();
        const newest = trimUtf8Start(text, MAX_OUTPUT_BYTES);
        const retainedOld = trimUtf8Start(
            existing.map((line) => line.text).join(""),
            Math.max(0, MAX_OUTPUT_BYTES - utf8Length(newest)),
        );
        const lines: OutputLine[] = [];
        if (retainedOld) lines.push({ id: nextOutputId++, text: retainedOld, tone: "stdout" });
        if (newest) lines.push({ id: nextOutputId++, text: newest, tone });
        setOutput(lines);
        setOutputBytes(utf8Length(retainedOld) + utf8Length(newest));
        queueMicrotask(() => {
            if (outputElement) outputElement.scrollTop = outputElement.scrollHeight;
        });
    }

    async function cancelRun(): Promise<void> {
        cancelRequested = true;
        setStopping(true);
        try {
            await activeRun?.cancel();
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : "The command could not be canceled.");
        }
    }

    async function requestClose(): Promise<void> {
        if (running()) {
            await cancelRun();
            return;
        }
        setPassphrase("");
        setNewPassphrase("");
        props.onClose();
    }

    async function submitCommand(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        if (running()) return;
        const activeArchive = props.archive;
        const input = command().trim();
        if (!activeArchive) {
            setError("Open a Tutorux archive before running an archive command.");
            return;
        }
        if (activeArchive.dirty) {
            setError("Save the archive's unsaved changes before running a command.");
            return;
        }
        if (!available()) {
            setError(availability());
            return;
        }
        if (!input) {
            setError("Enter a Tutorux command first.");
            return;
        }
        if (utf8Length(input) > MAX_COMMAND_BYTES) {
            setError("Keep each command under 64 KiB.");
            return;
        }
        if (!platform.startCommandConsole) {
            setError("The in-app command console is only available in the desktop application.");
            return;
        }

        setError("");
        setExitCode(null);
        appendOutput(`$ tutorux ${input}\n`, "notice");
        setCommand("");
        setRunning(true);
        setStopping(false);
        cancelRequested = false;
        try {
            const start = platform.startCommandConsole(
                activeArchive.source,
                input,
                passphrase(),
                newPassphrase(),
                (text) => untrack(() => appendOutput(text, "stdout")),
            );
            setPassphrase("");
            setNewPassphrase("");
            const run = await start;
            activeRun = run;
            if (disposed) {
                await run.cancel().catch(() => undefined);
                return;
            }
            if (cancelRequested) await run.cancel();
            const result: CommandConsoleResult = await run.completion;
            setExitCode(result.exitCode);
            setStopping(false);
            if (result.cancelled) appendOutput("Command canceled.\n", "notice");
            else appendOutput(`Command finished with exit code ${result.exitCode}.\n`, "notice");
            if (result.archiveChanged) {
                appendOutput(
                    "The archive changed on disk; refreshing the open workspace.\n",
                    "notice",
                );
                await props.onArchiveChanged(activeArchive.source, activeArchive.location);
            }
        } catch (cause) {
            setError(
                cause instanceof Error ? cause.message : "The command could not be completed.",
            );
        } finally {
            activeRun = null;
            cancelRequested = false;
            if (!disposed) {
                setRunning(false);
                setStopping(false);
                setPassphrase("");
                setNewPassphrase("");
            }
        }
    }

    function handleDialogCancel(event: Event): void {
        event.preventDefault();
        void requestClose();
    }

    function updateCommand(value: string): void {
        setCommand(value);
        setError(utf8Length(value) > MAX_COMMAND_BYTES ? "Keep each command under 64 KiB." : "");
    }

    return (
        <dialog
            class={cn(
                "command-console-dialog",
                "backdrop:backdrop-blur-sm backdrop:bg-[rgb(11_18_13_/_48%)] max-[560px]:rounded-[5px] max-[560px]:max-h-[calc(100vh_-_20px)] max-[560px]:w-[calc(100vw_-_20px)] animate-[modal-in_0.14s_ease-out] bg-surface rounded-[5px] border border-line shadow-[0_24px_80px_color-mix(in_srgb,_var(--ink)_18%,_transparent)] text-ink max-h-[min(88vh,_820px)] max-w-none overflow-hidden p-0 w-[min(760px,_calc(100vw_-_32px))]",
            )}
            aria-labelledby="command-console-title"
            aria-describedby="command-console-description"
            ref={(element) => {
                dialogElement = element;
            }}
            onCancel={handleDialogCancel}
            onClick={(event) => {
                if (event.target === dialogElement) void requestClose();
            }}
        >
            <header
                class={cn(
                    "command-console-header",
                    "max-[560px]:min-h-[66px] max-[560px]:p-3 items-center border-b border-b-line-soft flex justify-between min-h-[72px] py-[15px] px-[19px]",
                )}
            >
                <div class="grid gap-[3px]">
                    <span
                        class={cn(
                            "command-console-eyebrow",
                            "text-accent text-xs font-bold tracking-[0.1em] normal-case",
                        )}
                    >
                        Tutorux desktop
                    </span>
                    <h2 id="command-console-title" class="text-ink text-[15px] font-[650] m-0">
                        Command console
                    </h2>
                </div>
                <button
                    class={cn("icon-button", iconButton)}
                    type="button"
                    aria-label={running() ? "Stop command" : "Close command console"}
                    onClick={() => void requestClose()}
                >
                    ×
                </button>
            </header>
            <div
                class={cn(
                    "command-console-body",
                    "max-[560px]:max-h-[calc(100vh_-_93px)] max-[560px]:pt-[13px] max-[560px]:pr-3 max-[560px]:pb-3.5 max-[560px]:pl-3 max-h-[calc(min(88vh,_820px)_-_73px)] overflow-y-auto pt-4 pr-[19px] pb-[19px] pl-[19px]",
                )}
            >
                <p
                    id="command-console-description"
                    class={cn(
                        "command-console-description",
                        "text-muted text-xs leading-[1.6] mt-0 mr-0 mb-[13px] ml-0",
                    )}
                >
                    Run one Tutorux CLI command in this application. Commands use the archive shown
                    here; shell operators are passed as ordinary command arguments.
                </p>
                <Show when={props.archive?.dirty}>
                    <p
                        class={cn(
                            "command-console-error",
                            "text-danger text-xs leading-[1.5] mt-0.5 mr-0 mb-0 ml-0",
                        )}
                        role="status"
                    >
                        Save unsaved workspace changes before running a command. This keeps disk
                        changes and the open workspace in sync.
                    </p>
                </Show>
                <div
                    class={cn(
                        "command-console-context",
                        "items-center bg-surface-subtle rounded-[5px] border border-line-soft flex gap-2.5 min-w-0 p-[11px]",
                    )}
                >
                    <span
                        class={cn(
                            "command-console-context-mark",
                            "bg-accent-soft rounded-[5px] text-accent grid flex-none text-[20px] h-[31px] place-items-center w-[31px]",
                        )}
                        aria-hidden="true"
                    >
                        ⌁
                    </span>
                    <div class="grid flex-1 gap-[3px] min-w-0">
                        <strong class="text-ink-soft text-xs font-[650] overflow-hidden text-ellipsis whitespace-nowrap">
                            {props.archive?.name ?? "No archive open"}
                        </strong>
                        <small class="text-faint text-xs overflow-hidden text-ellipsis whitespace-nowrap">
                            {props.archive?.location ?? "Open an archive to enable commands"}
                            <Show when={props.archive?.locked}>
                                <span> · Encrypted archive; enter its passphrase when needed</span>
                            </Show>
                        </small>
                    </div>
                    <span
                        class={cn(
                            "command-console-lock",
                            "rounded-[5px] border border-line-soft text-accent flex-none text-xs font-[650] py-1 px-[7px]",
                        )}
                        aria-label="Archive is fixed"
                    >
                        Pinned
                    </span>
                </div>
                <div
                    class={cn(
                        "command-console-runtime",
                        "items-center text-faint flex text-xs gap-[7px] min-h-[27px]",
                    )}
                    role="status"
                >
                    <span
                        class={cn(
                            `command-console-status-dot ${available() ? "is-ready" : ""}`,
                            "bg-[var(--warning)] rounded-full h-[6px] w-[6px]",
                        )}
                    />
                    {availability()}
                </div>
                <form
                    class={cn("command-console-form", "grid gap-[7px] mt-[9px]")}
                    onSubmit={(event) => void submitCommand(event)}
                >
                    <label for="command-console-input" class="text-ink-soft text-xs font-[650]">
                        Tutorux command
                    </label>
                    <textarea
                        id="command-console-input"
                        ref={(element) => {
                            commandElement = element;
                        }}
                        data-dialog-initial-focus
                        rows="2"
                        spellcheck={false}
                        autocomplete="off"
                        autocapitalize="off"
                        placeholder="student list --json"
                        aria-describedby="command-console-help"
                        value={command()}
                        disabled={
                            running() || !available() || !props.archive || props.archive.dirty
                        }
                        onInput={(event) => updateCommand(event.currentTarget.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                event.currentTarget.form?.requestSubmit();
                            }
                        }}
                        class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:opacity-65 focus:outline-offset-px focus:outline-2 focus:outline-accent bg-surface-subtle rounded-[5px] border border-line-strong text-ink text-xs leading-[1.55] min-h-[57px] py-[9px] px-2.5 resize-y w-full"
                    />
                    <div
                        class={cn(
                            "command-console-command-meta",
                            "text-faint flex text-xs gap-2.5 justify-between",
                        )}
                    >
                        <small id="command-console-help">
                            Enter runs the command · Shift+Enter adds a line · 64 KiB maximum
                        </small>
                        <small>
                            {utf8Length(command()).toLocaleString("en-US")} / 65,536 bytes
                        </small>
                    </div>
                    <div
                        class={cn(
                            "command-console-secrets",
                            "max-[560px]:grid-cols-1 grid gap-2.5 grid-cols-[repeat(2,_minmax(0,_1fr))] mt-[5px]",
                        )}
                    >
                        <label class="text-ink-soft text-xs font-[650] grid gap-[5px] min-w-0">
                            <span class="text-ink-soft text-xs font-[650]">
                                Current archive passphrase
                            </span>
                            <input
                                type="password"
                                autocomplete="current-password"
                                value={passphrase()}
                                disabled={running()}
                                onInput={(event) => setPassphrase(event.currentTarget.value)}
                                class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:opacity-65 focus:outline-offset-px focus:outline-2 focus:outline-accent bg-surface-subtle rounded-[5px] border border-line-strong text-ink text-xs min-h-[33px] py-1.5 px-2 w-full"
                            />
                        </label>
                        <label class="text-ink-soft text-xs font-[650] grid gap-[5px] min-w-0">
                            <span class="text-ink-soft text-xs font-[650]">
                                New archive passphrase
                            </span>
                            <input
                                type="password"
                                autocomplete="new-password"
                                value={newPassphrase()}
                                disabled={running()}
                                onInput={(event) => setNewPassphrase(event.currentTarget.value)}
                                class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] disabled:opacity-65 focus:outline-offset-px focus:outline-2 focus:outline-accent bg-surface-subtle rounded-[5px] border border-line-strong text-ink text-xs min-h-[33px] py-1.5 px-2 w-full"
                            />
                        </label>
                    </div>
                    <p
                        class={cn(
                            "command-console-passphrase-note",
                            "text-faint text-xs leading-[1.5] m-0",
                        )}
                    >
                        Passphrases stay in memory, are available only to this command, and are
                        cleared when it ends. Keep them out of command text.
                    </p>
                    <Show when={error()}>
                        <p
                            class={cn(
                                "command-console-error",
                                "text-danger text-xs leading-[1.5] mt-0.5 mr-0 mb-0 ml-0",
                            )}
                            role="alert"
                        >
                            {error()}
                        </p>
                    </Show>
                    <div
                        class={cn(
                            "command-console-actions",
                            "max-[560px]:flex-wrap max-[560px]:justify-start items-center flex gap-[7px] justify-end mt-[3px] min-h-9",
                        )}
                    >
                        <span
                            class={cn(
                                "command-console-run-status",
                                "max-[560px]:basis-[100%] text-muted flex-1 text-xs",
                            )}
                            role="status"
                        >
                            {running()
                                ? stopping()
                                    ? "Stopping command…"
                                    : "Command running…"
                                : ""}
                            <Show when={exitCode() !== null && !running()}>
                                Exit code {exitCode()}
                            </Show>
                        </span>
                        <button
                            class={cn("button button-outline", buttonOutline)}
                            type="button"
                            disabled={running() || outputBytes() === 0}
                            onClick={() => {
                                setOutput([]);
                                setOutputBytes(0);
                                setExitCode(null);
                            }}
                        >
                            Clear output
                        </button>
                        <Show
                            when={running()}
                            fallback={
                                <button
                                    class={cn("button button-primary", buttonPrimary)}
                                    type="submit"
                                    disabled={
                                        !available() ||
                                        !props.archive ||
                                        props.archive.dirty ||
                                        !command().trim() ||
                                        Boolean(error())
                                    }
                                >
                                    Run command
                                </button>
                            }
                        >
                            <button
                                class={cn("button button-danger", buttonDanger)}
                                type="button"
                                onClick={() => void cancelRun()}
                            >
                                Stop
                            </button>
                        </Show>
                    </div>
                </form>
                <section
                    class={cn(
                        "command-console-output-section",
                        "border-t border-t-line-soft mt-[15px]",
                    )}
                    aria-label="Command output"
                >
                    <div
                        class={cn(
                            "command-console-output-heading",
                            "items-center flex justify-between pt-2.5 pr-0 pb-[7px] pl-0",
                        )}
                    >
                        <h3 class="text-ink-soft text-xs font-[650] m-0">Output</h3>
                        <small class="text-faint text-xs">Up to 256 KiB retained</small>
                    </div>
                    <output
                        class={cn(
                            "command-console-output",
                            "bg-surface-inset rounded-[5px] border border-line-soft text-ink-soft block text-xs leading-[1.65] max-h-[240px] min-h-[128px] wrap-anywhere overflow-auto p-2.5 whitespace-pre-wrap",
                        )}
                        ref={(element) => {
                            outputElement = element;
                        }}
                        aria-live="off"
                        aria-label="Command output log"
                    >
                        <Show
                            when={output().length > 0}
                            fallback={
                                <span class={cn("command-console-output-empty", "text-faint")}>
                                    Command output will appear here.
                                </span>
                            }
                        >
                            <For each={output()}>
                                {(line) => (
                                    <span
                                        class={cn(
                                            `command-console-output-line is-${line.tone}`,
                                            "block whitespace-pre-wrap",
                                        )}
                                    >
                                        {line.text}
                                    </span>
                                )}
                            </For>
                        </Show>
                    </output>
                </section>
            </div>
        </dialog>
    );
}

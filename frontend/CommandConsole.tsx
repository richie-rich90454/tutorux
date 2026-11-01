import { twClasses } from "./tailwind";
import { jsxTailwindStyles } from "./CommandConsole.tailwind";
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
            class={twClasses("command-console-dialog", jsxTailwindStyles, "dialog")}
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
            <header class={twClasses("command-console-header", jsxTailwindStyles, "header")}>
                <div class={twClasses("", jsxTailwindStyles, "div")}>
                    <span class={twClasses("command-console-eyebrow", jsxTailwindStyles, "span")}>
                        Tutorux desktop
                    </span>
                    <h2 id="command-console-title" class={twClasses("", jsxTailwindStyles, "h2")}>
                        Command console
                    </h2>
                </div>
                <button
                    class={twClasses("icon-button", jsxTailwindStyles, "button")}
                    type="button"
                    aria-label={running() ? "Stop command" : "Close command console"}
                    onClick={() => void requestClose()}
                >
                    ×
                </button>
            </header>
            <div class={twClasses("command-console-body", jsxTailwindStyles, "div")}>
                <p
                    id="command-console-description"
                    class={twClasses("command-console-description", jsxTailwindStyles, "p")}
                >
                    Run one Tutorux CLI command in this application. Commands use the archive shown
                    here; shell operators are passed as ordinary command arguments.
                </p>
                <Show when={props.archive?.dirty}>
                    <p
                        class={twClasses("command-console-error", jsxTailwindStyles, "p")}
                        role="status"
                    >
                        Save unsaved workspace changes before running a command. This keeps disk
                        changes and the open workspace in sync.
                    </p>
                </Show>
                <div class={twClasses("command-console-context", jsxTailwindStyles, "div")}>
                    <span
                        class={twClasses("command-console-context-mark", jsxTailwindStyles, "span")}
                        aria-hidden="true"
                    >
                        ⌁
                    </span>
                    <div class={twClasses("", jsxTailwindStyles, "div")}>
                        <strong class={twClasses("", jsxTailwindStyles, "strong")}>
                            {props.archive?.name ?? "No archive open"}
                        </strong>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            {props.archive?.location ?? "Open an archive to enable commands"}
                            <Show when={props.archive?.locked}>
                                <span class={twClasses("", jsxTailwindStyles, "span")}>
                                    {" "}
                                    · Encrypted archive; enter its passphrase when needed
                                </span>
                            </Show>
                        </small>
                    </div>
                    <span
                        class={twClasses("command-console-lock", jsxTailwindStyles, "span")}
                        aria-label="Archive is fixed"
                    >
                        Pinned
                    </span>
                </div>
                <div
                    class={twClasses("command-console-runtime", jsxTailwindStyles, "div")}
                    role="status"
                >
                    <span
                        class={twClasses(
                            `command-console-status-dot ${available() ? "is-ready" : ""}`,
                            jsxTailwindStyles,
                            "span",
                        )}
                    />
                    {availability()}
                </div>
                <form
                    class={twClasses("command-console-form", jsxTailwindStyles, "form")}
                    onSubmit={(event) => void submitCommand(event)}
                >
                    <label
                        for="command-console-input"
                        class={twClasses("", jsxTailwindStyles, "label")}
                    >
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
                        class={twClasses("", jsxTailwindStyles, "textarea")}
                    />
                    <div
                        class={twClasses("command-console-command-meta", jsxTailwindStyles, "div")}
                    >
                        <small
                            id="command-console-help"
                            class={twClasses("", jsxTailwindStyles, "small")}
                        >
                            Enter runs the command · Shift+Enter adds a line · 64 KiB maximum
                        </small>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            {utf8Length(command()).toLocaleString()} / 65,536 bytes
                        </small>
                    </div>
                    <div class={twClasses("command-console-secrets", jsxTailwindStyles, "div")}>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                Current archive passphrase
                            </span>
                            <input
                                type="password"
                                autocomplete="current-password"
                                value={passphrase()}
                                disabled={running()}
                                onInput={(event) => setPassphrase(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                        <label class={twClasses("", jsxTailwindStyles, "label")}>
                            <span class={twClasses("", jsxTailwindStyles, "span")}>
                                New archive passphrase
                            </span>
                            <input
                                type="password"
                                autocomplete="new-password"
                                value={newPassphrase()}
                                disabled={running()}
                                onInput={(event) => setNewPassphrase(event.currentTarget.value)}
                                class={twClasses("", jsxTailwindStyles, "input")}
                            />
                        </label>
                    </div>
                    <p class={twClasses("command-console-passphrase-note", jsxTailwindStyles, "p")}>
                        Passphrases stay in memory, are available only to this command, and are
                        cleared when it ends. Keep them out of command text.
                    </p>
                    <Show when={error()}>
                        <p
                            class={twClasses("command-console-error", jsxTailwindStyles, "p")}
                            role="alert"
                        >
                            {error()}
                        </p>
                    </Show>
                    <div class={twClasses("command-console-actions", jsxTailwindStyles, "div")}>
                        <span
                            class={twClasses(
                                "command-console-run-status",
                                jsxTailwindStyles,
                                "span",
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
                            class={twClasses("button button-outline", jsxTailwindStyles, "button")}
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
                                    class={twClasses(
                                        "button button-primary",
                                        jsxTailwindStyles,
                                        "button",
                                    )}
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
                                class={twClasses(
                                    "button button-danger",
                                    jsxTailwindStyles,
                                    "button",
                                )}
                                type="button"
                                onClick={() => void cancelRun()}
                            >
                                Stop
                            </button>
                        </Show>
                    </div>
                </form>
                <section
                    class={twClasses(
                        "command-console-output-section",
                        jsxTailwindStyles,
                        "section",
                    )}
                    aria-label="Command output"
                >
                    <div
                        class={twClasses(
                            "command-console-output-heading",
                            jsxTailwindStyles,
                            "div",
                        )}
                    >
                        <h3 class={twClasses("", jsxTailwindStyles, "h3")}>Output</h3>
                        <small class={twClasses("", jsxTailwindStyles, "small")}>
                            Up to 256 KiB retained
                        </small>
                    </div>
                    <output
                        class={twClasses("command-console-output", jsxTailwindStyles, "output")}
                        ref={(element) => {
                            outputElement = element;
                        }}
                        aria-live="off"
                        aria-label="Command output log"
                    >
                        <Show
                            when={output().length > 0}
                            fallback={
                                <span
                                    class={twClasses(
                                        "command-console-output-empty",
                                        jsxTailwindStyles,
                                        "span",
                                    )}
                                >
                                    Command output will appear here.
                                </span>
                            }
                        >
                            <For each={output()}>
                                {(line) => (
                                    <span
                                        class={twClasses(
                                            `command-console-output-line is-${line.tone}`,
                                            jsxTailwindStyles,
                                            "span",
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

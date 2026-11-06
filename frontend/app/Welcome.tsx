import { Show, createSignal, type JSX } from "solid-js";
import { Button, Field, InlineNotice, TextArea, TextInput } from "../design-system/ui";
import { Icon } from "../shared-ui";
import { useWorkspace } from "./workspace";

export function Welcome(): JSX.Element {
    const workspace = useWorkspace();
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [encrypt, setEncrypt] = createSignal(false);
    const [passphrase, setPassphrase] = createSignal("");
    const [confirmation, setConfirmation] = createSignal("");
    const [unlockPassphrase, setUnlockPassphrase] = createSignal("");
    const [localError, setLocalError] = createSignal("");

    return (
        <div class="grid min-h-dvh place-items-center bg-canvas px-5 py-10">
            <div class="w-full max-w-[760px]">
                <div class="mb-8 flex items-center gap-3">
                    <span class="grid h-10 w-10 place-items-center rounded-[6px] border border-line bg-surface text-accent">
                        <Icon name="archive" />
                    </span>
                    <div>
                        <h1 class="text-xl font-semibold tracking-tight text-ink">Tutorux</h1>
                        <p class="text-xs text-muted">A local-first tutoring workspace</p>
                    </div>
                </div>
                <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,0.65fr)]">
                    <section>
                        <h2 class="text-[28px] font-semibold leading-tight tracking-tight text-ink">
                            One file for the whole teaching practice.
                        </h2>
                        <p class="mt-2 max-w-[56ch] text-sm leading-relaxed text-ink-soft">
                            Students, sessions, recordings, notes, materials, progress, and guides
                            live in a single portable
                            <span class="font-medium text-ink"> .tutor</span> workspace. It stays on
                            this device.
                        </p>
                        <div class="mt-5 grid gap-2 text-xs text-muted">
                            <div class="flex items-start gap-2">
                                <Icon name="shield" class="mt-0.5 text-accent" />
                                <span>
                                    Recording and notes stay local. Cloud AI requires a preview and
                                    confirmation.
                                </span>
                            </div>
                            <div class="flex items-start gap-2">
                                <Icon name="sessions" class="mt-0.5 text-accent" />
                                <span>
                                    Sessions hold the capture, transcript, observations, materials,
                                    evidence, and guide.
                                </span>
                            </div>
                            <div class="flex items-start gap-2">
                                <Icon name="students" class="mt-0.5 text-accent" />
                                <span>
                                    Student progress is built from goals, skills, evidence, and
                                    session history.
                                </span>
                            </div>
                        </div>
                    </section>
                    <section class="grid content-start gap-3">
                        <div class="rounded-[6px] border border-line bg-surface p-4">
                            <h3 class="text-sm font-semibold text-ink">Create a workspace</h3>
                            <p class="mt-0.5 text-xs leading-relaxed text-muted">
                                Choose where the .tutor file lives. You can move or back it up
                                later.
                            </p>
                            <form
                                class="mt-3 grid gap-2.5"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    setLocalError("");
                                    if (encrypt()) {
                                        if (passphrase().length < 12) {
                                            setLocalError(
                                                "Use a passphrase of at least 12 characters.",
                                            );
                                            return;
                                        }
                                        if (passphrase() !== confirmation()) {
                                            setLocalError("The passphrases do not match.");
                                            return;
                                        }
                                    }
                                    void workspace.createWorkspace(
                                        name(),
                                        description(),
                                        encrypt() ? passphrase() : "",
                                    );
                                }}
                            >
                                <Field label="Workspace name">
                                    <TextInput
                                        value={name()}
                                        onInput={setName}
                                        placeholder="My tutoring workspace"
                                        ariaLabel="Workspace name"
                                    />
                                </Field>
                                <Field label="Description (optional)">
                                    <TextArea
                                        value={description()}
                                        onInput={setDescription}
                                        rows={2}
                                        ariaLabel="Workspace description"
                                    />
                                </Field>
                                <label class="flex items-start gap-2 text-xs leading-relaxed text-ink-soft">
                                    <input
                                        type="checkbox"
                                        class="mt-0.5"
                                        checked={encrypt()}
                                        onChange={(event) =>
                                            setEncrypt(event.currentTarget.checked)
                                        }
                                    />
                                    <span>Protect this workspace with a passphrase.</span>
                                </label>
                                <Show when={encrypt()}>
                                    <Field label="Passphrase">
                                        <TextInput
                                            value={passphrase()}
                                            onInput={setPassphrase}
                                            type="password"
                                            ariaLabel="Workspace passphrase"
                                        />
                                    </Field>
                                    <Field label="Confirm passphrase">
                                        <TextInput
                                            value={confirmation()}
                                            onInput={setConfirmation}
                                            type="password"
                                            ariaLabel="Confirm workspace passphrase"
                                        />
                                    </Field>
                                </Show>
                                <Show when={localError()}>
                                    <InlineNotice tone="danger">{localError()}</InlineNotice>
                                </Show>
                                <Show when={workspace.error()}>
                                    <InlineNotice tone="danger">{workspace.error()}</InlineNotice>
                                </Show>
                                <Button type="submit" variant="primary" disabled={workspace.busy()}>
                                    {workspace.busy() ? "Working…" : "Create workspace"}
                                </Button>
                            </form>
                        </div>
                        <div class="rounded-[6px] border border-line bg-surface p-4">
                            <h3 class="text-sm font-semibold text-ink">
                                Open an existing workspace
                            </h3>
                            <p class="mt-0.5 text-xs leading-relaxed text-muted">
                                Select a .tutor file from this device.
                            </p>
                            <Button
                                class="mt-3 w-full"
                                onClick={() => void workspace.openWorkspace()}
                                disabled={workspace.busy()}
                            >
                                <Icon name="folder" />
                                Open workspace
                            </Button>
                        </div>
                        <Show when={workspace.encryptedPath()}>
                            <div class="rounded-[6px] border border-accent/40 bg-surface p-4">
                                <h3 class="text-sm font-semibold text-ink">Encrypted workspace</h3>
                                <p class="mt-0.5 break-all text-xs leading-relaxed text-muted">
                                    {workspace.encryptedPath()}
                                </p>
                                <form
                                    class="mt-3 grid gap-2.5"
                                    onSubmit={(event) => {
                                        event.preventDefault();
                                        void workspace.unlockWorkspace(unlockPassphrase());
                                    }}
                                >
                                    <Field label="Passphrase">
                                        <TextInput
                                            value={unlockPassphrase()}
                                            onInput={setUnlockPassphrase}
                                            type="password"
                                            ariaLabel="Workspace passphrase"
                                        />
                                    </Field>
                                    <Show when={workspace.error()}>
                                        <InlineNotice tone="danger">
                                            {workspace.error()}
                                        </InlineNotice>
                                    </Show>
                                    <div class="flex gap-2">
                                        <Button
                                            type="submit"
                                            variant="primary"
                                            disabled={workspace.busy()}
                                        >
                                            {workspace.busy() ? "Unlocking…" : "Unlock"}
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            onClick={() => workspace.cancelUnlock()}
                                        >
                                            Cancel
                                        </Button>
                                    </div>
                                </form>
                            </div>
                        </Show>
                    </section>
                </div>
            </div>
        </div>
    );
}

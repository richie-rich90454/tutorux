import { Show, createSignal, type JSX } from "solid-js";
import { errorMessage } from "../../api/client";
import {
    Badge,
    Button,
    ConfirmButton,
    Field,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
    Select,
    TextArea,
    TextInput,
} from "../../design-system/ui";
import { useWorkspace } from "../../app/workspace";
import { formatBytes } from "../../shared/format";

export function SettingsPage(): JSX.Element {
    const workspace = useWorkspace();
    const [name, setName] = createSignal(workspace.summary()?.name ?? "");
    const [description, setDescription] = createSignal(workspace.summary()?.description ?? "");
    const [newPassphrase, setNewPassphrase] = createSignal("");
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");

    async function rename(event: SubmitEvent): Promise<void> {
        event.preventDefault();
        setError("");
        try {
            await workspace.renameWorkspace(name(), description());
            setMessage("Workspace details updated.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    return (
        <div class="mx-auto w-full max-w-[1000px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Settings"
                description="Appearance, workspace details, and the way Tutorux behaves."
            />
            <Show when={error()}>
                <div class="mb-4">
                    <InlineNotice tone="danger">{error()}</InlineNotice>
                </div>
            </Show>
            <Show when={message()}>
                <div class="mb-4">
                    <InlineNotice tone="success">{message()}</InlineNotice>
                </div>
            </Show>
            <div class="grid gap-4">
                <Panel>
                    <PanelHeader
                        title="Appearance"
                        detail="The current teal, without gradients or glass effects."
                    />
                    <div class="grid gap-3 p-4 sm:grid-cols-2">
                        <Field label="Theme">
                            <Select
                                value={workspace.themeMode()}
                                onChange={(value) =>
                                    workspace.setThemeMode(value as "light" | "dark" | "system")
                                }
                                ariaLabel="Theme"
                                options={[
                                    { value: "system", label: "Follow the system" },
                                    { value: "light", label: "Light" },
                                    { value: "dark", label: "Dark" },
                                ]}
                            />
                        </Field>
                        <Field
                            label="Mode"
                            helper="Simple mode hides provider setup, maintenance, and advanced evidence tools."
                        >
                            <Select
                                value={workspace.simpleMode() ? "simple" : "advanced"}
                                onChange={(value) => workspace.setSimpleMode(value === "simple")}
                                ariaLabel="Mode"
                                options={[
                                    { value: "simple", label: "Simple" },
                                    { value: "advanced", label: "Advanced" },
                                ]}
                            />
                        </Field>
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader title="Workspace details" />
                    <form class="grid gap-3 p-4" onSubmit={(event) => void rename(event)}>
                        <Field label="Workspace name">
                            <TextInput
                                value={name()}
                                onInput={setName}
                                ariaLabel="Workspace name"
                            />
                        </Field>
                        <Field label="Description">
                            <TextArea
                                value={description()}
                                onInput={setDescription}
                                rows={3}
                                ariaLabel="Workspace description"
                            />
                        </Field>
                        <div class="flex justify-end">
                            <Button type="submit" variant="primary" disabled={workspace.busy()}>
                                Save details
                            </Button>
                        </div>
                    </form>
                    <div class="grid gap-2 border-t border-line-soft p-4 text-xs text-muted">
                        <div class="flex justify-between gap-3">
                            <span>File</span>
                            <span class="truncate text-ink">{workspace.summary()?.path}</span>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Size</span>
                            <strong class="text-ink">
                                {formatBytes(workspace.summary()?.sizeBytes ?? 0)}
                            </strong>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Schema</span>
                            <Badge>{workspace.summary()?.schemaVersion}</Badge>
                        </div>
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader title="Shortcuts" />
                    <div class="grid gap-2 p-4 text-xs text-muted sm:grid-cols-2">
                        <div class="flex justify-between gap-3">
                            <span>Search workspace</span>
                            <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5">
                                Ctrl K
                            </kbd>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Save now</span>
                            <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5">
                                Ctrl S
                            </kbd>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Close search</span>
                            <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5">
                                Esc
                            </kbd>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Move through results</span>
                            <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5">
                                ↑ ↓
                            </kbd>
                        </div>
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="Data"
                        detail="Backups are manual. Auto-save writes changes into the open workspace."
                    />
                    <div class="grid gap-2 p-4">
                        <Button
                            size="sm"
                            onClick={() => {
                                window.location.hash = "#/archive";
                            }}
                        >
                            Open archive and backups
                        </Button>
                        <Show when={workspace.summary()?.encrypted}>
                            <form
                                class="mt-2 grid gap-2 border-t border-line-soft pt-3"
                                onSubmit={(event) => {
                                    event.preventDefault();
                                    void workspace
                                        .rekeyWorkspace(newPassphrase())
                                        .then((changed) => {
                                            if (changed) setNewPassphrase("");
                                        });
                                }}
                            >
                                <Field label="Change workspace passphrase">
                                    <TextInput
                                        value={newPassphrase()}
                                        onInput={setNewPassphrase}
                                        type="password"
                                        ariaLabel="New workspace passphrase"
                                    />
                                </Field>
                                <Button
                                    size="sm"
                                    type="submit"
                                    disabled={workspace.busy() || newPassphrase().length < 12}
                                >
                                    Change passphrase
                                </Button>
                            </form>
                        </Show>
                        <ConfirmButton
                            label="Close workspace"
                            confirmLabel="Close workspace"
                            onConfirm={() => void workspace.closeWorkspace()}
                        />
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader title="About" />
                    <div class="grid gap-2 p-4 text-xs leading-relaxed text-muted">
                        <p class="m-0">
                            Tutorux is a local-first tutoring workspace. The .tutor file is a SQLite
                            database with compressed media, indexes, and full-text search.
                        </p>
                        <p class="m-0">
                            The app is desktop-first. Mobile uses the same workspace format later.
                        </p>
                        <p class="m-0">
                            All changes are written directly to the workspace; backups are manual
                            and verified.
                        </p>
                    </div>
                </Panel>
            </div>
        </div>
    );
}

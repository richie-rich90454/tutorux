import { For, Show, createResource, createSignal, type JSX } from "solid-js";
import {
    backup as backupApi,
    chooseBackupFile,
    chooseWorkspaceFile,
    chooseWorkingCopy,
    errorMessage,
    settings as settingsApi,
    trash as trashApi,
    workspace as workspaceApi,
} from "../../api/client";
import type { TrashItem } from "../../api/types";
import {
    Badge,
    Button,
    ConfirmButton,
    EmptyState,
    InlineNotice,
    PageHeader,
    Panel,
    PanelHeader,
} from "../../design-system/ui";
import { formatBytes, formatDate } from "../../shared/format";
import { Icon } from "../../shared-ui";
import { useWorkspace } from "../../app/workspace";
import { navigate } from "../../app/router";

export function ArchivePage(): JSX.Element {
    const workspace = useWorkspace();
    const [error, setError] = createSignal("");
    const [message, setMessage] = createSignal("");
    const [checking, setChecking] = createSignal(false);
    const [backingUp, setBackingUp] = createSignal(false);
    const [maintaining, setMaintaining] = createSignal("");
    const [summary, { refetch: refetchSummary }] = createResource(() => workspaceApi.summary());
    const [settings, { refetch: refetchSettings }] = createResource(() => settingsApi.all());
    const [trash, { refetch: refetchTrash }] = createResource(() => trashApi.list());

    async function check(): Promise<void> {
        setChecking(true);
        setError("");
        try {
            const result = await workspaceApi.check();
            setMessage(
                result === "ok"
                    ? "The workspace passed its integrity check."
                    : `Integrity check: ${result}`,
            );
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setChecking(false);
        }
    }

    async function backup(): Promise<void> {
        setError("");
        setBackingUp(true);
        try {
            const path = await chooseBackupFile(summary()?.name ?? "workspace");
            if (!path) return;
            const result = await backupApi.create(path);
            setMessage(`Backup created: ${result.path} (${formatBytes(result.bytes)}).`);
            await refetchSettings();
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setBackingUp(false);
        }
    }

    async function compact(): Promise<void> {
        setError("");
        setMaintaining("compact");
        try {
            const result = await workspaceApi.compact();
            setMessage(
                `Workspace compacted from ${formatBytes(result.beforeBytes)} to ${formatBytes(result.afterBytes)}. Integrity: ${result.integrity}.`,
            );
            await refetchSummary();
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setMaintaining("");
        }
    }

    async function reindex(): Promise<void> {
        setError("");
        setMaintaining("reindex");
        try {
            const result = await workspaceApi.reindex();
            setMessage(`Indexes rebuilt. Integrity: ${result.integrity}.`);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setMaintaining("");
        }
    }

    async function recoveryCopy(): Promise<void> {
        setError("");
        setMaintaining("recovery");
        try {
            const path = await chooseWorkingCopy(
                summary()?.name ?? "workspace",
                "Create recovery copy",
                "recovery",
            );
            if (!path) return;
            const result = await workspaceApi.recoveryCopy(path);
            setMessage(`Recovery copy created: ${result.path} (${formatBytes(result.bytes)}).`);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setMaintaining("");
        }
    }

    async function sanitizedCopy(): Promise<void> {
        setError("");
        setMaintaining("sanitized");
        try {
            const path = await chooseWorkingCopy(
                summary()?.name ?? "workspace",
                "Create sanitized copy",
                "sanitized",
            );
            if (!path) return;
            const result = await workspaceApi.sanitizedCopy(path);
            setMessage(`Sanitized copy created: ${result.path} (${formatBytes(result.bytes)}).`);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setMaintaining("");
        }
    }

    async function salvage(): Promise<void> {
        setError("");
        setMaintaining("salvage");
        try {
            const source = await chooseWorkspaceFile();
            if (!source) return;
            const destination = await chooseWorkingCopy(
                summary()?.name ?? "workspace",
                "Save recovered workspace",
                "recovered",
            );
            if (!destination) return;
            const result = await workspaceApi.salvage(source, destination);
            const warning = result.warnings.length
                ? ` Skipped ${result.warnings.length} unreadable table(s).`
                : "";
            setMessage(
                `Recovered ${result.copiedRows} rows into ${result.path}. ` +
                    `${result.skippedRows} rows skipped. Integrity: ${result.integrity}.${warning}`,
            );
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setMaintaining("");
        }
    }

    async function restore(item: TrashItem): Promise<void> {
        setError("");
        try {
            await trashApi.restore(item.entityType, item.entityId);
            await refetchTrash();
            await refetchSummary();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function remove(item: TrashItem): Promise<void> {
        setError("");
        try {
            await trashApi.remove(item.entityType, item.entityId);
            await refetchTrash();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    async function emptyTrash(): Promise<void> {
        setError("");
        try {
            await trashApi.empty();
            await refetchTrash();
            await refetchSummary();
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

    const lastBackup = (): number | null => {
        const value = settings()?.["backup_last_at"];
        const parsed = value ? Number(value) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : null;
    };

    return (
        <div class="mx-auto w-full max-w-[1240px] px-5 py-5 sm:px-7 lg:px-9">
            <PageHeader
                title="Archive"
                description="The workspace file, its health, and the items you can still recover."
                actions={
                    <Badge tone={summary()?.encrypted ? "success" : "neutral"}>
                        {summary()?.encrypted ? "Encrypted" : "Local file"}
                    </Badge>
                }
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
            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.65fr)]">
                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader title="Workspace file" detail={summary()?.path ?? ""} />
                        <div class="grid gap-2 p-4 text-xs text-muted">
                            <div class="flex justify-between gap-3">
                                <span>Name</span>
                                <strong class="text-ink">{summary()?.name}</strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Size</span>
                                <strong class="text-ink">
                                    {formatBytes(summary()?.sizeBytes ?? 0)}
                                </strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Last backup</span>
                                <strong class="text-ink">
                                    {lastBackup() ? formatDate(lastBackup()) : "Never"}
                                </strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Students</span>
                                <strong class="text-ink">{summary()?.studentCount}</strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Sessions</span>
                                <strong class="text-ink">{summary()?.sessionCount}</strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Materials</span>
                                <strong class="text-ink">{summary()?.materialCount}</strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Created</span>
                                <strong class="text-ink">{formatDate(summary()?.createdAt)}</strong>
                            </div>
                            <div class="flex justify-between gap-3">
                                <span>Updated</span>
                                <strong class="text-ink">{formatDate(summary()?.updatedAt)}</strong>
                            </div>
                        </div>
                        <div class="flex flex-wrap gap-2 border-t border-line-soft p-3">
                            <Button size="sm" onClick={() => void check()} disabled={checking()}>
                                {checking() ? "Checking…" : "Check integrity"}
                            </Button>
                            <Button size="sm" onClick={() => void backup()} disabled={backingUp()}>
                                {backingUp() ? "Backing up…" : "Create backup"}
                            </Button>
                            <Button size="sm" onClick={() => void refetchSummary()}>
                                Refresh
                            </Button>
                        </div>
                    </Panel>

                    <Panel>
                        <PanelHeader
                            title="Recently deleted"
                            detail="Items stay recoverable for 90 days."
                            actions={
                                <Button
                                    size="sm"
                                    onClick={() => void emptyTrash()}
                                    disabled={!trash()?.length}
                                >
                                    Empty trash
                                </Button>
                            }
                        />
                        <Show
                            when={trash()?.length}
                            fallback={
                                <EmptyState
                                    icon="trash"
                                    title="Trash is empty"
                                    text="Deleted students, sessions, materials, guides, and evidence will appear here."
                                />
                            }
                        >
                            <div class="divide-y divide-line-soft">
                                <For each={trash()}>
                                    {(item) => (
                                        <div class="flex flex-wrap items-center gap-2 px-4 py-3">
                                            <Badge>{item.entityType}</Badge>
                                            <span class="min-w-0 flex-1 truncate text-xs text-ink">
                                                {item.title || item.entityId.slice(0, 8)}
                                            </span>
                                            <span class="text-[11px] text-faint">
                                                {formatDate(item.deletedAt)}
                                            </span>
                                            <Button size="sm" onClick={() => void restore(item)}>
                                                Restore
                                            </Button>
                                            <ConfirmButton
                                                label="Delete"
                                                confirmLabel="Delete forever"
                                                onConfirm={() => void remove(item)}
                                            />
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
                    </Panel>
                </div>

                <div class="grid content-start gap-4">
                    <Panel>
                        <PanelHeader title="Workspace" />
                        <div class="grid gap-2 p-3">
                            <Button size="sm" onClick={() => navigate("/settings")}>
                                Workspace settings
                            </Button>
                            <Button size="sm" onClick={() => void workspace.openWorkspace()}>
                                Open another workspace
                            </Button>
                            <ConfirmButton
                                label="Close workspace"
                                confirmLabel="Close workspace"
                                onConfirm={() => void workspace.closeWorkspace()}
                            />
                        </div>
                    </Panel>
                    <Show when={!workspace.simpleMode()}>
                        <Panel>
                            <PanelHeader
                                title="Advanced"
                                detail="Maintenance tools appear only in Advanced mode."
                            />
                            <div class="grid gap-2 p-3 text-xs leading-relaxed text-muted">
                                <Button size="sm" onClick={() => void check()}>
                                    Verify database
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void compact()}
                                    disabled={Boolean(maintaining())}
                                >
                                    {maintaining() === "compact"
                                        ? "Compacting…"
                                        : "Compact workspace"}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void reindex()}
                                    disabled={Boolean(maintaining())}
                                >
                                    {maintaining() === "reindex"
                                        ? "Rebuilding…"
                                        : "Rebuild search indexes"}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void recoveryCopy()}
                                    disabled={Boolean(maintaining())}
                                >
                                    {maintaining() === "recovery"
                                        ? "Copying…"
                                        : "Create recovery copy"}
                                </Button>
                                <Button
                                    size="sm"
                                    onClick={() => void sanitizedCopy()}
                                    disabled={Boolean(maintaining())}
                                >
                                    {maintaining() === "sanitized"
                                        ? "Sanitizing…"
                                        : "Create sanitized copy"}
                                </Button>
                                <ConfirmButton
                                    label="Repair a damaged workspace"
                                    confirmLabel="Start recovery"
                                    disabled={Boolean(maintaining())}
                                    onConfirm={() => void salvage()}
                                />
                                <Button size="sm" onClick={() => void window.print()}>
                                    Print workspace summary
                                </Button>
                                <p class="m-0 text-[11px]">
                                    A sanitized copy removes recordings, transcripts, journals,
                                    observations, materials, and AI jobs, masks student names, and
                                    clears session notes. Encrypted workspaces keep their
                                    passphrase.
                                </p>
                            </div>
                        </Panel>
                    </Show>
                    <Panel>
                        <PanelHeader title="Privacy" />
                        <div class="p-4 text-xs leading-relaxed text-muted">
                            This workspace is a local file. Tutorux does not upload lesson data.
                            Cloud AI requests require an explicit preview and confirmation.
                        </div>
                    </Panel>
                </div>
            </div>
            <div class="mt-4 flex items-center gap-2 text-[11px] text-faint">
                <Icon name="shield" />
                The file stays on this device until you choose to move or back it up.
            </div>
        </div>
    );
}

import { For, Show, createEffect, createResource, createSignal, type JSX } from "solid-js";
import { calendar as calendarApi, errorMessage, settings as settingsApi } from "../../api/client";
import type { CalendarAccount } from "../../api/types";
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
    const [settings] = createResource(() => settingsApi.all());
    const [remindersEnabled, setRemindersEnabled] = createSignal(true);
    const [reminderLead, setReminderLead] = createSignal("15");
    const [calendarAccounts, { refetch: refetchCalendars }] = createResource(() =>
        calendarApi.accounts(),
    );
    const [googleClientId, setGoogleClientId] = createSignal("");
    const [googleClientSecret, setGoogleClientSecret] = createSignal("");
    const [microsoftClientId, setMicrosoftClientId] = createSignal("");
    const [microsoftClientSecret, setMicrosoftClientSecret] = createSignal("");
    const [caldavUrl, setCaldavUrl] = createSignal("");
    const [caldavUser, setCaldavUser] = createSignal("");
    const [caldavPassword, setCaldavPassword] = createSignal("");
    const [calendarBusy, setCalendarBusy] = createSignal("");
    const [calendarMessage, setCalendarMessage] = createSignal("");
    const shortcut = navigator.userAgent.includes("Mac") ? "⌘" : "Ctrl";

    createEffect(() => {
        const values = settings();
        if (!values) return;
        setGoogleClientId(values["calendar_google_client_id"] ?? "");
        setMicrosoftClientId(values["calendar_microsoft_client_id"] ?? "");
    });

    async function saveCalendarClient(provider: "google" | "microsoft"): Promise<void> {
        setError("");
        setCalendarMessage("");
        setCalendarBusy(`save-${provider}`);
        try {
            const clientId = provider === "google" ? googleClientId() : microsoftClientId();
            const secret = provider === "google" ? googleClientSecret() : microsoftClientSecret();
            await calendarApi.saveClient(provider, clientId, secret || null);
            if (provider === "google") setGoogleClientSecret("");
            else setMicrosoftClientSecret("");
            setCalendarMessage("Calendar client saved in the OS credential store.");
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCalendarBusy("");
        }
    }

    async function connectCalendar(provider: "google" | "microsoft"): Promise<void> {
        setError("");
        setCalendarMessage("");
        setCalendarBusy(`connect-${provider}`);
        try {
            const clientId = provider === "google" ? googleClientId() : microsoftClientId();
            const secret = provider === "google" ? googleClientSecret() : microsoftClientSecret();
            await calendarApi.saveClient(provider, clientId, secret || null);
            if (provider === "google") setGoogleClientSecret("");
            else setMicrosoftClientSecret("");
            const account = await calendarApi.connect(provider);
            await refetchCalendars();
            setCalendarMessage(`Connected ${account.accountEmail}.`);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCalendarBusy("");
        }
    }

    async function connectCaldav(): Promise<void> {
        setError("");
        setCalendarMessage("");
        setCalendarBusy("connect-caldav");
        try {
            const account = await calendarApi.connectCaldav(
                caldavUrl(),
                caldavUser(),
                caldavPassword(),
            );
            setCaldavPassword("");
            await refetchCalendars();
            setCalendarMessage(`Connected ${account.accountEmail}.`);
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCalendarBusy("");
        }
    }

    async function syncCalendar(account: CalendarAccount): Promise<void> {
        setError("");
        setCalendarMessage("");
        setCalendarBusy(`sync-${account.id}`);
        try {
            const result = await calendarApi.sync(account.id);
            await refetchCalendars();
            setCalendarMessage(
                `Synced ${account.provider}: ${result.created} new, ${result.updated} updated, ${result.removed} removed.`,
            );
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCalendarBusy("");
        }
    }

    async function disconnectCalendar(account: CalendarAccount): Promise<void> {
        setError("");
        setCalendarMessage("");
        setCalendarBusy(`disconnect-${account.id}`);
        try {
            await calendarApi.disconnect(account.id);
            await refetchCalendars();
            setCalendarMessage("Calendar disconnected.");
        } catch (cause) {
            setError(errorMessage(cause));
        } finally {
            setCalendarBusy("");
        }
    }

    createEffect(() => {
        const values = settings();
        if (!values) return;
        setRemindersEnabled(values["reminders_enabled"] !== "false");
        setReminderLead(values["reminder_lead_minutes"] ?? "15");
    });

    async function saveReminders(): Promise<void> {
        setError("");
        try {
            const lead = Math.max(0, Math.min(1440, Number(reminderLead()) || 15));
            await settingsApi.set("reminders_enabled", remindersEnabled() ? "true" : "false");
            await settingsApi.set("reminder_lead_minutes", String(lead));
            setReminderLead(String(lead));
            setMessage("Reminder settings saved.");
        } catch (cause) {
            setError(errorMessage(cause));
        }
    }

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
                        detail="Theme and layout preferences for this device."
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
                    <PanelHeader
                        title="Reminders"
                        detail="Desktop notifications for lessons that are about to start."
                    />
                    <div class="grid gap-3 p-4 sm:grid-cols-2">
                        <Field label="Reminders">
                            <Select
                                value={remindersEnabled() ? "on" : "off"}
                                onChange={(value) => setRemindersEnabled(value === "on")}
                                ariaLabel="Reminders"
                                options={[
                                    { value: "on", label: "Enabled" },
                                    { value: "off", label: "Disabled" },
                                ]}
                            />
                        </Field>
                        <Field label="Lead time in minutes">
                            <TextInput
                                value={reminderLead()}
                                onInput={setReminderLead}
                                type="number"
                                ariaLabel="Reminder lead time in minutes"
                            />
                        </Field>
                        <div class="sm:col-span-2 flex justify-end">
                            <Button size="sm" onClick={() => void saveReminders()}>
                                Save reminders
                            </Button>
                        </div>
                    </div>
                </Panel>

                <Panel>
                    <PanelHeader
                        title="Calendars"
                        detail="Connect Google Calendar or Microsoft Outlook. Create a desktop OAuth client in the provider console first."
                    />
                    <div class="grid gap-4 p-4">
                        <Show when={calendarMessage()}>
                            <InlineNotice tone="success">{calendarMessage()}</InlineNotice>
                        </Show>
                        <div class="grid gap-3 rounded-[5px] bg-surface-subtle p-3 sm:grid-cols-2">
                            <strong class="sm:col-span-2 text-xs font-medium text-ink">
                                Google Calendar
                            </strong>
                            <Field label="Client ID">
                                <TextInput
                                    value={googleClientId()}
                                    onInput={setGoogleClientId}
                                    ariaLabel="Google calendar client ID"
                                />
                            </Field>
                            <Field label="Client secret">
                                <TextInput
                                    value={googleClientSecret()}
                                    onInput={setGoogleClientSecret}
                                    type="password"
                                    ariaLabel="Google calendar client secret"
                                />
                            </Field>
                            <div class="flex flex-wrap gap-2 sm:col-span-2">
                                <Button
                                    size="sm"
                                    onClick={() => void saveCalendarClient("google")}
                                    disabled={Boolean(calendarBusy())}
                                >
                                    Save client
                                </Button>
                                <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => void connectCalendar("google")}
                                    disabled={Boolean(calendarBusy()) || !googleClientId().trim()}
                                >
                                    {calendarBusy() === "connect-google"
                                        ? "Waiting for browser…"
                                        : "Connect Google"}
                                </Button>
                            </div>
                        </div>
                        <div class="grid gap-3 rounded-[5px] bg-surface-subtle p-3 sm:grid-cols-2">
                            <strong class="sm:col-span-2 text-xs font-medium text-ink">
                                Microsoft Outlook
                            </strong>
                            <Field label="Client ID">
                                <TextInput
                                    value={microsoftClientId()}
                                    onInput={setMicrosoftClientId}
                                    ariaLabel="Microsoft calendar client ID"
                                />
                            </Field>
                            <Field label="Client secret">
                                <TextInput
                                    value={microsoftClientSecret()}
                                    onInput={setMicrosoftClientSecret}
                                    type="password"
                                    ariaLabel="Microsoft calendar client secret"
                                />
                            </Field>
                            <div class="flex flex-wrap gap-2 sm:col-span-2">
                                <Button
                                    size="sm"
                                    onClick={() => void saveCalendarClient("microsoft")}
                                    disabled={Boolean(calendarBusy())}
                                >
                                    Save client
                                </Button>
                                <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => void connectCalendar("microsoft")}
                                    disabled={
                                        Boolean(calendarBusy()) || !microsoftClientId().trim()
                                    }
                                >
                                    {calendarBusy() === "connect-microsoft"
                                        ? "Waiting for browser…"
                                        : "Connect Outlook"}
                                </Button>
                            </div>
                        </div>
                        <div class="grid gap-3 rounded-[5px] bg-surface-subtle p-3 sm:grid-cols-2">
                            <strong class="sm:col-span-2 text-xs font-medium text-ink">
                                Apple Calendar (CalDAV)
                            </strong>
                            <Field label="Calendar URL">
                                <TextInput
                                    value={caldavUrl()}
                                    onInput={setCaldavUrl}
                                    placeholder="https://caldav.icloud.com/…/calendars/…"
                                    ariaLabel="Apple calendar URL"
                                />
                            </Field>
                            <Field label="Apple ID">
                                <TextInput
                                    value={caldavUser()}
                                    onInput={setCaldavUser}
                                    ariaLabel="Apple calendar username"
                                />
                            </Field>
                            <Field label="App-specific password">
                                <TextInput
                                    value={caldavPassword()}
                                    onInput={setCaldavPassword}
                                    type="password"
                                    ariaLabel="Apple calendar app-specific password"
                                />
                            </Field>
                            <div class="flex items-end">
                                <Button
                                    size="sm"
                                    variant="primary"
                                    onClick={() => void connectCaldav()}
                                    disabled={
                                        Boolean(calendarBusy()) ||
                                        !caldavUrl().trim() ||
                                        !caldavUser().trim() ||
                                        !caldavPassword()
                                    }
                                >
                                    {calendarBusy() === "connect-caldav"
                                        ? "Connecting…"
                                        : "Connect Apple Calendar"}
                                </Button>
                            </div>
                        </div>
                        <Show
                            when={calendarAccounts()?.length}
                            fallback={
                                <p class="m-0 text-xs text-muted">
                                    No calendars are connected. ICS import and export remain
                                    available on the Schedule page.
                                </p>
                            }
                        >
                            <div class="grid gap-2">
                                <For each={calendarAccounts()}>
                                    {(account) => (
                                        <div class="flex flex-wrap items-center gap-2 rounded-[5px] border border-line-soft px-3 py-2 text-xs">
                                            <Badge>{account.provider}</Badge>
                                            <span class="min-w-0 flex-1 truncate text-ink">
                                                {account.accountEmail}
                                            </span>
                                            <span class="text-faint">
                                                {account.eventCount} events
                                            </span>
                                            <Button
                                                size="sm"
                                                onClick={() => void syncCalendar(account)}
                                                disabled={Boolean(calendarBusy())}
                                            >
                                                {calendarBusy() === `sync-${account.id}`
                                                    ? "Syncing…"
                                                    : "Sync now"}
                                            </Button>
                                            <ConfirmButton
                                                label="Disconnect"
                                                confirmLabel="Disconnect calendar"
                                                onConfirm={() => void disconnectCalendar(account)}
                                            />
                                        </div>
                                    )}
                                </For>
                            </div>
                        </Show>
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
                                {shortcut} K
                            </kbd>
                        </div>
                        <div class="flex justify-between gap-3">
                            <span>Save now</span>
                            <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5">
                                {shortcut} S
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

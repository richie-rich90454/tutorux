import { onCleanup, onMount } from "solid-js";
import {
    isPermissionGranted,
    requestPermission,
    sendNotification,
} from "@tauri-apps/plugin-notification";
import { reminders as remindersApi, settings as settingsApi } from "../api/client";
import type { Reminder } from "../api/types";
import { useWorkspace } from "./workspace";

const POLL_MS = 30_000;

export function ReminderWatcher(): null {
    const workspace = useWorkspace();
    const notified = new Set<string>();
    let permission: boolean | null = null;
    let warned = false;
    let stopped = false;

    async function ensurePermission(): Promise<boolean> {
        if (permission !== null) return permission;
        permission = await isPermissionGranted();
        if (!permission) {
            permission = (await requestPermission()) === "granted";
        }
        return permission;
    }

    function key(reminder: Reminder): string {
        return `${reminder.entityType}:${reminder.id}:${reminder.startAt}`;
    }

    async function check(): Promise<void> {
        if (stopped || !workspace.summary()) return;
        try {
            const settings = await settingsApi.all();
            if (settings["reminders_enabled"] === "false") return;
            const lead = Number(settings["reminder_lead_minutes"] ?? "15");
            const due = await remindersApi.due(Number.isFinite(lead) ? lead : 15);
            if (!due.length) return;
            const allowed = await ensurePermission();
            if (!allowed) {
                if (!warned) {
                    warned = true;
                    workspace.notify(
                        "Reminders are enabled, but desktop notifications are blocked.",
                        "danger",
                    );
                }
                return;
            }
            for (const reminder of due) {
                const id = key(reminder);
                if (notified.has(id)) continue;
                notified.add(id);
                const when =
                    reminder.minutesUntil <= 0
                        ? "Starting now"
                        : `Starts in ${reminder.minutesUntil} min`;
                sendNotification({
                    title: `${when}: ${reminder.title}`,
                    body: reminder.studentName
                        ? `${reminder.studentName} · ${new Date(reminder.startAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
                        : new Date(reminder.startAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                          }),
                });
            }
        } catch {
            // A closed or busy workspace is retried on the next tick.
        }
    }

    onMount(() => {
        void check();
        const timer = window.setInterval(() => void check(), POLL_MS);
        onCleanup(() => {
            stopped = true;
            window.clearInterval(timer);
        });
    });

    return null;
}

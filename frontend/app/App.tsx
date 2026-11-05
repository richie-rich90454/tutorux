import { Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { CommandPalette } from "./shell/CommandPalette";
import { Sidebar } from "./shell/Sidebar";
import { Welcome } from "./Welcome";
import { navigate, startRouter, useRoute } from "./router";
import { useWorkspace } from "./workspace";
import { TodayPage } from "../features/today/TodayPage";
import { StudentsPage, StudentDetailPage } from "../features/students/StudentsPage";
import { SessionsPage } from "../features/sessions/SessionsPage";
import { SessionDetailPage } from "../features/sessions/SessionDetailPage";
import { SchedulePage } from "../features/schedule/SchedulePage";
import { MaterialsPage } from "../features/materials/MaterialsPage";
import { GuidesPage, GuideEditorPage } from "../features/guides/GuidesPage";
import { EvidencePage } from "../features/evidence/EvidencePage";
import { AssistantPage } from "../features/assistant/AssistantPage";
import { ArchivePage } from "../features/archive/ArchivePage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { Icon } from "../shared-ui";

function RouteView(): JSX.Element {
    const route = useRoute();
    return (
        <div class="contents">
            <Show when={route().name === "today"}>
                <TodayPage />
            </Show>
            <Show when={route().name === "students"}>
                <StudentsPage />
            </Show>
            <Show when={route().name === "student"}>
                <StudentDetailPage />
            </Show>
            <Show when={route().name === "sessions"}>
                <SessionsPage />
            </Show>
            <Show when={route().name === "session"}>
                <SessionDetailPage />
            </Show>
            <Show when={route().name === "schedule"}>
                <SchedulePage />
            </Show>
            <Show when={route().name === "materials"}>
                <MaterialsPage />
            </Show>
            <Show when={route().name === "guides"}>
                <GuidesPage />
            </Show>
            <Show when={route().name === "guide"}>
                <GuideEditorPage />
            </Show>
            <Show when={route().name === "evidence"}>
                <EvidencePage />
            </Show>
            <Show when={route().name === "assistant"}>
                <AssistantPage />
            </Show>
            <Show when={route().name === "archive"}>
                <ArchivePage />
            </Show>
            <Show when={route().name === "settings"}>
                <SettingsPage />
            </Show>
            <Show when={route().name === "not-found"}>
                <div class="p-8 text-sm text-muted">That page does not exist.</div>
            </Show>
        </div>
    );
}

export function App(): JSX.Element {
    const workspace = useWorkspace();
    const [paletteOpen, setPaletteOpen] = createSignal(false);
    const [mobileOpen, setMobileOpen] = createSignal(false);

    onMount(() => {
        startRouter();
        const onKey = (event: KeyboardEvent): void => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                setPaletteOpen((value) => !value);
            } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
                event.preventDefault();
                workspace.notify("Changes save automatically into the workspace.", "info");
            }
        };
        window.addEventListener("keydown", onKey);
        let unlisten: (() => void) | undefined;
        void listen<string>("tutorux:native-command", (event) => {
            switch (event.payload) {
                case "open":
                    void workspace.openWorkspace();
                    break;
                case "save":
                    workspace.notify("Changes save automatically into the workspace.", "info");
                    break;
                case "quick-actions":
                    setPaletteOpen((value) => !value);
                    break;
                case "preferences":
                    navigate("/settings");
                    break;
                case "toggle-appearance":
                    workspace.setThemeMode(workspace.themeMode() === "dark" ? "light" : "dark");
                    break;
                case "open-launch-archive":
                    void invoke<string | null>("take_pending_open_archive").then((path) => {
                        if (path) void workspace.openWorkspacePath(path);
                    });
                    break;
            }
        }).then((stop) => {
            unlisten = stop;
        });
        onCleanup(() => {
            window.removeEventListener("keydown", onKey);
            unlisten?.();
        });
    });

    return (
        <Show when={workspace.summary()} fallback={<Welcome />}>
            <div class="flex h-dvh min-h-0 overflow-hidden bg-canvas">
                <Sidebar
                    onOpenPalette={() => setPaletteOpen(true)}
                    mobileOpen={mobileOpen()}
                    onCloseMobile={() => setMobileOpen(false)}
                />
                <div class="flex min-w-0 flex-1 flex-col">
                    <div class="flex items-center gap-2 border-b border-line bg-canvas px-3 py-2 md:hidden">
                        <button
                            type="button"
                            class="inline-grid h-8 w-8 place-items-center rounded-[5px] border border-line bg-surface text-ink"
                            aria-label="Open navigation"
                            onClick={() => setMobileOpen(true)}
                        >
                            <Icon name="more" />
                        </button>
                        <strong class="min-w-0 flex-1 truncate text-xs font-medium text-ink">
                            {workspace.summary()?.name}
                        </strong>
                        <Show when={workspace.dirty()}>
                            <span class="text-[11px] text-warning">Unsaved changes</span>
                        </Show>
                    </div>
                    <main
                        id="main-content"
                        tabindex="-1"
                        class="min-h-0 flex-1 overflow-auto focus-visible:outline-none"
                    >
                        <RouteView />
                    </main>
                </div>
            </div>
            <CommandPalette open={paletteOpen()} onClose={() => setPaletteOpen(false)} />
            <Show when={workspace.notice()}>
                {(notice) => (
                    <div
                        class="fixed bottom-5 right-5 z-40 flex max-w-[min(440px,_calc(100vw_-_32px))] items-start gap-2 rounded-[5px] border border-line bg-surface px-3 py-2 text-xs text-ink-soft"
                        role="status"
                        aria-live="polite"
                    >
                        <span
                            class={
                                notice().tone === "danger"
                                    ? "mt-0.5 text-danger"
                                    : notice().tone === "success"
                                      ? "mt-0.5 text-success"
                                      : "mt-0.5 text-accent"
                            }
                        >
                            <Icon
                                name={
                                    notice().tone === "danger"
                                        ? "close"
                                        : notice().tone === "success"
                                          ? "check"
                                          : "spark"
                                }
                            />
                        </span>
                        <span class="min-w-0 flex-1 leading-relaxed">{notice().message}</span>
                        <button
                            type="button"
                            class="text-faint hover:text-ink"
                            aria-label="Dismiss notification"
                            onClick={() => workspace.dismissNotice()}
                        >
                            <Icon name="close" />
                        </button>
                    </div>
                )}
            </Show>
        </Show>
    );
}

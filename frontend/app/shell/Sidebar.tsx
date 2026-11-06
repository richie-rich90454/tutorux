import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon, type IconName } from "../../shared-ui";
import { cn } from "../../design-system/ui";
import { useWorkspace } from "../workspace";
import { useRoute } from "../router";

interface NavItem {
    href: string;
    label: string;
    icon: IconName;
    match: string;
}

const groups: Array<{ title: string; items: NavItem[] }> = [
    {
        title: "Workspace",
        items: [
            { href: "#/today", label: "Today", icon: "home", match: "today" },
            { href: "#/students", label: "Students", icon: "students", match: "student" },
            { href: "#/sessions", label: "Sessions", icon: "sessions", match: "session" },
            { href: "#/schedule", label: "Schedule", icon: "calendar", match: "schedule" },
        ],
    },
    {
        title: "Library",
        items: [
            { href: "#/materials", label: "Materials", icon: "assets", match: "materials" },
            { href: "#/guides", label: "Guides", icon: "guides", match: "guide" },
            { href: "#/evidence", label: "Evidence", icon: "evidence", match: "evidence" },
        ],
    },
    {
        title: "Tools",
        items: [{ href: "#/assistant", label: "Assistant", icon: "spark", match: "assistant" }],
    },
    {
        title: "System",
        items: [
            { href: "#/archive", label: "Archive", icon: "archive", match: "archive" },
            { href: "#/settings", label: "Settings", icon: "settings", match: "settings" },
        ],
    },
];

function activeMatch(pathname: string, match: string): boolean {
    if (match === "today") return pathname === "today" || pathname === "";
    if (match === "student") return pathname === "students" || pathname === "student";
    if (match === "session") return pathname === "sessions" || pathname === "session";
    if (match === "guide") return pathname === "guides" || pathname === "guide";
    return pathname === match;
}

export function Sidebar(props: {
    onOpenPalette: () => void;
    mobileOpen: boolean;
    onCloseMobile: () => void;
}): JSX.Element {
    const workspace = useWorkspace();
    const route = useRoute();
    const [showWorkspaceActions, setShowWorkspaceActions] = createSignal(false);
    const activeRoot = (): string => {
        const current = route();
        if (current.name === "student") return "student";
        if (current.name === "session") return "session";
        if (current.name === "guide") return "guide";
        return current.name;
    };

    const nav = (
        <aside
            class={cn(
                "flex h-full min-h-0 w-full flex-col border-r border-line bg-canvas px-3 py-4",
                props.mobileOpen ? "shadow-none" : "",
            )}
            aria-label="Workspace navigation"
        >
            <div class="mb-3 border-b border-line-soft pb-3">
                <button
                    type="button"
                    class="flex w-full min-w-0 items-center gap-2 rounded-[5px] px-1 py-1 text-left hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    onClick={() => setShowWorkspaceActions((value) => !value)}
                    title="Workspace actions"
                >
                    <span class="grid h-8 w-8 flex-none place-items-center rounded-[5px] border border-line bg-surface text-accent">
                        <Icon name="archive" />
                    </span>
                    <span class="grid min-w-0 flex-1 gap-0.5">
                        <strong class="truncate text-[13px] font-semibold text-ink">
                            {workspace.summary()?.name ?? "Tutorux"}
                        </strong>
                        <Show when={workspace.dirty()}>
                            <span class="text-[11px] text-warning">Unsaved changes</span>
                        </Show>
                    </span>
                    <Icon name="chevron" class="h-3.5 w-3.5 rotate-90 text-faint" />
                </button>
                <Show when={showWorkspaceActions()}>
                    <div class="mt-1 grid gap-1 rounded-[5px] border border-line bg-surface p-1.5">
                        <button
                            type="button"
                            class="rounded-[4px] px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-inset hover:text-ink"
                            onClick={() => {
                                setShowWorkspaceActions(false);
                                void workspace.openWorkspace();
                            }}
                        >
                            Open another workspace
                        </button>
                        <button
                            type="button"
                            class="rounded-[4px] px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-inset hover:text-ink"
                            onClick={() => {
                                setShowWorkspaceActions(false);
                                window.location.hash = "#/archive";
                            }}
                        >
                            Workspace archive
                        </button>
                        <button
                            type="button"
                            class="rounded-[4px] px-2 py-1.5 text-left text-xs text-ink-soft hover:bg-surface-inset hover:text-ink"
                            onClick={() => {
                                setShowWorkspaceActions(false);
                                window.location.hash = "#/settings";
                            }}
                        >
                            Settings
                        </button>
                    </div>
                </Show>
            </div>

            <button
                type="button"
                class="mb-3 flex min-h-9 w-full items-center gap-2 rounded-[5px] border border-line-strong bg-surface px-2.5 text-left text-[13px] text-ink-soft hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => props.onOpenPalette()}
                aria-label="Search workspace"
            >
                <Icon name="search" />
                <span class="flex-1">Search workspace</span>
                <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5 text-[10px] text-muted">
                    Ctrl K
                </kbd>
            </button>

            <nav class="min-h-0 flex-1 overflow-y-auto">
                <For each={groups}>
                    {(group) => (
                        <div class="mb-3">
                            <div class="px-2 pb-1 text-[11px] font-medium text-muted">
                                {group.title}
                            </div>
                            <div class="grid gap-0.5">
                                <For each={group.items}>
                                    {(item) => {
                                        const active = (): boolean =>
                                            activeMatch(activeRoot(), item.match) ||
                                            (item.match === "materials" &&
                                                route().name === "materials");
                                        return (
                                            <a
                                                href={item.href}
                                                class={cn(
                                                    "flex min-h-9 items-center gap-2.5 rounded-[5px] px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                                                    active()
                                                        ? "bg-accent-soft text-accent"
                                                        : "text-ink-soft hover:bg-surface-inset hover:text-ink",
                                                )}
                                                aria-current={active() ? "page" : undefined}
                                                onClick={() => props.onCloseMobile()}
                                            >
                                                <Icon name={item.icon} />
                                                <span>{item.label}</span>
                                            </a>
                                        );
                                    }}
                                </For>
                            </div>
                        </div>
                    )}
                </For>
            </nav>

            <div class="mt-2 grid gap-1 border-t border-line-soft pt-2">
                <button
                    type="button"
                    class="flex min-h-8 items-center justify-between rounded-[5px] px-2.5 text-left text-xs text-muted hover:bg-surface-inset hover:text-ink"
                    onClick={() => workspace.setSimpleMode(!workspace.simpleMode())}
                >
                    <span>{workspace.simpleMode() ? "Simple mode" : "Advanced mode"}</span>
                    <span class="text-[10px] text-faint">
                        {workspace.simpleMode() ? "Show advanced" : "Hide advanced"}
                    </span>
                </button>
            </div>
        </aside>
    );

    return (
        <>
            <div class="hidden h-full min-h-0 w-[236px] md:block">{nav}</div>
            <Show when={props.mobileOpen}>
                <div class="fixed inset-0 z-30 flex md:hidden">
                    <div
                        class="absolute inset-0 bg-[rgb(10_16_12_/_42%)]"
                        onClick={() => props.onCloseMobile()}
                    />
                    <div class="relative z-10 h-full w-[min(320px,_88vw)] bg-canvas">{nav}</div>
                </div>
            </Show>
        </>
    );
}

import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { search as searchApi, errorMessage } from "../../api/client";
import type { SearchHit } from "../../api/types";
import { Icon, type IconName } from "../../shared-ui";
import { navigate, guidePath, sessionPath, studentPath } from "../router";

interface PaletteItem {
    id: string;
    label: string;
    detail: string;
    icon: IconName;
    run: () => void;
}

const commandItems: PaletteItem[] = [
    {
        id: "today",
        label: "Today",
        detail: "Open the daily workspace",
        icon: "home",
        run: () => navigate("/today"),
    },
    {
        id: "students",
        label: "Students",
        detail: "Browse learners",
        icon: "students",
        run: () => navigate("/students"),
    },
    {
        id: "sessions",
        label: "Sessions",
        detail: "Browse lessons",
        icon: "sessions",
        run: () => navigate("/sessions"),
    },
    {
        id: "schedule",
        label: "Schedule",
        detail: "Open the lesson schedule",
        icon: "calendar",
        run: () => navigate("/schedule"),
    },
    {
        id: "materials",
        label: "Materials",
        detail: "Open the library",
        icon: "assets",
        run: () => navigate("/materials"),
    },
    {
        id: "guides",
        label: "Guides",
        detail: "Open study guides",
        icon: "guides",
        run: () => navigate("/guides"),
    },
    {
        id: "evidence",
        label: "Evidence",
        detail: "Open learning evidence",
        icon: "evidence",
        run: () => navigate("/evidence"),
    },
    {
        id: "assistant",
        label: "Assistant",
        detail: "Summaries, guides, feedback",
        icon: "spark",
        run: () => navigate("/assistant"),
    },
    {
        id: "archive",
        label: "Archive",
        detail: "Backups and workspace health",
        icon: "archive",
        run: () => navigate("/archive"),
    },
    {
        id: "settings",
        label: "Settings",
        detail: "Appearance and preferences",
        icon: "settings",
        run: () => navigate("/settings"),
    },
];

function hitRoute(hit: SearchHit): string {
    switch (hit.entityType) {
        case "student":
            return studentPath(hit.entityId);
        case "session":
            return sessionPath(hit.entityId);
        case "guide":
            return guidePath(hit.entityId);
        case "transcript":
            return hit.sessionId ? sessionPath(hit.sessionId, "transcript") : "/sessions";
        case "journal":
        case "observation":
            return hit.sessionId ? sessionPath(hit.sessionId, "notes") : "/sessions";
        case "material":
            return "/materials";
        case "evidence":
            return "/evidence";
        default:
            return "/today";
    }
}

function hitIcon(type: string): IconName {
    switch (type) {
        case "student":
            return "students";
        case "session":
            return "sessions";
        case "journal":
        case "observation":
            return "journal";
        case "transcript":
            return "transcripts";
        case "material":
            return "assets";
        case "guide":
            return "guides";
        case "evidence":
            return "evidence";
        default:
            return "search";
    }
}

function hitLabel(type: string): string {
    const labels: Record<string, string> = {
        student: "Student",
        session: "Session",
        journal: "Journal",
        observation: "Observation",
        transcript: "Transcript",
        material: "Material",
        guide: "Guide",
        evidence: "Evidence",
    };
    return labels[type] ?? type;
}

export function CommandPalette(props: { open: boolean; onClose: () => void }): JSX.Element {
    const [query, setQuery] = createSignal("");
    const [hits, setHits] = createSignal<SearchHit[]>([]);
    const [active, setActive] = createSignal(0);
    const [message, setMessage] = createSignal("");
    let input: HTMLInputElement | undefined;
    let timer = 0;
    let requestVersion = 0;

    const commands = (): PaletteItem[] => {
        const needle = query().trim().toLowerCase();
        if (!needle) return commandItems;
        return commandItems.filter((item) =>
            `${item.label} ${item.detail}`.toLowerCase().includes(needle),
        );
    };

    const items = (): PaletteItem[] => {
        const commandResults = commands();
        const hitResults = hits().map((hit) => ({
            id: `${hit.entityType}:${hit.entityId}`,
            label: hit.title || hitLabel(hit.entityType),
            detail: `${hitLabel(hit.entityType)} · ${hit.snippet.replace(/<[^>]+>/gu, "")}`,
            icon: hitIcon(hit.entityType),
            run: () => navigate(hitRoute(hit)),
        }));
        return [...hitResults, ...commandResults];
    };

    createEffect(() => {
        if (!props.open) return;
        const needle = query().trim();
        window.clearTimeout(timer);
        const version = ++requestVersion;
        if (needle.length < 2) {
            setHits([]);
            setMessage("");
            return;
        }
        timer = window.setTimeout(() => {
            void searchApi
                .global(needle)
                .then((results) => {
                    if (version !== requestVersion) return;
                    setHits(results);
                    setMessage(results.length === 0 ? "No matching records." : "");
                })
                .catch((cause) => {
                    if (version !== requestVersion) return;
                    setMessage(errorMessage(cause));
                });
        }, 140);
    });

    createEffect(() => {
        if (props.open) {
            setQuery("");
            setHits([]);
            setActive(0);
            setMessage("");
            window.requestAnimationFrame(() => input?.focus());
        }
    });

    createEffect(() => {
        query();
        hits();
        setActive(0);
    });

    onMount(() => {
        const onKey = (event: KeyboardEvent): void => {
            if (!props.open) return;
            if (event.key === "Escape") {
                event.preventDefault();
                props.onClose();
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => Math.min(value + 1, Math.max(0, items().length - 1)));
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter") {
                event.preventDefault();
                const item = items()[active()];
                if (item) {
                    item.run();
                    props.onClose();
                }
            }
        };
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
    });

    const current = (): PaletteItem | undefined => items()[active()];

    return (
        <Show when={props.open}>
            <div class="fixed inset-0 z-50 grid place-items-start justify-center bg-[rgb(10_16_12_/_42%)] px-4 pt-[12vh]">
                <div class="absolute inset-0" onClick={() => props.onClose()} />
                <div
                    class="relative z-10 w-full max-w-[640px] rounded-[8px] border border-line-strong bg-surface"
                    role="dialog"
                    aria-modal="true"
                    aria-label="Search workspace"
                >
                    <div class="flex items-center gap-2 border-b border-line-soft px-3">
                        <Icon name="search" class="text-muted" />
                        <input
                            ref={(element) => (input = element)}
                            class="h-11 min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
                            placeholder="Search students, sessions, notes, transcripts, materials, guides…"
                            value={query()}
                            onInput={(event) => setQuery(event.currentTarget.value)}
                            aria-label="Search workspace"
                        />
                        <kbd class="rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5 text-[10px] text-muted">
                            Esc
                        </kbd>
                    </div>
                    <div class="max-h-[56vh] overflow-y-auto p-1.5">
                        <Show
                            when={items().length > 0}
                            fallback={
                                <p class="px-3 py-6 text-xs text-muted">
                                    {message() || "No results."}
                                </p>
                            }
                        >
                            <For each={items()}>
                                {(item, index) => (
                                    <button
                                        type="button"
                                        class={
                                            index() === active()
                                                ? "flex w-full items-start gap-2.5 rounded-[5px] bg-accent-soft px-2.5 py-2 text-left"
                                                : "flex w-full items-start gap-2.5 rounded-[5px] px-2.5 py-2 text-left hover:bg-surface-inset"
                                        }
                                        onMouseEnter={() => setActive(index())}
                                        onClick={() => {
                                            item.run();
                                            props.onClose();
                                        }}
                                    >
                                        <span class="mt-0.5 text-accent">
                                            <Icon name={item.icon} />
                                        </span>
                                        <span class="grid min-w-0 gap-0.5">
                                            <strong class="truncate text-[13px] font-medium text-ink">
                                                {item.label}
                                            </strong>
                                            <span class="line-clamp-1 text-xs text-muted">
                                                {item.detail}
                                            </span>
                                        </span>
                                    </button>
                                )}
                            </For>
                        </Show>
                    </div>
                    <div class="flex items-center justify-between border-t border-line-soft px-3 py-2 text-[11px] text-faint">
                        <span>Type to search the whole workspace</span>
                        <span>{current() ? "Enter to open" : "Ctrl K"}</span>
                    </div>
                </div>
            </div>
        </Show>
    );
}

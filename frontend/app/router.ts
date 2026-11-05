import { createSignal } from "solid-js";

export type RouteName =
    | "welcome"
    | "today"
    | "students"
    | "student"
    | "sessions"
    | "session"
    | "schedule"
    | "materials"
    | "guides"
    | "guide"
    | "evidence"
    | "assistant"
    | "archive"
    | "settings"
    | "not-found";

export interface Route {
    name: RouteName;
    id: string;
    tab: string;
}

const [route, setRoute] = createSignal<Route>(parseRoute(window.location.hash));

export function parseRoute(hash: string): Route {
    const raw = hash.replace(/^#\/?/u, "");
    const pathPart = raw.split("?")[0]!;
    const parts = pathPart.split("/").filter(Boolean);
    const [root, id, tab] = parts;
    switch (root) {
        case undefined:
        case "":
            return { name: "today", id: "", tab: "" };
        case "today":
            return { name: "today", id: "", tab: "" };
        case "students":
            return id
                ? { name: "student", id, tab: tab ?? "overview" }
                : { name: "students", id: "", tab: "" };
        case "sessions":
            return id
                ? { name: "session", id, tab: tab ?? "overview" }
                : { name: "sessions", id: "", tab: "" };
        case "schedule":
            return { name: "schedule", id: "", tab: "" };
        case "materials":
            return { name: "materials", id: "", tab: "" };
        case "guides":
            return id
                ? { name: "guide", id, tab: tab ?? "edit" }
                : { name: "guides", id: "", tab: "" };
        case "evidence":
            return { name: "evidence", id: "", tab: "" };
        case "assistant":
            return { name: "assistant", id: "", tab: "" };
        case "archive":
            return { name: "archive", id: "", tab: "" };
        case "settings":
            return { name: "settings", id: "", tab: "" };
        default:
            return { name: "not-found", id: "", tab: "" };
    }
}

export function navigate(path: string, replace = false): void {
    const target = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
    if (replace) {
        window.history.replaceState(null, "", target);
    } else {
        window.location.hash = target;
    }
    setRoute(parseRoute(target));
}

export function startRouter(): void {
    const update = (): void => {
        setRoute(parseRoute(window.location.hash));
        window.requestAnimationFrame(() => {
            document.getElementById("main-content")?.focus({ preventScroll: true });
        });
    };
    if (!window.location.hash) window.history.replaceState(null, "", "#/today");
    window.addEventListener("hashchange", update, { passive: true });
    setRoute(parseRoute(window.location.hash));
}

export function useRoute(): () => Route {
    return route;
}

export function sessionPath(id: string, tab = "overview"): string {
    return `#/sessions/${id}/${tab}`;
}

export function studentPath(id: string, tab = "overview"): string {
    return `#/students/${id}/${tab}`;
}

export function guidePath(id: string): string {
    return `#/guides/${id}/edit`;
}

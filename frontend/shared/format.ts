export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const value = bytes / 1024 ** index;
    return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

export function formatDate(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "No date";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return "No date";
    return new Intl.DateTimeFormat("en-US", {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

export function formatShortDate(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "No date";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return "No date";
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

export function formatTime(value: number | string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "";
    const date = typeof value === "number" ? new Date(value) : new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
}

export function formatDateTime(value: number | string | null | undefined): string {
    const date = formatDate(value);
    const time = formatTime(value);
    return time ? `${date}, ${time}` : date;
}

export function formatDuration(seconds: number | null | undefined): string {
    if (!seconds || seconds <= 0) return "0 min";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

export function formatTimestampUs(microseconds: number): string {
    const totalSeconds = Math.max(0, Math.floor(microseconds / 1_000_000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
        : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function parseTimestampUs(value: string): number {
    const parts = value
        .trim()
        .split(":")
        .map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part) || part < 0)) return 0;
    if (parts.length === 2) return Math.round((parts[0]! * 60 + parts[1]!) * 1_000_000);
    if (parts.length === 3) {
        return Math.round((parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1_000_000);
    }
    return 0;
}

export function todayIso(): string {
    const date = new Date();
    return [
        date.getFullYear().toString().padStart(4, "0"),
        (date.getMonth() + 1).toString().padStart(2, "0"),
        date.getDate().toString().padStart(2, "0"),
    ].join("-");
}

export function toDateTimeLocal(value: number | null | undefined): string {
    const date = value ? new Date(value) : new Date();
    const pad = (part: number): string => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromDateTimeLocal(value: string): number | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.getTime();
}

export function initials(name: string): string {
    const parts = name.trim().split(/\s+/u).filter(Boolean);
    if (parts.length === 0) return "?";
    const first = parts[0]!.charAt(0);
    const last = parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : "";
    return `${first}${last}`.toUpperCase();
}

export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

export function daysUntil(value: number | null | undefined): string {
    if (!value) return "No date";
    const days = Math.ceil((value - Date.now()) / 86_400_000);
    if (days === 0) return "Today";
    if (days === 1) return "Tomorrow";
    if (days === -1) return "Yesterday";
    if (days > 1) return `In ${days} days`;
    return `${Math.abs(days)} days ago`;
}

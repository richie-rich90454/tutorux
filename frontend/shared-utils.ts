import { ArchiveFormatError, type ArchiveRecord } from "./archive/format";

export function field(record: ArchiveRecord, name: string, fallback = ""): string {
    return record.fields.get(name) ?? fallback;
}

export function pluralNoun(count: number, singular: string, plural = `${singular}s`): string {
    return count === 1 ? singular : plural;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
    return `${count.toLocaleString("en-US")} ${pluralNoun(count, singular, plural)}`;
}

export function safeFileName(value: string): string {
    const slug = value
        .trim()
        // eslint-disable-next-line no-control-regex -- Remove platform-invalid filename controls.
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
        .replace(/\s+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^[.-]+|[.-]+$/gu, "");
    return (slug || "Tutorux-workspace").slice(0, 100);
}

export function formatTimestamp(value: string): string {
    try {
        const microseconds = BigInt(value || "0");
        const milliseconds = Number(microseconds / 1000n);
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Date not set";
        return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
            new Date(milliseconds),
        );
    } catch {
        return "Date not set";
    }
}

export function errorMessage(error: unknown): string {
    if (error instanceof ArchiveFormatError) return error.message;
    if (error instanceof Error) return error.message;
    return String(error);
}

export function safeBigInt(value: string): bigint {
    try {
        return BigInt(value || "0");
    } catch {
        return 0n;
    }
}

export function annotationTypeLabel(type: string): string {
    return type
        .split("-")
        .map((word) => word[0]!.toUpperCase() + word.slice(1))
        .join(" ");
}

export function formatBytes(size: bigint): string {
    if (size < 1024n) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = Number(size);
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

export function initials(name: string): string {
    return (
        name
            .trim()
            .split(/\s+/u)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() ?? "")
            .join("") || "T"
    );
}

export function currentJournalDate(now = new Date()): string {
    return [now.getFullYear(), now.getMonth() + 1, now.getDate()]
        .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0")))
        .join("-");
}

export function dateParts(value: string): { day: string; month: string; year: string } {
    const date = new Date(`${value}T12:00:00`);
    if (Number.isNaN(date.getTime())) return { day: "–", month: "---", year: "" };
    return {
        day: new Intl.DateTimeFormat("en-US", { day: "2-digit" }).format(date),
        month: new Intl.DateTimeFormat("en-US", { month: "short" }).format(date).toUpperCase(),
        year: new Intl.DateTimeFormat("en-US", { year: "numeric" }).format(date),
    };
}

export function safeJournalColor(record: ArchiveRecord): string {
    const color = field(record, "color");
    return /^#[\da-f]{6}$/iu.test(color) ? color : "var(--accent)";
}

import type { Session, SessionDetail, SessionInput, TranscriptCue } from "../../api/types";
import { formatTimestampUs, parseTimestampUs } from "../../shared/format";

export function sessionInput(
    session: Session,
    overrides: Partial<SessionInput> = {},
): SessionInput {
    return {
        studentId: session.studentId,
        title: session.title,
        subject: session.subject,
        scheduledAt: session.scheduledAt,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        status: session.status,
        notes: session.notes,
        ...overrides,
    };
}

type ParsedCue = Pick<
    TranscriptCue,
    "sessionId" | "startUs" | "endUs" | "speaker" | "body" | "verified"
>;

export function parseTranscript(text: string, sessionId: string): ParsedCue[] {
    const normalized = text.replace(/\r\n/gu, "\n").trim();
    const result: ParsedCue[] = [];
    const blocks = normalized.split(/\n{2,}/u);
    for (const block of blocks) {
        const lines = block
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean);
        const timeLine = lines.find((line) => line.includes("-->"));
        if (timeLine) {
            const [startRaw, endRaw] = timeLine
                .split("-->")
                .map((part) => part.trim().split(/\s+/u)[0] ?? "");
            const body = lines
                .slice(lines.indexOf(timeLine) + 1)
                .join(" ")
                .replace(/<[^>]+>/gu, "")
                .trim();
            if (!body) continue;
            result.push({
                sessionId,
                startUs: parseTimestampUs((startRaw ?? "").replace(",", ".")),
                endUs: parseTimestampUs((endRaw ?? "").replace(",", ".")),
                speaker: "",
                body,
                verified: false,
            });
            continue;
        }
        for (const line of lines) {
            const match =
                /^(?:\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*)?(?:([^:]{1,40}):\s*)?(.+)$/u.exec(line);
            if (!match?.[3]) continue;
            const time = match[1];
            const speaker = match[2] ?? "";
            const body = match[3].trim();
            if (!body) continue;
            const start = time ? parseTimestampUs(time) : 0;
            result.push({
                sessionId,
                startUs: start,
                endUs: start + 5_000_000,
                speaker,
                body,
                verified: false,
            });
        }
    }
    return result;
}

function stamp(microseconds: number, separator: "," | "."): string {
    const total = Math.floor(microseconds / 1000);
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const millis = total % 1000;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(millis).padStart(3, "0")}`;
}

export function toSrt(cues: TranscriptCue[]): string {
    return cues
        .map(
            (cue, index) =>
                `${index + 1}\n${stamp(cue.startUs, ",")} --> ${stamp(cue.endUs, ",")}\n${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
        )
        .join("\n\n");
}

export function toVtt(cues: TranscriptCue[]): string {
    return `WEBVTT\n\n${cues
        .map(
            (cue) =>
                `${stamp(cue.startUs, ".")} --> ${stamp(cue.endUs, ".")}\n${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
        )
        .join("\n\n")}`;
}

export function buildGuide(detail: SessionDetail): string {
    const lines: string[] = [`# ${detail.session.title}`, ""];
    if (detail.session.subject) lines.push(`Subject: ${detail.session.subject}`, "");
    if (detail.session.notes) lines.push("## Session focus", detail.session.notes, "");
    if (detail.observations.length) {
        lines.push("## What stood out");
        for (const observation of detail.observations) {
            lines.push(`- ${observation.title || "Observation"}: ${observation.body}`);
        }
        lines.push("");
    }
    if (detail.cues.length) {
        lines.push("## Transcript highlights");
        for (const cue of detail.cues.slice(0, 60)) {
            lines.push(
                `- ${formatTimestampUs(cue.startUs)} ${cue.speaker ? `${cue.speaker}: ` : ""}${cue.body}`,
            );
        }
        lines.push("");
    }
    if (detail.materials.length) {
        lines.push("## Materials");
        for (const material of detail.materials) {
            lines.push(`- ${material.title || material.filename}`);
        }
        lines.push("");
    }
    return lines.join("\n").trim();
}

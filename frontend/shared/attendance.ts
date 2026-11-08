export interface AttendanceStats {
    completed: number;
    noShows: number;
    rate: number | null;
}

export function attendanceStats(sessions: ReadonlyArray<{ status: string }>): AttendanceStats {
    let completed = 0;
    let noShows = 0;
    for (const session of sessions) {
        if (session.status === "completed") completed += 1;
        else if (session.status === "no_show") noShows += 1;
    }
    const total = completed + noShows;
    return {
        completed,
        noShows,
        rate: total > 0 ? Math.round((completed / total) * 100) : null,
    };
}

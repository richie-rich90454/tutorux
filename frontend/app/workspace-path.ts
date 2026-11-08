export function normalizePath(value: string): string {
    const slashed = value.trim().replace(/\\/gu, "/").replace(/\/+/gu, "/");
    if (slashed.length <= 1) return slashed;
    return slashed.replace(/\/+$/u, "");
}

export function isInsideDirectory(path: string, directory: string): boolean {
    const target = normalizePath(path).toLowerCase();
    const root = normalizePath(directory).toLowerCase();
    if (!target || !root) return false;
    return target === root || target.startsWith(`${root}/`);
}

export function isRestorableWorkspacePath(path: string, temporaryDirectory: string): boolean {
    const value = path.trim();
    if (!value) return false;
    if (!temporaryDirectory.trim()) return true;
    return !isInsideDirectory(value, temporaryDirectory);
}

export function workspaceFileName(path: string): string {
    const normalized = normalizePath(path);
    const index = normalized.lastIndexOf("/");
    return index >= 0 ? normalized.slice(index + 1) : normalized;
}

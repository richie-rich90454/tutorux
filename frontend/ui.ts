export function cn(...values: Array<string | false | null | undefined>): string {
    return values.filter(Boolean).join(" ");
}

const focusRing =
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export const buttonBase = cn(
    "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[5px] border border-transparent px-3 text-[13px] font-medium leading-none whitespace-nowrap transition-colors",
    "active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
    focusRing,
);

export const buttonPrimary = cn(
    buttonBase,
    "border-accent bg-accent text-white hover:border-accent-hover hover:bg-accent-hover",
);

export const buttonOutline = cn(
    buttonBase,
    "border-line-strong bg-surface text-ink-soft hover:bg-surface-inset hover:text-ink",
);

export const buttonQuiet = cn(
    buttonBase,
    "bg-transparent text-ink-soft hover:bg-accent-soft hover:text-ink",
);

export const buttonDanger = cn(
    buttonBase,
    "border-danger/30 bg-[var(--danger-soft)] text-danger hover:border-danger",
);

export const buttonLarge = cn(buttonBase, "min-h-10 px-4 text-sm");

export const iconButton = cn(
    "inline-grid h-8 w-8 shrink-0 place-items-center rounded-[5px] text-muted transition-colors",
    "hover:bg-surface-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50",
    focusRing,
);

export const inputBase = cn(
    "h-9 w-full min-w-0 rounded-[5px] border border-line-strong bg-surface px-2.5 text-[13px] text-ink",
    "placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
    "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted",
);

export const selectBase = cn(inputBase, "cursor-pointer pr-8");

export const textareaBase = cn(
    "min-h-24 w-full rounded-[5px] border border-line-strong bg-surface px-2.5 py-2 text-[13px] leading-relaxed text-ink",
    "placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
    "disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted",
);

export const labelBase = "grid min-w-0 gap-1.5 text-xs font-semibold text-ink-soft";

export const helperText = "text-xs leading-relaxed text-muted";

export const errorText = "text-xs font-medium text-danger";

export const fieldGrid = "grid gap-2.5 sm:grid-cols-2";

export const pageBody = "mx-auto w-full max-w-[1320px] px-5 pt-5 pb-[78px] sm:px-7 sm:pt-7 sm:pb-8 lg:px-9 lg:pb-10";

export const pageToolbar =
    "sticky top-0 z-10 flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-line-soft bg-canvas/95 px-4 py-2 backdrop-blur sm:px-6";

export const card = "min-w-0 rounded-[5px] border border-line bg-surface";

export const cardHeading = "flex flex-wrap items-start justify-between gap-3";

export const eyebrow = "text-xs font-medium tracking-wide text-muted";

export const heading1 = "text-[28px] font-semibold leading-tight tracking-tight text-ink";

export const heading2 = "text-lg font-semibold leading-snug tracking-tight text-ink";

export const heading3 = "text-sm font-semibold leading-snug text-ink";

export const bodyText = "text-[13px] leading-relaxed text-ink-soft";

export const mutedText = "text-xs leading-relaxed text-muted";

export const kbd =
    "inline-flex items-center rounded-[4px] border border-line-soft bg-surface-subtle px-1.5 py-0.5 text-[11px] leading-none text-muted";

export const icon = "h-4 w-4 shrink-0";

export const iconSmall = "h-3.5 w-3.5 shrink-0";

export const chip =
    "inline-flex items-center gap-1 rounded-[5px] border border-line-soft bg-surface-subtle px-1.5 py-0.5 text-xs text-ink-soft";

export const emptyPanel = "flex min-h-[180px] flex-col items-start justify-center gap-2 px-2 py-7 text-left";

export const dialogBackdrop =
    "fixed inset-0 z-20 grid place-items-center bg-[rgb(10_16_12_/_43%)] p-5 [animation:fade-in_0.14s_ease-out]";

export const dialogPanel =
    "relative w-full max-w-[475px] max-h-[92vh] overflow-auto rounded-xl border border-line bg-surface p-6 pb-4 shadow-none [animation:modal-in_0.18s_ease-out]";

export const dialogTitle = "text-xl font-semibold tracking-tight text-ink";

export const dialogDescription = "max-w-[405px] text-xs leading-relaxed text-muted";

export const sectionStack = "grid gap-4";

export const statisticCard = cn(
    card,
    "flex min-h-[88px] min-w-0 items-start gap-2.5 p-3 text-left text-ink transition-colors",
    "hover:border-line-strong",
);

export const recordList = "grid gap-0";

export const recordCard = cn(card, "p-4");

export const inlineMeta = "flex flex-wrap items-center gap-3 text-xs text-muted";

export const tag = "inline-flex rounded-[4px] bg-accent-soft px-1.5 py-0.5 text-xs font-medium text-accent";

export const tableHeader = "text-left text-xs font-medium text-muted";

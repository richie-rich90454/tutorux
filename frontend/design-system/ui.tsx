import { For, Show, createSignal, type JSX } from "solid-js";
import { Icon, type IconName } from "../shared-ui";

export function cn(...values: Array<string | false | null | undefined>): string {
    return values.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md";

const buttonBase =
    "inline-flex items-center justify-center gap-1.5 rounded-[5px] border font-medium leading-none whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50";

const buttonVariants: Record<ButtonVariant, string> = {
    primary:
        "border-accent bg-accent text-[var(--accent-contrast)] hover:border-accent-hover hover:bg-accent-hover",
    secondary: "border-line-strong bg-surface text-ink-soft hover:bg-surface-inset hover:text-ink",
    ghost: "border-transparent bg-transparent text-ink-soft hover:bg-surface-inset hover:text-ink",
    danger: "border-danger/30 bg-[var(--danger-soft)] text-danger hover:border-danger",
};

const buttonSizes: Record<ButtonSize, string> = {
    sm: "min-h-7 px-2.5 text-xs",
    md: "min-h-9 px-3 text-[13px]",
};

export function Button(props: {
    variant?: ButtonVariant | undefined;
    size?: ButtonSize | undefined;
    type?: "button" | "submit" | undefined;
    disabled?: boolean | undefined;
    class?: string | undefined;
    title?: string | undefined;
    onClick?: ((event: MouseEvent) => void) | undefined;
    children: JSX.Element;
}): JSX.Element {
    return (
        <button
            class={cn(
                buttonBase,
                buttonVariants[props.variant ?? "secondary"],
                buttonSizes[props.size ?? "md"],
                props.class,
            )}
            type={props.type ?? "button"}
            disabled={props.disabled}
            title={props.title}
            onClick={(event) => props.onClick?.(event)}
        >
            {props.children}
        </button>
    );
}

export function IconButton(props: {
    icon: IconName;
    label: string;
    disabled?: boolean | undefined;
    onClick?: (() => void) | undefined;
}): JSX.Element {
    return (
        <button
            type="button"
            class="inline-grid h-8 w-8 place-items-center rounded-[5px] text-muted transition-colors hover:bg-surface-inset hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            aria-label={props.label}
            title={props.label}
            disabled={props.disabled}
            onClick={() => props.onClick?.()}
        >
            <Icon name={props.icon} />
        </button>
    );
}

export function Field(props: {
    label: string;
    helper?: string | undefined;
    error?: string | undefined;
    children: JSX.Element;
    class?: string | undefined;
}): JSX.Element {
    return (
        <label class={cn("grid min-w-0 gap-1.5 text-xs font-semibold text-ink-soft", props.class)}>
            <span>{props.label}</span>
            {props.children}
            <Show when={props.error}>
                <span class="text-xs font-medium text-danger">{props.error}</span>
            </Show>
            <Show when={!props.error && props.helper}>
                <span class="text-xs font-normal leading-relaxed text-muted">{props.helper}</span>
            </Show>
        </label>
    );
}

const inputClass =
    "h-9 w-full min-w-0 rounded-[5px] border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-muted";

export function TextInput(props: {
    value: string;
    onInput?: ((value: string) => void) | undefined;
    placeholder?: string | undefined;
    type?: string | undefined;
    disabled?: boolean | undefined;
    ariaLabel?: string | undefined;
    class?: string | undefined;
}): JSX.Element {
    return (
        <input
            class={cn(inputClass, props.class)}
            value={props.value}
            type={props.type ?? "text"}
            placeholder={props.placeholder}
            disabled={props.disabled}
            aria-label={props.ariaLabel}
            onInput={(event) => props.onInput?.(event.currentTarget.value)}
        />
    );
}

export function TextArea(props: {
    value: string;
    onInput?: ((value: string) => void) | undefined;
    placeholder?: string | undefined;
    disabled?: boolean | undefined;
    rows?: number | undefined;
    ariaLabel?: string | undefined;
    class?: string | undefined;
}): JSX.Element {
    return (
        <textarea
            class={cn(inputClass, "min-h-24 h-auto resize-y py-2 leading-relaxed", props.class)}
            value={props.value}
            placeholder={props.placeholder}
            disabled={props.disabled}
            rows={props.rows ?? 4}
            aria-label={props.ariaLabel}
            onInput={(event) => props.onInput?.(event.currentTarget.value)}
        />
    );
}

export function Select(props: {
    value: string;
    options: Array<{ value: string; label: string }>;
    onChange: (value: string) => void;
    disabled?: boolean | undefined;
    ariaLabel?: string | undefined;
    class?: string | undefined;
}): JSX.Element {
    return (
        <select
            class={cn(inputClass, "cursor-pointer pr-8", props.class)}
            value={props.value}
            disabled={props.disabled}
            aria-label={props.ariaLabel}
            onChange={(event) => props.onChange(event.currentTarget.value)}
        >
            <For each={props.options}>
                {(option) => <option value={option.value}>{option.label}</option>}
            </For>
        </select>
    );
}

export function PageHeader(props: {
    eyebrow?: string | undefined;
    title: string;
    description?: string | undefined;
    actions?: JSX.Element | undefined;
}): JSX.Element {
    return (
        <header class="mb-6 flex flex-wrap items-end justify-between gap-4 max-sm:mb-4 max-sm:items-start">
            <div class="min-w-0">
                <Show when={props.eyebrow}>
                    <span class="text-xs font-medium text-accent">{props.eyebrow}</span>
                </Show>
                <h1 class="mt-1 text-[26px] font-semibold leading-tight tracking-tight text-ink">
                    {props.title}
                </h1>
                <Show when={props.description}>
                    <p class="mt-1.5 max-w-[72ch] text-[13px] leading-relaxed text-muted">
                        {props.description}
                    </p>
                </Show>
            </div>
            <Show when={props.actions}>
                <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
            </Show>
        </header>
    );
}

export function Panel(props: { class?: string | undefined; children: JSX.Element }): JSX.Element {
    return (
        <section class={cn("min-w-0 rounded-[6px] border border-line bg-surface", props.class)}>
            {props.children}
        </section>
    );
}

export function PanelHeader(props: {
    title: string;
    detail?: string | undefined;
    actions?: JSX.Element | undefined;
}): JSX.Element {
    return (
        <div class="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
            <div class="min-w-0">
                <h2 class="text-sm font-semibold text-ink">{props.title}</h2>
                <Show when={props.detail}>
                    <p class="mt-0.5 text-xs text-muted">{props.detail}</p>
                </Show>
            </div>
            <Show when={props.actions}>
                <div class="flex flex-wrap items-center gap-2">{props.actions}</div>
            </Show>
        </div>
    );
}

export function EmptyState(props: {
    icon: IconName;
    title: string;
    text: string;
    action?: JSX.Element | undefined;
}): JSX.Element {
    return (
        <div class="flex min-h-[150px] flex-col items-start justify-center gap-2 px-5 py-8 text-left">
            <span class="grid h-9 w-9 place-items-center rounded-[5px] border border-line bg-surface-subtle text-accent">
                <Icon name={props.icon} />
            </span>
            <h3 class="text-sm font-semibold text-ink">{props.title}</h3>
            <p class="max-w-[58ch] text-xs leading-relaxed text-muted">{props.text}</p>
            <Show when={props.action}>
                <div class="mt-1">{props.action}</div>
            </Show>
        </div>
    );
}

export function Badge(props: {
    tone?: "neutral" | "accent" | "success" | "warning" | "danger";
    children: JSX.Element;
}): JSX.Element {
    const tones = {
        neutral: "border-line-soft bg-surface-subtle text-muted",
        accent: "border-accent/20 bg-accent-soft text-accent",
        success: "border-success/20 bg-accent-soft text-success",
        warning: "border-warning/25 bg-[var(--warning-soft,#fbf5e8)] text-warning",
        danger: "border-danger/20 bg-[var(--danger-soft)] text-danger",
    };
    return (
        <span
            class={cn(
                "inline-flex items-center rounded-[4px] border px-1.5 py-0.5 text-[11px] font-medium",
                tones[props.tone ?? "neutral"],
            )}
        >
            {props.children}
        </span>
    );
}

export function Tabs(props: {
    tabs: Array<{ id: string; label: string; count?: number }>;
    active: string;
    onChange: (id: string) => void;
}): JSX.Element {
    return (
        <div class="flex flex-wrap gap-1 border-b border-line-soft pb-px" role="tablist">
            <For each={props.tabs}>
                {(tab) => (
                    <button
                        type="button"
                        role="tab"
                        aria-selected={props.active === tab.id}
                        class={cn(
                            "relative rounded-[4px] px-2.5 py-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                            props.active === tab.id
                                ? "bg-accent-soft text-accent"
                                : "text-muted hover:bg-surface-inset hover:text-ink",
                        )}
                        onClick={() => props.onChange(tab.id)}
                    >
                        {tab.label}
                        <Show when={tab.count !== undefined}>
                            <span class="ml-1 text-[11px] text-faint">{tab.count}</span>
                        </Show>
                    </button>
                )}
            </For>
        </div>
    );
}

export function InlineNotice(props: {
    tone?: "info" | "danger" | "success";
    children: JSX.Element;
}): JSX.Element {
    const tones = {
        info: "border-line bg-surface-subtle text-ink-soft",
        danger: "border-danger/25 bg-[var(--danger-soft)] text-danger",
        success: "border-success/25 bg-accent-soft text-success",
    };
    return (
        <div
            class={cn(
                "rounded-[5px] border px-3 py-2 text-xs leading-relaxed",
                tones[props.tone ?? "info"],
            )}
        >
            {props.children}
        </div>
    );
}

export function ConfirmButton(props: {
    label: string;
    confirmLabel?: string | undefined;
    class?: string | undefined;
    onConfirm: () => void;
    disabled?: boolean | undefined;
}): JSX.Element {
    const [armed, setArmed] = createSignal(false);
    return (
        <Button
            variant={armed() ? "danger" : "ghost"}
            size="sm"
            class={props.class}
            disabled={props.disabled}
            onClick={() => {
                if (!armed()) {
                    setArmed(true);
                    window.setTimeout(() => setArmed(false), 3500);
                    return;
                }
                setArmed(false);
                props.onConfirm();
            }}
        >
            {armed() ? (props.confirmLabel ?? "Confirm") : props.label}
        </Button>
    );
}

export function Metric(props: {
    label: string;
    value: string | number;
    detail?: string;
}): JSX.Element {
    return (
        <div class="grid gap-0.5">
            <span class="text-[11px] font-medium text-muted">{props.label}</span>
            <strong class="text-lg font-semibold leading-tight text-ink">{props.value}</strong>
            <Show when={props.detail}>
                <span class="text-[11px] text-faint">{props.detail}</span>
            </Show>
        </div>
    );
}

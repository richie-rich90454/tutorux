import { onCleanup, onMount, Show, type JSX } from "solid-js";

export type IconName =
    | "home"
    | "journal"
    | "students"
    | "sessions"
    | "annotations"
    | "transcripts"
    | "guides"
    | "evidence"
    | "assets"
    | "trash"
    | "archive"
    | "settings"
    | "plus"
    | "microphone"
    | "search"
    | "sun"
    | "moon"
    | "chevron"
    | "arrow"
    | "book"
    | "clock"
    | "spark"
    | "folder"
    | "shield"
    | "close"
    | "check"
    | "more";

export function EmptyState(props: {
    icon: IconName;
    title: string;
    text: string;
    action: string;
    onAction: () => void;
    disabled: boolean;
}): JSX.Element {
    return (
        <div class="empty-state">
            <span class="empty-illustration">
                <span class="empty-illustration-back" />
                <span class="empty-illustration-paper">
                    <Icon name={props.icon} />
                    <i />
                    <i />
                    <i />
                </span>
                <span class="empty-illustration-spark">✳</span>
            </span>
            <h2>{props.title}</h2>
            <p>{props.text}</p>
            <Show when={!props.disabled}>
                <button
                    class="button button-primary"
                    type="button"
                    onClick={() => props.onAction()}
                >
                    <Icon name="plus" />
                    {props.action}
                </button>
            </Show>
        </div>
    );
}

export function Icon(props: { name: IconName }): JSX.Element {
    const common = {
        fill: "none",
        stroke: "currentColor",
        "stroke-width": 1.7,
        "stroke-linecap": "round" as const,
        "stroke-linejoin": "round" as const,
    };
    return (
        <svg class="icon" viewBox="0 0 24 24" aria-hidden="true" {...common}>
            {props.name === "home" && (
                <>
                    <path d="m3.5 10.5 8.5-7 8.5 7" />
                    <path d="M5.5 9.8V20h13V9.8M9.5 20v-6.5h5V20" />
                </>
            )}
            {props.name === "journal" && (
                <>
                    <path d="M6 4.5h12a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H6A2.5 2.5 0 0 1 3.5 17V7A2.5 2.5 0 0 1 6 4.5Z" />
                    <path d="M3.5 17A2.5 2.5 0 0 1 6 14.5h13.5M8 8h7M8 11h7" />
                </>
            )}
            {props.name === "students" && (
                <>
                    <circle cx="9" cy="8" r="3.2" />
                    <path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.2a3.2 3.2 0 0 1 0 6.2M17 15a5 5 0 0 1 3.5 4.8" />
                </>
            )}
            {props.name === "sessions" && (
                <>
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M12 7v5l3.2 2" />
                </>
            )}
            {props.name === "annotations" && (
                <>
                    <path d="M12 21s7-6.4 7-12a7 7 0 1 0-14 0c0 5.6 7 12 7 12Z" />
                    <circle cx="12" cy="9" r="2.2" />
                </>
            )}
            {props.name === "transcripts" && (
                <>
                    <path d="M5.5 4.5h13v15h-13z" />
                    <path d="M8.5 8h7M8.5 11h7M8.5 14h4" />
                    <path d="M3.5 7v12a1.5 1.5 0 0 0 1.5 1.5h11" />
                </>
            )}
            {props.name === "guides" && (
                <>
                    <path d="M5.5 4.5h13v15h-13zM8.5 8h7M8.5 11h7M8.5 14h4" />
                    <path d="M5.5 18c0-1.1.9-2 2-2h11" />
                </>
            )}
            {props.name === "evidence" && (
                <>
                    <path d="M4 19.5h16M6.5 16v-4M12 16V7M17.5 16V9" />
                    <path d="m5.5 9 5-3 5 1 3-3" />
                </>
            )}
            {props.name === "assets" && (
                <>
                    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H10l2 2h5.5A2.5 2.5 0 0 1 20 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17.5z" />
                    <path d="m8 15 2-2 2 2 2.5-3 2.5 3" />
                </>
            )}
            {props.name === "archive" && (
                <>
                    <path d="M4 7h16v13H4zM3 4h18v3H3z" />
                    <path d="M9 11h6" />
                </>
            )}
            {props.name === "trash" && (
                <>
                    <path d="M4.5 7.5h15M9 7.5V5h6v2.5M7 7.5l.8 12h8.4l.8-12M10 11v5M14 11v5" />
                </>
            )}
            {props.name === "settings" && (
                <>
                    <circle cx="12" cy="12" r="3" />
                    <path
                        d="m19.4 15 .1.1 1.1.9-1.2 2.1-1.4-.5a7.8 7.8 0 0 1-1.4.8l-.3 1.5h-2.5l-.3-1.5a7.8 7.8 0 0 1-1.4-.8l-1.4.5-1.2-2.1 1.1-.9a6.9 6.9 0 0 1 0-1.7l-1.1-.9 1.2-2.1 1.4.5a7.8 7.8 0 0 1 1.4-.8l.3-1.5h2.5l.3 1.5a7.8 7.8 0 0 1 1.4.8l1.4-.5 1.2 2.1-1.1.9a6.9 6.9 0 0 1 0 1.6Z"
                        transform="translate(-2 -1) scale(.9)"
                    />
                </>
            )}
            {props.name === "plus" && <path d="M12 5v14M5 12h14" />}
            {props.name === "microphone" && (
                <>
                    <rect x="9" y="3" width="6" height="12" rx="3" />
                    <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M9 21h6" />
                </>
            )}
            {props.name === "search" && (
                <>
                    <circle cx="10.8" cy="10.8" r="6.8" />
                    <path d="m16 16 4.5 4.5" />
                </>
            )}
            {props.name === "sun" && (
                <>
                    <circle cx="12" cy="12" r="4" />
                    <path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2.5 12h2m15 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
                </>
            )}
            {props.name === "moon" && (
                <path d="M20.5 15.1A8.5 8.5 0 0 1 8.9 3.5 8.6 8.6 0 1 0 20.5 15.1Z" />
            )}
            {props.name === "chevron" && <path d="m9 5 7 7-7 7" />}
            {props.name === "arrow" && (
                <>
                    <path d="M5 12h13M13 6l6 6-6 6" />
                </>
            )}
            {props.name === "book" && (
                <>
                    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v17H6.5A2.5 2.5 0 0 1 4 17.5z" />
                    <path d="M4 17.5A2.5 2.5 0 0 1 6.5 15H20M8 7h7M8 10h7" />
                </>
            )}
            {props.name === "clock" && (
                <>
                    <circle cx="12" cy="12" r="8.5" />
                    <path d="M12 7v5l3 1.8" />
                </>
            )}
            {props.name === "spark" && (
                <>
                    <path d="m12 3 1.6 6.1L20 11l-6.4 1.9L12 19l-1.7-6.1L4 11l6.3-1.9z" />
                    <path d="m19 16 .6 2.4L22 19l-2.4.6L19 22l-.6-2.4L16 19l2.4-.6z" />
                </>
            )}
            {props.name === "folder" && (
                <>
                    <path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z" />
                    <path d="M3.5 10h17" />
                </>
            )}
            {props.name === "shield" && (
                <>
                    <path d="M12 3 19 6v5c0 4.4-2.8 7.8-7 10-4.2-2.2-7-5.6-7-10V6z" />
                    <path d="m9 12 2 2 4-4" />
                </>
            )}
            {props.name === "close" && (
                <>
                    <path d="m6 6 12 12M18 6 6 18" />
                </>
            )}
            {props.name === "check" && <path d="m5 12.5 4.5 4.5L19 7" />}
            {props.name === "more" && (
                <>
                    <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
                    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
                    <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
                </>
            )}
        </svg>
    );
}

export interface ManagedDialogProps {
    children: JSX.Element;
    class: string;
    role: "dialog" | "alertdialog";
    labelledBy?: string;
    describedBy?: string;
    label?: string;
    onEscape?: () => void;
    canEscape?: () => boolean;
    onKeyDown?: (event: KeyboardEvent) => void;
    restoreFocus?: () => boolean;
}

export function ManagedDialog(props: ManagedDialogProps): JSX.Element {
    const returnFocus =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let dialogElement!: HTMLElement;

    const focusableElements = (): HTMLElement[] =>
        [
            ...dialogElement.querySelectorAll<HTMLElement>(
                'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, audio[controls], video[controls], [contenteditable="true"], [tabindex]:not([tabindex="-1"])',
            ),
        ].filter(
            (element) =>
                !element.hasAttribute("hidden") &&
                element.getAttribute("aria-hidden") !== "true" &&
                element.getClientRects().length > 0,
        );

    onMount(() => {
        const initialFocus =
            dialogElement.querySelector<HTMLElement>("[data-dialog-initial-focus]") ??
            (props.role === "dialog"
                ? dialogElement.querySelector<HTMLElement>(
                      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled]), [contenteditable="true"]',
                  )
                : null) ??
            focusableElements()[0] ??
            dialogElement;
        initialFocus.focus({ preventScroll: true });

        const onKeyDown = (event: KeyboardEvent): void => {
            if (
                !dialogElement.isConnected ||
                [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].at(-1) !==
                    dialogElement
            ) {
                return;
            }

            if (event.key === "Escape" && props.onEscape) {
                event.preventDefault();
                event.stopPropagation();
                if (props.canEscape?.() ?? true) props.onEscape();
                return;
            }

            if (event.key !== "Tab") return;
            const focusable = focusableElements();
            if (focusable.length === 0) {
                event.preventDefault();
                dialogElement.focus({ preventScroll: true });
                return;
            }

            const first = focusable[0]!;
            const last = focusable.at(-1)!;
            const active = document.activeElement;
            if (
                event.shiftKey &&
                (active === first || active === dialogElement || !dialogElement.contains(active))
            ) {
                event.preventDefault();
                last.focus();
            } else if (
                !event.shiftKey &&
                (active === last || active === dialogElement || !dialogElement.contains(active))
            ) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener("keydown", onKeyDown, true);
        onCleanup(() => {
            document.removeEventListener("keydown", onKeyDown, true);
            if (props.restoreFocus?.() === false) return;
            queueMicrotask(() => {
                const activeDialog = [
                    ...document.querySelectorAll<HTMLElement>('[aria-modal="true"]'),
                ].at(-1);
                const returnTarget =
                    returnFocus?.isConnected &&
                    !returnFocus.matches(":disabled, [aria-disabled='true']")
                        ? returnFocus
                        : null;
                const target = activeDialog
                    ? returnTarget && activeDialog.contains(returnTarget)
                        ? returnTarget
                        : (activeDialog.querySelector<HTMLElement>(
                              'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
                          ) ?? activeDialog)
                    : (returnTarget ?? document.querySelector<HTMLElement>("#main-content"));
                target?.focus({ preventScroll: true });
            });
        });
    });

    return (
        <section
            ref={(element) => {
                dialogElement = element;
            }}
            class={`${props.class} modal-focus-scope`}
            role={props.role}
            aria-modal="true"
            aria-labelledby={props.labelledBy}
            aria-describedby={props.describedBy}
            aria-label={props.label}
            tabindex="-1"
            onKeyDown={(event) => props.onKeyDown?.(event)}
        >
            {props.children}
        </section>
    );
}

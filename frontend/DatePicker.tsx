import { cn } from "./ui";
import {
    createEffect,
    createMemo,
    createSignal,
    For,
    onCleanup,
    onMount,
    Show,
    untrack,
} from "solid-js";
import { Icon } from "./shared-ui";

interface DatePickerProps {
    id: string;
    value: string;
    onChange: (value: string) => void;
    "aria-label": string;
    disabled?: boolean;
}

function parseDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return null;

    const date = new Date(0);
    date.setUTCHours(12, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day
        ? date
        : null;
}

function formatDate(date: Date): string {
    return [
        date.getUTCFullYear().toString().padStart(4, "0"),
        (date.getUTCMonth() + 1).toString().padStart(2, "0"),
        date.getUTCDate().toString().padStart(2, "0"),
    ].join("-");
}

function monthStart(date: Date): Date {
    const result = new Date(0);
    result.setUTCHours(12, 0, 0, 0);
    result.setUTCFullYear(date.getUTCFullYear(), date.getUTCMonth(), 1);
    return result;
}

function todayDate(): Date {
    const today = new Date();
    const result = new Date(0);
    result.setUTCHours(12, 0, 0, 0);
    result.setUTCFullYear(today.getFullYear(), today.getMonth(), today.getDate());
    return result;
}

function monthLabel(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function accessibleDateLabel(date: Date): string {
    return new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeZone: "UTC",
    }).format(date);
}

export function DatePicker(props: DatePickerProps) {
    const selected = () => parseDate(props.value);
    const [draft, setDraft] = createSignal(untrack(() => props.value));
    const [month, setMonth] = createSignal(monthStart(selected() ?? todayDate()));
    const [focusedDate, setFocusedDate] = createSignal(formatDate(selected() ?? todayDate()));
    const [open, setOpen] = createSignal(false);
    const [invalid, setInvalid] = createSignal(false);
    const days = createMemo(() => {
        const first = month();
        const offset = (first.getUTCDay() + 6) % 7;
        const gridStart = new Date(first);
        gridStart.setUTCDate(gridStart.getUTCDate() - offset);
        return Array.from({ length: 42 }, (_, index) => {
            const day = new Date(gridStart);
            day.setUTCDate(gridStart.getUTCDate() + index);
            return { date: day, inMonth: day.getUTCMonth() === first.getUTCMonth() };
        });
    });
    let root: HTMLDivElement | undefined;
    let input: HTMLInputElement | undefined;
    const dayButtons = new Map<string, HTMLButtonElement>();

    createEffect(() => {
        const value = props.value;
        setDraft(value);
        setInvalid(false);
        const date = parseDate(value);
        if (date) {
            setMonth(monthStart(date));
            setFocusedDate(formatDate(date));
        }
    });

    createEffect(() => {
        if (!open()) return;
        const frame = window.requestAnimationFrame(() => dayButtons.get(focusedDate())?.focus());
        onCleanup(() => window.cancelAnimationFrame(frame));
    });

    onMount(() => {
        const dismissOutside = (event: PointerEvent): void => {
            if (root && event.target instanceof Node && !root.contains(event.target)) {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", dismissOutside);
        onCleanup(() => document.removeEventListener("pointerdown", dismissOutside));
    });

    function moveMonth(offset: number): void {
        const current = parseDate(focusedDate()) ?? todayDate();
        const next = monthStart(current);
        next.setUTCMonth(next.getUTCMonth() + offset, 1);
        const daysInMonth = new Date(
            Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
        ).getUTCDate();
        next.setUTCDate(Math.min(current.getUTCDate(), daysInMonth));
        setMonth(monthStart(next));
        setFocusedDate(formatDate(next));
        window.requestAnimationFrame(() => dayButtons.get(formatDate(next))?.focus());
    }

    function focusDate(date: Date): void {
        const value = formatDate(date);
        setFocusedDate(value);
        if (
            date.getUTCMonth() !== month().getUTCMonth() ||
            date.getUTCFullYear() !== month().getUTCFullYear()
        ) {
            setMonth(monthStart(date));
        }
        window.requestAnimationFrame(() => dayButtons.get(value)?.focus());
    }

    function handleDayKeys(event: KeyboardEvent, date: Date): void {
        const offset =
            event.key === "ArrowLeft"
                ? -1
                : event.key === "ArrowRight"
                  ? 1
                  : event.key === "ArrowUp"
                    ? -7
                    : event.key === "ArrowDown"
                      ? 7
                      : 0;
        if (offset) {
            event.preventDefault();
            const next = new Date(date);
            next.setUTCDate(next.getUTCDate() + offset);
            focusDate(next);
        } else if (event.key === "Home" || event.key === "End") {
            event.preventDefault();
            const next = new Date(date);
            const mondayOffset = (next.getUTCDay() + 6) % 7;
            next.setUTCDate(
                next.getUTCDate() + (event.key === "Home" ? -mondayOffset : 6 - mondayOffset),
            );
            focusDate(next);
        } else if (event.key === "PageUp" || event.key === "PageDown") {
            event.preventDefault();
            const next = monthStart(date);
            next.setUTCMonth(next.getUTCMonth() + (event.key === "PageUp" ? -1 : 1));
            const daysInMonth = new Date(
                Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
            ).getUTCDate();
            next.setUTCDate(Math.min(date.getUTCDate(), daysInMonth));
            focusDate(next);
        }
    }

    function chooseDate(date: Date): void {
        const value = formatDate(date);
        setDraft(value);
        setInvalid(false);
        props.onChange(value);
        setOpen(false);
        input?.focus();
    }

    function handleKeys(event: KeyboardEvent): void {
        if (event.key === "Escape" && open()) {
            event.preventDefault();
            setOpen(false);
            input?.focus();
        }
    }

    return (
        <div
            class={cn("date-picker", "text-ink-soft min-w-0 relative")}
            ref={(element) => (root = element)}
            data-escape-scope="true"
            onKeyDown={handleKeys}
        >
            <div
                class={cn(
                    `date-picker-control ${invalid() ? "is-invalid" : ""}`,
                    "focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,_var(--accent)_18%,_transparent)] motion-reduce:transition-none bg-surface rounded-[7px] border border-line-strong grid grid-cols-[minmax(0,_1fr)_36px] h-[36px] min-w-0 overflow-hidden transition-colors",
                )}
            >
                <input
                    ref={(element) => (input = element)}
                    id={props.id}
                    type="text"
                    inputMode="numeric"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    placeholder="YYYY-MM-DD"
                    maxLength={10}
                    value={draft()}
                    disabled={props.disabled}
                    aria-label={props["aria-label"]}
                    aria-invalid={invalid()}
                    aria-describedby={invalid() ? `${props.id}-error` : undefined}
                    onInput={(event) => {
                        const value = event.currentTarget.value;
                        setDraft(value);
                        if (!value || parseDate(value)) {
                            setInvalid(false);
                            props.onChange(value);
                        }
                    }}
                    onBlur={() => setInvalid(Boolean(draft() && !parseDate(draft())))}
                    class="focus-visible:outline-offset-1 placeholder:text-faint placeholder:opacity-100 focus-visible:outline-none bg-transparent border-0 text-ink tabular-nums h-full tracking-[0.02em] min-w-0 outline-none py-0 px-2.5 w-full"
                />
                <button
                    class={cn(
                        "date-picker-trigger",
                        "hover:bg-accent-soft hover:text-accent aria-expanded:bg-accent-soft aria-expanded:text-accent motion-reduce:transition-none bg-transparent border-l border-l-line-soft border-0 cursor-pointer grid p-0 place-items-center transition-colors focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                    )}
                    type="button"
                    disabled={props.disabled}
                    aria-label={open() ? "Close calendar" : "Choose date"}
                    aria-expanded={open()}
                    aria-controls={`${props.id}-calendar`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                        if (!open()) {
                            const current = parseDate(draft()) ?? todayDate();
                            setMonth(monthStart(current));
                            setFocusedDate(formatDate(current));
                        }
                        setOpen((value) => !value);
                    }}
                >
                    <Icon name="calendar" />
                </button>
            </div>
            <Show when={invalid()}>
                <span
                    class={cn(
                        "date-picker-error",
                        "text-danger block text-[11px] leading-[1.35] mt-1",
                    )}
                    id={`${props.id}-error`}
                    role="alert"
                >
                    Enter a real date as YYYY-MM-DD.
                </span>
            </Show>
            <Show when={open()}>
                <section
                    class={cn(
                        "date-picker-popover",
                        "bg-surface rounded-[10px] border border-line-strong shadow-[0_14px_35px_color-mix(in_srgb,_var(--ink)_14%,_transparent)] p-3 absolute left-0 right-auto sm:left-auto sm:right-0 w-[min(286px,_calc(100vw_-_32px))] z-[20]",
                    )}
                    id={`${props.id}-calendar`}
                    role="dialog"
                    aria-label="Choose date"
                >
                    <header
                        class={cn(
                            "date-picker-calendar-heading",
                            "items-center grid gap-1 grid-cols-[32px_1fr_32px] mb-[9px] text-center",
                        )}
                    >
                        <button
                            type="button"
                            class={cn(
                                "date-picker-month-button",
                                "bg-transparent rounded-md border-0 cursor-pointer grid min-h-[30px] min-w-[30px] p-0 place-items-center hover:bg-accent-soft hover:text-[var(--accent-deep)] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                            )}
                            aria-label="Previous month"
                            onClick={() => moveMonth(-1)}
                        >
                            <Icon name="chevron" />
                        </button>
                        <strong class="text-ink text-[13px] font-semibold">
                            {monthLabel(month())}
                        </strong>
                        <button
                            type="button"
                            class={cn(
                                "date-picker-month-button is-next",
                                "bg-transparent rounded-md border-0 cursor-pointer grid min-h-[30px] min-w-[30px] p-0 place-items-center hover:bg-accent-soft hover:text-[var(--accent-deep)] focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] text-inherit disabled:cursor-not-allowed! disabled:opacity-56",
                            )}
                            aria-label="Next month"
                            onClick={() => moveMonth(1)}
                        >
                            <Icon name="chevron" />
                        </button>
                    </header>
                    <div
                        class={cn(
                            "date-picker-weekdays",
                            "text-faint grid text-[10px] font-semibold gap-0.5 grid-cols-[repeat(7,_minmax(0,_1fr))] mb-[3px] text-center",
                        )}
                        aria-hidden="true"
                    >
                        <For each={["M", "T", "W", "T", "F", "S", "S"]}>
                            {(day) => <span class="grid min-h-6 place-items-center">{day}</span>}
                        </For>
                    </div>
                    <div
                        class={cn(
                            "date-picker-days",
                            "grid gap-0.5 grid-cols-[repeat(7,_minmax(0,_1fr))] text-center",
                        )}
                        role="grid"
                        aria-label={monthLabel(month())}
                    >
                        <For each={days()}>
                            {(day) => {
                                const isSelected = () =>
                                    selected() !== null &&
                                    formatDate(selected()!) === formatDate(day.date);
                                const dateValue = formatDate(day.date);
                                return (
                                    <button
                                        ref={(element) => {
                                            dayButtons.set(dateValue, element);
                                        }}
                                        type="button"
                                        role="gridcell"
                                        tabIndex={focusedDate() === dateValue ? 0 : -1}
                                        class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] hover:bg-accent-soft hover:text-[var(--accent-deep)] bg-transparent rounded-md border-0 cursor-pointer grid text-xs tabular-nums min-h-[31px] min-w-[30px] p-0 place-items-center w-full text-inherit disabled:cursor-not-allowed! disabled:opacity-56 [.date-picker-days_button&:where(.is-outside)]:text-faint [.date-picker-days_button&:where(.is-selected)]:bg-accent [.date-picker-days_button&:where(.is-selected)]:text-surface [.date-picker-days_button&:where(.is-selected)]:font-semibold [.date-picker-days_button&:where(.is-today):not(.is-selected)]:outline-offset-[-2px] [.date-picker-days_button&:where(.is-today):not(.is-selected)]:outline-1 [.date-picker-days_button&:where(.is-today):not(.is-selected)]:outline-line-strong"
                                        classList={{
                                            "is-outside": !day.inMonth,
                                            "is-selected": isSelected(),
                                            "is-today":
                                                formatDate(day.date) === formatDate(todayDate()),
                                        }}
                                        aria-label={accessibleDateLabel(day.date)}
                                        aria-selected={isSelected()}
                                        onClick={() => chooseDate(day.date)}
                                        onKeyDown={(event) => handleDayKeys(event, day.date)}
                                    >
                                        {day.date.getUTCDate()}
                                    </button>
                                );
                            }}
                        </For>
                    </div>
                    <footer
                        class={cn(
                            "date-picker-calendar-footer",
                            "border-t border-t-line-soft flex justify-between mt-2 pt-[7px]",
                        )}
                    >
                        <button
                            type="button"
                            onClick={() => chooseDate(todayDate())}
                            class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] hover:bg-accent-soft hover:text-[var(--accent-deep)] bg-transparent rounded-md border-0 cursor-pointer grid text-[11px] font-semibold min-h-[30px] min-w-[30px] py-0 px-2 place-items-center text-inherit disabled:cursor-not-allowed! disabled:opacity-56"
                        >
                            Today
                        </button>
                        <button
                            type="button"
                            onClick={() => {
                                setDraft("");
                                setInvalid(false);
                                props.onChange("");
                                setOpen(false);
                                input?.focus();
                            }}
                            class="focus-visible:outline-offset-1 focus-visible:outline-3 focus-visible:outline-[color-mix(in_srgb,_var(--accent)_42%,_transparent)] hover:bg-accent-soft hover:text-[var(--accent-deep)] bg-transparent rounded-md border-0 cursor-pointer grid text-[11px] font-semibold min-h-[30px] min-w-[30px] py-0 px-2 place-items-center text-inherit disabled:cursor-not-allowed! disabled:opacity-56"
                        >
                            Clear
                        </button>
                    </footer>
                </section>
            </Show>
        </div>
    );
}

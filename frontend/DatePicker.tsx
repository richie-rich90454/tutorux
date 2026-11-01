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
import "./date-picker.css";

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
    return new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
    }).format(date);
}

function accessibleDateLabel(date: Date): string {
    return new Intl.DateTimeFormat(undefined, {
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
        <div class="date-picker" ref={(element) => (root = element)} onKeyDown={handleKeys}>
            <div class={`date-picker-control ${invalid() ? "is-invalid" : ""}`}>
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
                />
                <button
                    class="date-picker-trigger"
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
                <span class="date-picker-error" id={`${props.id}-error`} role="alert">
                    Enter a real date as YYYY-MM-DD.
                </span>
            </Show>
            <Show when={open()}>
                <section
                    class="date-picker-popover"
                    id={`${props.id}-calendar`}
                    role="dialog"
                    aria-label="Choose date"
                >
                    <header class="date-picker-calendar-heading">
                        <button
                            type="button"
                            class="date-picker-month-button"
                            aria-label="Previous month"
                            onClick={() => moveMonth(-1)}
                        >
                            <Icon name="chevron" />
                        </button>
                        <strong>{monthLabel(month())}</strong>
                        <button
                            type="button"
                            class="date-picker-month-button is-next"
                            aria-label="Next month"
                            onClick={() => moveMonth(1)}
                        >
                            <Icon name="chevron" />
                        </button>
                    </header>
                    <div class="date-picker-weekdays" aria-hidden="true">
                        <For each={["M", "T", "W", "T", "F", "S", "S"]}>
                            {(day) => <span>{day}</span>}
                        </For>
                    </div>
                    <div class="date-picker-days" role="grid" aria-label={monthLabel(month())}>
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
                    <footer class="date-picker-calendar-footer">
                        <button type="button" onClick={() => chooseDate(todayDate())}>
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
                        >
                            Clear
                        </button>
                    </footer>
                </section>
            </Show>
        </div>
    );
}

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { render } from "solid-js/web";
import { EmptyState, Icon } from "../../../frontend/shared-ui";

const disposers: Array<() => void> = [];

afterEach(() => {
    for (const dispose of disposers.splice(0)) dispose();
});

function mount(node: () => ReturnType<typeof EmptyState>): HTMLDivElement {
    const container = document.createElement("div");
    document.body.append(container);
    disposers.push(render(node, container));
    return container;
}

describe("shared UI", () => {
    it("renders the empty-state copy and action", () => {
        let action = 0;
        const container = mount(() => (
            <EmptyState
                icon="journal"
                title="Your first note can be small"
                text="Capture one thing you noticed."
                action="Write a journal entry"
                onAction={() => {
                    action += 1;
                }}
                disabled={false}
            />
        ));

        expect(container.textContent).toContain("Your first note can be small");
        expect(container.textContent).toContain("Capture one thing you noticed.");
        const button = container.querySelector("button");
        expect(button?.textContent).toContain("Write a journal entry");
        button?.click();
        expect(action).toBe(1);
    });

    it("hides the action when the empty state is disabled", () => {
        const container = mount(() => (
            <EmptyState
                icon="sessions"
                title="No archived sessions"
                text="Archived sessions stay available here."
                action=""
                onAction={() => undefined}
                disabled
            />
        ));
        expect(container.querySelector("button")).toBeNull();
    });

    it("renders icons as decorative SVGs", () => {
        const container = mount(() => <Icon name="search" />);
        const svg = container.querySelector("svg");
        expect(svg?.getAttribute("aria-hidden")).toBe("true");
        expect(svg?.querySelector("circle")).not.toBeNull();
    });
});

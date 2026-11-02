import type { Page } from "@playwright/test";

export interface ActionInventory {
    buttons: string[];
    links: string[];
    inputs: string[];
    all: string[];
}

/**
 * Collect the accessible names of enabled, visible controls in the active workspace.
 * Only the main workspace body is inspected so sidebar chrome does not leak into results.
 */
export async function collectActionInventory(page: Page): Promise<ActionInventory> {
    const inventory = await page.locator("#main-content").evaluate((root) => {
        const nameOf = (element: Element): string => {
            const ariaLabel = element.getAttribute("aria-label")?.trim();
            if (ariaLabel) return ariaLabel;

            const labelledBy = element.getAttribute("aria-labelledby");
            if (labelledBy) {
                const labelledText = labelledBy
                    .split(/\s+/u)
                    .map((id) => document.getElementById(id)?.textContent ?? "")
                    .join(" ")
                    .replace(/\s+/gu, " ")
                    .trim();
                if (labelledText) return labelledText;
            }

            if (
                element instanceof HTMLInputElement ||
                element instanceof HTMLSelectElement ||
                element instanceof HTMLTextAreaElement
            ) {
                const labelText = element.labels
                    ? [...element.labels]
                          .map((label) => label.textContent ?? "")
                          .join(" ")
                          .replace(/\s+/gu, " ")
                          .trim()
                    : "";
                if (labelText) return labelText;
                const placeholder = element.getAttribute("placeholder")?.trim();
                if (placeholder) return placeholder;
                if (
                    element instanceof HTMLInputElement &&
                    (element.type === "submit" || element.type === "button")
                ) {
                    return element.value.trim();
                }
            }

            const content = (element.textContent ?? "").replace(/\s+/gu, " ").trim();
            return content || (element.getAttribute("title")?.trim() ?? "");
        };

        const isEnabled = (element: Element): boolean => {
            if (element.getAttribute("aria-disabled") === "true") return false;
            if ("disabled" in element && (element as { disabled: boolean }).disabled) return false;
            return element.getClientRects().length > 0;
        };

        const collect = (selector: string): string[] =>
            [...root.querySelectorAll(selector)]
                .filter(isEnabled)
                .map(nameOf)
                .filter((name) => name.length > 0);

        return {
            buttons: collect("button"),
            links: collect("a[href]"),
            inputs: collect("input, select, textarea"),
        };
    });

    return {
        ...inventory,
        all: [...new Set([...inventory.buttons, ...inventory.links, ...inventory.inputs])],
    };
}

// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("solid-js")>();
    return {
        ...actual,
        lazy: (loader: () => Promise<{ default: unknown }>) => {
            const component = (() => undefined) as (() => undefined) & {
                load: () => Promise<{ default: unknown }>;
            };
            component.load = loader;
            return component;
        },
    };
});

import * as components from "../../frontend/lazy-components";

type LazyModule = (() => undefined) & { load: () => Promise<{ default: unknown }> };

function asLazyModule(value: unknown): LazyModule {
    return value as LazyModule;
}

describe("lazy component loaders", () => {
    it.each(Object.entries(components))("%s resolves to its named export", async (_name, value) => {
        const loaded = await asLazyModule(value).load();
        expect(typeof loaded.default).toBe("function");
        expect(Object.keys(loaded)).toEqual(["default"]);
    });
});

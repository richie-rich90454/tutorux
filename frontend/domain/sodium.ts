import type sodiumModule from "libsodium-wrappers-sumo";

type Sodium = typeof sodiumModule;

let sodiumPromise: Promise<Sodium> | undefined;

/** Load the sizeable hashing implementation only when material hashing is needed. */
export function loadSodium(): Promise<Sodium> {
    sodiumPromise ??= import("libsodium-wrappers-sumo").then(async ({ default: sodium }) => {
        await sodium.ready;
        return sodium;
    });
    return sodiumPromise;
}

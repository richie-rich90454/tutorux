import { ErrorBoundary, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { App } from "./App";
import { WorkspaceProvider } from "./workspace";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The application root is missing.");

function Crash(props: { error: unknown; reset: () => void }): JSX.Element {
    return (
        <div class="grid min-h-dvh place-items-center bg-canvas px-6">
            <div class="w-full max-w-[520px] rounded-[8px] border border-line bg-surface p-5">
                <h1 class="text-lg font-semibold text-ink">Tutorux hit an unexpected error</h1>
                <p class="mt-1 text-xs leading-relaxed text-muted">
                    Your workspace is autosaved. Try the page again, or reopen Tutorux if the
                    problem continues.
                </p>
                <pre class="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-[4px] bg-surface-inset p-2 text-[11px] text-ink-soft">
                    {String(props.error)}
                </pre>
                <button
                    type="button"
                    class="mt-3 inline-flex min-h-9 items-center rounded-[5px] border border-accent-solid bg-accent-solid px-3 text-[13px] font-medium text-white"
                    onClick={() => props.reset()}
                >
                    Try again
                </button>
            </div>
        </div>
    );
}

render(
    () => (
        <ErrorBoundary fallback={(error, reset) => <Crash error={error} reset={reset} />}>
            <WorkspaceProvider>
                <App />
            </WorkspaceProvider>
        </ErrorBoundary>
    ),
    root,
);

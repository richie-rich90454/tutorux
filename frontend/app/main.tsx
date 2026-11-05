import { render } from "solid-js/web";
import { App } from "./App";
import { WorkspaceProvider } from "./workspace";
import "../styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("The application root is missing.");

render(
    () => (
        <WorkspaceProvider>
            <App />
        </WorkspaceProvider>
    ),
    root,
);

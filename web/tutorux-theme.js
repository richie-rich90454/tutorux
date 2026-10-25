(() => {
    "use strict";

    const root = document.documentElement;
    const button = document.getElementById("toggle-theme");
    const themeColor = document.querySelector('meta[name="theme-color"]');
    const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
    let themeSource = "system";

    function applyTheme(theme) {
        const dark = theme === "dark";
        root.dataset.theme = dark ? "dark" : "light";
        if (themeColor) themeColor.content = dark ? "#101713" : "#ffffff";
        if (button) {
            const nextTheme = dark ? "light" : "dark";
            button.setAttribute("aria-label", `Switch to ${nextTheme} theme`);
            button.setAttribute("aria-pressed", String(dark));
            button.title = `Switch to ${nextTheme} theme`;
        }
    }

    function applySystemTheme() {
        applyTheme(systemTheme.matches ? "dark" : "light");
    }

    async function loadArchiveTheme() {
        const bridge = window.tutoruxJournalBridge;
        if (!bridge?.archiveOpen()) {
            themeSource = "system";
            applySystemTheme();
            return;
        }

        themeSource = "system";
        applySystemTheme();
        try {
            const response = await bridge.read(["settings", "get", "ui.theme"]);
            const setting = JSON.parse(String(response?.output || "{}"));
            const value = String(setting?.value || "").toLowerCase();
            if (value === "light" || value === "dark") {
                themeSource = "archive";
                applyTheme(value);
            }
        } catch {
            // An archive without a saved theme follows the operating-system preference.
        }
    }

    button?.addEventListener("click", async () => {
        const nextTheme = root.dataset.theme === "dark" ? "light" : "dark";
        const bridge = window.tutoruxJournalBridge;
        if (bridge?.archiveOpen()) {
            button.disabled = true;
            try {
                await bridge.write([
                    "settings",
                    "set",
                    "--key",
                    "ui.theme",
                    "--value",
                    nextTheme,
                ]);
                themeSource = "archive";
                applyTheme(nextTheme);
            } catch (error) {
                bridge.notice?.(`Theme preference could not be saved: ${error.message}`, true);
            } finally {
                button.disabled = false;
            }
            return;
        }

        themeSource = "session";
        applyTheme(nextTheme);
    });

    systemTheme.addEventListener("change", () => {
        if (themeSource === "system") applySystemTheme();
    });
    window.addEventListener("tutorux:archive-open", () => void loadArchiveTheme());
    void loadArchiveTheme();
})();

# Desktop release builds

`pnpm desktop:build` runs `tauri build`, including the configured desktop typecheck and Vite build, then runs `scripts/collect-release.mjs` to copy the host's bundle artifacts into `release/`.

## Windows outputs

The Windows release directory contains three distributable files:

- `Tutorux_<version>_x64_en-US.msi` installs the desktop application with Windows Installer.
- `Tutorux_<version>_x64-setup.exe` installs the desktop application with NSIS.
- `Tutorux_<version>_x64_portable.exe` is the Tauri desktop executable copied from `src-tauri/target/release/tutorux-desktop.exe`.

The portable executable embeds the Vite frontend, native host, and multilingual Whisper Base Q5_1 model in one application file. The model is compiled into the executable and loaded directly from memory, so full-track and live transcription work offline without an external Whisper executable/model and without model extraction. The MSI and NSIS installers package the same model-enabled desktop executable. Windows still needs the system WebView2 runtime. GGUF models and FFmpeg remain optional user-supplied tools or data; they are not bundled into this executable.

The portable application may create per-user state under `%LOCALAPPDATA%` for archive locks and detached recording controls. Compressed-audio import uses uniquely named temporary files directly under the OS temp location and removes them. Whisper transcription uses the embedded model and in-memory audio; neither workflow creates a temporary workspace directory. The system credential service and WebView2 application data are used when the corresponding credential or preference features are selected. The Windows WebView disables general address and contact autofill suggestions so saved browser form data does not appear over Tutorux inputs.

## Other operating systems

Tauri packages for the host operating system's configured targets. Build release artifacts on Windows, macOS, and Linux runners with their native toolchains and bundle prerequisites; one host does not cross-package all targets. The Windows portable `_x64_portable.exe` name is only emitted by the release collector on Windows.

## Standalone CLI

The Node.js CLI is a separate developer tool, launched with `pnpm run cli`. It is not embedded in or required by the portable desktop executable. It has its own Node runtime and may use temporary directories for particular workflows; see the [CLI live recording guide](../audio/CLI-LIVE-RECORDING.md).

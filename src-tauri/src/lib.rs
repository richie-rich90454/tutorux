// MSVC emits linker status lines for unit-test executables; keep this off normal library builds.
#![cfg_attr(all(windows, test), allow(linker_messages))]

pub mod ai_transport;
pub mod credentials;
pub mod desktop;
pub mod diagnostics;
pub mod embedded_ai;
pub mod host;
pub mod live_transcription;
pub mod platform;
pub mod store;
pub mod transcription;

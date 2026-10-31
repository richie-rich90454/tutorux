//! Headless native audio helpers shared by the CLI adapter.
//!
//! These functions reuse the same cpal, flexaudio, and ScreenCaptureKit paths as the Tauri
//! commands, but they never require a webview window or emit Tauri events.

mod capture;
mod device;
mod probe;

pub use capture::{
    begin_capture, HeadlessCapture, HeadlessCaptureStarted, HeadlessChunk, HeadlessFinished,
    HeadlessTrackSummary,
};
pub use device::{enumerate_devices, HeadlessDevice, HeadlessDevices};
pub use probe::{probe_application, probe_input, HeadlessProbe};

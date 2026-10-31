
pub(super) fn microphone_limitation() -> &'static str {
    "No microphone endpoint was available from the native audio backend. Check device support and operating-system microphone permissions."
}

pub(super) fn system_limitation() -> &'static str {
    #[cfg(target_os = "windows")]
    {
        "No native WASAPI output loopback was available."
    }
    #[cfg(target_os = "macos")]
    {
        "No CoreAudio output-loopback device was available."
    }
    #[cfg(target_os = "linux")]
    {
        "No PipeWire monitor/loopback input was available."
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Native system-audio capture is not supported on this operating system."
    }
}

pub(super) fn application_limitation() -> String {
    #[cfg(target_os = "windows")]
    {
        "No active WASAPI application-audio sessions were found. Start playback in the target application and retry."
            .to_owned()
    }
    #[cfg(target_os = "macos")]
    {
        "No shareable applications were found. Check Screen & System Audio Recording permission and retry."
            .to_owned()
    }
    #[cfg(target_os = "linux")]
    {
        "No active PipeWire application-audio streams were found. ALSA cannot identify per-application audio."
            .to_owned()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        "Per-application audio capture is not supported on this operating system.".to_owned()
    }
}


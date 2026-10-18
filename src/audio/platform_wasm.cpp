#include "tutorux/audio/capture.hpp"
#include "tutorux/audio/recording_control.hpp"

namespace tutorux::audio {
namespace {

    core::Error browserCaptureError() {
        return core::error(
            "audio_capture_browser_only",
            "The browser edition captures microphone audio through its explicit browser "
            "permission workflow. Native device capture and detached recording are unavailable "
            "in WebAssembly.");
    }

} // namespace

core::Result<std::vector<DeviceInfo>> enumerateDevices() {
    return std::unexpected(browserCaptureError());
}

core::Result<CaptureDeviceProbe> probeCaptureDevice(DeviceKind source, std::string deviceId) {
    static_cast<void>(source);
    static_cast<void>(deviceId);
    return std::unexpected(browserCaptureError());
}

core::Result<CaptureSummary>
captureNative(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
    static_cast<void>(archive);
    static_cast<void>(sessionId);
    static_cast<void>(options);
    return std::unexpected(browserCaptureError());
}

core::Result<MultiTrackCaptureSummary> captureNativeTracks(archive::Archive& archive,
                                                           const archive::Uuid& sessionId,
                                                           CaptureOptions microphone,
                                                           CaptureOptions systemAudio) {
    static_cast<void>(archive);
    static_cast<void>(sessionId);
    static_cast<void>(microphone);
    static_cast<void>(systemAudio);
    return std::unexpected(browserCaptureError());
}

core::Result<CaptureSummary> recoverNativeCapture(archive::Archive& archive,
                                                  const archive::Uuid& sessionId,
                                                  std::optional<archive::Uuid> trackId) {
    static_cast<void>(archive);
    static_cast<void>(sessionId);
    static_cast<void>(trackId);
    return std::unexpected(core::error(
        "audio_recovery_browser_only",
        "Browser recordings are recovered as archive-linked media assets rather than native "
        "audio tracks."));
}

core::Result<MultiTrackCaptureSummary> recoverNativeCaptureTracks(archive::Archive& archive,
                                                                  const archive::Uuid& sessionId) {
    static_cast<void>(archive);
    static_cast<void>(sessionId);
    return std::unexpected(core::error(
        "audio_recovery_browser_only",
        "Browser recordings are recovered as archive-linked media assets rather than native "
        "audio tracks."));
}

core::Result<std::string> recordingControlEndpoint(const std::filesystem::path& archivePath,
                                                   std::string_view sessionId) {
    static_cast<void>(archivePath);
    static_cast<void>(sessionId);
    return std::unexpected(browserCaptureError());
}

core::Result<RecordingControlResponse> sendRecordingControl(std::string_view endpoint,
                                                            std::string_view command) {
    static_cast<void>(endpoint);
    static_cast<void>(command);
    return std::unexpected(browserCaptureError());
}

core::Status launchRecordingWorker(std::string_view endpoint,
                                   const std::vector<std::string>& arguments) {
    static_cast<void>(endpoint);
    static_cast<void>(arguments);
    return std::unexpected(browserCaptureError());
}

int runRecordingWorker(std::string endpoint, RecordingWorker worker) {
    static_cast<void>(endpoint);
    static_cast<void>(worker);
    return 2;
}

} // namespace tutorux::audio

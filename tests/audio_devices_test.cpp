// Audio device enumeration, validation, and failure-path coverage.
#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/capture.hpp"
#include "tutorux/audio/devices.hpp"
#include "tutorux/audio/playback.hpp"
#include "tutorux/audio/wav_import.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <system_error>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "audio devices: " << label << '\n';
    return false;
}

template <typename T>
bool expectError(const tutorux::core::Result<T>& result, std::string_view label) {
    if (result)
        return expect(false, label);
    return true;
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    auto devices = audio::enumerateDevices();
    okay &= expect(devices.has_value(), "device enumeration failed");
    if (devices) {
        for (const auto& device : *devices) {
            okay &= expect(!device.id.empty() && !device.name.empty(),
                           "enumerated device has an empty identity");
        }
    }

    for (const audio::DeviceKind kind :
         {audio::DeviceKind::microphone, audio::DeviceKind::playback,
          audio::DeviceKind::application}) {
        auto invalid = audio::probeCaptureDevice(kind, "definitely-not-a-device");
        okay &= expect(!invalid, "invalid capture device was accepted");
    }

    audio::CapturePreflightOptions shortPreflight;
    shortPreflight.deviceId = "definitely-not-a-device";
    shortPreflight.duration = std::chrono::milliseconds(10);
    auto shortResult = audio::preflightCaptureInput(shortPreflight);
    okay &= expect(!shortResult, "short preflight duration was accepted");

    audio::CapturePreflightOptions badInterval;
    badInterval.deviceId = "definitely-not-a-device";
    badInterval.levelInterval = std::chrono::milliseconds(0);
    auto intervalResult = audio::preflightCaptureInput(badInterval);
    okay &= expect(!intervalResult, "zero preflight interval was accepted");

    const auto directory =
        std::filesystem::temp_directory_path() /
        ("tutorux-audio-devices-" +
         std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    const auto path = directory / "audio.tux";
    if (errorCode) {
        std::cerr << "audio devices: temporary directory failed\n";
        return 1;
    }
    auto created = archive::Archive::create(path, "Audio devices");
    if (!created) {
        std::cerr << "audio devices: archive creation failed\n";
        return 1;
    }
    domain::Session session;
    session.id = archive::randomUuid();
    session.studentId = "anonymous";
    session.title = "Audio failure path";
    static_cast<void>(created->put(domain::toRecord(session)));

    audio::CaptureOptions captureOptions;
    captureOptions.deviceId = "definitely-not-a-device";
    captureOptions.maximumDuration = std::chrono::milliseconds(100);
    auto capture = audio::captureNative(*created, session.id, captureOptions);
    okay &= expect(!capture, "invalid capture device started a recording");

    auto recovery = audio::recoverNativeCapture(*created, session.id);
    okay &= expect(!recovery, "native recovery accepted a session without tracks");
    auto trackRecovery = audio::recoverNativeCaptureTracks(*created, session.id);
    okay &= expect(!trackRecovery, "track recovery accepted a session without tracks");
    auto waveRecovery = audio::recoverWaveImport(*created, session.id);
    okay &= expect(!waveRecovery, "WAV recovery accepted a session without import metadata");

    audio::PlaybackOptions playbackOptions;
    playbackOptions.stopRequested = [] { return true; };
    auto playback = audio::playArchiveTrack(*created, session.id, playbackOptions);
    okay &= expect(!playback, "playback accepted a session without audio");

    std::filesystem::remove_all(directory, errorCode);
    return okay ? 0 : 1;
}

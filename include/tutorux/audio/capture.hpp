#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/devices.hpp"

#include <chrono>
#include <functional>
#include <optional>
#include <string>

namespace tutorux::audio {

    struct CaptureSummary;

    enum class DurabilityPolicy {
        defaultPolicy,
        maximum,
        reducedWrite
    };

    struct CaptureDeviceProbe final {
        std::string deviceId;
        std::string sampleFormat;
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
    };

    struct CaptureOptions final {
        DeviceKind source{DeviceKind::microphone};
        DurabilityPolicy durability{DurabilityPolicy::defaultPolicy};
        std::string deviceId;
        std::string consentConfirmedBy{"not-specified"};
        std::optional<std::chrono::milliseconds> maximumDuration;
        std::function<bool()> stopRequested;
        std::function<bool()> pauseRequested;
        std::function<void(std::string state, std::string message)> stateChanged;
        std::function<void(const CaptureSummary&)> progress;
    };

    struct CaptureSummary final {
        archive::Uuid trackId{};
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
        std::uint64_t sampleCount{};
        std::uint64_t timelineSampleCount{};
        std::uint64_t chunkCount{};
        std::uint64_t durationUs{};
        std::uint64_t byteCount{};
        bool completed{};
        std::string state;
    };

    core::Result<CaptureSummary> captureNative(archive::Archive& archive,
                                               const archive::Uuid& sessionId,
                                               CaptureOptions options);
    core::Result<CaptureDeviceProbe> probeCaptureDevice(DeviceKind source, std::string deviceId);
    core::Result<CaptureSummary> recoverNativeCapture(archive::Archive& archive,
                                                      const archive::Uuid& sessionId);

} // namespace tutorux::audio

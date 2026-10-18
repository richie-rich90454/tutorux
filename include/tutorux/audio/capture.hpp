#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/devices.hpp"

#include <chrono>
#include <cstddef>
#include <functional>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace tutorux::audio {

struct CaptureSummary;

// Captured chunks are limited to 1 MiB. The sample view is valid only for the duration of the
// callback; consumers that need to retain it must copy or enqueue it to their own worker.
struct PcmCaptureChunk final {
    archive::Uuid trackId{};
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint64_t startTimestampUnixMicroseconds{};
    std::uint64_t firstSampleIndex{};
    std::uint64_t frameCount{};
    std::string_view sampleFormat;
    std::span<const std::byte> samples;
};

using PcmChunkCallback = std::function<void(const PcmCaptureChunk&)>;

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

struct CaptureInputLevel final {
    // Peak and RMS levels describe the most recent interval, normalized to [0, 1].
    std::chrono::milliseconds elapsed{};
    std::uint64_t framesInInterval{};
    // Cumulative frame count since the preflight stream started.
    std::uint64_t framesMeasured{};
    double peakLevel{};
    double rmsLevel{};
    double peakDbfs{-120.0};
    double rmsDbfs{-120.0};
};

struct CapturePreflightOptions final {
    // An empty ID selects the platform default microphone. Duration must be 200ms–10s and
    // levelInterval must be 20ms–1s. The callback runs synchronously on the preflight caller's
    // thread and receives interval levels; it must not retain the reference.
    std::string deviceId;
    std::chrono::milliseconds duration{1'800};
    std::chrono::milliseconds levelInterval{100};
    std::function<void(const CaptureInputLevel&)> levelChanged;
};

struct CapturePreflightSummary final {
    CaptureDeviceProbe device;
    std::chrono::milliseconds measuredDuration{};
    std::uint64_t framesMeasured{};
    double peakLevel{};
    double rmsLevel{};
    double peakDbfs{-120.0};
    double rmsDbfs{-120.0};
    bool signalDetected{};
};

struct CaptureOptions final {
    DeviceKind source{DeviceKind::microphone};
    DurabilityPolicy durability{DurabilityPolicy::defaultPolicy};
    std::string deviceId;
    std::string consentConfirmedBy{"not-specified"};
    std::optional<std::chrono::milliseconds> maximumDuration;
    std::optional<archive::Uuid> trackId;
    std::function<bool()> waitForSynchronizedStart;
    std::function<bool()> stopRequested;
    std::function<bool()> pauseRequested;
    std::function<void(std::string state, std::string message)> stateChanged;
    std::function<void(const CaptureSummary&)> progress;
    // Called synchronously on the capture worker after each bounded chunk is committed. Keep this
    // callback short and enqueue work elsewhere; device I/O callbacks never run this callback.
    PcmChunkCallback pcmChunk;
};

struct CaptureSummary final {
    archive::Uuid trackId{};
    std::string deviceId;
    std::string sampleFormat;
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint32_t channelMask{};
    std::uint64_t sampleCount{};
    std::uint64_t timelineSampleCount{};
    std::uint64_t chunkCount{};
    std::uint64_t durationUs{};
    std::uint64_t byteCount{};
    bool completed{};
    std::string state;
    // Set when the optional live PCM consumer throws or cannot accept a bounded chunk. Recording
    // continues and remains durable.
    std::optional<core::Error> pcmObserverFailure;
};

struct CaptureTrackOutcome final {
    DeviceKind source{DeviceKind::microphone};
    std::optional<CaptureSummary> summary;
    std::optional<core::Error> failure;
};

struct MultiTrackCaptureSummary final {
    std::vector<CaptureTrackOutcome> tracks;
    bool completed{};
    std::uint64_t durationUs{};
    std::uint64_t chunkCount{};
    std::uint64_t sampleCount{};
    std::uint64_t byteCount{};
};

core::Result<CaptureSummary> captureNative(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options);
core::Result<MultiTrackCaptureSummary> captureNativeTracks(archive::Archive& archive, const archive::Uuid& sessionId,
                                                           CaptureOptions microphone, CaptureOptions systemAudio);
core::Result<CaptureDeviceProbe> probeCaptureDevice(DeviceKind source, std::string deviceId);
// Opens and briefly reads the selected microphone to verify access and report levels. The
// function is blocking and should run on a worker thread. It holds input only long enough to
// calculate levels; it creates no session, archive, recording track, or audio asset, and does
// not count as consent to begin a recording. The callback reports interval levels on the caller
// thread. Digital silence is -120 dBFS; signalDetected uses an aggregate RMS threshold of -60 dBFS.
core::Result<CapturePreflightSummary> preflightCaptureInput(CapturePreflightOptions options = {});
core::Result<CaptureSummary> recoverNativeCapture(archive::Archive& archive, const archive::Uuid& sessionId,
                                                  std::optional<archive::Uuid> trackId = {});
core::Result<MultiTrackCaptureSummary> recoverNativeCaptureTracks(archive::Archive& archive, const archive::Uuid& sessionId);

} // namespace tutorux::audio

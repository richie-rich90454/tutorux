#pragma once

#include "tutorux/audio/capture.hpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <exception>
#include <utility>

namespace tutorux::audio::detail {

struct LevelMeasurement final {
    std::uint64_t sampleValueCount{};
    double peak{};
    double rms{};
};

class LevelAccumulator final {
  public:
    void add(double sample) noexcept {
        if (!std::isfinite(sample))
            sample = 0.0;
        sample = std::clamp(sample, -1.0, 1.0);
        const double magnitude = std::abs(sample);
        windowPeak_ = std::max(windowPeak_, magnitude);
        totalPeak_ = std::max(totalPeak_, magnitude);
        windowSquares_ += sample * sample;
        totalSquares_ += sample * sample;
        ++windowSampleValueCount_;
        ++totalSampleValueCount_;
    }

    LevelMeasurement takeWindow() noexcept {
        const LevelMeasurement result =
            measure(windowSampleValueCount_, windowPeak_, windowSquares_);
        windowSampleValueCount_ = 0;
        windowPeak_ = 0.0;
        windowSquares_ = 0.0;
        return result;
    }

    LevelMeasurement total() const noexcept {
        return measure(totalSampleValueCount_, totalPeak_, totalSquares_);
    }

  private:
    static LevelMeasurement measure(std::uint64_t sampleValueCount, double peak,
                                    double squares) noexcept {
        const double rms = sampleValueCount == 0
                               ? 0.0
                               : std::sqrt(squares / static_cast<double>(sampleValueCount));
        return {sampleValueCount, peak, rms};
    }

    std::uint64_t windowSampleValueCount_{};
    std::uint64_t totalSampleValueCount_{};
    double windowPeak_{};
    double totalPeak_{};
    double windowSquares_{};
    double totalSquares_{};
};

inline double levelToDbfs(double level) noexcept {
    return level > 0.0 ? 20.0 * std::log10(level) : -120.0;
}

inline CaptureInputLevel makeCaptureInputLevel(const LevelMeasurement& measurement,
                                               std::uint16_t channelCount,
                                               std::chrono::milliseconds elapsed) noexcept {
    const std::uint64_t channels = std::max<std::uint64_t>(channelCount, 1);
    CaptureInputLevel result;
    result.elapsed = elapsed;
    result.framesInInterval = measurement.sampleValueCount / channels;
    result.peakLevel = measurement.peak;
    result.rmsLevel = measurement.rms;
    result.peakDbfs = levelToDbfs(result.peakLevel);
    result.rmsDbfs = levelToDbfs(result.rmsLevel);
    return result;
}

inline CapturePreflightSummary
makeCapturePreflightSummary(CaptureDeviceProbe device, const LevelMeasurement& measurement,
                            std::chrono::milliseconds measuredDuration) {
    CapturePreflightSummary result;
    const std::uint16_t channels = std::max<std::uint16_t>(device.channelCount, 1);
    result.device = std::move(device);
    result.measuredDuration = measuredDuration;
    result.framesMeasured = measurement.sampleValueCount / channels;
    result.peakLevel = measurement.peak;
    result.rmsLevel = measurement.rms;
    result.peakDbfs = levelToDbfs(result.peakLevel);
    result.rmsDbfs = levelToDbfs(result.rmsLevel);
    result.signalDetected = result.rmsLevel >= 0.001;
    return result;
}

inline core::Status validatePreflightOptions(const CapturePreflightOptions& options) {
    if (options.duration < std::chrono::milliseconds(200) ||
        options.duration > std::chrono::seconds(10)) {
        return std::unexpected(core::error(
            "audio_preflight_duration_invalid",
            "Microphone check duration must be between 200 milliseconds and 10 seconds."));
    }
    if (options.levelInterval < std::chrono::milliseconds(20) ||
        options.levelInterval > std::chrono::seconds(1)) {
        return std::unexpected(
            core::error("audio_preflight_interval_invalid",
                        "Microphone level interval must be between 20 milliseconds and 1 second."));
    }
    return {};
}

inline core::Status notifyPreflightLevel(const CapturePreflightOptions& options,
                                         const CaptureInputLevel& level) {
    if (!options.levelChanged)
        return {};
    try {
        options.levelChanged(level);
    } catch (const std::exception& error) {
        return std::unexpected(
            core::error("audio_preflight_callback_failed",
                        std::string("The microphone level callback failed: ") + error.what()));
    } catch (...) {
        return std::unexpected(
            core::error("audio_preflight_callback_failed",
                        "The microphone level callback failed with an unknown exception."));
    }
    return {};
}

} // namespace tutorux::audio::detail

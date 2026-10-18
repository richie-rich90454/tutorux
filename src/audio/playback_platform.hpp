#pragma once

#include "tutorux/core/result.hpp"

#include <cstdint>
#include <functional>
#include <span>
#include <string_view>

namespace tutorux::audio::detail {

struct PcmPlaybackSource final {
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::function<core::Result<std::size_t>(std::span<std::int16_t>)> readFrames;
    std::function<bool()> stopRequested;
    std::function<void(std::uint64_t playedFrames)> progress;
};

struct PcmPlaybackResult final {
    std::uint64_t playedFrames{};
    bool reachedEnd{};
};

core::Result<PcmPlaybackResult> playPcmSource(PcmPlaybackSource source);

} // namespace tutorux::audio::detail

#include "tutorux/audio/playback.hpp"

#include "playback_platform.hpp"

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <utility>
#include <vector>

namespace tutorux::audio {
namespace {

    constexpr std::size_t maximumPlaybackFramesPerRead = 4'096;

    std::uint64_t framesToMicroseconds(std::uint64_t frames, std::uint32_t sampleRateHz) {
        const std::uint64_t seconds = frames / sampleRateHz;
        const std::uint64_t remainingFrames = frames % sampleRateHz;
        if (seconds > std::numeric_limits<std::uint64_t>::max() / 1'000'000ULL)
            return std::numeric_limits<std::uint64_t>::max();
        return seconds * 1'000'000ULL + (remainingFrames * 1'000'000ULL) / sampleRateHz;
    }

} // namespace

core::Result<PlaybackSummary> playArchiveTrack(archive::Archive& archive,
                                               const archive::Uuid& sessionId,
                                               PlaybackOptions options) {
    auto reader = AudioTimelineReader::open(archive, sessionId, options.trackId);
    if (!reader)
        return std::unexpected(reader.error());
    if (options.startFrame > reader->info().timelineFrameCount) {
        return std::unexpected(core::error(
            "audio_playback_seek_invalid",
            "The requested playback start is beyond the end of the selected recording."));
    }
    if (options.maximumFrames && *options.maximumFrames == 0) {
        return std::unexpected(
            core::error("audio_playback_duration_invalid",
                        "The requested playback duration must be greater than zero."));
    }
    if (auto status = reader->seek(options.startFrame); !status)
        return std::unexpected(status.error());

    PlaybackSummary summary;
    summary.timeline = reader->info();
    summary.startFrame = options.startFrame;
    const std::uint64_t framesAfterStart = summary.timeline.timelineFrameCount - options.startFrame;
    const std::uint64_t selectedFrames = options.maximumFrames
                                             ? std::min(*options.maximumFrames, framesAfterStart)
                                             : framesAfterStart;
    std::uint64_t framesRead = 0;
    std::vector<std::uint8_t> gapFlags(maximumPlaybackFramesPerRead);
    detail::PcmPlaybackSource source;
    source.sampleRateHz = summary.timeline.sampleRateHz;
    source.channelCount = summary.timeline.channelCount;
    source.stopRequested = options.stopRequested;
    source.progress = [&](std::uint64_t playedFrames) {
        summary.playedFrames = playedFrames;
        summary.durationUs = framesToMicroseconds(playedFrames, summary.timeline.sampleRateHz);
        if (options.progress)
            options.progress(playedFrames, selectedFrames);
    };
    source.readFrames = [&](std::span<std::int16_t> samples) -> core::Result<std::size_t> {
        if (options.stopRequested && options.stopRequested())
            return std::size_t{0};
        const std::size_t frameCapacity = samples.size() / summary.timeline.channelCount;
        const std::uint64_t remainingFrames = selectedFrames - framesRead;
        if (remainingFrames == 0)
            return std::size_t{0};
        const std::size_t requestedFrames =
            static_cast<std::size_t>(std::min<std::uint64_t>(remainingFrames, frameCapacity));
        auto read =
            reader->readFrames(samples.first(requestedFrames * summary.timeline.channelCount),
                               std::span<std::uint8_t>(gapFlags.data(), requestedFrames));
        if (!read)
            return std::unexpected(read.error());
        if (read->framesRead > remainingFrames) {
            return std::unexpected(
                core::error("audio_playback_reader_invalid",
                            "The archive timeline reader returned more frames than requested."));
        }
        if (summary.gapFramesPlayed >
            std::numeric_limits<std::uint64_t>::max() - read->gapFramesRead) {
            return std::unexpected(
                core::error("audio_playback_counter_invalid", "Playback counters overflowed."));
        }
        summary.gapFramesPlayed += read->gapFramesRead;
        framesRead += read->framesRead;
        return read->framesRead;
    };

    auto played = detail::playPcmSource(std::move(source));
    if (!played)
        return std::unexpected(played.error());
    summary.playedFrames = played->playedFrames;
    summary.durationUs = framesToMicroseconds(summary.playedFrames, summary.timeline.sampleRateHz);
    summary.completed = played->reachedEnd && !(options.stopRequested && options.stopRequested());
    return summary;
}

} // namespace tutorux::audio

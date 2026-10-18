#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace tutorux::audio {

struct AudioTimelineInfo final {
    archive::Uuid trackId{};
    std::uint32_t sampleRateHz{};
    std::uint16_t channelCount{};
    std::uint64_t storedFrameCount{};
    std::uint64_t timelineFrameCount{};
    std::uint64_t durationUs{};
    std::uint64_t chunkCount{};
    std::string sourceFingerprint;
};

struct AudioReadResult final {
    std::size_t framesRead{};
    std::uint64_t gapFramesRead{};
};

namespace detail {

    struct AudioChunkReference final {
        archive::Uuid id{};
        std::uint64_t sequence{};
        std::uint64_t firstFrame{};
        std::uint64_t frameCount{};
        std::uint64_t gapBeforeFrames{};
        std::uint64_t revision{};
    };

} // namespace detail

class AudioTimelineReader final {
  public:
    static core::Result<AudioTimelineReader> open(archive::Archive& archive,
                                                  const archive::Uuid& sessionId,
                                                  std::optional<archive::Uuid> trackId = {});

    AudioTimelineReader(AudioTimelineReader&&) noexcept = default;
    AudioTimelineReader& operator=(AudioTimelineReader&&) noexcept = default;
    AudioTimelineReader(const AudioTimelineReader&) = delete;
    AudioTimelineReader& operator=(const AudioTimelineReader&) = delete;

    const AudioTimelineInfo& info() const noexcept;
    std::uint64_t position() const noexcept;
    core::Status seek(std::uint64_t frameIndex);
    core::Result<AudioReadResult> readFrames(std::span<std::int16_t> interleavedSamples,
                                             std::span<std::uint8_t> gapFlags = {});

  private:
    AudioTimelineReader(archive::Archive& archive, archive::Uuid sessionId, AudioTimelineInfo info,
                        std::vector<detail::AudioChunkReference> chunks);

    core::Result<const archive::Record*> loadChunk(std::size_t chunkIndex);

    archive::Archive* archive_{};
    archive::Uuid sessionId_{};
    AudioTimelineInfo info_;
    std::vector<detail::AudioChunkReference> chunks_;
    std::optional<archive::Record> loadedChunk_;
    std::size_t loadedChunkIndex_{static_cast<std::size_t>(-1)};
    std::size_t nextChunkIndex_{};
    std::uint64_t position_{};
};

} // namespace tutorux::audio

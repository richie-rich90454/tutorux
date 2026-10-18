#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::transcription {

struct WhisperOptions final {
    std::filesystem::path modelPath;
    std::string language{"auto"};
    std::optional<archive::Uuid> trackId;
    std::optional<std::int64_t> startTimeUs;
    std::optional<std::int64_t> endTimeUs;
    std::uint32_t threadCount{};
    bool replaceProvisional{};
    bool diarizeSpeakerTurns{};
};

struct WhisperSummary final {
    archive::Uuid trackId{};
    std::uint64_t segmentsCreated{};
    std::uint64_t segmentsSuperseded{};
    std::uint64_t segmentsSkippedForHumanEdits{};
    std::uint64_t speakerTurnBoundaries{};
    std::uint64_t audioDurationUs{};
    bool diarizationEnabled{};
    std::string modelName;
    std::string backendVersion;
};

struct LiveWhisperOptions final {
    std::filesystem::path modelPath;
    std::string language{"auto"};
    std::uint32_t threadCount{};
    std::uint32_t windowSeconds{5};
    bool diarizeSpeakerTurns{};
};

struct LiveWhisperSegment final {
    std::int64_t startTimeUs{};
    std::int64_t endTimeUs{};
    std::string text;
    std::string language;
    std::string modelName;
    std::string backendVersion;
    bool provisional{true};
    bool diarizationEnabled{};
    bool speakerTurnNext{};
};

// Owns one model context. Call push and finish serially from the capture owner.
class LiveWhisperSession final {
  public:
    static core::Result<LiveWhisperSession> create(LiveWhisperOptions options);

    ~LiveWhisperSession();
    LiveWhisperSession(LiveWhisperSession&&) noexcept;
    LiveWhisperSession& operator=(LiveWhisperSession&&) noexcept;
    LiveWhisperSession(const LiveWhisperSession&) = delete;
    LiveWhisperSession& operator=(const LiveWhisperSession&) = delete;

    // Accepts interleaved pcm_u8, pcm_s16le, pcm_s24le, pcm_s32le, or pcm_f32le.
    // Returned segments are provisional and must be persisted by the caller if desired.
    core::Result<std::vector<LiveWhisperSegment>> push(std::span<const std::byte> pcm, std::string_view sampleFormat,
                                                       std::uint32_t sampleRateHz, std::uint16_t channelCount,
                                                       std::int64_t absoluteStartUs);
    // Transcribes the remaining partial window. This class never writes archive records.
    core::Result<std::vector<LiveWhisperSegment>> finish();

  private:
    struct Impl;

    explicit LiveWhisperSession(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
};

core::Result<WhisperSummary> transcribeSession(archive::Archive& archive, const archive::Uuid& sessionId, WhisperOptions options);

} // namespace tutorux::transcription

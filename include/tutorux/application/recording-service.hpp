#pragma once

#include "tutorux/audio/waveform.hpp"
#include "tutorux/audio/recording_take.hpp"
#include "tutorux/core/result.hpp"

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::application {

struct RecordingTrackChoice final {
    std::string id;
    std::string label;
};

struct RecordingTakeChoice final {
    std::string id;
    std::string label;
    std::string source;
    std::string state;
    std::uint64_t durationUs{};
    bool legacy{};
    std::vector<RecordingTrackChoice> tracks;
};

struct RecordingOverview final {
    std::string errorMessage;
    std::string waveformState{"empty"};
    std::string selectedTakeId;
    std::string selectedTrackId;
    std::uint32_t sampleRateHz{};
    std::uint64_t durationUs{};
    std::uint64_t timelineFrameCount{};
    std::vector<RecordingTakeChoice> takes;
    std::vector<audio::WaveformBucket> buckets;
};

enum class RecordingTakeMutation { rename, moveToTrash, restore };

struct RecordingTakeMutationRequest final {
    RecordingTakeMutation mutation{RecordingTakeMutation::rename};
    std::string sessionId;
    std::string takeId;
    std::string label;
};

class RecordingService final {
  public:
    [[nodiscard]] RecordingOverview snapshot(
        const std::filesystem::path& archivePath,
        std::string_view passphrase,
        std::string_view sessionId,
        std::string_view selectedTakeId = {},
        std::string_view selectedTrackId = {},
        std::size_t maximumBuckets = 512) const;

    [[nodiscard]] core::Status mutateTake(const std::filesystem::path& archivePath,
                                          std::string_view passphrase,
                                          const RecordingTakeMutationRequest& request) const;
};

} // namespace tutorux::application

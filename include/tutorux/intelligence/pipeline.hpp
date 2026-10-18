#pragma once

#include "tutorux/archive/archive.hpp"
#include "tutorux/core/result.hpp"

#include <cstddef>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <optional>
#include <queue>
#include <set>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::intelligence {

struct TranscriptCue final {
    std::string id;
    std::int64_t startTimeUs{};
    std::int64_t endTimeUs{};
    std::string speakerId;
    std::string text;
    bool verified{};
    std::uint64_t revision{};
};

struct AlignmentChange final {
    bool inserted{};
    std::uint64_t previousRevision{};
    std::uint64_t currentRevision{};
    std::vector<std::string> neighboringCueIds;
};

// Keeps transcript cues addressable by ID and ordered by time. Updating one cue only
// touches its index entries and nearby alignment context.
class TranscriptAlignmentEngine final {
  public:
    core::Result<AlignmentChange> upsert(TranscriptCue cue);
    core::Status erase(std::string_view cueId);
    core::Result<AlignmentChange>
    reviseText(std::string_view cueId, std::string text, bool verified);
    std::vector<TranscriptCue> overlapping(std::int64_t startTimeUs,
                                           std::int64_t endTimeUs,
                                           std::int64_t toleranceUs = 0) const;
    std::optional<TranscriptCue> find(std::string_view cueId) const;
    std::size_t size() const noexcept;

  private:
    using TimeKey = std::pair<std::int64_t, std::string>;
    std::vector<std::string> neighborsFor(const TimeKey& key) const;

    std::map<std::string, TranscriptCue, std::less<>> cuesById_;
    std::map<TimeKey, std::string> cuesByTime_;
};

struct EvidenceNode final {
    archive::Uuid id{};
    std::string sessionId;
    std::string kind;
    std::string statement;
    std::string reviewState{"suggested"};
    std::string origin{"transcript-derived-candidate"};
    double confidence{};
    std::vector<std::string> annotationSourceIds;
    std::vector<std::string> transcriptSourceIds;
    std::vector<std::string> assetSourceIds;
};

struct EvidenceEdge final {
    archive::Uuid id{};
    std::string sessionId;
    std::string sourceId;
    std::string targetId;
    std::string relationship;
    double confidence{};
};

class EvidenceAwareInstructionGraph final {
  public:
    core::Status addNode(EvidenceNode node);
    core::Status addEdge(EvidenceEdge edge);
    core::Status removeNode(std::string_view nodeId);
    core::Status validate() const;
    std::vector<EvidenceNode> nodesForSession(std::string_view sessionId) const;
    std::vector<EvidenceEdge> edgesForNode(std::string_view nodeId) const;
    std::vector<std::pair<std::string, std::string>> contradictions() const;
    std::vector<archive::Record> toArchiveRecords() const;

  private:
    std::map<std::string, EvidenceNode, std::less<>> nodes_;
    std::map<std::string, EvidenceEdge, std::less<>> edges_;
};

enum class EvidencePriority : std::uint8_t {
    background,
    normal,
    important,
    critical,
};

struct ContextCandidate final {
    std::string sourceId;
    std::string sourceKind;
    std::string content;
    std::int64_t startTimeUs{};
    std::int64_t endTimeUs{};
    std::uint64_t updatedAtUs{};
    EvidencePriority priority{EvidencePriority::normal};
    double confidence{1.0};
    bool tutorAuthored{};
    bool required{};
};

struct ContextPackOptions final {
    std::size_t tokenBudget{};
    std::size_t maximumItemTokens{};
    bool splitOversizedCandidates{true};
    std::function<std::size_t(std::string_view)> countTokens;
};

struct PackedContextItem final {
    std::string sourceId;
    std::string sourceKind;
    std::string content;
    std::size_t sourceByteStart{};
    std::size_t sourceByteEnd{};
    std::size_t estimatedTokens{};
    std::uint32_t fragmentIndex{};
    bool tutorAuthored{};
};

struct OmittedContextItem final {
    std::string sourceId;
    std::string reason;
    std::size_t estimatedTokens{};
    std::uint32_t fragmentIndex{};
};

struct ContextPack final {
    std::vector<PackedContextItem> included;
    std::vector<OmittedContextItem> omitted;
    std::size_t tokenBudget{};
    std::size_t usedTokens{};
    bool complete{};
};

std::size_t estimateTokenCount(std::string_view text) noexcept;
core::Result<ContextPack> packContext(std::vector<ContextCandidate> candidates,
                                      ContextPackOptions options);

struct GuideDependency final {
    std::string guideId;
    std::string sectionId;
    std::string blockId;
    std::string sourceId;
    std::string sourceHash;
};

struct StaleGuideBlock final {
    std::string guideId;
    std::string sectionId;
    std::string blockId;
    std::string sourceId;
};

class IncrementalGuideDependencyEngine final {
  public:
    core::Status registerDependency(GuideDependency dependency);
    std::vector<StaleGuideBlock> invalidateSource(std::string_view sourceId,
                                                  std::string_view newSourceHash);
    std::vector<StaleGuideBlock>
    invalidateSources(const std::map<std::string, std::string, std::less<>>& sourceHashes);
    std::vector<GuideDependency> dependenciesForSource(std::string_view sourceId) const;
    std::vector<GuideDependency> dependenciesForBlock(std::string_view guideId,
                                                      std::string_view blockId) const;

  private:
    std::map<std::string, std::vector<GuideDependency>, std::less<>> bySource_;
};

struct TranscriptionWork final {
    std::string id;
    std::string sessionId;
    std::string trackId;
    std::int64_t startTimeUs{};
    std::int64_t endTimeUs{};
    std::uint8_t priority{};
    bool provisional{};
};

struct TranscriptionBudget final {
    std::uint32_t hardwareThreads{};
    std::uint32_t reservedThreads{1};
    std::uint64_t availableMemoryBytes{};
    std::uint64_t modelMemoryBytes{};
    double realTimeFactor{1.0};
    std::uint32_t maximumWorkers{};
    std::int64_t targetChunkDurationUs{30'000'000};
};

struct TranscriptionPlan final {
    std::vector<TranscriptionWork> work;
    std::uint32_t workerCount{};
    std::int64_t chunkDurationUs{};
    std::uint64_t estimatedPeakMemoryBytes{};
    std::uint64_t estimatedWorkDurationUs{};
};

core::Result<TranscriptionPlan> planTranscription(std::string_view sessionId,
                                                  std::string_view trackId,
                                                  std::int64_t durationUs,
                                                  TranscriptionBudget budget);

class AdaptiveTranscriptionScheduler final {
  public:
    explicit AdaptiveTranscriptionScheduler(TranscriptionBudget budget);

    core::Status enqueue(TranscriptionWork work);
    core::Status updateBudget(TranscriptionBudget budget);
    std::vector<TranscriptionWork> takeReady();
    core::Status cancel(std::string_view workId);
    core::Status finish(std::string_view workId, bool succeeded, bool retryable = false);
    bool cancellationRequested(std::string_view workId) const;
    std::vector<archive::Record> checkpointRecords() const;
    core::Status saveCheckpoints(archive::Archive& archive) const;
    std::uint32_t workerLimit() const;
    std::size_t queuedCount() const;
    std::size_t runningCount() const;

  private:
    enum class WorkState : std::uint8_t {
        queued,
        running,
        cancelRequested,
        completed,
        failed,
        cancelled,
    };

    struct Entry final {
        TranscriptionWork work;
        WorkState state{WorkState::queued};
        std::uint64_t enqueueOrder{};
        std::uint32_t attempts{1};
    };

    struct QueueItem final {
        std::uint8_t priority{};
        std::uint64_t enqueueOrder{};
        std::string id;
    };

    struct QueueItemCompare final {
        bool operator()(const QueueItem& left, const QueueItem& right) const noexcept;
    };

    static std::uint32_t calculateWorkerLimit(const TranscriptionBudget& budget) noexcept;

    mutable std::mutex mutex_;
    TranscriptionBudget budget_;
    std::map<std::string, Entry, std::less<>> entries_;
    std::priority_queue<QueueItem, std::vector<QueueItem>, QueueItemCompare> ready_;
    std::uint64_t nextEnqueueOrder_{};
    std::size_t queuedCount_{};
    std::size_t runningCount_{};
};

struct WaveformPeak final {
    std::int16_t minimum{};
    std::int16_t maximum{};
};

// A multi-resolution min/max pyramid supports fast overview rendering while retaining
// the original sample stream only in the archive's audio records.
class IncrementalWaveformPyramid final {
  public:
    explicit IncrementalWaveformPyramid(std::uint32_t baseWindowSamples = 256);
    core::Status appendPcm16Le(std::span<const std::byte> pcmBytes);
    core::Status finish();
    std::vector<WaveformPeak>
    query(std::size_t level, std::size_t firstBucket, std::size_t bucketCount) const;
    std::size_t bucketCount(std::size_t level) const noexcept;
    std::uint64_t sampleCount() const noexcept;
    std::uint32_t baseWindowSamples() const noexcept;
    archive::Record toArchiveRecord(const archive::Uuid& sessionId,
                                    const archive::Uuid& trackId) const;

  private:
    void appendBasePeak(WaveformPeak peak);

    std::uint32_t baseWindowSamples_{};
    std::uint64_t sampleCount_{};
    std::vector<std::vector<WaveformPeak>> levels_;
    std::vector<std::int16_t> pendingSamples_;
    bool finished_{};
};

struct TimestampOffset final {
    std::int64_t timeUs{};
    std::uint64_t byteOffset{};
};

// Sparse timestamp anchors bound seek work independently of recording length.
class SparseTimestampSeekIndex final {
  public:
    explicit SparseTimestampSeekIndex(std::int64_t intervalUs = 2'000'000);
    core::Status add(std::int64_t timeUs, std::uint64_t byteOffset);
    std::optional<TimestampOffset> atOrBefore(std::int64_t timeUs) const;
    std::optional<TimestampOffset> atOrAfter(std::int64_t timeUs) const;
    const std::vector<TimestampOffset>& entries() const noexcept;
    archive::Record toArchiveRecord(const archive::Uuid& sessionId,
                                    const archive::Uuid& trackId) const;

  private:
    std::int64_t intervalUs_{};
    std::vector<TimestampOffset> entries_;
};

core::Result<archive::Record> makeContentAddressedAssetMetadata(std::string_view fileName,
                                                                std::string_view mediaType,
                                                                std::string_view sourcePath,
                                                                std::span<const std::byte> content);

} // namespace tutorux::intelligence

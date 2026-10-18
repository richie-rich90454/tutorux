#include "tutorux/intelligence/pipeline.hpp"

#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <limits>
#include <tuple>

namespace tutorux::intelligence {
namespace {

    constexpr std::int64_t minimumChunkDurationUs = 5'000'000;
    constexpr std::int64_t maximumChunkDurationUs = 120'000'000;

    std::int64_t saturatedSubtract(std::int64_t value, std::int64_t amount) noexcept {
        if (amount <= 0)
            return value;
        return value < std::numeric_limits<std::int64_t>::min() + amount
                   ? std::numeric_limits<std::int64_t>::min()
                   : value - amount;
    }

    std::int64_t saturatedAdd(std::int64_t value, std::int64_t amount) noexcept {
        if (amount <= 0)
            return value;
        return value > std::numeric_limits<std::int64_t>::max() - amount
                   ? std::numeric_limits<std::int64_t>::max()
                   : value + amount;
    }

    std::string joinIds(const std::vector<std::string>& ids) {
        std::string output;
        for (const auto& id : ids) {
            if (!output.empty())
                output.push_back(',');
            output += id;
        }
        return output;
    }

    bool isSupportedRelationship(std::string_view relationship) {
        static constexpr std::array relationships{
            "supports",
            "contradicts",
            "elaborates",
            "causes",
            "precedes",
            "corrects",
            "exemplifies",
            "assesses",
            "derived-from",
            "reinforces",
            "explains",
            "demonstrates",
            "references",
            "depends-on",
            "recommends",
        };
        return std::find(relationships.begin(), relationships.end(), relationship) !=
               relationships.end();
    }

    std::size_t countTokens(std::string_view text, const ContextPackOptions& options) {
        return options.countTokens ? options.countTokens(text) : estimateTokenCount(text);
    }

    std::size_t nextCodePointBoundary(std::string_view text, std::size_t offset) noexcept {
        if (offset >= text.size())
            return text.size();
        const auto first = static_cast<unsigned char>(text[offset]);
        std::size_t width = 1;
        if ((first & 0xE0U) == 0xC0U)
            width = 2;
        else if ((first & 0xF0U) == 0xE0U)
            width = 3;
        else if ((first & 0xF8U) == 0xF0U)
            width = 4;
        return std::min(text.size(), offset + width);
    }

    std::vector<std::pair<std::size_t, std::size_t>>
    splitText(std::string_view text,
              std::size_t maximumTokens,
              const std::function<std::size_t(std::string_view)>& counter) {
        std::vector<std::pair<std::size_t, std::size_t>> ranges;
        if (text.empty())
            return ranges;

        std::size_t start = 0;
        while (start < text.size()) {
            std::size_t low = start;
            std::size_t high = text.size();
            while (nextCodePointBoundary(text, low) < high) {
                const std::size_t middle = low + (high - low) / 2;
                std::size_t boundary = middle;
                while (boundary > low && boundary < text.size() &&
                       (static_cast<unsigned char>(text[boundary]) & 0xC0U) == 0x80U)
                    --boundary;
                if (boundary <= low)
                    boundary = nextCodePointBoundary(text, low);
                if (counter(text.substr(start, boundary - start)) <= maximumTokens)
                    low = boundary;
                else
                    high = boundary;
            }

            std::size_t end = low;
            const std::size_t nextBoundary = nextCodePointBoundary(text, low);
            if (nextBoundary > low &&
                counter(text.substr(start, nextBoundary - start)) <= maximumTokens)
                end = nextBoundary;
            if (end <= start)
                end = nextCodePointBoundary(text, start);
            if (end < text.size()) {
                const std::size_t preferredMinimum = start + (end - start) / 2;
                const std::size_t paragraphBreak = text.rfind("\n\n", end - 1);
                if (paragraphBreak != std::string_view::npos &&
                    paragraphBreak >= preferredMinimum) {
                    end = paragraphBreak + 2;
                } else {
                    const std::size_t lineBreak = text.rfind('\n', end - 1);
                    if (lineBreak != std::string_view::npos && lineBreak >= preferredMinimum)
                        end = lineBreak + 1;
                }
            }
            ranges.emplace_back(start, end);
            start = end;
        }
        return ranges;
    }

    std::uint64_t multiplySaturated(std::uint64_t left, std::uint64_t right) noexcept {
        if (left != 0 && right > std::numeric_limits<std::uint64_t>::max() / left)
            return std::numeric_limits<std::uint64_t>::max();
        return left * right;
    }

    void appendU32(archive::Bytes& bytes, std::uint32_t value) {
        for (unsigned shift = 0; shift < 32; shift += 8)
            bytes.push_back(static_cast<std::byte>((value >> shift) & 0xFFU));
    }

    void appendU64(archive::Bytes& bytes, std::uint64_t value) {
        for (unsigned shift = 0; shift < 64; shift += 8)
            bytes.push_back(static_cast<std::byte>((value >> shift) & 0xFFU));
    }

    void appendI16(archive::Bytes& bytes, std::int16_t value) {
        const auto bits = static_cast<std::uint16_t>(value);
        bytes.push_back(static_cast<std::byte>(bits & 0xFFU));
        bytes.push_back(static_cast<std::byte>((bits >> 8U) & 0xFFU));
    }

    std::string uuidKey(const archive::Uuid& id) {
        return archive::uuidToString(id);
    }

    archive::Uuid checkpointUuid(std::string_view workId) {
        const auto bytes =
            std::span<const std::byte>(reinterpret_cast<const std::byte*>(workId.data()),
                                       workId.size());
        const auto digest = domain::sha256(bytes);
        archive::Uuid id{};
        std::copy_n(digest.begin(), id.size(), id.begin());
        id[6] = static_cast<std::byte>((std::to_integer<std::uint8_t>(id[6]) & 0x0FU) | 0x50U);
        id[8] = static_cast<std::byte>((std::to_integer<std::uint8_t>(id[8]) & 0x3FU) | 0x80U);
        return id;
    }

} // namespace

core::Result<AlignmentChange> TranscriptAlignmentEngine::upsert(TranscriptCue cue) {
    if (cue.id.empty())
        return std::unexpected(
            core::error("transcript_cue_id_required", "A transcript cue needs a stable ID."));
    if (cue.startTimeUs < 0 || cue.endTimeUs < cue.startTimeUs)
        return std::unexpected(
            core::error("transcript_cue_time_invalid",
                        "Transcript cue times must be non-negative and ordered."));

    const auto existing = cuesById_.find(cue.id);
    AlignmentChange change;
    TimeKey key{cue.startTimeUs, cue.id};
    if (existing != cuesById_.end()) {
        change.previousRevision = existing->second.revision;
        cuesByTime_.erase(TimeKey{existing->second.startTimeUs, existing->first});
        if (cue.revision == 0)
            cue.revision = existing->second.revision + 1;
    } else {
        change.inserted = true;
        cue.revision = std::max<std::uint64_t>(cue.revision, 1);
    }

    change.currentRevision = cue.revision;
    cuesById_.insert_or_assign(cue.id, std::move(cue));
    cuesByTime_.emplace(key, key.second);
    change.neighboringCueIds = neighborsFor(key);
    return change;
}

core::Status TranscriptAlignmentEngine::erase(std::string_view cueId) {
    const auto existing = cuesById_.find(cueId);
    if (existing == cuesById_.end())
        return std::unexpected(
            core::error("transcript_cue_not_found", "The transcript cue does not exist."));
    cuesByTime_.erase(TimeKey{existing->second.startTimeUs, existing->first});
    cuesById_.erase(existing);
    return {};
}

core::Result<AlignmentChange>
TranscriptAlignmentEngine::reviseText(std::string_view cueId, std::string text, bool verified) {
    const auto existing = cuesById_.find(cueId);
    if (existing == cuesById_.end())
        return std::unexpected(
            core::error("transcript_cue_not_found", "The transcript cue does not exist."));
    TranscriptCue revised = existing->second;
    revised.text = std::move(text);
    revised.verified = verified;
    ++revised.revision;
    return upsert(std::move(revised));
}

std::vector<TranscriptCue> TranscriptAlignmentEngine::overlapping(std::int64_t startTimeUs,
                                                                  std::int64_t endTimeUs,
                                                                  std::int64_t toleranceUs) const {
    std::vector<TranscriptCue> result;
    if (startTimeUs < 0 || endTimeUs < startTimeUs)
        return result;
    toleranceUs = std::max<std::int64_t>(toleranceUs, 0);
    const std::int64_t searchStart = saturatedSubtract(startTimeUs, toleranceUs);
    const std::int64_t searchEnd = saturatedAdd(endTimeUs, toleranceUs);
    for (auto iterator = cuesByTime_.lower_bound({searchStart, {}});
         iterator != cuesByTime_.end() && iterator->first.first <= searchEnd;
         ++iterator) {
        const auto cue = cuesById_.find(iterator->second);
        if (cue != cuesById_.end() &&
            saturatedAdd(cue->second.endTimeUs, toleranceUs) >= startTimeUs)
            result.push_back(cue->second);
    }
    return result;
}

std::optional<TranscriptCue> TranscriptAlignmentEngine::find(std::string_view cueId) const {
    const auto found = cuesById_.find(cueId);
    if (found == cuesById_.end())
        return std::nullopt;
    return found->second;
}

std::size_t TranscriptAlignmentEngine::size() const noexcept {
    return cuesById_.size();
}

std::vector<std::string> TranscriptAlignmentEngine::neighborsFor(const TimeKey& key) const {
    std::vector<std::string> result;
    auto current = cuesByTime_.lower_bound(key);
    if (current == cuesByTime_.end())
        return result;
    if (current != cuesByTime_.begin()) {
        auto previous = std::prev(current);
        result.push_back(previous->second);
    }
    result.push_back(current->second);
    auto next = std::next(current);
    if (next != cuesByTime_.end())
        result.push_back(next->second);
    return result;
}

core::Status EvidenceAwareInstructionGraph::addNode(EvidenceNode node) {
    if (node.sessionId.empty() || node.kind.empty() || node.statement.empty())
        return std::unexpected(core::error("evidence_node_invalid",
                                           "Evidence needs a session, a type, and a statement."));
    if (!std::isfinite(node.confidence) || node.confidence < 0.0 || node.confidence > 1.0)
        return std::unexpected(core::error("evidence_confidence_invalid",
                                           "Evidence confidence must be between zero and one."));
    if (node.id == archive::Uuid{})
        node.id = archive::randomUuid();
    nodes_.insert_or_assign(uuidKey(node.id), std::move(node));
    return {};
}

core::Status EvidenceAwareInstructionGraph::addEdge(EvidenceEdge edge) {
    if (edge.sessionId.empty() || edge.sourceId.empty() || edge.targetId.empty() ||
        edge.sourceId == edge.targetId || !isSupportedRelationship(edge.relationship))
        return std::unexpected(
            core::error("evidence_edge_invalid",
                        "Evidence relationship endpoints and type must be valid."));
    if (!std::isfinite(edge.confidence) || edge.confidence < 0.0 || edge.confidence > 1.0)
        return std::unexpected(core::error("evidence_confidence_invalid",
                                           "Evidence confidence must be between zero and one."));
    if (edge.id == archive::Uuid{})
        edge.id = archive::randomUuid();
    edges_.insert_or_assign(uuidKey(edge.id), std::move(edge));
    return {};
}

core::Status EvidenceAwareInstructionGraph::removeNode(std::string_view nodeId) {
    if (nodes_.erase(nodeId) == 0)
        return std::unexpected(
            core::error("evidence_node_not_found", "The evidence node does not exist."));
    std::erase_if(edges_, [&](const auto& entry) {
        return entry.second.sourceId == nodeId || entry.second.targetId == nodeId;
    });
    return {};
}

core::Status EvidenceAwareInstructionGraph::validate() const {
    for (const auto& [edgeId, edge] : edges_) {
        static_cast<void>(edgeId);
        const auto source = nodes_.find(edge.sourceId);
        const auto target = nodes_.find(edge.targetId);
        if (source == nodes_.end() || target == nodes_.end())
            return std::unexpected(
                core::error("evidence_edge_orphaned",
                            "An evidence relationship points to a missing node."));
        if (source->second.sessionId != edge.sessionId ||
            target->second.sessionId != edge.sessionId)
            return std::unexpected(core::error("evidence_session_mismatch",
                                               "Evidence relationships cannot cross sessions."));
    }
    return {};
}

std::vector<EvidenceNode>
EvidenceAwareInstructionGraph::nodesForSession(std::string_view sessionId) const {
    std::vector<EvidenceNode> result;
    for (const auto& [id, node] : nodes_) {
        static_cast<void>(id);
        if (node.sessionId == sessionId)
            result.push_back(node);
    }
    return result;
}

std::vector<EvidenceEdge>
EvidenceAwareInstructionGraph::edgesForNode(std::string_view nodeId) const {
    std::vector<EvidenceEdge> result;
    for (const auto& [id, edge] : edges_) {
        static_cast<void>(id);
        if (edge.sourceId == nodeId || edge.targetId == nodeId)
            result.push_back(edge);
    }
    return result;
}

std::vector<std::pair<std::string, std::string>>
EvidenceAwareInstructionGraph::contradictions() const {
    std::set<std::pair<std::string, std::string>> uniquePairs;
    for (const auto& [id, edge] : edges_) {
        static_cast<void>(id);
        if (edge.relationship != "contradicts")
            continue;
        uniquePairs.emplace(std::min(edge.sourceId, edge.targetId),
                            std::max(edge.sourceId, edge.targetId));
    }
    return {uniquePairs.begin(), uniquePairs.end()};
}

std::vector<archive::Record> EvidenceAwareInstructionGraph::toArchiveRecords() const {
    std::vector<archive::Record> records;
    records.reserve(nodes_.size() + edges_.size());
    for (const auto& [id, node] : nodes_) {
        static_cast<void>(id);
        archive::Record record;
        record.type = archive::RecordType::EvidenceNode;
        record.id = node.id;
        record.fields = {
            {"session_id",           node.sessionId                                             },
            {"type",                 node.kind                                                  },
            {"content",              node.statement                                             },
            {"verification_state",   node.reviewState                                           },
            {"origin",               node.origin                                                },
            {"confidence",           std::to_string(node.confidence)                            },
            {"source_annotation_id",
             node.annotationSourceIds.empty() ? std::string{} : node.annotationSourceIds.front()},
            {"source_segment_ids",   joinIds(node.transcriptSourceIds)                          },
            {"source_asset_ids",     joinIds(node.assetSourceIds)                               }
        };
        records.push_back(std::move(record));
    }
    for (const auto& [id, edge] : edges_) {
        static_cast<void>(id);
        archive::Record record;
        record.type = archive::RecordType::EvidenceEdge;
        record.id = edge.id;
        record.fields = {
            {"session_id",   edge.sessionId                 },
            {"from_id",      edge.sourceId                  },
            {"to_id",        edge.targetId                  },
            {"relationship", edge.relationship              },
            {"confidence",   std::to_string(edge.confidence)}
        };
        records.push_back(std::move(record));
    }
    return records;
}

std::size_t estimateTokenCount(std::string_view text) noexcept {
    if (text.empty())
        return 0;
    return text.size() / 3 + (text.size() % 3 == 0 ? 0 : 1);
}

core::Result<ContextPack> packContext(std::vector<ContextCandidate> candidates,
                                      ContextPackOptions options) {
    if (options.tokenBudget == 0)
        return std::unexpected(core::error("context_budget_invalid",
                                           "Context token budget must be greater than zero."));
    if (options.maximumItemTokens == 0)
        options.maximumItemTokens = options.tokenBudget;

    std::stable_sort(candidates.begin(), candidates.end(), [](const auto& left, const auto& right) {
        return std::tuple{left.required,
                          left.priority,
                          left.tutorAuthored,
                          left.confidence,
                          left.updatedAtUs,
                          left.sourceId} > std::tuple{right.required,
                                                      right.priority,
                                                      right.tutorAuthored,
                                                      right.confidence,
                                                      right.updatedAtUs,
                                                      right.sourceId};
    });

    ContextPack result;
    result.tokenBudget = options.tokenBudget;
    std::size_t usedTokens = 0;
    for (const auto& candidate : candidates) {
        if (candidate.sourceId.empty())
            return std::unexpected(core::error("context_source_id_required",
                                               "Every context candidate needs a source ID."));
        if (!std::isfinite(candidate.confidence) || candidate.confidence < 0.0 ||
            candidate.confidence > 1.0)
            return std::unexpected(core::error("context_confidence_invalid",
                                               "Context confidence must be between zero and one."));

        std::vector<std::pair<std::size_t, std::size_t>> fragments;
        const std::size_t totalTokens = countTokens(candidate.content, options);
        if (totalTokens <= options.maximumItemTokens || !options.splitOversizedCandidates) {
            fragments.emplace_back(0, candidate.content.size());
        } else {
            fragments = splitText(candidate.content,
                                  options.maximumItemTokens,
                                  [&](std::string_view value) {
                                      return countTokens(value, options);
                                  });
        }

        for (std::size_t index = 0; index < fragments.size(); ++index) {
            const auto [begin, end] = fragments[index];
            const std::string_view text(candidate.content.data() + begin, end - begin);
            const std::size_t tokens = countTokens(text, options);
            const auto fragmentIndex = static_cast<std::uint32_t>(index);
            if (tokens > options.maximumItemTokens) {
                result.omitted.push_back(
                    {candidate.sourceId, "exceeds-item-token-limit", tokens, fragmentIndex});
            } else if (tokens > options.tokenBudget - usedTokens) {
                result.omitted.push_back({candidate.sourceId,
                                          "exceeds-remaining-context-budget",
                                          tokens,
                                          fragmentIndex});
            } else {
                result.included.push_back({candidate.sourceId,
                                           candidate.sourceKind,
                                           std::string(text),
                                           begin,
                                           end,
                                           tokens,
                                           fragmentIndex,
                                           candidate.tutorAuthored});
                usedTokens += tokens;
            }
        }
    }
    result.usedTokens = usedTokens;
    result.complete = result.omitted.empty();
    return result;
}

core::Status IncrementalGuideDependencyEngine::registerDependency(GuideDependency dependency) {
    if (dependency.guideId.empty() || dependency.sectionId.empty() || dependency.blockId.empty() ||
        dependency.sourceId.empty())
        return std::unexpected(
            core::error("guide_dependency_invalid",
                        "Guide dependencies need guide, section, block, and source IDs."));
    auto& dependencies = bySource_[dependency.sourceId];
    const auto existing =
        std::find_if(dependencies.begin(), dependencies.end(), [&](const GuideDependency& current) {
            return current.guideId == dependency.guideId && current.blockId == dependency.blockId;
        });
    if (existing == dependencies.end())
        dependencies.push_back(std::move(dependency));
    else
        *existing = std::move(dependency);
    return {};
}

std::vector<StaleGuideBlock>
IncrementalGuideDependencyEngine::invalidateSource(std::string_view sourceId,
                                                   std::string_view newSourceHash) {
    std::vector<StaleGuideBlock> stale;
    const auto found = bySource_.find(sourceId);
    if (found == bySource_.end())
        return stale;
    for (auto& dependency : found->second) {
        if (dependency.sourceHash == newSourceHash)
            continue;
        stale.push_back(
            {dependency.guideId, dependency.sectionId, dependency.blockId, dependency.sourceId});
        dependency.sourceHash = std::string(newSourceHash);
    }
    return stale;
}

std::vector<StaleGuideBlock> IncrementalGuideDependencyEngine::invalidateSources(
    const std::map<std::string, std::string, std::less<>>& sourceHashes) {
    std::vector<StaleGuideBlock> stale;
    for (const auto& [sourceId, newHash] : sourceHashes) {
        auto affected = invalidateSource(sourceId, newHash);
        stale.insert(stale.end(),
                     std::make_move_iterator(affected.begin()),
                     std::make_move_iterator(affected.end()));
    }
    return stale;
}

std::vector<GuideDependency>
IncrementalGuideDependencyEngine::dependenciesForSource(std::string_view sourceId) const {
    const auto found = bySource_.find(sourceId);
    return found == bySource_.end() ? std::vector<GuideDependency>{} : found->second;
}

std::vector<GuideDependency>
IncrementalGuideDependencyEngine::dependenciesForBlock(std::string_view guideId,
                                                       std::string_view blockId) const {
    std::vector<GuideDependency> result;
    for (const auto& [sourceId, dependencies] : bySource_) {
        static_cast<void>(sourceId);
        for (const auto& dependency : dependencies) {
            if (dependency.guideId == guideId && dependency.blockId == blockId)
                result.push_back(dependency);
        }
    }
    return result;
}

core::Result<TranscriptionPlan> planTranscription(std::string_view sessionId,
                                                  std::string_view trackId,
                                                  std::int64_t durationUs,
                                                  TranscriptionBudget budget) {
    if (sessionId.empty() || trackId.empty() || durationUs <= 0)
        return std::unexpected(
            core::error("transcription_plan_input_invalid",
                        "A session, track, and positive duration are required."));
    if (!std::isfinite(budget.realTimeFactor) || budget.realTimeFactor <= 0.0)
        return std::unexpected(core::error("transcription_budget_invalid",
                                           "Transcription real-time factor must be positive."));

    const std::uint32_t cpuWorkers = budget.hardwareThreads > budget.reservedThreads
                                         ? budget.hardwareThreads - budget.reservedThreads
                                         : 1;
    std::uint32_t workerLimit =
        budget.maximumWorkers == 0 ? cpuWorkers : std::min(cpuWorkers, budget.maximumWorkers);
    if (budget.availableMemoryBytes == 0 || budget.modelMemoryBytes == 0) {
        workerLimit = 1;
    } else {
        const std::uint64_t memoryWorkers = budget.availableMemoryBytes / budget.modelMemoryBytes;
        if (memoryWorkers == 0)
            return std::unexpected(
                core::error("transcription_memory_budget_insufficient",
                            "The transcription model exceeds the available memory budget."));
        workerLimit =
            static_cast<std::uint32_t>(std::min<std::uint64_t>(workerLimit, memoryWorkers));
    }

    const std::int64_t chunkDuration =
        std::clamp(budget.targetChunkDurationUs, minimumChunkDurationUs, maximumChunkDurationUs);
    TranscriptionPlan plan;
    plan.workerCount = std::max<std::uint32_t>(workerLimit, 1);
    plan.chunkDurationUs = chunkDuration;
    plan.estimatedPeakMemoryBytes = multiplySaturated(budget.modelMemoryBytes, plan.workerCount);
    const double estimatedWork = static_cast<double>(durationUs) * budget.realTimeFactor /
                                 static_cast<double>(plan.workerCount);
    plan.estimatedWorkDurationUs =
        estimatedWork >= static_cast<double>(std::numeric_limits<std::uint64_t>::max())
            ? std::numeric_limits<std::uint64_t>::max()
            : static_cast<std::uint64_t>(std::ceil(estimatedWork));
    for (std::int64_t start = 0; start < durationUs;) {
        const std::int64_t remaining = durationUs - start;
        const std::int64_t end = start + std::min(remaining, chunkDuration);
        TranscriptionWork work;
        work.id = std::string(sessionId) + ":" + std::string(trackId) + ":" + std::to_string(start);
        work.sessionId = sessionId;
        work.trackId = trackId;
        work.startTimeUs = start;
        work.endTimeUs = end;
        work.priority = 2;
        work.provisional = true;
        plan.work.push_back(std::move(work));
        start = end;
    }
    return plan;
}

AdaptiveTranscriptionScheduler::AdaptiveTranscriptionScheduler(TranscriptionBudget budget)
    : budget_(std::move(budget)) {}

core::Status AdaptiveTranscriptionScheduler::enqueue(TranscriptionWork work) {
    if (work.id.empty() || work.sessionId.empty() || work.trackId.empty() || work.startTimeUs < 0 ||
        work.endTimeUs <= work.startTimeUs)
        return std::unexpected(
            core::error("transcription_work_invalid",
                        "Queued transcription work needs valid IDs and a time range."));
    std::lock_guard lock(mutex_);
    if (entries_.contains(work.id))
        return std::unexpected(
            core::error("transcription_work_duplicate",
                        "This transcription work ID has already been scheduled."));
    const std::uint64_t order = nextEnqueueOrder_++;
    const std::string id = work.id;
    entries_.emplace(id, Entry{std::move(work), WorkState::queued, order, 1});
    ready_.push({entries_.at(id).work.priority, order, id});
    ++queuedCount_;
    return {};
}

core::Status AdaptiveTranscriptionScheduler::updateBudget(TranscriptionBudget budget) {
    if (!std::isfinite(budget.realTimeFactor) || budget.realTimeFactor <= 0.0 ||
        budget.targetChunkDurationUs <= 0)
        return std::unexpected(
            core::error("transcription_budget_invalid",
                        "Scheduler estimates and chunk duration must be positive."));
    std::lock_guard lock(mutex_);
    budget_ = std::move(budget);
    return {};
}

std::vector<TranscriptionWork> AdaptiveTranscriptionScheduler::takeReady() {
    std::lock_guard lock(mutex_);
    std::vector<TranscriptionWork> result;
    const std::uint32_t limit = calculateWorkerLimit(budget_);
    if (runningCount_ >= limit)
        return result;
    result.reserve(std::min<std::size_t>(queuedCount_, limit - runningCount_));
    while (!ready_.empty() && runningCount_ < limit) {
        QueueItem item = ready_.top();
        ready_.pop();
        const auto found = entries_.find(item.id);
        if (found == entries_.end() || found->second.state != WorkState::queued ||
            found->second.enqueueOrder != item.enqueueOrder)
            continue;
        found->second.state = WorkState::running;
        --queuedCount_;
        ++runningCount_;
        result.push_back(found->second.work);
    }
    return result;
}

core::Status AdaptiveTranscriptionScheduler::cancel(std::string_view workId) {
    std::lock_guard lock(mutex_);
    const auto found = entries_.find(workId);
    if (found == entries_.end())
        return std::unexpected(core::error("transcription_work_not_found",
                                           "The transcription work item does not exist."));
    if (found->second.state == WorkState::queued) {
        found->second.state = WorkState::cancelled;
        --queuedCount_;
        return {};
    }
    if (found->second.state == WorkState::running) {
        found->second.state = WorkState::cancelRequested;
        return {};
    }
    if (found->second.state == WorkState::cancelRequested ||
        found->second.state == WorkState::cancelled)
        return {};
    return std::unexpected(core::error("transcription_work_terminal",
                                       "Completed transcription work cannot be cancelled."));
}

core::Status
AdaptiveTranscriptionScheduler::finish(std::string_view workId, bool succeeded, bool retryable) {
    std::lock_guard lock(mutex_);
    const auto found = entries_.find(workId);
    if (found == entries_.end())
        return std::unexpected(core::error("transcription_work_not_found",
                                           "The transcription work item does not exist."));
    Entry& entry = found->second;
    if (entry.state == WorkState::cancelRequested) {
        entry.state = WorkState::cancelled;
        --runningCount_;
        return {};
    }
    if (entry.state != WorkState::running)
        return std::unexpected(core::error("transcription_work_state_invalid",
                                           "Only a running work item can be finished."));
    --runningCount_;
    if (succeeded) {
        entry.state = WorkState::completed;
    } else if (retryable) {
        entry.state = WorkState::queued;
        ++entry.attempts;
        entry.enqueueOrder = nextEnqueueOrder_++;
        ready_.push({entry.work.priority, entry.enqueueOrder, entry.work.id});
        ++queuedCount_;
    } else {
        entry.state = WorkState::failed;
    }
    return {};
}

bool AdaptiveTranscriptionScheduler::cancellationRequested(std::string_view workId) const {
    std::lock_guard lock(mutex_);
    const auto found = entries_.find(workId);
    return found == entries_.end() || found->second.state == WorkState::cancelRequested ||
           found->second.state == WorkState::cancelled;
}

std::vector<archive::Record> AdaptiveTranscriptionScheduler::checkpointRecords() const {
    std::lock_guard lock(mutex_);
    std::vector<archive::Record> records;
    records.reserve(entries_.size());
    for (const auto& [id, entry] : entries_) {
        std::string state;
        switch (entry.state) {
            case WorkState::queued:
                state = "queued";
                break;
            case WorkState::running:
                state = "running";
                break;
            case WorkState::cancelRequested:
                state = "cancel-requested";
                break;
            case WorkState::completed:
                state = "completed";
                break;
            case WorkState::failed:
                state = "failed";
                break;
            case WorkState::cancelled:
                state = "cancelled";
                break;
        }
        archive::Record record;
        record.type = archive::RecordType::AiJob;
        record.id = checkpointUuid(id);
        record.fields = {
            {"record_role",   "transcription-checkpoint"               },
            {"work_id",       id                                       },
            {"session_id",    entry.work.sessionId                     },
            {"track_id",      entry.work.trackId                       },
            {"start_time_us", std::to_string(entry.work.startTimeUs)   },
            {"end_time_us",   std::to_string(entry.work.endTimeUs)     },
            {"priority",      std::to_string(entry.work.priority)      },
            {"provisional",   entry.work.provisional ? "true" : "false"},
            {"state",         state                                    },
            {"attempts",      std::to_string(entry.attempts)           }
        };
        records.push_back(std::move(record));
    }
    return records;
}

core::Status AdaptiveTranscriptionScheduler::saveCheckpoints(archive::Archive& archive) const {
    auto records = checkpointRecords();
    if (records.empty())
        return {};
    return archive.putMany(std::move(records));
}

std::uint32_t AdaptiveTranscriptionScheduler::workerLimit() const {
    std::lock_guard lock(mutex_);
    return calculateWorkerLimit(budget_);
}

std::size_t AdaptiveTranscriptionScheduler::queuedCount() const {
    std::lock_guard lock(mutex_);
    return queuedCount_;
}

std::size_t AdaptiveTranscriptionScheduler::runningCount() const {
    std::lock_guard lock(mutex_);
    return runningCount_;
}

bool AdaptiveTranscriptionScheduler::QueueItemCompare::operator()(
    const QueueItem& left,
    const QueueItem& right) const noexcept {
    if (left.priority != right.priority)
        return left.priority < right.priority;
    return left.enqueueOrder > right.enqueueOrder;
}

std::uint32_t
AdaptiveTranscriptionScheduler::calculateWorkerLimit(const TranscriptionBudget& budget) noexcept {
    const std::uint32_t cpuWorkers = budget.hardwareThreads > budget.reservedThreads
                                         ? budget.hardwareThreads - budget.reservedThreads
                                         : 1;
    std::uint32_t workerLimit =
        budget.maximumWorkers == 0 ? cpuWorkers : std::min(cpuWorkers, budget.maximumWorkers);
    if (budget.availableMemoryBytes == 0 || budget.modelMemoryBytes == 0)
        return 1;
    const std::uint64_t memoryWorkers = budget.availableMemoryBytes / budget.modelMemoryBytes;
    if (memoryWorkers == 0)
        return 0;
    return static_cast<std::uint32_t>(std::min<std::uint64_t>(workerLimit, memoryWorkers));
}

IncrementalWaveformPyramid::IncrementalWaveformPyramid(std::uint32_t baseWindowSamples)
    : baseWindowSamples_(std::max<std::uint32_t>(baseWindowSamples, 1))
    , levels_(1) {}

core::Status IncrementalWaveformPyramid::appendPcm16Le(std::span<const std::byte> pcmBytes) {
    if (finished_)
        return std::unexpected(core::error("waveform_already_finished",
                                           "No more samples can be appended after finalization."));
    if (pcmBytes.size() % 2 != 0)
        return std::unexpected(
            core::error("waveform_pcm_invalid", "16-bit PCM data must contain complete samples."));
    for (std::size_t offset = 0; offset < pcmBytes.size(); offset += 2) {
        const std::uint16_t bits = static_cast<std::uint16_t>(
            std::to_integer<std::uint8_t>(pcmBytes[offset]) |
            (static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(pcmBytes[offset + 1]))
             << 8U));
        pendingSamples_.push_back(static_cast<std::int16_t>(bits));
        ++sampleCount_;
        if (pendingSamples_.size() == baseWindowSamples_) {
            const auto [minimum, maximum] =
                std::minmax_element(pendingSamples_.begin(), pendingSamples_.end());
            appendBasePeak({*minimum, *maximum});
            pendingSamples_.clear();
        }
    }
    return {};
}

core::Status IncrementalWaveformPyramid::finish() {
    if (finished_)
        return {};
    if (!pendingSamples_.empty()) {
        const auto [minimum, maximum] =
            std::minmax_element(pendingSamples_.begin(), pendingSamples_.end());
        appendBasePeak({*minimum, *maximum});
        pendingSamples_.clear();
    }
    finished_ = true;
    return {};
}

std::vector<WaveformPeak> IncrementalWaveformPyramid::query(std::size_t level,
                                                            std::size_t firstBucket,
                                                            std::size_t requestedCount) const {
    if (level >= levels_.size() || firstBucket >= levels_[level].size() || requestedCount == 0)
        return {};
    const std::size_t end =
        firstBucket + std::min(requestedCount, levels_[level].size() - firstBucket);
    return {levels_[level].begin() + static_cast<std::ptrdiff_t>(firstBucket),
            levels_[level].begin() + static_cast<std::ptrdiff_t>(end)};
}

std::size_t IncrementalWaveformPyramid::bucketCount(std::size_t level) const noexcept {
    return level < levels_.size() ? levels_[level].size() : 0;
}

std::uint64_t IncrementalWaveformPyramid::sampleCount() const noexcept {
    return sampleCount_;
}

std::uint32_t IncrementalWaveformPyramid::baseWindowSamples() const noexcept {
    return baseWindowSamples_;
}

archive::Record IncrementalWaveformPyramid::toArchiveRecord(const archive::Uuid& sessionId,
                                                            const archive::Uuid& trackId) const {
    archive::Record record;
    record.type = archive::RecordType::AssetMetadata;
    record.id = archive::randomUuid();
    record.fields = {
        {"record_role",         "waveform-pyramid"                },
        {"session_id",          uuidKey(sessionId)                },
        {"track_id",            uuidKey(trackId)                  },
        {"algorithm",           "incremental-minmax-v1"           },
        {"base_window_samples", std::to_string(baseWindowSamples_)},
        {"sample_count",        std::to_string(sampleCount_)      },
        {"level_count",         std::to_string(levels_.size())    },
        {"finalized",           finished_ ? "true" : "false"      }
    };
    appendU32(record.blob, baseWindowSamples_);
    appendU64(record.blob, sampleCount_);
    appendU32(record.blob, static_cast<std::uint32_t>(levels_.size()));
    for (const auto& level : levels_) {
        appendU64(record.blob, level.size());
        for (const auto& peak : level) {
            appendI16(record.blob, peak.minimum);
            appendI16(record.blob, peak.maximum);
        }
    }
    return record;
}

void IncrementalWaveformPyramid::appendBasePeak(WaveformPeak peak) {
    levels_[0].push_back(peak);
    std::size_t level = 0;
    while (levels_[level].size() % 2 == 0) {
        const auto& current = levels_[level];
        const WaveformPeak combined{
            std::min(current[current.size() - 2].minimum, current[current.size() - 1].minimum),
            std::max(current[current.size() - 2].maximum, current[current.size() - 1].maximum)};
        if (levels_.size() == level + 1)
            levels_.emplace_back();
        levels_[level + 1].push_back(combined);
        ++level;
    }
}

SparseTimestampSeekIndex::SparseTimestampSeekIndex(std::int64_t intervalUs)
    : intervalUs_(std::max<std::int64_t>(intervalUs, 1)) {}

core::Status SparseTimestampSeekIndex::add(std::int64_t timeUs, std::uint64_t byteOffset) {
    if (timeUs < 0)
        return std::unexpected(
            core::error("seek_index_time_invalid", "Seek timestamps must be non-negative."));
    if (entries_.empty()) {
        entries_.push_back({timeUs, byteOffset});
        return {};
    }
    const auto& last = entries_.back();
    if (timeUs < last.timeUs || byteOffset < last.byteOffset)
        return std::unexpected(core::error("seek_index_order_invalid",
                                           "Seek index timestamps and offsets must be monotonic."));
    if (timeUs == last.timeUs) {
        entries_.back().byteOffset = byteOffset;
        return {};
    }
    if (timeUs - last.timeUs >= intervalUs_)
        entries_.push_back({timeUs, byteOffset});
    return {};
}

std::optional<TimestampOffset> SparseTimestampSeekIndex::atOrBefore(std::int64_t timeUs) const {
    const auto found = std::upper_bound(entries_.begin(),
                                        entries_.end(),
                                        timeUs,
                                        [](std::int64_t value, const TimestampOffset& entry) {
                                            return value < entry.timeUs;
                                        });
    return found == entries_.begin() ? std::nullopt : *std::prev(found);
}

std::optional<TimestampOffset> SparseTimestampSeekIndex::atOrAfter(std::int64_t timeUs) const {
    const auto found = std::lower_bound(entries_.begin(),
                                        entries_.end(),
                                        timeUs,
                                        [](const TimestampOffset& entry, std::int64_t value) {
                                            return entry.timeUs < value;
                                        });
    return found == entries_.end() ? std::nullopt : *found;
}

const std::vector<TimestampOffset>& SparseTimestampSeekIndex::entries() const noexcept {
    return entries_;
}

archive::Record SparseTimestampSeekIndex::toArchiveRecord(const archive::Uuid& sessionId,
                                                          const archive::Uuid& trackId) const {
    archive::Record record;
    record.type = archive::RecordType::AssetMetadata;
    record.id = archive::randomUuid();
    record.fields = {
        {"record_role", "sparse-timestamp-seek-index"  },
        {"session_id",  uuidKey(sessionId)             },
        {"track_id",    uuidKey(trackId)               },
        {"algorithm",   "stsi-v1"                      },
        {"interval_us", std::to_string(intervalUs_)    },
        {"entry_count", std::to_string(entries_.size())}
    };
    appendU32(record.blob, 1);
    appendU64(record.blob, entries_.size());
    for (const auto& entry : entries_) {
        appendU64(record.blob, static_cast<std::uint64_t>(entry.timeUs));
        appendU64(record.blob, entry.byteOffset);
    }
    return record;
}

core::Result<archive::Record>
makeContentAddressedAssetMetadata(std::string_view fileName,
                                  std::string_view mediaType,
                                  std::string_view sourcePath,
                                  std::span<const std::byte> content) {
    if (fileName.empty() || mediaType.empty())
        return std::unexpected(core::error("asset_metadata_invalid",
                                           "Imported assets need a file name and media type."));
    if (content.size() > archive::kMaximumRecordPayload)
        return std::unexpected(
            core::error("asset_too_large", "Asset content exceeds the archive record size limit."));
    archive::Record record;
    record.type = archive::RecordType::AssetMetadata;
    record.id = archive::randomUuid();
    record.fields = {
        {"record_role",    "asset-metadata"              },
        {"file_name",      std::string(fileName)         },
        {"media_type",     std::string(mediaType)        },
        {"source_path",    std::string(sourcePath)       },
        {"content_sha256", domain::hexHash(content)      },
        {"byte_count",     std::to_string(content.size())},
        {"blob_encoding",  "raw-content-addressed"       }
    };
    return record;
}

} // namespace tutorux::intelligence

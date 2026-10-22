// Direct unit coverage for the intelligence pipeline's real data structures.
#include "tutorux/archive/archive.hpp"
#include "tutorux/intelligence/pipeline.hpp"

#include <array>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "pipeline units: " << label << '\n';
    return false;
}

template <typename T>
bool expectError(const tutorux::core::Result<T>& result, std::string_view label) {
    if (result)
        return expect(false, label);
    return true;
}

std::vector<std::byte> pcm16(std::initializer_list<std::int16_t> samples) {
    std::vector<std::byte> bytes;
    bytes.reserve(samples.size() * 2);
    for (const std::int16_t sample : samples) {
        bytes.push_back(static_cast<std::byte>(static_cast<std::uint16_t>(sample) & 0xFFU));
        bytes.push_back(static_cast<std::byte>((static_cast<std::uint16_t>(sample) >> 8U) & 0xFFU));
    }
    return bytes;
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    // Transcript alignment engine.
    {
        intelligence::TranscriptAlignmentEngine engine;
        intelligence::TranscriptCue first;
        first.id = "cue-1";
        first.startTimeUs = 1'000'000;
        first.endTimeUs = 2'000'000;
        first.text = "First";
        auto inserted = engine.upsert(first);
        okay &= expect(inserted && inserted->inserted, "first cue was not inserted");
        okay &= expect(engine.size() == 1 && engine.find("cue-1").has_value(),
                       "cue lookup failed");

        first.endTimeUs = 2'500'000;
        first.text = "First revised";
        auto updated = engine.upsert(first);
        okay &= expect(updated && !updated->inserted && updated->previousRevision == 1,
                       "cue update was not tracked");
        okay &= expect(!updated->neighboringCueIds.empty(), "updated cue lost neighbors");

        intelligence::TranscriptCue second;
        second.id = "cue-2";
        second.startTimeUs = 3'000'000;
        second.endTimeUs = 4'000'000;
        second.text = "Second";
        okay &= expect(engine.upsert(second).has_value(), "second cue insertion failed");
        auto overlapping = engine.overlapping(2'000'000, 3'500'000, 500'000);
        okay &= expect(overlapping.size() == 2, "overlap tolerance is wrong");
        auto revised = engine.reviseText("cue-2", "Second revised", true);
        okay &= expect(revised && revised->neighboringCueIds.size() <= 2,
                       "cue text revision failed");
        auto missingRevision = engine.reviseText("missing", "text", false);
        okay &= expectError(missingRevision, "missing cue revision succeeded");
        okay &= expect(!engine.erase("missing"), "missing cue erase succeeded");
        okay &= expect(static_cast<bool>(engine.erase("cue-2")), "cue erase failed");
        okay &= expect(engine.overlapping(-1, 10).empty(), "negative overlap accepted");

        intelligence::TranscriptCue invalid;
        okay &= expectError(engine.upsert(invalid), "invalid cue accepted");
    }

    // Evidence graph.
    {
        intelligence::EvidenceAwareInstructionGraph graph;
        intelligence::EvidenceNode first;
        first.id = archive::randomUuid();
        first.sessionId = "session-1";
        first.kind = "instruction";
        first.statement = "Use a number line.";
        first.confidence = 0.9;
        okay &= expect(graph.addNode(first).has_value(), "valid evidence node rejected");
        intelligence::EvidenceNode second = first;
        second.id = archive::randomUuid();
        second.kind = "recommendation";
        second.statement = "Try a worked example.";
        okay &= expect(graph.addNode(second).has_value(), "second evidence node rejected");

        intelligence::EvidenceEdge edge;
        edge.id = archive::randomUuid();
        edge.sessionId = "session-1";
        edge.sourceId = archive::uuidToString(first.id);
        edge.targetId = archive::uuidToString(second.id);
        edge.relationship = "supports";
        edge.confidence = 0.8;
        okay &= expect(graph.addEdge(edge).has_value(), "valid evidence edge rejected");

        intelligence::EvidenceEdge contradiction = edge;
        contradiction.id = archive::randomUuid();
        contradiction.relationship = "contradicts";
        okay &= expect(graph.addEdge(contradiction).has_value(),
                       "contradiction edge rejected");
        okay &= expect(graph.validate().has_value(), "valid graph failed validation");
        okay &= expect(graph.contradictions().size() == 1,
                       "contradiction pair was not reported");
        okay &= expect(graph.nodesForSession("session-1").size() == 2,
                       "session node filter failed");
        okay &= expect(graph.edgesForNode(archive::uuidToString(first.id)).size() == 2,
                       "node edge filter failed");
        auto records = graph.toArchiveRecords();
        okay &= expect(records.size() == 4, "graph archive serialization lost records");

        intelligence::EvidenceNode invalid = first;
        invalid.id = archive::randomUuid();
        invalid.statement.clear();
        okay &= expect(!graph.addNode(invalid), "empty evidence statement accepted");
        invalid = first;
        invalid.id = archive::randomUuid();
        invalid.confidence = 2.0;
        okay &= expect(!graph.addNode(invalid), "out-of-range confidence accepted");

        intelligence::EvidenceEdge badEdge = edge;
        badEdge.id = archive::randomUuid();
        badEdge.relationship = "unknown";
        okay &= expect(!graph.addEdge(badEdge), "unknown relationship accepted");
        intelligence::EvidenceAwareInstructionGraph incomplete;
        okay &= expect(incomplete.addNode(first).has_value(),
                       "incomplete graph node rejected");
        intelligence::EvidenceEdge missingTarget = edge;
        missingTarget.id = archive::randomUuid();
        missingTarget.targetId = archive::uuidToString(archive::randomUuid());
        okay &= expect(incomplete.addEdge(missingTarget).has_value(),
                       "incomplete graph edge rejected before validation");
        okay &= expect(!incomplete.validate(), "missing edge target passed validation");
        okay &= expect(graph.removeNode(archive::uuidToString(first.id)).has_value(),
                       "node removal failed");
        okay &= expect(!graph.removeNode("missing"), "missing node removal succeeded");
    }

    // Context packing.
    {
        okay &= expect(intelligence::estimateTokenCount("") == 0,
                       "empty token estimate is wrong");
        okay &= expect(intelligence::estimateTokenCount("abcd") == 2,
                       "token estimate is wrong");

        intelligence::ContextPackOptions options;
        options.tokenBudget = 20;
        options.maximumItemTokens = 10;
        std::vector<intelligence::ContextCandidate> candidates;
        intelligence::ContextCandidate required;
        required.sourceId = "required";
        required.sourceKind = "annotation";
        required.content = "Required content";
        required.required = true;
        required.priority = intelligence::EvidencePriority::critical;
        candidates.push_back(required);
        intelligence::ContextCandidate optional;
        optional.sourceId = "optional";
        optional.sourceKind = "transcript";
        optional.content = "Optional content that is long enough to be split";
        optional.priority = intelligence::EvidencePriority::background;
        candidates.push_back(optional);
        auto pack = intelligence::packContext(std::move(candidates), options);
        okay &= expect(pack && !pack->included.empty(),
                       "context packing produced no items");
        if (pack) {
            okay &= expect(pack->usedTokens <= pack->tokenBudget,
                           "context pack exceeded its budget");
            okay &= expect(!pack->complete || pack->omitted.empty(),
                           "complete context pack contains omissions");
        }
        options.tokenBudget = 0;
        okay &= expectError(intelligence::packContext({}, options),
                            "zero token budget accepted");
        options.tokenBudget = 10;
        options.maximumItemTokens = 0;
        okay &= expect(intelligence::packContext({}, options).has_value(),
                       "zero item budget was not normalized to the token budget");
    }

    // Guide dependency invalidation.
    {
        intelligence::IncrementalGuideDependencyEngine engine;
        intelligence::GuideDependency dependency{"guide", "section", "block", "source", "hash"};
        okay &= expect(engine.registerDependency(dependency).has_value(),
                       "dependency registration failed");
        okay &= expect(engine.dependenciesForSource("source").size() == 1,
                       "dependency lookup failed");
        okay &= expect(engine.dependenciesForBlock("guide", "block").size() == 1,
                       "block dependency lookup failed");
        okay &= expect(engine.invalidateSource("source", "hash").empty(),
                       "unchanged source invalidated");
        okay &= expect(engine.invalidateSource("source", "new-hash").size() == 1,
                       "changed source was not invalidated");
        std::map<std::string, std::string, std::less<>> changes{{"source", "another"}};
        okay &= expect(engine.invalidateSources(changes).size() == 1,
                       "batch source invalidation failed");
        intelligence::GuideDependency invalid{"", "section", "block", "source", "hash"};
        okay &= expect(!engine.registerDependency(invalid),
                       "invalid dependency accepted");
    }

    // Transcription planning and scheduler.
    {
        intelligence::TranscriptionBudget budget;
        budget.hardwareThreads = 4;
        budget.reservedThreads = 1;
        budget.availableMemoryBytes = 1'000'000'000;
        budget.modelMemoryBytes = 200'000'000;
        budget.realTimeFactor = 1.0;
        budget.maximumWorkers = 4;
        budget.targetChunkDurationUs = 10'000'000;
        auto plan = intelligence::planTranscription("session", "track", 25'000'000, budget);
        okay &= expect(plan && plan->workerCount >= 1 && !plan->work.empty(),
                       "transcription planning failed");
        okay &= expectError(
            intelligence::planTranscription("", "track", 10, budget),
            "empty session plan accepted");
        budget.realTimeFactor = 0.0;
        okay &= expectError(
            intelligence::planTranscription("session", "track", 10, budget),
            "zero realtime factor plan accepted");

        budget.realTimeFactor = 1.0;
        intelligence::AdaptiveTranscriptionScheduler scheduler(budget);
        intelligence::TranscriptionWork work{"work-1", "session", "track", 0, 10, 5, true};
        okay &= expect(scheduler.enqueue(work).has_value(), "work enqueue failed");
        okay &= expect(!scheduler.enqueue(work), "duplicate work accepted");
        intelligence::TranscriptionWork invalid{"", "session", "track", 0, 10, 0, false};
        okay &= expect(!scheduler.enqueue(invalid), "invalid work accepted");
        auto ready = scheduler.takeReady();
        okay &= expect(ready.size() == 1 && scheduler.runningCount() == 1,
                       "scheduler did not start work");
        okay &= expect(scheduler.cancel("work-1").has_value(),
                       "running work cancellation failed");
        okay &= expect(scheduler.cancellationRequested("work-1"),
                       "cancellation was not observable");
        okay &= expect(scheduler.finish("work-1", false, true).has_value(),
                       "cancelled work finish failed");
        auto checkpoints = scheduler.checkpointRecords();
        okay &= expect(checkpoints.size() == 1, "scheduler checkpoint missing");

        auto directory =
            std::filesystem::temp_directory_path() /
            ("tutorux-pipeline-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::error_code errorCode;
        std::filesystem::create_directories(directory, errorCode);
        auto archive = archive::Archive::create(directory / "pipeline.tux", "Pipeline");
        okay &= expect(archive.has_value(), "checkpoint archive creation failed");
        if (archive) {
            okay &= expect(scheduler.saveCheckpoints(*archive).has_value(),
                           "checkpoint persistence failed");
        }
        std::filesystem::remove_all(directory, errorCode);
    }

    // Incremental waveform pyramid.
    {
        intelligence::IncrementalWaveformPyramid pyramid(2);
        auto samples = pcm16({-100, 100, -200, 200, 300, -300});
        okay &= expect(pyramid.appendPcm16Le(samples).has_value(),
                       "waveform append failed");
        okay &= expect(pyramid.sampleCount() == 6, "waveform sample count is wrong");
        okay &= expect(pyramid.finish().has_value(), "waveform finish failed");
        okay &= expect(!pyramid.appendPcm16Le(samples), "append after finish accepted");
        okay &= expect(pyramid.bucketCount(0) > 0, "waveform level missing");
        okay &= expect(pyramid.query(0, 0, 1).size() == 1, "waveform query failed");
        okay &= expect(pyramid.query(99, 0, 1).empty(), "invalid waveform level returned data");
        auto record = pyramid.toArchiveRecord(archive::randomUuid(), archive::randomUuid());
        okay &= expect(!record.blob.empty(), "waveform record blob is empty");
        std::array<std::byte, 3> odd{};
        okay &= expect(!pyramid.appendPcm16Le(odd), "odd PCM append accepted");
    }

    // Sparse timestamp seek index.
    {
        intelligence::SparseTimestampSeekIndex index(1'000'000);
        okay &= expect(index.add(0, 0).has_value(), "seek anchor add failed");
        okay &= expect(index.add(1'000'000, 100).has_value(), "seek anchor add failed");
        okay &= expect(index.add(2'000'000, 200).has_value(), "seek anchor add failed");
        okay &= expect(!index.add(-1, 0), "negative seek time accepted");
        okay &= expect(!index.add(1, 50), "out-of-order seek anchor accepted");
        auto before = index.atOrBefore(1'500'000);
        okay &= expect(before && before->timeUs == 1'000'000,
                       "atOrBefore returned the wrong anchor");
        auto after = index.atOrAfter(1'500'000);
        okay &= expect(after && after->timeUs == 2'000'000,
                       "atOrAfter returned the wrong anchor");
        okay &= expect(!index.atOrBefore(-1).has_value(), "negative atOrBefore returned data");
        okay &= expect(!index.atOrAfter(5'000'000).has_value(), "past-end atOrAfter returned data");
        auto record = index.toArchiveRecord(archive::randomUuid(), archive::randomUuid());
        okay &= expect(!record.blob.empty(), "seek index record blob is empty");
    }

    // Content-addressed asset metadata.
    {
        const std::string content = "asset bytes";
        std::vector<std::byte> bytes;
        for (const char character : content)
            bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
        auto record = intelligence::makeContentAddressedAssetMetadata(
            "worksheet.txt", "text/plain", "worksheet.txt", bytes);
        okay &= expect(record && !record->fields.empty(),
                       "content-addressed asset metadata failed");
        auto invalid = intelligence::makeContentAddressedAssetMetadata(
            "", "text/plain", "worksheet.txt", bytes);
        okay &= expectError(invalid, "empty asset file name accepted");
    }

    return okay ? 0 : 1;
}

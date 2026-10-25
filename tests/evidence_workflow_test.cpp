#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

const std::string* jsonString(const tutorux::command::JsonValue& value, std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return nullptr;
    const auto found = object->find(key);
    return found == object->end() ? nullptr : found->second.asString();
}

tutorux::core::Result<tutorux::command::JsonValue> dispatchJson(const std::filesystem::path& archivePath, std::vector<std::string> command,
                                                                bool allowNonzeroExit = false) {
    std::vector<std::string> arguments{"--archive", archivePath.string(), "--json"};
    arguments.insert(arguments.end(), command.begin(), command.end());
    auto result = tutorux::command::dispatch(arguments);
    if (!result)
        return std::unexpected(result.error());
    if (result->exitCode != 0 && !allowNonzeroExit) {
        return std::unexpected(tutorux::core::error("evidence_workflow_command_failed", result->output));
    }
    return tutorux::command::parseJson(result->output);
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::temp_directory_path() / ("tutorux-evidence-workflow-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode) {
        std::cerr << "Unable to create the temporary directory: " << errorCode.message() << '\n';
        return 1;
    }

    const auto archivePath = temporary.path / "workspace.tux";
    const auto sessionId = archive::randomUuid();
    const auto segmentId = archive::randomUuid();
    const std::string sessionIdText = archive::uuidToString(sessionId);
    const std::string segmentIdText = archive::uuidToString(segmentId);
    {
        auto created = archive::Archive::create(archivePath, "Evidence workflow test");
        if (!created) {
            std::cerr << "Unable to create the archive: " << created.error().message << '\n';
            return 1;
        }
        domain::Session session;
        session.id = sessionId;
        session.studentId = "anonymous";
        session.subject = "Mathematics";
        session.title = "Fractions";
        if (auto status = created->put(domain::toRecord(session)); !status) {
            std::cerr << "Unable to create the session: " << status.error().message << '\n';
            return 1;
        }
        archive::Record segment;
        segment.type = archive::RecordType::TranscriptSegment;
        segment.id = segmentId;
        segment.fields = {
            {"session_id", sessionIdText                   },
            {"text",       "Remember to compare fractions."},
        };
        if (auto status = created->put(std::move(segment)); !status) {
            std::cerr << "Unable to create the transcript segment: " << status.error().message << '\n';
            return 1;
        }
    }

    auto extracted = dispatchJson(archivePath, {"evidence", "extract", "--session", sessionIdText});
    const auto* candidates = extracted ? extracted->asArray() : nullptr;
    if (!candidates || candidates->size() != 1) {
        std::cerr << "Evidence extraction did not return one provisional instruction candidate.\n";
        return 1;
    }
    const command::JsonValue& candidate = candidates->front();
    const std::string* candidateId = jsonString(candidate, "id");
    const std::string* sourceRevision = jsonString(candidate, "source_segment_revision");
    const std::string* reviewState = jsonString(candidate, "verification_state");
    if (!candidateId || !sourceRevision || !reviewState || *reviewState != "needs-review" || jsonString(candidate, "type") == nullptr ||
        *jsonString(candidate, "type") != "explicit-instruction-candidate") {
        std::cerr << "Extracted evidence omitted its source revision or review-only state.\n";
        return 1;
    }

    auto approved = command::dispatch({"--archive", archivePath.string(), "evidence", "approve", *candidateId});
    if (!approved || approved->exitCode != 0) {
        std::cerr << "Current evidence could not be approved: " << (approved ? approved->output : approved.error().message) << '\n';
        return 1;
    }
    auto verified = dispatchJson(archivePath, {"evidence", "verify", *candidateId});
    if (!verified || !jsonString(*verified, "source_valid") || *jsonString(*verified, "source_valid") != "true") {
        std::cerr << "Evidence with a current source revision did not verify.\n";
        return 1;
    }

    {
        auto writable = archive::Archive::open(archivePath, true);
        if (!writable) {
            std::cerr << "Unable to reopen the archive for transcript editing: " << writable.error().message << '\n';
            return 1;
        }
        auto segment = writable->get(archive::RecordType::TranscriptSegment, segmentId);
        if (!segment || !*segment) {
            std::cerr << "The transcript source disappeared before editing.\n";
            return 1;
        }
        (**segment).fields["text"] = "Make sure to compare the numerators.";
        if (auto status = writable->put(**segment); !status) {
            std::cerr << "Unable to revise the transcript source: " << status.error().message << '\n';
            return 1;
        }
    }

    auto staleVerification = dispatchJson(archivePath, {"evidence", "verify", *candidateId}, true);
    if (!staleVerification || !jsonString(*staleVerification, "source_valid") ||
        *jsonString(*staleVerification, "source_valid") != "false") {
        std::cerr << "Evidence remained valid after its transcript source changed.\n";
        return 1;
    }
    auto staleApproval = command::dispatch({"--archive", archivePath.string(), "evidence", "approve", *candidateId});
    if (staleApproval && staleApproval->exitCode == 0) {
        std::cerr << "Stale transcript evidence was approved.\n";
        return 1;
    }

    auto reextracted = dispatchJson(archivePath, {"evidence", "extract", "--session", sessionIdText});
    const auto* currentCandidates = reextracted ? reextracted->asArray() : nullptr;
    if (!currentCandidates || currentCandidates->size() != 1) {
        std::cerr << "A revised transcript source did not create a new evidence candidate.\n";
        return 1;
    }
    const std::string* currentCandidateId = jsonString(currentCandidates->front(), "id");
    const std::string* currentSourceRevision = jsonString(currentCandidates->front(), "source_segment_revision");
    if (!currentCandidateId || *currentCandidateId == *candidateId || !currentSourceRevision || *currentSourceRevision == *sourceRevision) {
        std::cerr << "The new evidence candidate did not capture the revised transcript revision.\n";
        return 1;
    }
    auto currentVerification = dispatchJson(archivePath, {"evidence", "verify", *currentCandidateId});
    if (!currentVerification || !jsonString(*currentVerification, "source_valid") ||
        *jsonString(*currentVerification, "source_valid") != "true") {
        std::cerr << "Evidence for the revised transcript did not verify.\n";
        return 1;
    }

    auto generatedGuide = command::dispatch({"--archive", archivePath.string(), "guide", "generate", "--session", sessionIdText});
    if (!generatedGuide || generatedGuide->exitCode != 0) {
        std::cerr << "Guide generation failed after the source changed: "
                  << (generatedGuide ? generatedGuide->output : generatedGuide.error().message) << '\n';
        return 1;
    }
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened) {
            std::cerr << "Unable to reopen the archive to inspect the generated guide.\n";
            return 1;
        }
        auto guides = opened->list(archive::RecordType::Guide);
        if (!guides || guides->empty()) {
            std::cerr << "Guide generation did not persist a guide.\n";
            return 1;
        }
        for (const auto& record : *guides) {
            auto guide = domain::guideFromRecord(record);
            if (!guide) {
                std::cerr << "Unable to read a generated guide: " << guide.error().message << '\n';
                return 1;
            }
            for (const auto& section : guide->sections) {
                for (const auto& block : section.blocks) {
                    if (std::find(block.sourceIds.begin(), block.sourceIds.end(), *candidateId) != block.sourceIds.end()) {
                        std::cerr << "A generated guide cited stale transcript evidence.\n";
                        return 1;
                    }
                }
            }
        }
    }
    auto context = dispatchJson(archivePath, {"ai", "context", "--session", sessionIdText});
    const auto* contextObject = context ? context->asObject() : nullptr;
    const std::string* includedText = nullptr;
    if (contextObject) {
        const auto includedField = contextObject->find("included");
        if (includedField != contextObject->end())
            includedText = includedField->second.asString();
    }
    if (!includedText) {
        std::cerr << "AI context preview did not return its included-source list.\n";
        return 1;
    }
    auto includedValue = command::parseJson(*includedText);
    const auto* included = includedValue ? includedValue->asArray() : nullptr;
    if (!included) {
        std::cerr << "AI context preview did not return its included-source list.\n";
        return 1;
    }
    for (const auto& item : *included) {
        const std::string* sourceId = jsonString(item, "source_id");
        if (sourceId && *sourceId == *candidateId) {
            std::cerr << "Stale transcript evidence was included in AI context.\n";
            return 1;
        }
    }
    const bool includedCurrentEvidence = std::any_of(included->begin(), included->end(), [&](const auto& item) {
        const std::string* sourceId = jsonString(item, "source_id");
        return sourceId && *sourceId == *currentCandidateId;
    });
    if (!includedCurrentEvidence) {
        std::cerr << "AI context omitted evidence with a valid current transcript source.\n";
        return 1;
    }

    auto createdFirst = dispatchJson(archivePath, {"evidence", "create", "--session", sessionIdText,
                                                    "--source-segment", segmentIdText,
                                                    "--title", "Tutor observation", "--type", "observation",
                                                    "--content", "The learner explained the common denominator."});
    const std::string* firstId = createdFirst ? jsonString(*createdFirst, "id") : nullptr;
    if (!firstId) {
        std::cerr << "The GUI-backed evidence create operation did not return a saved item.\n";
        return 1;
    }
    if (!jsonString(*createdFirst, "source_segment_ids") ||
        *jsonString(*createdFirst, "source_segment_ids") != segmentIdText ||
        !jsonString(*createdFirst, "source_segment_revision")) {
        std::cerr << "Created evidence did not retain the selected transcript source revision.\n";
        return 1;
    }
    auto tutorEvidenceApproval = command::dispatch({"--archive", archivePath.string(), "evidence", "approve", *firstId});
    if (!tutorEvidenceApproval || tutorEvidenceApproval->exitCode != 0) {
        std::cerr << "Evidence created from a current transcript source could not be approved.\n";
        return 1;
    }
    auto createdSecond = dispatchJson(archivePath, {"evidence", "create", "--session", sessionIdText,
                                                     "--source-segment", segmentIdText,
                                                     "--title", "Tutor follow-up", "--type", "follow-up",
                                                     "--content", "Ask the learner to solve one independently."});
    const std::string* secondId = createdSecond ? jsonString(*createdSecond, "id") : nullptr;
    if (!secondId || *secondId == *firstId) {
        std::cerr << "A second evidence item could not be created in the same session.\n";
        return 1;
    }
    auto updated = dispatchJson(archivePath, {"evidence", "update", *firstId,
                                               "--title", "Revised tutor observation",
                                               "--content", "The learner solved a fraction example independently."});
    if (!updated || !jsonString(*updated, "title") || *jsonString(*updated, "title") != "Revised tutor observation" ||
        !jsonString(*updated, "verification_state") || *jsonString(*updated, "verification_state") != "needs-review") {
        std::cerr << "Evidence edits did not persist or return the changed item to review.\n";
        return 1;
    }
    auto linked = dispatchJson(archivePath, {"evidence", "link", "--from", *firstId, "--to", *secondId,
                                             "--relationship", "supports"});
    const std::string* edgeId = linked ? jsonString(*linked, "id") : nullptr;
    if (!edgeId) {
        std::cerr << "Evidence link creation failed.\n";
        return 1;
    }
    auto edgeList = dispatchJson(archivePath, {"evidence", "edges", "--session", sessionIdText});
    const auto* edgeRows = edgeList ? edgeList->asArray() : nullptr;
    if (!edgeRows || edgeRows->size() != 1 || !jsonString(edgeRows->front(), "from_title") ||
        *jsonString(edgeRows->front(), "from_title") != "Revised tutor observation") {
        std::cerr << "The session evidence link list omitted readable endpoints.\n";
        return 1;
    }
    auto removedLink = dispatchJson(archivePath, {"evidence", "unlink", *edgeId});
    if (!removedLink || !jsonString(*removedLink, "_deleted") || *jsonString(*removedLink, "_deleted") != "true") {
        std::cerr << "Removing an evidence link did not move it into recoverable Trash.\n";
        return 1;
    }
    auto relinked = dispatchJson(archivePath, {"evidence", "link", "--from", *firstId, "--to", *secondId,
                                               "--relationship", "supports"});
    const std::string* restoredEdgeId = relinked ? jsonString(*relinked, "id") : nullptr;
    if (!restoredEdgeId) {
        std::cerr << "Evidence could not be linked again after removal.\n";
        return 1;
    }
    auto deletedEvidence = dispatchJson(archivePath, {"evidence", "delete", *firstId});
    if (!deletedEvidence || !jsonString(*deletedEvidence, "_deleted") || *jsonString(*deletedEvidence, "_deleted") != "true") {
        std::cerr << "Evidence removal did not move the item into Trash.\n";
        return 1;
    }
    auto restoredEvidence = dispatchJson(archivePath, {"evidence", "restore", *firstId});
    if (!restoredEvidence || !jsonString(*restoredEvidence, "id") || *jsonString(*restoredEvidence, "id") != *firstId) {
        std::cerr << "Evidence restore did not restore the selected item.\n";
        return 1;
    }
    auto restoredEdges = dispatchJson(archivePath, {"evidence", "edges", "--session", sessionIdText});
    const auto* restoredEdgeRows = restoredEdges ? restoredEdges->asArray() : nullptr;
    if (!restoredEdgeRows || restoredEdgeRows->size() != 1 ||
        !jsonString(restoredEdgeRows->front(), "id") || *jsonString(restoredEdgeRows->front(), "id") != *restoredEdgeId) {
        std::cerr << "Restoring evidence did not restore its grouped relationship.\n";
        return 1;
    }
    return 0;
}

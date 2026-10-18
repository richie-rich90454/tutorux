#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

int fail(std::string_view message) {
    std::cerr << message << '\n';
    return 1;
}

tutorux::core::Result<tutorux::command::CommandResult> run(const std::filesystem::path& archivePath, std::vector<std::string> arguments) {
    arguments.insert(arguments.begin(), archivePath.string());
    arguments.insert(arguments.begin(), "--archive");
    return tutorux::command::dispatch(arguments);
}

std::string field(const tutorux::command::JsonValue& value, std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return {};
    const auto found = object->find(key);
    if (found == object->end() || !found->second.asString())
        return {};
    return *found->second.asString();
}

} // namespace

int main() {
    using namespace tutorux;

    domain::StudentProgress codecFixture;
    codecFixture.skill = "Ratios: parts;whole";
    codecFixture.classification = domain::StudentProgressClassification::newlyObserved;
    codecFixture.evidenceSourceIds.push_back(archive::uuidToString(archive::randomUuid()));
    codecFixture.note = "Tutor saw a first attempt.\nNo prompting.";
    codecFixture.reviewedBy = "Tutor";
    codecFixture.reviewedAtUs = 1'800'000'000'000'000;
    auto decodedFixture = domain::decodeStudentProgress(domain::encodeStudentProgress({codecFixture}));
    if (!decodedFixture || decodedFixture->size() != 1 || decodedFixture->front().skill != codecFixture.skill ||
        decodedFixture->front().note != codecFixture.note || decodedFixture->front().evidenceSourceIds != codecFixture.evidenceSourceIds) {
        return fail("Student progress storage encoding did not round-trip its fields.");
    }
    if (domain::decodeStudentProgress("TP1;1;3:bad"))
        return fail("Malformed student progress storage was accepted.");

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto directory = std::filesystem::current_path() / ("tutorux-student-progress-" + std::to_string(uniqueSuffix));
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    if (errorCode)
        return fail("Unable to create the student progress fixture directory.");
    struct Cleanup final {
        std::filesystem::path path;
        ~Cleanup() {
            std::error_code ignored;
            std::filesystem::remove_all(path, ignored);
        }
    } cleanup{directory};
    const auto archivePath = directory / "progress.tux";
    {
        auto created = archive::Archive::create(archivePath, "Student progress test");
        if (!created)
            return fail(created.error().message);
    }

    auto createdStudent = run(archivePath, {"--json", "student", "create", "--name", "Alex", "--demonstrated-improvements",
                                            "Explains equivalent fractions", "--preferred-guide-template", "math-worked-examples"});
    if (!createdStudent || createdStudent->exitCode != 0)
        return fail("Student creation with learning-history fields failed.");
    auto createdJson = command::parseJson(createdStudent->output);
    if (!createdJson || field(*createdJson, "demonstrated_improvements") != "Explains equivalent fractions" ||
        field(*createdJson, "preferred_guide_template") != "math-worked-examples") {
        return fail("Created student did not preserve the new profile fields.");
    }
    const std::string studentId = field(*createdJson, "id");
    if (studentId.empty())
        return fail("Student creation did not return its ID.");

    auto updatedStudent = run(archivePath, {"--json", "student", "update", studentId, "--demonstrated-improvements",
                                            "Shows work independently", "--preferred-guide-template", "concise-review"});
    if (!updatedStudent || updatedStudent->exitCode != 0)
        return fail("Student learning-history update failed.");
    auto shownStudent = run(archivePath, {"--json", "student", "show", studentId});
    if (!shownStudent || shownStudent->exitCode != 0)
        return fail("Student show failed after profile update.");
    auto shownJson = command::parseJson(shownStudent->output);
    if (!shownJson || field(*shownJson, "demonstrated_improvements") != "Shows work independently" ||
        field(*shownJson, "preferred_guide_template") != "concise-review") {
        return fail("Student show did not expose the updated learning-history fields.");
    }

    const std::string secondStudentId = archive::uuidToString(archive::randomUuid());
    std::vector<std::string> evidenceIds;
    std::string sameSessionEvidenceId;
    std::string needsReviewEvidenceId;
    std::string foreignEvidenceId;
    {
        auto opened = archive::Archive::open(archivePath, true);
        if (!opened)
            return fail(opened.error().message);
        const auto parsedStudentId = archive::uuidFromString(studentId);
        const auto parsedSecondStudentId = archive::uuidFromString(secondStudentId);
        if (!parsedStudentId || !parsedSecondStudentId)
            return fail("Student UUID fixture is invalid.");

        domain::Student secondStudent;
        secondStudent.id = *parsedSecondStudentId;
        secondStudent.name = "Jordan";
        if (auto status = opened->put(domain::toRecord(secondStudent)); !status)
            return fail(status.error().message);

        const auto makeSession = [&](std::string student) {
            domain::Session session;
            session.id = archive::randomUuid();
            session.studentId = std::move(student);
            session.title = "Evidence session";
            return session;
        };
        domain::Session firstSession = makeSession(studentId);
        domain::Session secondSession = makeSession(studentId);
        domain::Session foreignSession = makeSession(secondStudentId);
        for (const auto* session : {&firstSession, &secondSession, &foreignSession}) {
            if (auto status = opened->put(domain::toRecord(*session)); !status)
                return fail(status.error().message);
        }

        const auto addEvidence = [&](const domain::Session& session, std::string_view state) {
            archive::Record evidence;
            evidence.type = archive::RecordType::EvidenceNode;
            evidence.id = archive::randomUuid();
            evidence.fields = {
                {"session_id",         archive::uuidToString(session.id)},
                {"student_id",         session.studentId                },
                {"verification_state", std::string(state)               },
                {"content",            "Learner explains the method"    },
            };
            if (auto status = opened->put(evidence); !status)
                return std::string{};
            return archive::uuidToString(evidence.id);
        };
        evidenceIds.push_back(addEvidence(firstSession, "human-verified"));
        evidenceIds.push_back(addEvidence(secondSession, "human-verified"));
        sameSessionEvidenceId = addEvidence(firstSession, "human-verified");
        needsReviewEvidenceId = addEvidence(secondSession, "needs-review");
        foreignEvidenceId = addEvidence(foreignSession, "human-verified");
        if (evidenceIds[0].empty() || evidenceIds[1].empty() || sameSessionEvidenceId.empty() || needsReviewEvidenceId.empty() ||
            foreignEvidenceId.empty()) {
            return fail("Unable to create the student progress evidence fixture.");
        }
    }

    const std::string crossSessionIds = evidenceIds[0] + "," + evidenceIds[1];
    auto reviewed = run(archivePath, {"--json", "student", "progress-review", studentId, "--skill", "Equivalent fractions",
                                      "--classification", "partial-improvement", "--evidence-ids", crossSessionIds, "--reviewed-by",
                                      "Tutor", "--note", "Uses a visual model"});
    if (!reviewed || reviewed->exitCode != 0)
        return fail("Human review with cross-session evidence failed.");
    auto reviewedJson = command::parseJson(reviewed->output);
    if (!reviewedJson || field(*reviewedJson, "classification") != "partial-improvement" ||
        field(*reviewedJson, "human_reviewed") != "true") {
        return fail("Reviewed progress did not return its classification and human-review state.");
    }

    auto recurring = run(archivePath, {"student", "progress-review", studentId, "--skill", "Algebra", "--classification", "recurring",
                                       "--evidence-ids", crossSessionIds, "--reviewed-by", "Tutor"});
    auto mastery = run(archivePath, {"student", "progress-review", studentId, "--skill", "Geometry", "--classification",
                                     "demonstrated-mastery", "--evidence-ids", crossSessionIds, "--reviewed-by", "Tutor"});
    auto newlyObserved = run(archivePath, {"student", "progress-review", studentId, "--skill", "Ratios", "--classification",
                                           "newly-observed", "--evidence-ids", evidenceIds[0], "--reviewed-by", "Tutor"});
    auto notRevisited = run(archivePath, {"student", "progress-review", studentId, "--skill", "Geometry proofs", "--classification",
                                          "not-revisited", "--evidence-ids", evidenceIds[1], "--reviewed-by", "Tutor"});
    if (!recurring || recurring->exitCode != 0 || !mastery || mastery->exitCode != 0 || !newlyObserved || newlyObserved->exitCode != 0 ||
        !notRevisited || notRevisited->exitCode != 0) {
        return fail("A supported progress classification could not be human-reviewed.");
    }

    auto unverified = run(archivePath, {"--json", "student", "progress-review", studentId, "--skill", "Fractions", "--classification",
                                        "unverified-improvement", "--evidence-ids", needsReviewEvidenceId, "--reviewed-by", "Tutor"});
    if (!unverified || unverified->exitCode != 0)
        return fail("Unverified improvement classification was not saved.");
    auto unverifiedJson = command::parseJson(unverified->output);
    if (!unverifiedJson || field(*unverifiedJson, "claim_label").find("UNVERIFIED CLAIM") == std::string::npos) {
        return fail("Unverified improvement was not clearly labeled in command output.");
    }

    const auto mustReject = [&](std::vector<std::string> arguments, std::string_view expectedError) {
        auto response = run(archivePath, std::move(arguments));
        return !response && response.error().code == expectedError;
    };
    if (!mustReject({"student", "progress-review", studentId, "--skill", "Fractions", "--classification", "demonstrated-mastery",
                     "--evidence-ids", evidenceIds[0] + "," + needsReviewEvidenceId, "--reviewed-by", "Tutor"},
                    "student_progress_mastery_requires_verified_evidence")) {
        return fail("Mastery accepted evidence that was not human-verified.");
    }
    if (!mustReject({"student", "progress-review", studentId, "--skill", "Fractions", "--classification", "recurring", "--evidence-ids",
                     evidenceIds[0] + "," + sameSessionEvidenceId, "--reviewed-by", "Tutor"},
                    "student_progress_cross_session_evidence_required")) {
        return fail("Recurring classification accepted evidence from only one session.");
    }
    if (!mustReject({"student", "progress-review", studentId, "--skill", "Fractions", "--classification", "newly-observed",
                     "--evidence-ids", foreignEvidenceId, "--reviewed-by", "Tutor"},
                    "student_progress_evidence_student_mismatch")) {
        return fail("Progress accepted evidence from another student's session.");
    }
    if (!mustReject({"student", "progress-review", studentId, "--skill", "Fractions", "--classification", "newly-observed",
                     "--evidence-ids", archive::uuidToString(archive::randomUuid()), "--reviewed-by", "Tutor"},
                    "student_progress_evidence_missing")) {
        return fail("Progress accepted a missing evidence reference.");
    }
    if (!mustReject({"student", "progress-review", studentId, "--skill", "Fractions", "--classification", "made-up", "--evidence-ids",
                     evidenceIds[0], "--reviewed-by", "Tutor"},
                    "student_progress_classification_invalid")) {
        return fail("Progress accepted an unsupported classification.");
    }

    auto progress = run(archivePath, {"--json", "student", "progress", studentId});
    if (!progress || progress->exitCode != 0)
        return fail("Student progress listing failed.");
    auto progressJson = command::parseJson(progress->output);
    if (!progressJson)
        return fail("Student progress listing was not valid JSON.");
    const auto* progressObject = progressJson->asObject();
    if (!progressObject)
        return fail("Student progress JSON did not return the summary object.");
    const auto classifications = progressObject->find("classifications");
    if (classifications == progressObject->end() || !classifications->second.asArray() || classifications->second.asArray()->size() != 6) {
        return fail("Student progress listing omitted the reviewed classifications.");
    }

    return 0;
}

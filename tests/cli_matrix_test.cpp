// Broad command-surface regression coverage. Every call below is a real
// in-process dispatch against a temporary archive; no command is stubbed.
#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

using tutorux::command::CommandResult;

struct TemporaryDirectory final {
    std::filesystem::path path;
    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::permissions(path, std::filesystem::perms::owner_all,
                                      std::filesystem::perm_options::add, ignored);
        std::filesystem::remove_all(path, ignored);
    }
};

struct Harness final {
    std::filesystem::path archive;
    std::filesystem::path root;
    std::vector<std::string> failures;

    void fail(std::string message) {
        failures.push_back(std::move(message));
    }

    std::optional<CommandResult> run(std::string_view name,
                                     std::vector<std::string> arguments,
                                     bool expectSuccess = true) {
        std::vector<std::string> full{"--archive", archive.string()};
        full.insert(full.end(), arguments.begin(), arguments.end());
        auto result = tutorux::command::dispatch(full);
        if (!result) {
            if (expectSuccess) {
                fail(std::string(name) + ": " + result.error().code + ": " +
                     result.error().message);
            }
            return std::nullopt;
        }
        if (expectSuccess && result->exitCode != 0) {
            fail(std::string(name) + ": exit " + std::to_string(result->exitCode) +
                 ": " + result->output);
        }
        return std::optional<CommandResult>(std::move(*result));
    }

    std::optional<CommandResult> global(std::string_view name,
                                        std::vector<std::string> arguments,
                                        bool expectSuccess = true) {
        auto result = tutorux::command::dispatch(arguments);
        if (!result) {
            fail(std::string(name) + ": " + result.error().code + ": " +
                 result.error().message);
            return std::nullopt;
        }
        if (expectSuccess && result->exitCode != 0) {
            fail(std::string(name) + ": exit " + std::to_string(result->exitCode) +
                 ": " + result->output);
        }
        return std::optional<CommandResult>(std::move(*result));
    }

    void expectFailure(std::string_view name, std::vector<std::string> arguments,
                       std::string_view code) {
        std::vector<std::string> full{"--archive", archive.string()};
        full.insert(full.end(), arguments.begin(), arguments.end());
        auto result = tutorux::command::dispatch(full);
        if (result) {
            if (result->exitCode == 0)
                fail(std::string(name) + ": expected failure but command succeeded");
            return;
        }
        if (!code.empty() && result.error().code != code) {
            fail(std::string(name) + ": expected code " + std::string(code) +
                 ", got " + result.error().code);
        }
    }

    std::optional<tutorux::command::JsonValue>
    json(std::string_view name, std::vector<std::string> arguments) {
        auto result = run(name, std::move(arguments));
        if (!result)
            return std::nullopt;
        auto parsed = tutorux::command::parseJson(result->output);
        if (!parsed) {
            fail(std::string(name) + ": invalid JSON: " + result->output);
            return std::nullopt;
        }
        return std::move(*parsed);
    }
};

const std::string* field(const tutorux::command::JsonValue& value,
                         std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return nullptr;
    const auto found = object->find(key);
    return found == object->end() ? nullptr : found->second.asString();
}

std::optional<std::string> textField(const std::optional<CommandResult>& result,
                                     std::string_view key) {
    if (!result)
        return std::nullopt;
    auto parsed = tutorux::command::parseJson(result->output);
    if (!parsed)
        return std::nullopt;
    const auto* value = field(*parsed, key);
    return value ? std::optional<std::string>(*value) : std::nullopt;
}

std::optional<std::string> firstId(const std::optional<tutorux::command::JsonValue>& value) {
    if (!value || !value->asArray() || value->asArray()->empty())
        return std::nullopt;
    const auto* id = field(value->asArray()->front(), "id");
    return id ? std::optional<std::string>(*id) : std::nullopt;
}

bool writeText(const std::filesystem::path& path, std::string_view text) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    return output.good();
}

} // namespace

int main() {
    using namespace std::chrono;
    const auto suffix = duration_cast<microseconds>(
                            steady_clock::now().time_since_epoch())
                            .count();
    TemporaryDirectory temporary{
        std::filesystem::temp_directory_path() /
        ("tutorux-cli-matrix-" + std::to_string(suffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode) {
        std::cerr << "cli matrix: unable to create temporary directory\n";
        return 1;
    }

    Harness h;
    h.root = temporary.path;
    h.archive = temporary.path / "workspace.tux";

    auto created = h.global("archive init",
                            {"archive", "init", h.archive.string(), "--name",
                             "Matrix"});
    if (!created || created->exitCode != 0) {
        std::cerr << "cli matrix: unable to create the fixture archive\n";
        return 1;
    }

    auto student = h.run("student create",
                         {"--json", "student", "create", "--name", "Maya Ortiz",
                          "--grade", "10", "--subjects", "Algebra,Writing"});
    const auto studentId = textField(student, "id");
    if (!studentId) {
        std::cerr << "cli matrix: fixture student missing\n";
        return 1;
    }
    h.run("student show", {"--json", "student", "show", *studentId});
    h.run("student list", {"--json", "student", "list"});
    h.run("student update", {"student", "update", *studentId, "--grade", "11"});
    h.run("student history", {"--json", "student", "history", *studentId});
    h.run("student progress", {"--json", "student", "progress", *studentId});

    auto session = h.run("session create",
                         {"--json", "session", "create", "--student-id", *studentId,
                          "--subject", "Algebra", "--title", "Linear equations",
                          "--type", "notes-only", "--guide-template", "mathematics"});
    const auto sessionId = textField(session, "id");
    if (!sessionId) {
        std::cerr << "cli matrix: fixture session missing\n";
        return 1;
    }
    auto sessionDetails = h.run("session show", {"--json", "session", "show", *sessionId});
    const auto notesDocumentId = textField(sessionDetails, "notes_document_id");
    if (!notesDocumentId) {
        std::cerr << "cli matrix: fixture notes document missing\n";
        return 1;
    }
    h.run("session list", {"--json", "session", "list"});
    h.run("session update", {"session", "update", *sessionId, "--title",
                             "Linear equations review"});
    h.run("session start", {"session", "start", *sessionId});
    h.run("session complete", {"session", "complete", *sessionId});
    h.run("session review", {"session", "review", *sessionId});
    h.run("session resume", {"session", "resume", *sessionId});
    auto cloned = h.run("session clone",
                        {"--json", "session", "clone", *sessionId});
    const auto clonedId = textField(cloned, "id");
    if (clonedId) {
        h.run("session archive", {"session", "archive", *clonedId});
        auto deletionDryRun = h.run("session delete dry-run",
                                    {"--json", "session", "delete", *clonedId,
                                     "--dry-run"});
        const auto scopeToken = textField(deletionDryRun, "scope_token");
        if (scopeToken) {
            h.run("session delete confirmed",
                  {"session", "delete", *clonedId, "--confirm-scope",
                   "--scope-token", *scopeToken});
        }
    }

    h.run("session note add",
          {"journal", "document", "add-block", *notesDocumentId, "--kind",
           "paragraph", "--text", "Use inverse operations on both sides."});
    auto notes = h.run("journal document show",
                       {"--json", "journal", "document", "show", *notesDocumentId});
    std::string blockId;
    if (notes) {
        auto parsed = tutorux::command::parseJson(notes->output);
        if (parsed && parsed->asObject()) {
            const auto blocks = parsed->asObject()->find("blocks_json");
            std::optional<tutorux::command::JsonValue> parsedBlocks;
            const tutorux::command::JsonValue* blockArray = nullptr;
            if (blocks != parsed->asObject()->end()) {
                if (blocks->second.asArray()) {
                    blockArray = &blocks->second;
                } else if (const auto* encoded = blocks->second.asString()) {
                    auto decoded = tutorux::command::parseJson(*encoded);
                    if (decoded) {
                        parsedBlocks = std::move(*decoded);
                        blockArray = &*parsedBlocks;
                    }
                }
            }
            if (blockArray && blockArray->asArray() && !blockArray->asArray()->empty()) {
                if (const auto* id = field(blockArray->asArray()->front(), "id"))
                    blockId = *id;
            }
        }
    }
    if (blockId.empty())
        h.fail("journal document show did not expose a block id");
    h.run("journal document update",
          {"journal", "document", "update", *notesDocumentId, "--block-id", blockId,
           "--text", "Use inverse operations on both sides, then check."});
    h.run("journal document move-block",
          {"journal", "document", "move-block", *notesDocumentId, "--from", "0",
           "--to", "0"});
    if (!blockId.empty()) {
        h.run("journal document remove-block",
              {"journal", "document", "remove-block", *notesDocumentId,
               "--block-id", blockId});
        h.run("journal document add-block",
              {"journal", "document", "add-block", *notesDocumentId, "--kind",
               "paragraph", "--text",
               "Use inverse operations on both sides."});
    }

    auto collection = h.run("journal collection create",
                            {"--json", "journal", "collection", "create", "--name",
                             "Algebra"});
    const auto collectionId = textField(collection, "id");
    auto tag = h.run("journal tag create",
                     {"--json", "journal", "tag", "create", "--name", "Equations"});
    const auto tagId = textField(tag, "id");
    h.run("journal collection list", {"--json", "journal", "collection", "list"});
    h.run("journal tag list", {"--json", "journal", "tag", "list"});
    if (collectionId) {
        h.run("journal collection show",
              {"--json", "journal", "collection", "show", *collectionId});
        h.run("journal collection update",
              {"journal", "collection", "update", *collectionId, "--name",
               "Algebra I"});
    }
    if (tagId) {
        h.run("journal tag show", {"--json", "journal", "tag", "show", *tagId});
        h.run("journal tag update",
              {"journal", "tag", "update", *tagId, "--name", "Linear equations"});
    }
    auto entry = h.run("journal entry create",
                       {"--json", "journal", "entry", "create", "--title",
                        "Equation practice"});
    const auto entryId = textField(entry, "id");
    h.run("journal entry list", {"--json", "journal", "entry", "list"});
    h.run("journal search", {"--json", "journal", "search", "--query", "Equation"});
    if (entryId) {
        h.run("journal entry show",
              {"--json", "journal", "entry", "show", *entryId});
        h.run("journal entry update",
              {"journal", "entry", "update", *entryId, "--title",
               "Equation practice updated"});
    }
    auto throwawayCollection = h.run(
        "journal collection create throwaway",
        {"--json", "journal", "collection", "create", "--name", "Temporary"});
    auto throwawayTag = h.run("journal tag create throwaway",
                              {"--json", "journal", "tag", "create", "--name",
                               "Temporary"});
    const auto throwawayCollectionId = textField(throwawayCollection, "id");
    const auto throwawayTagId = textField(throwawayTag, "id");
    if (throwawayCollectionId)
        h.run("journal collection delete",
              {"journal", "collection", "delete", *throwawayCollectionId});
    if (throwawayTagId)
        h.run("journal tag delete",
              {"journal", "tag", "delete", *throwawayTagId});
    auto throwawayEntry = h.run(
        "journal entry create throwaway",
        {"--json", "journal", "entry", "create", "--title", "Temporary entry"});
    const auto throwawayEntryId = textField(throwawayEntry, "id");
    if (throwawayEntryId)
        h.run("journal entry delete",
              {"journal", "entry", "delete", *throwawayEntryId});

    auto annotation = h.run("annotation add",
                            {"--json", "annotation", "add", "--session", *sessionId,
                             "--type", "general-note", "--at", "00:00:10",
                             "--text", "Check the inverse operation"});
    const auto annotationId = textField(annotation, "id");
    if (annotationId) {
        h.run("annotation list", {"--json", "annotation", "list", "--session",
                                  *sessionId});
        h.run("annotation show", {"--json", "annotation", "show", *annotationId});
        h.run("annotation history", {"--json", "annotation", "history",
                                     *annotationId});
        h.run("annotation update",
              {"annotation", "update", *annotationId, "--text",
               "Check the inverse operation carefully"});
        h.run("annotation prioritize",
              {"annotation", "prioritize", *annotationId, "--priority", "high"});
    }
    auto annotationA = h.run("annotation add A",
                             {"--json", "annotation", "add", "--session",
                              *sessionId, "--type", "student-mistake", "--at",
                              "00:00:20", "--text", "First part"});
    auto annotationB = h.run("annotation add B",
                             {"--json", "annotation", "add", "--session",
                              *sessionId, "--type", "student-mistake", "--at",
                              "00:00:22", "--text", "Second part"});
    const auto annotationAId = textField(annotationA, "id");
    const auto annotationBId = textField(annotationB, "id");
    if (annotationAId && annotationBId) {
        auto merged = h.run("annotation merge",
                            {"--json", "annotation", "merge", *annotationAId,
                             *annotationBId, "--separator", " "});
        const auto mergedId = textField(merged, "id");
        if (mergedId) {
            h.run("annotation split",
                  {"--json", "annotation", "split", *mergedId, "--before",
                   "First part ", "--after", "Second part", "--at",
                   "00:00:21"});
            h.run("annotation remove", {"annotation", "remove", *mergedId});
        }
    }

    const auto transcriptPath = h.root / "transcript.txt";
    writeText(transcriptPath, "First line about equations.\nSecond line about checks.\n");
    h.run("transcript import",
          {"transcript", "import", "--session", *sessionId, "--input",
           transcriptPath.string(), "--format", "text"});
    auto transcript = h.run("transcript show",
                            {"--json", "transcript", "show", "--session", *sessionId});
    std::vector<std::string> segmentIds;
    if (transcript) {
        auto parsed = tutorux::command::parseJson(transcript->output);
        if (parsed && parsed->asArray()) {
            for (const auto& row : *parsed->asArray()) {
                if (const auto* id = field(row, "id"))
                    segmentIds.push_back(*id);
            }
        }
    }
    if (segmentIds.empty())
        h.fail("transcript import did not expose segment ids");
    const auto clock = [](std::size_t second) {
        const std::string value = second < 10 ? "0" + std::to_string(second)
                                              : std::to_string(second);
        return "00:00:" + value;
    };
    for (std::size_t index = 0; index < segmentIds.size(); ++index) {
        h.run("transcript timestamp",
              {"transcript", "timestamp", segmentIds[index], "--start",
               clock(index + 1), "--end", clock(index + 3)});
    }
    h.run("transcript search",
          {"--json", "transcript", "search", "--session", *sessionId, "--query",
           "equations"});
    h.run("transcript export",
          {"transcript", "export", "--session", *sessionId, "--output",
           (h.root / "transcript.srt").string(), "--format", "srt"});
    h.run("transcript export text",
          {"transcript", "export", "--session", *sessionId, "--output",
           (h.root / "transcript.txt").string(), "--format", "text"});
    h.run("transcript export vtt",
          {"transcript", "export", "--session", *sessionId, "--output",
           (h.root / "transcript.vtt").string(), "--format", "vtt"});
    h.run("transcript export json",
          {"transcript", "export", "--session", *sessionId, "--output",
           (h.root / "transcript.json").string(), "--format", "json"});
    h.run("transcript plan", {"--json", "transcript", "plan", "--session",
                              *sessionId});
    h.run("transcript generate without model",
          {"transcript", "generate", "--session", *sessionId}, false);
    h.run("transcript refine without model",
          {"transcript", "refine", "--session", *sessionId}, false);
    if (!segmentIds.empty()) {
        h.run("transcript correct",
              {"transcript", "correct", segmentIds.front(), "--text",
               "First line corrected."});
        h.run("transcript history",
              {"--json", "transcript", "history", segmentIds.front()});
        h.run("transcript verify",
              {"transcript", "verify", segmentIds.front(), "--state",
               "human-verified"});
        h.run("transcript speaker",
              {"transcript", "speaker", segmentIds.front(), "--name", "Tutor"});
        if (segmentIds.size() > 1) {
            h.run("transcript speaker unknown",
                  {"transcript", "speaker", segmentIds.back(), "--unknown"});
        }
        auto split = h.run("transcript split",
                           {"--json", "transcript", "split",
                            segmentIds.front(), "--before", "First line ",
                            "--after", "corrected.", "--at", "00:00:02"});
        const auto splitId = textField(split, "id");
        if (splitId) {
            h.run("transcript merge",
                  {"transcript", "merge", segmentIds.front(), *splitId,
                   "--separator", " "});
        }
        h.run("transcript restore",
              {"transcript", "restore", segmentIds.front(), "--revision",
               "1"});
    }

    const auto assetPath = h.root / "worksheet.txt";
    writeText(assetPath, "Worksheet content for the equation lesson.\n");
    auto asset = h.run("asset add",
                       {"--json", "asset", "add", assetPath.string(), "--session",
                        *sessionId});
    const auto assetId = textField(asset, "id");
    if (assetId) {
        h.run("asset list", {"--json", "asset", "list"});
        h.run("asset show", {"--json", "asset", "show", *assetId});
        h.run("asset verify", {"asset", "verify", *assetId});
        h.run("asset extract",
              {"asset", "extract", *assetId, "--output",
               (h.root / "extracted.txt").string()});
        if (annotationId) {
            h.run("annotation link",
                  {"annotation", "link", *annotationId, "--to", "asset",
                   "--target-id", *assetId});
            h.run("annotation unlink",
                  {"annotation", "unlink", *annotationId, "--to", "asset",
                   "--target-id", *assetId});
        }
        if (!segmentIds.empty()) {
            h.run("asset link",
                  {"asset", "link", *assetId, "--to", "transcript",
                   "--target-id", segmentIds.front()});
            h.run("asset unlink",
                  {"asset", "unlink", *assetId, "--to", "transcript",
                   "--target-id", segmentIds.front()});
        }
    }
    const auto assetFolder = h.root / "materials";
    std::filesystem::create_directories(assetFolder, errorCode);
    writeText(assetFolder / "handout.txt", "A folder-imported handout.\n");
    h.run("asset import-folder",
          {"asset", "import-folder", assetFolder.string(), "--session",
           *sessionId});

    auto evidence = h.run("evidence extract",
                          {"--json", "evidence", "extract", "--session",
                           *sessionId});
    std::optional<tutorux::command::JsonValue> parsedEvidence;
    if (evidence) {
        auto parsed = tutorux::command::parseJson(evidence->output);
        if (parsed)
            parsedEvidence = std::move(*parsed);
    }
    const auto evidenceId = firstId(parsedEvidence);
    if (evidenceId) {
        h.run("evidence list", {"--json", "evidence", "list", "--session",
                                *sessionId});
        h.run("evidence show", {"--json", "evidence", "show", *evidenceId});
        h.run("evidence graph", {"--json", "evidence", "graph", "--session",
                                 *sessionId});
        h.run("evidence approve", {"evidence", "approve", *evidenceId});
        h.run("evidence verify", {"--json", "evidence", "verify", *evidenceId});
    }

    auto guide = h.run("guide generate",
                       {"--json", "guide", "generate", "--session", *sessionId});
    auto guideId = textField(guide, "id");
    if (!guideId) {
        auto guides = h.run("guide list", {"--json", "guide", "list"});
        std::optional<tutorux::command::JsonValue> parsedGuides;
        if (guides) {
            auto parsed = tutorux::command::parseJson(guides->output);
            if (parsed)
                parsedGuides = std::move(*parsed);
        }
        guideId = firstId(parsedGuides);
    }
    if (guideId) {
        h.run("guide list", {"--json", "guide", "list"});
        h.run("guide show", {"--json", "guide", "show", *guideId});
        h.run("guide validate", {"guide", "validate", *guideId});
        h.run("guide edit",
              {"guide", "edit", *guideId, "--title", "Linear equations guide"});
        for (const std::string format :
             {"markdown", "html", "json", "docx", "pdf"}) {
            h.run("guide export " + format,
                  {"guide", "export", *guideId, "--format", format, "--output",
                   (h.root / ("guide." + format)).string()});
        }
        h.run("guide add-block",
              {"guide", "add-block", *guideId, "--section-index", "0", "--kind",
               "paragraph", "--text", "A reviewed addition."});
        h.run("guide edit block",
              {"guide", "edit", *guideId, "--section-index", "0",
               "--block-index", "1", "--text",
               "A reviewed addition with sources."});
        h.run("guide move-block",
              {"guide", "move-block", *guideId, "--section-index", "0", "--from",
               "1", "--to", "0"});
        h.run("guide remove-block",
              {"guide", "remove-block", *guideId, "--section-index", "0",
               "--block-index", "0"});
        h.run("guide regenerate",
              {"guide", "regenerate", *guideId, "--section-index", "0"});
        h.run("guide section",
              {"guide", "section", *guideId, "--heading", "Practice",
               "--text", "Practice the inverse operation."});
        h.run("guide move-section",
              {"guide", "move-section", *guideId, "--from", "1", "--to", "0"});
        h.run("guide approve", {"guide", "approve", *guideId});
        h.run("guide validate after approval",
              {"guide", "validate", *guideId});
    }

    h.run("template list", {"--json", "template", "list"});
    auto customTemplate = h.run("template create",
                                {"--json", "template", "create", "--name",
                                 "Matrix template", "--subject", "Algebra",
                                 "--sections", "Overview;Practice"});
    const auto templateId = textField(customTemplate, "id");
    if (templateId) {
        h.run("template update",
              {"template", "update", *templateId, "--description",
               "Matrix regression template"});
        const auto exportedTemplate = h.root / "template.json";
        h.run("template export",
              {"template", "export", *templateId, "--output",
               exportedTemplate.string()});
        auto importedTemplate = h.run(
            "template import",
            {"--json", "template", "import", "--name", "Imported template",
             "--input", exportedTemplate.string()});
        const auto importedTemplateId = textField(importedTemplate, "id");
        if (importedTemplateId)
            h.run("template delete imported",
                  {"template", "delete", *importedTemplateId});
        h.run("template delete", {"template", "delete", *templateId});
    }

    h.run("settings set",
          {"settings", "set", "--key", "ui.matrix", "--value", "covered"});
    h.run("settings get", {"settings", "get", "ui.matrix"});
    h.run("settings list", {"--json", "settings", "list"});
    const auto settingsImport = h.root / "settings.txt";
    writeText(settingsImport, "ui.imported=yes\n");
    h.run("settings import",
          {"settings", "import", "--input", settingsImport.string()});
    const auto sourceArchive = h.root / "settings-source.tux";
    h.global("settings source init",
             {"archive", "init", sourceArchive.string(), "--name", "Source"});
    h.global("settings source set",
             {"--archive", sourceArchive.string(), "settings", "set", "--key",
              "ui.copy", "--value", "copied"});
    h.run("settings copy",
          {"settings", "copy-to-archive", "--source-archive",
           sourceArchive.string(), "--key", "ui.copy"});
    h.run("settings get copied", {"settings", "get", "ui.copy"});
    h.run("settings reset", {"settings", "reset", "--key", "ui.imported"});
    h.run("settings credential-list", {"--json", "settings",
                                       "credential-list"});

    const auto modelFile = h.root / "model.bin";
    writeText(modelFile, "not a real model but a regular file\n");
    h.run("model list", {"--json", "model", "list"});
    auto selectedModel = h.run(
        "model select",
        {"--json", "model", "select", "--provider", "ollama", "--model",
         "llama3", "--path", modelFile.string()});
    const auto modelId = textField(selectedModel, "id");
    h.run("model list after select", {"--json", "model", "list"});
    h.run("model inspect", {"--json", "model", "inspect", "--path",
                            modelFile.string()});
    h.run("model verify", {"--json", "model", "verify", "--path",
                           modelFile.string()});
    if (modelId)
        h.run("model remove-reference",
              {"model", "remove-reference", *modelId});

    h.run("record devices", {"--json", "record", "devices"});
    h.run("record configure",
          {"record", "configure", "--microphone", "default", "--playback",
           "default", "--durability", "default"});
    h.run("record test", {"record", "test"}, false);
    h.run("record play",
          {"record", "play", "--session", *sessionId}, false);
    h.run("record status", {"record", "status", "--session", *sessionId},
          false);
    h.run("record waveform",
          {"record", "waveform", "--session", *sessionId, "--buckets", "16"},
          false);
    h.run("record export-wav",
          {"record", "export-wav", "--session", *sessionId, "--output",
           (h.root / "audio.wav").string()},
          false);
    h.run("record recover", {"record", "recover", "--session", *sessionId}, false);

    h.run("diagnostics run", {"--json", "diagnostics", "run"});
    h.run("diagnostics archive", {"--json", "diagnostics", "archive"});
    h.run("diagnostics audio", {"--json", "diagnostics", "audio"}, false);
    h.run("diagnostics graphics", {"--json", "diagnostics", "graphics"});
    h.run("diagnostics providers", {"--json", "diagnostics", "providers"});
    h.run("diagnostics report",
          {"diagnostics", "report", "--output",
           (h.root / "diagnostics.txt").string()});
    h.run("benchmark startup", {"--json", "benchmark", "startup"});
    h.run("benchmark memory", {"--json", "benchmark", "memory"});
    h.run("benchmark cpu", {"--json", "benchmark", "cpu"});
    h.run("benchmark indexing", {"--json", "benchmark", "indexing"});
    h.run("benchmark rendering", {"--json", "benchmark", "rendering"}, false);
    h.run("benchmark export", {"--json", "benchmark", "export"}, false);

    h.run("ai providers", {"--json", "ai", "providers"});
    h.run("ai context", {"--json", "ai", "context", "--session", *sessionId});
    for (const std::string format : {"json", "markdown", "parts"}) {
        h.run("ai package " + format,
              {"--json", "ai", "package", "--session", *sessionId,
               "--mode", "manual", "--format", format, "--output",
               (h.root / ("ai-package." + format)).string()});
    }
    h.run("ai configure",
          {"ai", "configure", "--provider", "ollama", "--endpoint",
           "http://127.0.0.1:11434", "--model", "llama3"});
    h.run("ai models", {"--json", "ai", "models", "--provider", "ollama"},
          false);
    h.run("ai test", {"ai", "test", "--provider", "ollama"}, false);
    h.run("ai jobs", {"--json", "ai", "jobs"});

    h.run("archive info", {"--json", "archive", "info", h.archive.string()});
    h.run("archive verify", {"archive", "verify", h.archive.string(), "--full"});
    h.expectFailure("unknown command", {"definitely-not-a-command"},
                    "command_unknown");
    h.expectFailure("missing session",
                    {"session", "show", "00000000-0000-4000-8000-000000000000"},
                    "");

    if (!h.failures.empty()) {
        for (const auto& failure : h.failures)
            std::cerr << "cli matrix: " << failure << '\n';
        return 1;
    }
    std::cout << "cli matrix: all command families passed\n";
    return 0;
}

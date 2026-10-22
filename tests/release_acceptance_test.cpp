// Release acceptance coverage for the specification's testable desktop and
// CLI contracts. Hardware-dependent capture and live provider tests remain
// platform-gated; every command exercised here is the same command the GUI
// invokes.
#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"

#include <algorithm>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::permissions(path, std::filesystem::perms::owner_all,
                                      std::filesystem::perm_options::add, ignored);
        std::filesystem::remove_all(path, ignored);
    }
};

int fail(std::string_view message) {
    std::cerr << "release acceptance: " << message << '\n';
    return 1;
}

std::string_view outputOf(const tutorux::command::CommandResult& result) {
    return result.output;
}

tutorux::core::Result<tutorux::command::CommandResult>
dispatch(const std::vector<std::string>& arguments) {
    return tutorux::command::dispatch(arguments);
}

tutorux::core::Result<tutorux::command::CommandResult>
run(const std::filesystem::path& archive, std::vector<std::string> arguments) {
    std::vector<std::string> full{"--archive", archive.string()};
    full.insert(full.end(), arguments.begin(), arguments.end());
    return dispatch(full);
}

std::optional<tutorux::command::JsonValue>
parseCommandJson(const tutorux::core::Result<tutorux::command::CommandResult>& result) {
    if (!result || result->exitCode != 0)
        return std::nullopt;
    auto parsed = tutorux::command::parseJson(result->output);
    if (!parsed)
        return std::nullopt;
    return std::move(*parsed);
}
const std::string* jsonString(const tutorux::command::JsonValue& value,
                              std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return nullptr;
    const auto found = object->find(key);
    return found == object->end() ? nullptr : found->second.asString();
}

std::optional<std::string> jsonField(std::string_view json, std::string_view key) {
    auto parsed = tutorux::command::parseJson(json);
    if (!parsed)
        return std::nullopt;
    const auto* value = jsonString(*parsed, key);
    return value ? std::optional<std::string>(*value) : std::nullopt;
}

bool writeText(const std::filesystem::path& path, std::string_view text) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    return output.good();
}

bool containsText(std::string_view haystack, std::string_view needle) {
    return haystack.find(needle) != std::string_view::npos;
}

bool noCompanionStateFiles(const std::filesystem::path& directory,
                           const std::vector<std::filesystem::path>& expected) {
    std::error_code errorCode;
    for (const auto& entry : std::filesystem::directory_iterator(directory, errorCode)) {
        if (errorCode)
            return false;
        const auto canonical = std::filesystem::weakly_canonical(entry.path(), errorCode);
        if (errorCode)
            return false;
        if (std::find(expected.begin(), expected.end(), canonical) == expected.end())
            return false;
    }
    return true;
}

int verifyVersionDoesNotCreateFiles(const std::filesystem::path& root) {
    const auto directory = root / "version";
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    if (errorCode)
        return fail("unable to create the version fixture directory");
    auto version = dispatch({"--version"});
    if (!version || version->exitCode != 0)
        return fail("--version failed");
    auto help = dispatch({"--help"});
    if (!help || help->exitCode != 0)
        return fail("--help failed");
    if (!noCompanionStateFiles(directory, {}))
        return fail("a read-only command created state files");
    return 0;
}

int verifyImmediateDiscovery(const std::filesystem::path& root) {
    const auto directory = root / "discovery";
    const auto nested = directory / "Old";
    std::error_code errorCode;
    std::filesystem::create_directories(nested, errorCode);
    if (errorCode)
        return fail("unable to create the discovery fixture directory");
    auto first = dispatch({"archive", "init", (directory / "Main.tux").string(), "--name",
                           "Main"});
    auto second = dispatch({"archive", "init", (directory / "Student-A.tux").string(), "--name",
                            "Student A"});
    auto third = dispatch({"archive", "init", (nested / "Archived.tux").string(), "--name",
                           "Archived"});
    if (!first || first->exitCode != 0 || !second || second->exitCode != 0 || !third ||
        third->exitCode != 0)
        return fail("unable to create discovery fixtures");
    auto discovered = tutorux::archive::Archive::discover(directory);
    if (!discovered)
        return fail("archive discovery failed");
    if (discovered->size() != 2)
        return fail("archive discovery was recursive or missed an immediate archive");
    for (const auto& archive : *discovered) {
        if (archive.path.parent_path() != directory)
            return fail("archive discovery returned a nested archive");
    }
    return 0;
}

int verifyExplicitSelection(const std::filesystem::path& root) {
    const auto directory = root / "selection";
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    if (errorCode)
        return fail("unable to create the selection fixture directory");
    if (auto created = dispatch({"archive", "init", (directory / "One.tux").string(), "--name",
                                 "One"});
        !created || created->exitCode != 0)
        return fail("unable to create the first selection archive");
    if (auto created = dispatch({"archive", "init", (directory / "Two.tux").string(), "--name",
                                 "Two"});
        !created || created->exitCode != 0)
        return fail("unable to create the second selection archive");

    auto ambiguous = dispatch({"--directory", directory.string(), "session", "create", "--title",
                               "Ambiguous"});
    if (ambiguous && ambiguous->exitCode == 0)
        return fail("a write command selected one of multiple archives implicitly");
    if (ambiguous && !containsText(outputOf(*ambiguous), "archive") &&
        !containsText(outputOf(*ambiguous), "select"))
        return fail("an ambiguous archive selection did not explain the required choice");

    auto explicitArchive = dispatch({"--archive", (directory / "One.tux").string(), "session",
                                     "create", "--title", "Explicit"});
    if (!explicitArchive || explicitArchive->exitCode != 0)
        return fail("an explicitly selected archive rejected a write command");
    return 0;
}

int verifyJournalLifecycle(const std::filesystem::path& root) {
    const auto directory = root / "journal";
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    if (errorCode)
        return fail("unable to create the journal fixture directory");
    const auto archivePath = directory / "workspace.tux";
    if (auto created = dispatch({"archive", "init", archivePath.string(), "--name",
                                 "Acceptance"});
        !created || created->exitCode != 0)
        return fail("unable to create the journal archive");

    auto student = run(archivePath, {"--json", "student", "create", "--name", "Alex Chen",
                                     "--grade", "11", "--subjects", "English"});
    if (!student || student->exitCode != 0)
        return fail("student creation failed");
    const auto studentId = jsonField(student->output, "id");
    if (!studentId || studentId->empty())
        return fail("student creation did not return an id");

    auto session = run(archivePath, {"--json", "session", "create", "--student-id", *studentId,
                                     "--subject", "AP Language", "--title",
                                     "Rhetorical analysis", "--type", "notes-only"});
    if (!session || session->exitCode != 0)
        return fail("journal-linked session creation failed");
    const auto sessionId = jsonField(session->output, "id");
    if (!sessionId || sessionId->empty())
        return fail("session creation did not return an id");

    auto entries = run(archivePath, {"--json", "journal", "entry", "list"});
    if (!entries || entries->exitCode != 0)
        return fail("journal entry listing failed");
    auto parsedEntries = tutorux::command::parseJson(entries->output);
    if (!parsedEntries || !parsedEntries->asArray() || parsedEntries->asArray()->empty())
        return fail("session creation did not create a journal entry");

    auto collection = run(archivePath, {"--json", "journal", "collection", "create", "--name",
                                        "English Language"});
    auto tag = run(archivePath, {"--json", "journal", "tag", "create", "--name", "Thesis"});
    if (!collection || collection->exitCode != 0 || !tag || tag->exitCode != 0)
        return fail("collection or tag creation failed");
    const auto collectionId = jsonField(collection->output, "id");
    const auto tagId = jsonField(tag->output, "id");
    if (!collectionId || !tagId)
        return fail("collection or tag creation did not return an id");

    auto tagged = run(archivePath, {"--json", "journal", "entry", "create", "--title",
                                    "Argumentative writing", "--collection-ids", *collectionId,
                                    "--tag-ids", *tagId});
    if (!tagged || tagged->exitCode != 0)
        return fail("entry creation with collection and tag references failed");

    auto search = run(archivePath, {"--json", "journal", "entry", "list", "--query",
                                    "Argumentative"});
    auto parsedSearch = parseCommandJson(search);
    if (!search || search->exitCode != 0 || !parsedSearch || !parsedSearch->asArray() ||
        parsedSearch->asArray()->empty())
        return fail("journal search did not find the created entry");

    auto annotation = run(archivePath, {"--json", "annotation", "add", "--session", *sessionId,
                                        "--type", "general-note", "--at", "00:00:05", "--text",
                                        "Check the thesis statement"});
    if (!annotation || annotation->exitCode != 0)
        return fail("timestamped annotation creation failed");
    const auto annotationId = jsonField(annotation->output, "id");
    if (!annotationId)
        return fail("annotation creation did not return an id");
    auto annotations = run(archivePath, {"--json", "annotation", "list", "--session",
                                         *sessionId});
    auto parsedAnnotations = parseCommandJson(annotations);
    if (!annotations || annotations->exitCode != 0 || !parsedAnnotations ||
        !parsedAnnotations->asArray() || parsedAnnotations->asArray()->size() != 1)
        return fail("annotation listing did not return the created marker");
    auto updated = run(archivePath, {"annotation", "update", *annotationId, "--text",
                                     "Check the thesis statement and evidence"});
    if (!updated || updated->exitCode != 0)
        return fail("annotation editing failed");

    const auto transcriptInput = directory / "transcript.txt";
    if (!writeText(transcriptInput,
                   "The student identified the author's central position early.\n"
                   "Remember to connect the evidence to the thesis.\n"))
        return fail("unable to write the transcript fixture");
    auto imported = run(archivePath, {"transcript", "import", "--session", *sessionId,
                                      "--input", transcriptInput.string()});
    if (!imported || imported->exitCode != 0)
        return fail("transcript import failed");
    auto transcript = run(archivePath, {"--json", "transcript", "show", "--session",
                                        *sessionId});
    if (!transcript || transcript->exitCode != 0 ||
        !containsText(outputOf(*transcript), "central position"))
        return fail("transcript show did not expose imported text");

    auto extracted = run(archivePath, {"--json", "evidence", "extract", "--session",
                                       *sessionId});
    auto parsedEvidence = parseCommandJson(extracted);
    if (!extracted || extracted->exitCode != 0 || !parsedEvidence ||
        !parsedEvidence->asArray() || parsedEvidence->asArray()->empty())
        return fail("evidence extraction returned no candidate");
    const auto evidenceId = jsonString(parsedEvidence->asArray()->front(), "id");
    if (!evidenceId)
        return fail("evidence extraction omitted the candidate id");
    auto approved = run(archivePath, {"evidence", "approve", *evidenceId});
    auto verified = run(archivePath, {"--json", "evidence", "verify", *evidenceId});
    if (!approved || approved->exitCode != 0 || !verified || verified->exitCode != 0 ||
        jsonField(verified->output, "source_valid").value_or("false") != "true")
        return fail("evidence approval or verification failed");

    const auto assetInput = directory / "material.txt";
    if (!writeText(assetInput, "Evidence, commentary, and argumentative structure.\n"))
        return fail("unable to write the material fixture");
    auto asset = run(archivePath, {"--json", "asset", "add", assetInput.string(), "--session",
                                   *sessionId});
    if (!asset || asset->exitCode != 0)
        return fail("material import failed");
    auto assets = run(archivePath, {"--json", "asset", "list"});
    auto parsedAssets = parseCommandJson(assets);
    if (!assets || assets->exitCode != 0 || !parsedAssets || !parsedAssets->asArray() ||
        parsedAssets->asArray()->empty())
        return fail("material listing did not return the imported asset");

    auto guide = run(archivePath, {"guide", "generate", "--session", *sessionId});
    if (!guide || guide->exitCode != 0)
        return fail("study guide generation failed");
    auto guides = run(archivePath, {"--json", "guide", "list"});
    auto parsedGuides = parseCommandJson(guides);
    if (!guides || guides->exitCode != 0 || !parsedGuides || !parsedGuides->asArray() ||
        parsedGuides->asArray()->empty())
        return fail("guide generation did not persist a guide");
    const auto guideId = jsonString(parsedGuides->asArray()->front(), "id");
    if (!guideId)
        return fail("guide listing omitted the guide id");

    for (const std::string format : {"markdown", "html", "docx"}) {
        const auto output = directory / ("guide." + format);
        auto exported = run(archivePath, {"guide", "export", *guideId, "--format", format,
                                          "--output", output.string()});
        std::error_code sizeError;
        const auto size = std::filesystem::file_size(output, sizeError);
        if (!exported || exported->exitCode != 0 || sizeError || size == 0)
            return fail("guide export failed for " + format);
    }

    auto providers = dispatch({"--json", "ai", "providers"});
    auto parsedProviders = parseCommandJson(providers);
    if (!parsedProviders || !parsedProviders->asArray() ||
        parsedProviders->asArray()->size() < 30)
        return fail("the provider catalog exposes fewer than thirty integrations");

    auto settingsSet = run(archivePath, {"settings", "set", "--key", "ui.acceptance",
                                         "--value", "verified"});
    auto settingsGet = run(archivePath, {"settings", "get", "ui.acceptance"});
    if (!settingsSet || settingsSet->exitCode != 0 || !settingsGet ||
        settingsGet->exitCode != 0 || !containsText(outputOf(*settingsGet), "verified"))
        return fail("archive-scoped settings did not round-trip");

    const auto exports = root / "exports";
    std::filesystem::create_directories(exports, errorCode);
    if (errorCode)
        return fail("unable to create the export fixture directory");
    const auto package = exports / "session.tux";
    auto sessionExport = run(archivePath, {"session", "export", *sessionId, "--output",
                                           package.string()});
    if (!sessionExport || sessionExport->exitCode != 0 ||
        !std::filesystem::exists(package)) {
        const std::string detail = sessionExport ? std::string(outputOf(*sessionExport))
                                                 : sessionExport.error().message;
        return fail("session package export failed: " + detail);
    }
    const auto exchangeArchive = exports / "exchange.tux";
    if (auto created = dispatch({"archive", "init", exchangeArchive.string(), "--name",
                                 "Exchange"});
        !created || created->exitCode != 0)
        return fail("unable to create the exchange archive");
    const auto settingsInput = exports / "settings.txt";
    if (!writeText(settingsInput, "ui.imported=from-file\n"))
        return fail("unable to write the settings import fixture");
    auto importedSettings = run(exchangeArchive, {"settings", "import", "--input",
                                                  settingsInput.string()});
    auto importedSetting = run(exchangeArchive, {"settings", "get", "ui.imported"});
    if (!importedSettings || importedSettings->exitCode != 0 || !importedSetting ||
        importedSetting->exitCode != 0 ||
        !containsText(outputOf(*importedSetting), "from-file"))
        return fail("settings import did not round-trip");
    auto copiedSettings = run(exchangeArchive, {"settings", "copy-to-archive",
                                                "--source-archive", archivePath.string(),
                                                "--key", "ui.acceptance"});
    auto copiedSetting = run(exchangeArchive, {"settings", "get", "ui.acceptance"});
    if (!copiedSettings || copiedSettings->exitCode != 0 || !copiedSetting ||
        copiedSetting->exitCode != 0 ||
        !containsText(outputOf(*copiedSetting), "verified"))
        return fail("settings copy-to-archive did not copy the selected setting");
    auto sessionImport = run(exchangeArchive, {"session", "import", package.string()});
    if (!sessionImport || sessionImport->exitCode != 0)
        return fail("session package import failed");
    auto exchangeSessions = run(exchangeArchive, {"--json", "session", "list"});
    auto parsedExchange = parseCommandJson(exchangeSessions);
    if (!parsedExchange || !parsedExchange->asArray() || parsedExchange->asArray()->empty())
        return fail("imported session package did not create a session");
    auto exchangeEntries = run(exchangeArchive, {"--json", "journal", "entry", "list"});
    auto parsedExchangeEntries = parseCommandJson(exchangeEntries);
    if (!parsedExchangeEntries || !parsedExchangeEntries->asArray() ||
        parsedExchangeEntries->asArray()->size() != 1)
        return fail("session import did not reuse the packaged journal entry");
    auto exchangeGuides = run(exchangeArchive, {"--json", "guide", "list"});
    auto parsedExchangeGuides = parseCommandJson(exchangeGuides);
    if (!parsedExchangeGuides || !parsedExchangeGuides->asArray() ||
        parsedExchangeGuides->asArray()->empty())
        return fail("session import dropped the packaged study guide");
    auto exchangeVerify = dispatch({"archive", "verify", exchangeArchive.string()});
    if (!exchangeVerify || exchangeVerify->exitCode != 0)
        return fail("the exchange archive did not verify after session import");

    const auto archiveCopy = exports / "copy.tux";
    auto copied = dispatch({"archive", "copy", archivePath.string(), "--output",
                            archiveCopy.string(), "--confirm-sensitive"});
    if (!copied || copied->exitCode != 0 || !std::filesystem::exists(archiveCopy))
        return fail("archive copy failed");
    auto copiedVerify = dispatch({"archive", "verify", archiveCopy.string()});
    if (!copiedVerify || copiedVerify->exitCode != 0)
        return fail("copied archive did not verify");
    auto copiedImport = run(archiveCopy, {"session", "import", package.string()});
    if (!copiedImport || copiedImport->exitCode != 0)
        return fail("session import into the copied archive failed");
    auto copiedSessions = run(archiveCopy, {"--json", "session", "list"});
    auto parsedCopiedSessions = parseCommandJson(copiedSessions);
    bool preservedStudent = false;
    if (parsedCopiedSessions && parsedCopiedSessions->asArray()) {
        for (const auto& row : *parsedCopiedSessions->asArray()) {
            const auto* student = jsonString(row, "student_id");
            if (student && *student == *studentId) {
                preservedStudent = true;
                break;
            }
        }
    }
    if (!preservedStudent)
        return fail("session import did not preserve the destination student reference");

    const auto sanitizedPreview = exports / "sanitized.tux";
    auto sanitize = dispatch({"archive", "sanitize", archivePath.string(), "--output",
                              sanitizedPreview.string()});
    if (!sanitize || sanitize->exitCode != 0 ||
        !containsText(outputOf(*sanitize), "Review the selection"))
        return fail("sanitized copy preview did not request an explicit review");

    const auto templateOutput = exports / "template.json";
    auto templateResult = run(archivePath, {"--json", "template", "create", "--name",
                                            "Acceptance template"});
    auto parsedTemplate = parseCommandJson(templateResult);
    const auto templateId = parsedTemplate ? jsonString(*parsedTemplate, "id") : nullptr;
    if (!templateId)
        return fail("guide template creation failed");
    auto templateExport = run(archivePath, {"template", "export", *templateId, "--output",
                                            templateOutput.string()});
    if (!templateExport || templateExport->exitCode != 0 ||
        !std::filesystem::exists(templateOutput))
        return fail("guide template export failed");

    auto verification = dispatch({"archive", "verify", archivePath.string()});
    if (!verification || verification->exitCode != 0)
        return fail("archive verification failed");

    // The archive directory only holds the archive and explicit exports; no
    // companion database, log, cache, or workspace directory is created.
    if (!noCompanionStateFiles(directory,
                               {std::filesystem::weakly_canonical(archivePath),
                                std::filesystem::weakly_canonical(transcriptInput),
                                std::filesystem::weakly_canonical(assetInput),
                                std::filesystem::weakly_canonical(directory / "guide.markdown"),
                                std::filesystem::weakly_canonical(directory / "guide.html"),
                                std::filesystem::weakly_canonical(directory / "guide.docx")}))
        return fail("the archive directory gained an unexpected companion file");
    return 0;
}

int verifyReadOnlyArchive(const std::filesystem::path& root) {
    const auto directory = root / "readonly";
    std::error_code errorCode;
    std::filesystem::create_directories(directory, errorCode);
    if (errorCode)
        return fail("unable to create the read-only fixture directory");
    const auto archivePath = directory / "readonly.tux";
    if (auto created = dispatch({"archive", "init", archivePath.string(), "--name", "Read only"});
        !created || created->exitCode != 0)
        return fail("unable to create the read-only archive");
    std::filesystem::permissions(archivePath, std::filesystem::perms::owner_read,
                                 std::filesystem::perm_options::replace, errorCode);
    if (errorCode)
        return fail("unable to remove write permission from the fixture");
    auto write = run(archivePath, {"session", "create", "--title", "Forbidden"});
    std::filesystem::permissions(archivePath, std::filesystem::perms::owner_all,
                                 std::filesystem::perm_options::add, errorCode);
    if (write && write->exitCode == 0)
        return fail("a read-only archive accepted a write");
    if (write && outputOf(*write).empty())
        return fail("a read-only archive failure had no explanation");
    return 0;
}

} // namespace

int main() {
    const auto suffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::temp_directory_path() /
                                 ("tutorux-release-acceptance-" + std::to_string(suffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return fail("unable to create the acceptance fixture root");

    if (const int result = verifyVersionDoesNotCreateFiles(temporary.path); result != 0)
        return result;
    if (const int result = verifyImmediateDiscovery(temporary.path); result != 0)
        return result;
    if (const int result = verifyExplicitSelection(temporary.path); result != 0)
        return result;
    if (const int result = verifyJournalLifecycle(temporary.path); result != 0)
        return result;
    if (const int result = verifyReadOnlyArchive(temporary.path); result != 0)
        return result;

    std::cout << "release acceptance: all testable contracts passed\n";
    return 0;
}

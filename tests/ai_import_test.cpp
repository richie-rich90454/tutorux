#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <string_view>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

int reportFailure(std::string_view step, std::string_view detail) {
    std::cerr << step << ": " << detail << '\n';
    return 1;
}

bool writeText(const std::filesystem::path& path, std::string_view content) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(content.data(), static_cast<std::streamsize>(content.size()));
    return static_cast<bool>(output);
}

std::string readText(const std::filesystem::path& path) {
    std::ifstream input(path, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}

tutorux::core::Result<tutorux::command::CommandResult>
importResponse(const std::filesystem::path& archivePath,
               const std::filesystem::path& inputPath,
               std::string_view sessionId) {
    return tutorux::command::dispatch({"--archive",
                                       archivePath.string(),
                                       "--json",
                                       "ai",
                                       "import",
                                       "--session",
                                       std::string(sessionId),
                                       "--input",
                                       inputPath.string()});
}

const std::string* jsonString(const tutorux::command::JsonValue& value, std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return nullptr;
    const auto found = object->find(key);
    return found == object->end() ? nullptr : found->second.asString();
}

bool containsOriginalResponse(const std::vector<tutorux::archive::Record>& jobs,
                              std::string_view response) {
    return std::any_of(jobs.begin(), jobs.end(), [&](const tutorux::archive::Record& job) {
        return job.blob.size() == response.size() &&
               std::equal(job.blob.begin(),
                          job.blob.end(),
                          reinterpret_cast<const std::byte*>(response.data()));
    });
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-ai-import-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return reportFailure("temporary directory", errorCode.message());

    const auto archivePath = temporary.path / "workspace.tux";
    const auto studentId = archive::randomUuid();
    const auto sessionId = archive::randomUuid();
    const auto transcriptId = archive::randomUuid();
    const std::string sessionIdText = archive::uuidToString(sessionId);
    {
        auto created = archive::Archive::create(archivePath, "AI import test");
        if (!created)
            return reportFailure("archive creation", created.error().message);
        domain::Student student;
        student.id = studentId;
        student.name = "Test student";
        if (auto status = created->put(domain::toRecord(student)); !status)
            return reportFailure("student creation", status.error().message);
        domain::Session session;
        session.id = sessionId;
        session.studentId = archive::uuidToString(studentId);
        session.subject = "Mathematics";
        session.title = "Fractions";
        if (auto status = created->put(domain::toRecord(session)); !status)
            return reportFailure("session creation", status.error().message);
        archive::Record transcript;
        transcript.type = archive::RecordType::TranscriptSegment;
        transcript.id = transcriptId;
        transcript.fields = {
            {"session_id", sessionIdText              },
            {"text",       "Use a common denominator."}
        };
        if (auto status = created->put(transcript); !status)
            return reportFailure("transcript source creation", status.error().message);
    }

    const std::string transcriptIdText = archive::uuidToString(transcriptId);
    const std::string structuredResponse =
        "{\"title\":\"Fraction review\",\"template_id\":\"mathematics\","
        "\"sections\":[{\"heading\":\"Compare fractions\",\"blocks\":["
        "{\"kind\":\"instruction\",\"text\":\"Use a common denominator.\","
        "\"source_ids\":[\"" +
        transcriptIdText +
        "\"]},{\"kind\":\"recommendation\",\"text\":\"Try three practice problems.\","
        "\"source_ids\":[\"" +
        transcriptIdText + "\"]}]}]}";
    const auto structuredPath = temporary.path / "structured-response.json";
    if (!writeText(structuredPath, structuredResponse))
        return reportFailure("write structured response", "Unable to write test input.");
    auto imported = importResponse(archivePath, structuredPath, sessionIdText);
    if (!imported || imported->exitCode != 0)
        return reportFailure("structured import",
                             imported ? imported->output : imported.error().message);
    auto importSummary = command::parseJson(imported->output);
    if (!importSummary || jsonString(*importSummary, "status") == nullptr ||
        *jsonString(*importSummary, "status") != "response-imported" ||
        jsonString(*importSummary, "schema_valid") == nullptr ||
        *jsonString(*importSummary, "schema_valid") != "true" ||
        jsonString(*importSummary, "source_validation") == nullptr ||
        *jsonString(*importSummary, "source_validation") != "passed") {
        return reportFailure("structured import summary",
                             importSummary ? imported->output : importSummary.error().message);
    }
    const std::string* guideId = jsonString(*importSummary, "guide_id");
    if (!guideId)
        return reportFailure("guide ID", "Structured import did not return a guide ID.");
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("archive reopen", opened.error().message);
        auto parsedGuideId = archive::uuidFromString(*guideId);
        if (!parsedGuideId)
            return reportFailure("guide ID", parsedGuideId.error().message);
        auto guideRecord = opened->get(archive::RecordType::Guide, *parsedGuideId);
        if (!guideRecord || !*guideRecord)
            return reportFailure("stored guide", "Imported guide was not stored.");
        auto guide = domain::guideFromRecord(**guideRecord);
        if (!guide || guide->approvalState != "proposed" || guide->sections.size() != 1 ||
            guide->sections.front().blocks.size() != 2 ||
            guide->sections.front().blocks.front().kind != "instruction" ||
            guide->sections.front().blocks.back().kind != "recommendation") {
            return reportFailure("structured guide model",
                                 guide ? "Structured blocks were not preserved."
                                       : guide.error().message);
        }
        if (auto status = domain::validateGuide(*guide, *opened); !status)
            return reportFailure("source validation", status.error().message);
        const std::string markdown = domain::renderGuideMarkdown(*guide);
        if (markdown.find("Tutor instruction:") == std::string::npos ||
            markdown.find("AI recommendation:") == std::string::npos)
            return reportFailure("guide provenance labels", markdown);
        auto jobs = opened->list(archive::RecordType::AiJob);
        if (!jobs || jobs->size() != 1 || !containsOriginalResponse(*jobs, structuredResponse)) {
            return reportFailure("original response preservation",
                                 jobs ? "Stored response bytes differ from the input."
                                      : jobs.error().message);
        }
    }

    for (const std::string_view format : {"html", "docx"}) {
        const auto exportPath = temporary.path / ("guide." + std::string(format));
        if (!writeText(exportPath, "previous export"))
            return reportFailure("prepare export destination", "Unable to write existing output.");
        auto exported = command::dispatch({"--archive",
                                           archivePath.string(),
                                           "guide",
                                           "export",
                                           *guideId,
                                           "--format",
                                           std::string(format),
                                           "--output",
                                           exportPath.string()});
        if (!exported || exported->exitCode != 0)
            return reportFailure("guide export",
                                 exported ? exported->output : exported.error().message);
        const std::string document = readText(exportPath);
        if (document.find("Tutor instruction") == std::string::npos ||
            document.find("AI recommendation") == std::string::npos) {
            return reportFailure("guide export provenance labels",
                                 "The exported guide omitted tutor or AI provenance labels.");
        }
    }
    for (std::filesystem::directory_iterator iterator(temporary.path, errorCode), end;
         iterator != end && !errorCode;
         iterator.increment(errorCode)) {
        if (iterator->path().extension() == ".partial")
            return reportFailure("atomic guide export", "A temporary export was left behind.");
    }
    if (errorCode)
        return reportFailure("inspect export directory", errorCode.message());

    const std::string malformedResponse = "{\"title\":\"unfinished\"";
    const auto malformedPath = temporary.path / "malformed-response.json";
    if (!writeText(malformedPath, malformedResponse))
        return reportFailure("write malformed response", "Unable to write test input.");
    auto malformedImport = importResponse(archivePath, malformedPath, sessionIdText);
    if (!malformedImport || malformedImport->exitCode != 0)
        return reportFailure("malformed response preservation",
                             malformedImport ? malformedImport->output
                                             : malformedImport.error().message);
    auto malformedSummary = command::parseJson(malformedImport->output);
    if (!malformedSummary || !jsonString(*malformedSummary, "status") ||
        *jsonString(*malformedSummary, "status") != "response-needs-correction" ||
        !jsonString(*malformedSummary, "schema_valid") ||
        *jsonString(*malformedSummary, "schema_valid") != "false" ||
        !jsonString(*malformedSummary, "warnings") ||
        jsonString(*malformedSummary, "warnings")->empty()) {
        return reportFailure("malformed response summary",
                             malformedSummary ? malformedImport->output
                                              : malformedSummary.error().message);
    }
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("archive reopen after malformed import", opened.error().message);
        auto jobs = opened->list(archive::RecordType::AiJob);
        if (!jobs || jobs->size() != 2 || !containsOriginalResponse(*jobs, malformedResponse)) {
            return reportFailure("malformed response bytes",
                                 jobs ? "Malformed response was not preserved exactly."
                                      : jobs.error().message);
        }
    }

    auto packageResult = command::dispatch(
        {"--archive", archivePath.string(), "--json", "ai", "package", "--session", sessionIdText});
    if (!packageResult || packageResult->exitCode != 0)
        return reportFailure("AI package creation",
                             packageResult ? packageResult->output : packageResult.error().message);
    auto packageSummary = command::parseJson(packageResult->output);
    const std::string* packageJobId =
        packageSummary ? jsonString(*packageSummary, "job_id") : nullptr;
    const std::string* packageHash =
        packageSummary ? jsonString(*packageSummary, "content_hash") : nullptr;
    if (!packageJobId || !packageHash || packageHash->size() != 64 || !packageSummary ||
        !jsonString(*packageSummary, "package_bytes")) {
        return reportFailure("AI package summary",
                             packageSummary ? packageResult->output
                                            : packageSummary.error().message);
    }

    auto previewResult = command::dispatch({"--archive",
                                            archivePath.string(),
                                            "--json",
                                            "ai",
                                            "generate",
                                            "--job",
                                            *packageJobId,
                                            "--provider",
                                            "openai",
                                            "--model",
                                            "fixture-model"});
    if (!previewResult || previewResult->exitCode != 0)
        return reportFailure("AI outbound preview",
                             previewResult ? previewResult->output : previewResult.error().message);
    auto preview = command::parseJson(previewResult->output);
    const std::string* requestBody = preview ? jsonString(*preview, "request_body") : nullptr;
    const std::string* confirmationCommand =
        preview ? jsonString(*preview, "confirmation_command") : nullptr;
    if (!preview || !jsonString(*preview, "outbound_confirmation_required") ||
        *jsonString(*preview, "outbound_confirmation_required") != "true" ||
        !jsonString(*preview, "package_sha256") ||
        *jsonString(*preview, "package_sha256") != *packageHash || !requestBody ||
        requestBody->find("fixture-model") == std::string::npos ||
        requestBody->find("tutorux-ai-package-v1") == std::string::npos ||
        requestBody->find("\"max_completion_tokens\":4096") == std::string::npos ||
        !confirmationCommand ||
        confirmationCommand->find("--api-key-env OPENAI_API_KEY") == std::string::npos ||
        !jsonString(*preview, "endpoint") || !jsonString(*preview, "authorization")) {
        return reportFailure("AI outbound preview summary",
                             preview ? previewResult->output : preview.error().message);
    }
    auto mismatchedConfirmation =
        command::dispatch({"--archive",
                           archivePath.string(),
                           "ai",
                           "generate",
                           "--job",
                           *packageJobId,
                           "--provider",
                           "openai",
                           "--model",
                           "fixture-model",
                           "--confirm-outbound",
                           "--confirm-hash",
                           "0000000000000000000000000000000000000000000000000000000000000000"});
    if (mismatchedConfirmation ||
        mismatchedConfirmation.error().code != "ai_outbound_confirmation_mismatch") {
        return reportFailure("AI outbound hash gate",
                             mismatchedConfirmation ? mismatchedConfirmation->output
                                                    : mismatchedConfirmation.error().message);
    }

    auto localProviderConfiguration = command::dispatch(
        {"--archive", archivePath.string(), "ai", "configure", "--provider", "ollama"});
    if (!localProviderConfiguration || localProviderConfiguration->exitCode != 0) {
        return reportFailure("local provider configuration",
                             localProviderConfiguration
                                 ? localProviderConfiguration->output
                                 : localProviderConfiguration.error().message);
    }
    std::string localEndpoint;
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("local provider archive open", opened.error().message);
        auto settings = opened->list(archive::RecordType::Settings);
        if (!settings)
            return reportFailure("local provider settings", settings.error().message);
        for (const auto& setting : *settings) {
            if (domain::getField(setting, "record_role") == "ai-provider" &&
                domain::getField(setting, "provider_id") == "ollama") {
                localEndpoint = domain::getField(setting, "endpoint");
                break;
            }
        }
    }
    if (localEndpoint != "http://127.0.0.1:11434") {
        return reportFailure("local provider default endpoint",
                             "Ollama was not configured with its loopback default.");
    }
    auto lmStudioConfiguration = command::dispatch(
        {"--archive", archivePath.string(), "ai", "configure", "--provider", "LM Studio"});
    auto llamaServerConfiguration = command::dispatch(
        {"--archive", archivePath.string(), "ai", "configure", "--provider", "llama.cpp server"});
    if (!lmStudioConfiguration || lmStudioConfiguration->exitCode != 0 ||
        !llamaServerConfiguration || llamaServerConfiguration->exitCode != 0) {
        return reportFailure("local server defaults",
                             !lmStudioConfiguration      ? lmStudioConfiguration.error().message
                             : !llamaServerConfiguration ? llamaServerConfiguration.error().message
                             : lmStudioConfiguration->exitCode != 0
                                 ? lmStudioConfiguration->output
                                 : llamaServerConfiguration->output);
    }
    bool foundLmStudioEndpoint = false;
    bool foundLlamaServerEndpoint = false;
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("local server archive reopen", opened.error().message);
        auto settings = opened->list(archive::RecordType::Settings);
        if (!settings)
            return reportFailure("local server settings", settings.error().message);
        for (const auto& setting : *settings) {
            const std::string providerId = domain::getField(setting, "provider_id");
            const std::string endpoint = domain::getField(setting, "endpoint");
            foundLmStudioEndpoint |=
                providerId == "lm-studio" && endpoint == "http://127.0.0.1:1234/v1";
            foundLlamaServerEndpoint |=
                providerId == "llama.cpp-server" && endpoint == "http://127.0.0.1:8080/v1";
        }
    }
    if (!foundLmStudioEndpoint || !foundLlamaServerEndpoint) {
        return reportFailure("local server default endpoints",
                             "LM Studio or llama.cpp server did not receive its default URL.");
    }
    auto providerList = command::dispatch({"--json", "ai", "providers"});
    if (!providerList || providerList->exitCode != 0) {
        return reportFailure("local provider catalog",
                             providerList ? providerList->output : providerList.error().message);
    }
    auto providerRows = command::parseJson(providerList->output);
    const auto* providerArray = providerRows ? providerRows->asArray() : nullptr;
    bool listsOllama = false;
    bool listsLmStudio = false;
    bool listsLlamaServer = false;
    struct CloudProviderExpectation final {
        std::string_view id;
        std::string_view endpoint;
    };
    constexpr std::array cloudProviders{
        CloudProviderExpectation{"openrouter",  "https://openrouter.ai/api/v1"       },
        CloudProviderExpectation{"groq",        "https://api.groq.com/openai/v1"     },
        CloudProviderExpectation{"deepseek",    "https://api.deepseek.com"           },
        CloudProviderExpectation{"mistral",     "https://api.mistral.ai/v1"          },
        CloudProviderExpectation{"together",    "https://api.together.ai/v1"         },
        CloudProviderExpectation{"xai",         "https://api.x.ai/v1"                },
        CloudProviderExpectation{"cerebras",    "https://api.cerebras.ai/v1"         },
        CloudProviderExpectation{"sambanova",   "https://api.sambanova.ai/v1"        },
        CloudProviderExpectation{"nvidia",      "https://integrate.api.nvidia.com/v1"},
        CloudProviderExpectation{"deepinfra",   "https://api.deepinfra.com/v1/openai"},
        CloudProviderExpectation{"moonshot",    "https://api.moonshot.ai/v1"         },
        CloudProviderExpectation{"novita",      "https://api.novita.ai/openai/v1"    },
        CloudProviderExpectation{"nebius",      "https://api.studio.nebius.com/v1"   },
        CloudProviderExpectation{"siliconflow", "https://api.siliconflow.cn/v1"      },
        CloudProviderExpectation{"minimax",     "https://api.minimax.io/v1"          },
    };
    std::array<bool, cloudProviders.size()> listedCloudProviders{};
    if (providerArray) {
        for (const auto& row : *providerArray) {
            const std::string* providerId = jsonString(row, "provider_id");
            const std::string* name = jsonString(row, "provider");
            const std::string* status = jsonString(row, "status");
            if (providerId && status) {
                for (std::size_t index = 0; index < cloudProviders.size(); ++index) {
                    if (*providerId == cloudProviders[index].id &&
                        *status == "openai-compatible-protocol") {
                        listedCloudProviders[index] = true;
                    }
                }
            }
            if (!name || !status)
                continue;
            listsOllama |= *name == "Ollama" && *status == "native-ollama-api";
            if (*status != "local-openai-compatible")
                continue;
            listsLmStudio |= *name == "LM Studio";
            listsLlamaServer |= *name == "llama.cpp server";
        }
    }
    if (!listsOllama || !listsLmStudio || !listsLlamaServer) {
        return reportFailure("local provider catalog status",
                             "A supported local model server was not marked integrated.");
    }
    if (!std::all_of(listedCloudProviders.begin(), listedCloudProviders.end(), [](bool listed) {
            return listed;
        })) {
        return reportFailure("cloud provider catalog status",
                             "A configured cloud provider was not marked integrated.");
    }
    for (const auto& provider : cloudProviders) {
        auto configuredCloudProvider = command::dispatch({"--archive",
                                                          archivePath.string(),
                                                          "ai",
                                                          "configure",
                                                          "--provider",
                                                          std::string(provider.id)});
        if (!configuredCloudProvider || configuredCloudProvider->exitCode != 0) {
            return reportFailure("cloud provider configuration",
                                 configuredCloudProvider ? configuredCloudProvider->output
                                                         : configuredCloudProvider.error().message);
        }
    }
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("cloud provider archive reopen", opened.error().message);
        auto settings = opened->list(archive::RecordType::Settings);
        if (!settings)
            return reportFailure("cloud provider settings", settings.error().message);
        for (const auto& provider : cloudProviders) {
            const auto configuration =
                std::find_if(settings->begin(),
                             settings->end(),
                             [&](const archive::Record& setting) {
                                 return domain::getField(setting, "record_role") == "ai-provider" &&
                                        domain::getField(setting, "provider_id") == provider.id;
                             });
            if (configuration == settings->end() ||
                domain::getField(*configuration, "endpoint") != provider.endpoint) {
                return reportFailure("cloud provider default endpoint",
                                     std::string(provider.id) +
                                         " did not save its documented URL.");
            }
        }
    }
    auto remoteOllamaConfiguration = command::dispatch({"--archive",
                                                        archivePath.string(),
                                                        "ai",
                                                        "configure",
                                                        "--provider",
                                                        "ollama",
                                                        "--endpoint",
                                                        "https://provider.example/v1"});
    if (remoteOllamaConfiguration ||
        remoteOllamaConfiguration.error().code != "ai_local_endpoint_invalid") {
        return reportFailure("local provider endpoint restriction",
                             remoteOllamaConfiguration ? remoteOllamaConfiguration->output
                                                       : remoteOllamaConfiguration.error().message);
    }

    auto localPackageResult = command::dispatch({"--archive",
                                                 archivePath.string(),
                                                 "--json",
                                                 "ai",
                                                 "package",
                                                 "--session",
                                                 sessionIdText,
                                                 "--mode",
                                                 "local",
                                                 "--format",
                                                 "json"});
    if (!localPackageResult || localPackageResult->exitCode != 0) {
        return reportFailure("local AI package creation",
                             localPackageResult ? localPackageResult->output
                                                : localPackageResult.error().message);
    }
    auto localPackageSummary = command::parseJson(localPackageResult->output);
    const std::string* localPackageJobId =
        localPackageSummary ? jsonString(*localPackageSummary, "job_id") : nullptr;
    if (!localPackageJobId) {
        return reportFailure("local AI package summary", localPackageResult->output);
    }
    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("local package archive reopen", opened.error().message);
        auto localPackageId = archive::uuidFromString(*localPackageJobId);
        if (!localPackageId)
            return reportFailure("local package job ID", "The returned job ID is invalid.");
        auto localPackage = opened->get(archive::RecordType::AiJob, *localPackageId);
        if (!localPackage || !*localPackage ||
            domain::getField(**localPackage, "mode") != "local" ||
            domain::getField(**localPackage, "format") != "json") {
            return reportFailure("local package archive record",
                                 localPackage ? "The local package record is missing or invalid."
                                              : localPackage.error().message);
        }
    }

    return 0;
}

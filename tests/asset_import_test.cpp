#include "tutorux/archive/archive.hpp"
#include "tutorux/assets/import.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/hash.hpp"

#include <chrono>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <span>
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

    bool writeBytes(const std::filesystem::path& path, const std::vector<std::byte>& bytes) {
        std::ofstream output(path, std::ios::binary | std::ios::trunc);
        output.write(reinterpret_cast<const char*>(bytes.data()),
                     static_cast<std::streamsize>(bytes.size()));
        return static_cast<bool>(output);
    }

    const std::string* jsonString(const tutorux::command::JsonValue& value, std::string_view key) {
        const auto* object = value.asObject();
        if (!object)
            return nullptr;
        const auto found = object->find(key);
        return found == object->end() ? nullptr : found->second.asString();
    }

    tutorux::core::Result<tutorux::command::CommandResult>
    addAsset(const std::filesystem::path& archivePath, const std::filesystem::path& filePath) {
        return tutorux::command::dispatch(
            {"--archive", archivePath.string(), "--json", "asset", "add", filePath.string()});
    }

} // namespace

int main() {
    using namespace tutorux;

    constexpr std::string_view emptyHash =
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    constexpr std::string_view abcHash =
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    domain::Sha256Builder emptyBuilder;
    if (domain::hexHash(emptyBuilder.finish()) != emptyHash)
        return reportFailure("empty streaming hash", "SHA-256 did not match the standard vector.");
    domain::Sha256Builder abcBuilder;
    const std::string_view abc = "abc";
    for (char character : abc) {
        const std::byte byte = static_cast<std::byte>(static_cast<unsigned char>(character));
        abcBuilder.update(std::span<const std::byte>(&byte, 1));
    }
    if (domain::hexHash(abcBuilder.finish()) != abcHash)
        return reportFailure("chunked streaming hash",
                             "SHA-256 did not match the standard vector.");

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-asset-import-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return reportFailure("temporary directory", errorCode.message());

    const auto archivePath = temporary.path / "workspace.tux";
    const auto firstPath = temporary.path / "first.bin";
    const auto duplicatePath = temporary.path / "duplicate.bin";
    std::vector<std::byte> content(2U * 1024U * 1024U + 37U);
    for (std::size_t index = 0; index < content.size(); ++index)
        content[index] = static_cast<std::byte>((index * 31U + index / 257U) & 0xffU);
    constexpr std::string_view largeContentHash =
        "8667b4858bffa54055e67e09de7a61f25e541136b8f21dbb1908555cda36e344";
    if (domain::hexHash(content) != largeContentHash)
        return reportFailure("multi-block streaming hash",
                             "SHA-256 did not match the independently verified fixture.");
    if (!writeBytes(firstPath, content) || !writeBytes(duplicatePath, content))
        return reportFailure("asset inputs", "Unable to write the test assets.");

    {
        auto created = archive::Archive::create(archivePath, "Asset import test");
        if (!created)
            return reportFailure("archive creation", created.error().message);
    }

    auto firstImport = addAsset(archivePath, firstPath);
    if (!firstImport || firstImport->exitCode != 0)
        return reportFailure("first asset import",
                             firstImport ? firstImport->output : firstImport.error().message);
    auto firstSummary = command::parseJson(firstImport->output);
    if (!firstSummary || !firstSummary->asArray() || firstSummary->asArray()->size() != 1)
        return reportFailure("first asset import result",
                             firstSummary ? firstImport->output : firstSummary.error().message);
    const std::string* firstAssetId = jsonString(firstSummary->asArray()->front(), "id");
    const std::string* firstBlobId = jsonString(firstSummary->asArray()->front(), "blob_id");
    if (!firstAssetId || !firstBlobId ||
        jsonString(firstSummary->asArray()->front(), "content_hash") == nullptr ||
        *jsonString(firstSummary->asArray()->front(), "content_hash") != domain::hexHash(content)) {
        return reportFailure("asset metadata", "The import result has incorrect content metadata.");
    }
    const std::string firstAssetIdText = *firstAssetId;
    const std::string firstBlobIdText = *firstBlobId;

    auto duplicateImport = addAsset(archivePath, duplicatePath);
    if (!duplicateImport || duplicateImport->exitCode != 0)
        return reportFailure("duplicate asset import", duplicateImport
                                                           ? duplicateImport->output
                                                           : duplicateImport.error().message);
    auto duplicateSummary = command::parseJson(duplicateImport->output);
    if (!duplicateSummary || !duplicateSummary->asArray() ||
        duplicateSummary->asArray()->size() != 1 ||
        jsonString(duplicateSummary->asArray()->front(), "blob_id") == nullptr ||
        *jsonString(duplicateSummary->asArray()->front(), "blob_id") != firstBlobIdText) {
        return reportFailure("asset content deduplication", duplicateSummary
                                                                ? duplicateImport->output
                                                                : duplicateSummary.error().message);
    }

    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("archive reopen", opened.error().message);
        auto assets = opened->list(archive::RecordType::AssetMetadata);
        auto blobs = opened->list(archive::RecordType::AssetBlob);
        if (!assets || !blobs || assets->size() != 2 || blobs->size() != 1)
            return reportFailure("archive asset counts",
                                 "Duplicate bytes were stored more than once.");
        auto firstBlobIdParsed = archive::uuidFromString(firstBlobIdText);
        auto firstAssetIdParsed = archive::uuidFromString(firstAssetIdText);
        if (!firstBlobIdParsed || !firstAssetIdParsed)
            return reportFailure("asset identifiers", "The CLI returned an invalid UUID.");
        auto storedBlob = opened->get(archive::RecordType::AssetBlob, *firstBlobIdParsed);
        auto storedAsset = opened->get(archive::RecordType::AssetMetadata, *firstAssetIdParsed);
        if (!storedBlob || !*storedBlob || (*storedBlob)->blob != content || !storedAsset ||
            !*storedAsset ||
            domain::getField(**storedAsset, "byte_size") != std::to_string(content.size())) {
            return reportFailure("archive content", "Imported bytes or size metadata changed.");
        }
        if (auto status = opened->verify(true); !status || !status->valid)
            return reportFailure("archive integrity",
                                 status ? "The imported archive failed verification."
                                        : status.error().message);
    }

    const auto inspection = assets::inspectFile(firstPath, content.size());
    if (!inspection || inspection->byteSize != content.size())
        return reportFailure("asset inspection",
                             inspection ? "Incorrect file size." : inspection.error().message);
    const auto rejected = assets::inspectFile(firstPath, content.size() - 1);
    if (rejected || rejected.error().code != "asset_size_limit")
        return reportFailure("asset size bound", "Oversized input was not rejected.");

    std::vector<std::byte> changed = content;
    changed.front() ^= std::byte{0xff};
    if (!writeBytes(firstPath, changed))
        return reportFailure("change source", "Unable to alter the test asset.");
    auto rejectedChange = assets::readVerifiedFile(firstPath, *inspection);
    if (rejectedChange || rejectedChange.error().code != "asset_source_changed")
        return reportFailure("source mutation detection", "Changed source bytes were accepted.");

    return 0;
}

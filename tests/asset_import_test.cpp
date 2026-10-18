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
    output.write(reinterpret_cast<const char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()));
    return static_cast<bool>(output);
}

bool writeText(const std::filesystem::path& path, std::string_view text) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    return static_cast<bool>(output);
}

void appendLe16(std::string& bytes, std::uint16_t value) {
    bytes.push_back(static_cast<char>(value & 0xffU));
    bytes.push_back(static_cast<char>((value >> 8U) & 0xffU));
}

void appendLe32(std::string& bytes, std::uint32_t value) {
    appendLe16(bytes, static_cast<std::uint16_t>(value & 0xffffU));
    appendLe16(bytes, static_cast<std::uint16_t>(value >> 16U));
}

std::uint32_t zipCrc32(std::string_view bytes) {
    std::uint32_t crc = 0xffffffffU;
    for (unsigned char byte : bytes) {
        crc ^= byte;
        for (unsigned bit = 0; bit < 8; ++bit)
            crc = (crc >> 1U) ^ (0xedb88320U & (0U - (crc & 1U)));
    }
    return ~crc;
}

std::string makePdfFixture() {
    const std::string stream = "BT /F1 12 Tf 72 720 Td (Portable PDF extraction) Tj ET\n";
    const std::vector<std::string> objects = {"<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
                                              "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                                              "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
                                              "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
                                              "<< /Length " + std::to_string(stream.size()) + " >>\nstream\n" + stream + "endstream"};
    std::string pdf = "%PDF-1.4\n";
    std::vector<std::size_t> offsets{0};
    for (std::size_t index = 0; index < objects.size(); ++index) {
        offsets.push_back(pdf.size());
        pdf += std::to_string(index + 1) + " 0 obj\n" + objects[index] + "\nendobj\n";
    }
    const std::size_t xrefOffset = pdf.size();
    pdf += "xref\n0 " + std::to_string(objects.size() + 1) + "\n";
    pdf += "0000000000 65535 f \n";
    for (std::size_t index = 1; index < offsets.size(); ++index) {
        std::string offset = std::to_string(offsets[index]);
        pdf.append(10U - offset.size(), '0');
        pdf += offset + " 00000 n \n";
    }
    pdf += "trailer\n<< /Size " + std::to_string(objects.size() + 1) + " /Root 1 0 R >>\n";
    pdf += "startxref\n" + std::to_string(xrefOffset) + "\n%%EOF\n";
    return pdf;
}

std::string makeDocxFixture() {
    constexpr std::string_view name = "word/document.xml";
    constexpr std::string_view xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>"
                                     "<w:document xmlns:w=\"urn:word\"><w:body><w:p><w:r><w:t>"
                                     "DOCX extracted &amp; archived"
                                     "</w:t></w:r></w:p></w:body></w:document>";
    // A final, raw DEFLATE stored block keeps the fixture dependency free.
    std::string compressed;
    compressed.push_back('\x01');
    appendLe16(compressed, static_cast<std::uint16_t>(xml.size()));
    appendLe16(compressed, static_cast<std::uint16_t>(~static_cast<std::uint16_t>(xml.size())));
    compressed.append(xml);

    const std::uint32_t crc = zipCrc32(xml);
    std::string zip;
    appendLe32(zip, 0x04034b50U);
    appendLe16(zip, 20);
    appendLe16(zip, 0);
    appendLe16(zip, 8);
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe32(zip, crc);
    appendLe32(zip, static_cast<std::uint32_t>(compressed.size()));
    appendLe32(zip, static_cast<std::uint32_t>(xml.size()));
    appendLe16(zip, static_cast<std::uint16_t>(name.size()));
    appendLe16(zip, 0);
    zip.append(name);
    zip.append(compressed);

    const std::uint32_t centralOffset = static_cast<std::uint32_t>(zip.size());
    appendLe32(zip, 0x02014b50U);
    appendLe16(zip, 20);
    appendLe16(zip, 20);
    appendLe16(zip, 0);
    appendLe16(zip, 8);
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe32(zip, crc);
    appendLe32(zip, static_cast<std::uint32_t>(compressed.size()));
    appendLe32(zip, static_cast<std::uint32_t>(xml.size()));
    appendLe16(zip, static_cast<std::uint16_t>(name.size()));
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe32(zip, 0);
    appendLe32(zip, 0);
    zip.append(name);
    const std::uint32_t centralSize = static_cast<std::uint32_t>(zip.size()) - centralOffset;
    appendLe32(zip, 0x06054b50U);
    appendLe16(zip, 0);
    appendLe16(zip, 0);
    appendLe16(zip, 1);
    appendLe16(zip, 1);
    appendLe32(zip, centralSize);
    appendLe32(zip, centralOffset);
    appendLe16(zip, 0);
    return zip;
}

const std::string* jsonString(const tutorux::command::JsonValue& value, std::string_view key) {
    const auto* object = value.asObject();
    if (!object)
        return nullptr;
    const auto found = object->find(key);
    return found == object->end() ? nullptr : found->second.asString();
}

tutorux::core::Result<tutorux::command::CommandResult> addAsset(const std::filesystem::path& archivePath,
                                                                const std::filesystem::path& filePath) {
    return tutorux::command::dispatch({"--archive", archivePath.string(), "--json", "asset", "add", filePath.string()});
}

} // namespace

int main() {
    using namespace tutorux;

    constexpr std::string_view emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    constexpr std::string_view abcHash = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
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
        return reportFailure("chunked streaming hash", "SHA-256 did not match the standard vector.");

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() / ("tutorux-asset-import-" + std::to_string(uniqueSuffix))};
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
    constexpr std::string_view largeContentHash = "8667b4858bffa54055e67e09de7a61f25e541136b8f21dbb1908555cda36e344";
    if (domain::hexHash(content) != largeContentHash)
        return reportFailure("multi-block streaming hash", "SHA-256 did not match the independently verified fixture.");
    if (!writeBytes(firstPath, content) || !writeBytes(duplicatePath, content))
        return reportFailure("asset inputs", "Unable to write the test assets.");

    {
        auto created = archive::Archive::create(archivePath, "Asset import test");
        if (!created)
            return reportFailure("archive creation", created.error().message);
    }

    auto firstImport = addAsset(archivePath, firstPath);
    if (!firstImport || firstImport->exitCode != 0)
        return reportFailure("first asset import", firstImport ? firstImport->output : firstImport.error().message);
    auto firstSummary = command::parseJson(firstImport->output);
    if (!firstSummary || !firstSummary->asArray() || firstSummary->asArray()->size() != 1)
        return reportFailure("first asset import result", firstSummary ? firstImport->output : firstSummary.error().message);
    const std::string* firstAssetId = jsonString(firstSummary->asArray()->front(), "id");
    const std::string* firstBlobId = jsonString(firstSummary->asArray()->front(), "blob_id");
    if (!firstAssetId || !firstBlobId || jsonString(firstSummary->asArray()->front(), "content_hash") == nullptr ||
        *jsonString(firstSummary->asArray()->front(), "content_hash") != domain::hexHash(content)) {
        return reportFailure("asset metadata", "The import result has incorrect content metadata.");
    }
    const std::string firstAssetIdText = *firstAssetId;
    const std::string firstBlobIdText = *firstBlobId;

    auto duplicateImport = addAsset(archivePath, duplicatePath);
    if (!duplicateImport || duplicateImport->exitCode != 0)
        return reportFailure("duplicate asset import", duplicateImport ? duplicateImport->output : duplicateImport.error().message);
    auto duplicateSummary = command::parseJson(duplicateImport->output);
    if (!duplicateSummary || !duplicateSummary->asArray() || duplicateSummary->asArray()->size() != 1 ||
        jsonString(duplicateSummary->asArray()->front(), "blob_id") == nullptr ||
        *jsonString(duplicateSummary->asArray()->front(), "blob_id") != firstBlobIdText) {
        return reportFailure("asset content deduplication", duplicateSummary ? duplicateImport->output : duplicateSummary.error().message);
    }

    {
        auto opened = archive::Archive::open(archivePath);
        if (!opened)
            return reportFailure("archive reopen", opened.error().message);
        auto assets = opened->list(archive::RecordType::AssetMetadata);
        auto blobs = opened->list(archive::RecordType::AssetBlob);
        if (!assets || !blobs || assets->size() != 2 || blobs->size() != 2)
            return reportFailure("archive asset counts", "Duplicate asset imports changed the content-addressed blob set.");
        auto firstBlobIdParsed = archive::uuidFromString(firstBlobIdText);
        auto firstAssetIdParsed = archive::uuidFromString(firstAssetIdText);
        if (!firstBlobIdParsed || !firstAssetIdParsed)
            return reportFailure("asset identifiers", "The CLI returned an invalid UUID.");
        auto storedBlob = opened->get(archive::RecordType::AssetBlob, *firstBlobIdParsed);
        auto storedAsset = opened->get(archive::RecordType::AssetMetadata, *firstAssetIdParsed);
        if (!storedBlob || !*storedBlob || domain::getField(**storedBlob, "record_role") != "asset-blob-manifest" ||
            domain::getField(**storedBlob, "chunk_count") != "1" || !storedAsset || !*storedAsset ||
            domain::getField(**storedAsset, "byte_size") != std::to_string(content.size())) {
            return reportFailure("archive content", "Imported manifest or size metadata changed.");
        }
        std::vector<std::byte> reconstructed;
        reconstructed.reserve(content.size());
        auto streamed = assets::visitArchiveAsset(*opened, **storedAsset, [&](std::span<const std::byte> chunk) -> core::Status {
            reconstructed.insert(reconstructed.end(), chunk.begin(), chunk.end());
            return {};
        });
        if (!streamed || reconstructed != content)
            return reportFailure("archive content", "Imported bytes changed during streaming.");
        if (auto status = opened->verify(true); !status || !status->valid)
            return reportFailure("archive integrity", status ? "The imported archive failed verification." : status.error().message);
    }

    const auto documentArchivePath = temporary.path / "documents.tux";
    const auto pdfPath = temporary.path / "document.pdf";
    const auto docxPath = temporary.path / "document.docx";
    const auto malformedPdfPath = temporary.path / "malformed.pdf";
    const auto malformedDocxPath = temporary.path / "malformed.docx";
    const std::string pdfFixture = makePdfFixture();
    const std::string docxFixture = makeDocxFixture();
    if (!writeText(pdfPath, pdfFixture) || !writeText(docxPath, docxFixture))
        return reportFailure("document fixtures", "Unable to write PDF or DOCX fixtures.");
    {
        auto created = archive::Archive::create(documentArchivePath, "Document text extraction test");
        if (!created)
            return reportFailure("document archive creation", created.error().message);
    }
    archive::Record pdfMetadata;
    archive::Record docxMetadata;
    {
        auto opened = archive::Archive::open(documentArchivePath);
        if (!opened)
            return reportFailure("document archive open", opened.error().message);
        auto imported = assets::importIntoArchive(*opened, pdfPath);
        if (!imported)
            return reportFailure("PDF text extraction", imported.error().message);
        pdfMetadata = std::move(imported->metadata);
    }
    if (domain::getField(pdfMetadata, "text_extraction_status") != "extracted" ||
        domain::getField(pdfMetadata, "extracted_text").find("Portable PDF extraction") == std::string::npos) {
        return reportFailure("PDF text metadata", "Extracted PDF text was not persisted.");
    }
    {
        auto opened = archive::Archive::open(documentArchivePath);
        if (!opened)
            return reportFailure("document archive reopen", opened.error().message);
        auto imported = assets::importIntoArchive(*opened, docxPath);
        if (!imported)
            return reportFailure("DOCX text extraction", imported.error().message);
        docxMetadata = std::move(imported->metadata);
    }
    if (domain::getField(docxMetadata, "text_extraction_status") != "extracted" ||
        domain::getField(docxMetadata, "extracted_text") != "DOCX extracted & archived") {
        return reportFailure("DOCX text metadata", "Extracted DOCX text or XML entities changed.");
    }
    const std::string malformedZip = std::string("PK\x03\x04", 4) + "broken";
    if (!writeText(malformedPdfPath, "%PDF-1.4\nmalformed fixture\n") || !writeText(malformedDocxPath, malformedZip)) {
        return reportFailure("malformed document fixtures", "Unable to write malformed fixtures.");
    }
    for (const auto& malformedPath : {malformedPdfPath, malformedDocxPath}) {
        auto opened = archive::Archive::open(documentArchivePath);
        if (!opened)
            return reportFailure("malformed-document archive open", opened.error().message);
        auto rejectedDocument = assets::importIntoArchive(*opened, malformedPath);
        if (rejectedDocument || rejectedDocument.error().code != "asset_document_invalid")
            return reportFailure("malformed document rejection", "Malformed PDF or DOCX did not fail with an explicit document error.");
    }
    {
        auto opened = archive::Archive::open(documentArchivePath);
        if (!opened)
            return reportFailure("document archive integrity open", opened.error().message);
        auto documentAssets = opened->list(archive::RecordType::AssetMetadata);
        if (!documentAssets || documentAssets->size() != 2)
            return reportFailure("malformed-document archive integrity", "Rejected document imports changed archive metadata.");
        if (auto status = opened->verify(true); !status || !status->valid)
            return reportFailure("document archive integrity",
                                 status ? "The document archive failed verification." : status.error().message);
    }

    const auto inspection = assets::inspectFile(firstPath, content.size());
    if (!inspection || inspection->byteSize != content.size())
        return reportFailure("asset inspection", inspection ? "Incorrect file size." : inspection.error().message);
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

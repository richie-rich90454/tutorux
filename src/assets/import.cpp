#include "tutorux/assets/import.hpp"

#include "tutorux/assets/mime.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <fstream>
#include <limits>
#include <optional>
#include <span>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

#include <zlib.h>

#ifndef __EMSCRIPTEN__
#if defined(TUTORUX_WITH_PDF) && TUTORUX_WITH_PDF && !defined(__EMSCRIPTEN__)
#include <podofo/podofo.h>
#endif
#endif

namespace tutorux::assets {
namespace {

    constexpr std::size_t ioBufferSize = 64U * 1024U;
    constexpr std::size_t signaturePrefixSize = 32;
    constexpr std::size_t archiveAssetChunkBytes = 8U * 1024U * 1024U;
    constexpr std::size_t archiveAssetBatchChunkCount = 4;
    constexpr std::size_t documentExtractionInputLimit = 16U * 1024U * 1024U;
    constexpr std::size_t documentExtractionTextLimit = 2U * 1024U * 1024U;
    constexpr std::size_t docxXmlLimit = 4U * 1024U * 1024U;
    constexpr std::size_t docxEntryLimit = 2048;
    constexpr std::size_t pdfPageLimit = 512;
    constexpr unsigned pdfOperatorLimit = 200000;

    struct ExtractedDocumentText final {
        std::string text;
        std::string status;
    };

    std::string pathFileNameUtf8(const std::filesystem::path& path) {
        const std::u8string fileName = path.filename().u8string();
        return {reinterpret_cast<const char*>(fileName.data()), fileName.size()};
    }

    core::Error fileError(std::string code, std::string message) {
        return core::error(std::move(code), std::move(message));
    }

    core::Status validateImportSource(const std::filesystem::path& path) {
        std::error_code errorCode;
        const auto status = std::filesystem::symlink_status(path, errorCode);
        if (errorCode) {
            return std::unexpected(fileError("asset_read_failed", "Unable to inspect the selected asset file."));
        }
        if (std::filesystem::is_symlink(status)) {
            return std::unexpected(
                fileError("asset_symbolic_link_rejected", "Symbolic links cannot be imported. Select the regular file directly."));
        }
        if (!std::filesystem::is_regular_file(status)) {
            return std::unexpected(fileError("asset_not_regular_file", "The selected asset must be a regular file."));
        }
        return {};
    }

    core::Result<std::uint64_t> parseUnsigned(std::string_view value, std::string_view fieldName) {
        std::uint64_t parsed = 0;
        const auto [end, errorCode] = std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(fileError("asset_metadata_invalid", "Asset " + std::string(fieldName) + " metadata is invalid."));
        }
        return parsed;
    }

    std::vector<std::string_view> splitIdentifiers(std::string_view value) {
        std::vector<std::string_view> identifiers;
        std::size_t start = 0;
        while (start < value.size()) {
            const std::size_t end = value.find(',', start);
            const std::size_t itemEnd = end == std::string_view::npos ? value.size() : end;
            if (itemEnd == start)
                return {};
            identifiers.push_back(value.substr(start, itemEnd - start));
            if (end == std::string_view::npos)
                break;
            start = end + 1;
        }
        return identifiers;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    std::uint16_t readLe16(std::span<const std::byte> bytes, std::size_t offset) {
        return static_cast<std::uint16_t>(std::to_integer<unsigned char>(bytes[offset])) |
               static_cast<std::uint16_t>(static_cast<std::uint16_t>(std::to_integer<unsigned char>(bytes[offset + 1])) << 8U);
    }

    std::uint32_t readLe32(std::span<const std::byte> bytes, std::size_t offset) {
        return static_cast<std::uint32_t>(readLe16(bytes, offset)) | (static_cast<std::uint32_t>(readLe16(bytes, offset + 2)) << 16U);
    }

    core::Error documentError(std::string message) {
        return fileError("asset_document_invalid", std::move(message));
    }

    core::Error textLimitError(std::string message) {
        return fileError("asset_text_limit", std::move(message));
    }

    bool appendUtf8(std::string& output, std::uint32_t codePoint) {
        if (codePoint == 0 || codePoint > 0x10ffffU || (codePoint >= 0xd800U && codePoint <= 0xdfffU)) {
            return false;
        }
        if (codePoint <= 0x7fU) {
            output.push_back(static_cast<char>(codePoint));
        } else if (codePoint <= 0x7ffU) {
            output.push_back(static_cast<char>(0xc0U | (codePoint >> 6U)));
            output.push_back(static_cast<char>(0x80U | (codePoint & 0x3fU)));
        } else if (codePoint <= 0xffffU) {
            output.push_back(static_cast<char>(0xe0U | (codePoint >> 12U)));
            output.push_back(static_cast<char>(0x80U | ((codePoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codePoint & 0x3fU)));
        } else {
            output.push_back(static_cast<char>(0xf0U | (codePoint >> 18U)));
            output.push_back(static_cast<char>(0x80U | ((codePoint >> 12U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | ((codePoint >> 6U) & 0x3fU)));
            output.push_back(static_cast<char>(0x80U | (codePoint & 0x3fU)));
        }
        return true;
    }

    bool isValidUtf8(std::string_view text) {
        for (std::size_t index = 0; index < text.size();) {
            const auto first = static_cast<unsigned char>(text[index]);
            std::uint32_t codePoint = 0;
            std::size_t length = 0;
            if (first <= 0x7fU) {
                codePoint = first;
                length = 1;
            } else if ((first & 0xe0U) == 0xc0U) {
                codePoint = first & 0x1fU;
                length = 2;
            } else if ((first & 0xf0U) == 0xe0U) {
                codePoint = first & 0x0fU;
                length = 3;
            } else if ((first & 0xf8U) == 0xf0U) {
                codePoint = first & 0x07U;
                length = 4;
            } else {
                return false;
            }
            if (length > text.size() - index)
                return false;
            for (std::size_t continuation = 1; continuation < length; ++continuation) {
                const auto next = static_cast<unsigned char>(text[index + continuation]);
                if ((next & 0xc0U) != 0x80U)
                    return false;
                codePoint = (codePoint << 6U) | (next & 0x3fU);
            }
            if ((length == 2 && codePoint < 0x80U) || (length == 3 && codePoint < 0x800U) || (length == 4 && codePoint < 0x10000U) ||
                codePoint > 0x10ffffU || (codePoint >= 0xd800U && codePoint <= 0xdfffU) || codePoint == 0 ||
                (codePoint < 0x20U && codePoint != 0x09U && codePoint != 0x0aU && codePoint != 0x0dU)) {
                return false;
            }
            index += length;
        }
        return true;
    }

    bool appendXmlEntity(std::string& output, std::string_view entity) {
        if (entity == "amp")
            output.push_back('&');
        else if (entity == "lt")
            output.push_back('<');
        else if (entity == "gt")
            output.push_back('>');
        else if (entity == "quot")
            output.push_back('"');
        else if (entity == "apos")
            output.push_back('\'');
        else if (!entity.empty() && entity.front() == '#') {
            std::uint32_t value = 0;
            const bool hexadecimal = entity.size() > 1 && (entity[1] == 'x' || entity[1] == 'X');
            const std::string_view digits = entity.substr(hexadecimal ? 2U : 1U);
            if (digits.empty())
                return false;
            for (const char digit : digits) {
                unsigned int number = 0;
                if (digit >= '0' && digit <= '9')
                    number = static_cast<unsigned int>(digit - '0');
                else if (hexadecimal && digit >= 'a' && digit <= 'f')
                    number = static_cast<unsigned int>(digit - 'a' + 10);
                else if (hexadecimal && digit >= 'A' && digit <= 'F')
                    number = static_cast<unsigned int>(digit - 'A' + 10);
                else
                    return false;
                const unsigned int radix = hexadecimal ? 16U : 10U;
                if (value > (0x10ffffU - number) / radix)
                    return false;
                value = value * radix + number;
            }
            return appendUtf8(output, value);
        } else {
            return false;
        }
        return true;
    }

    core::Result<std::string> extractDocxXmlText(std::string_view xml) {
        if (xml.size() >= 3 && static_cast<unsigned char>(xml[0]) == 0xefU && static_cast<unsigned char>(xml[1]) == 0xbbU &&
            static_cast<unsigned char>(xml[2]) == 0xbfU) {
            xml.remove_prefix(3);
        }
        if (!isValidUtf8(xml))
            return std::unexpected(documentError("DOCX main document is not valid UTF-8."));

        std::string output;
        output.reserve(std::min(xml.size(), documentExtractionTextLimit));
        std::vector<std::string_view> elements;
        elements.reserve(32);
        bool sawDocumentRoot = false;
        bool sawRootClose = false;
        bool insideWordText = false;
        bool textLimitExceeded = false;
        std::size_t cursor = 0;

        auto appendText = [&](std::string_view value, bool entities) -> bool {
            std::string decoded;
            decoded.reserve(value.size());
            for (std::size_t position = 0; position < value.size();) {
                if (entities && value[position] == '&') {
                    const std::size_t end = value.find(';', position + 1);
                    if (end == std::string_view::npos || end - position > 16U ||
                        !appendXmlEntity(decoded, value.substr(position + 1, end - position - 1))) {
                        return false;
                    }
                    position = end + 1;
                } else {
                    decoded.push_back(value[position++]);
                }
            }
            if (decoded.size() > documentExtractionTextLimit - output.size()) {
                textLimitExceeded = true;
                return false;
            }
            output += decoded;
            return true;
        };

        while (cursor < xml.size()) {
            const std::size_t tagStart = xml.find('<', cursor);
            if (tagStart == std::string_view::npos) {
                if (insideWordText && !appendText(xml.substr(cursor), true))
                    return std::unexpected(textLimitExceeded ? textLimitError("DOCX text exceeds the extraction limit.")
                                                             : documentError("DOCX text contains an invalid XML entity."));
                cursor = xml.size();
                break;
            }
            if (insideWordText && !appendText(xml.substr(cursor, tagStart - cursor), true))
                return std::unexpected(textLimitExceeded ? textLimitError("DOCX text exceeds the extraction limit.")
                                                         : documentError("DOCX text contains an invalid XML entity."));

            if (xml.substr(tagStart).starts_with("<!--")) {
                const std::size_t commentEnd = xml.find("-->", tagStart + 4);
                if (commentEnd == std::string_view::npos)
                    return std::unexpected(documentError("DOCX XML contains an unterminated comment."));
                cursor = commentEnd + 3;
                continue;
            }
            if (xml.substr(tagStart).starts_with("<![CDATA[")) {
                const std::size_t cdataEnd = xml.find("]]>", tagStart + 9);
                if (cdataEnd == std::string_view::npos)
                    return std::unexpected(documentError("DOCX XML contains an unterminated CDATA section."));
                if (insideWordText && !appendText(xml.substr(tagStart + 9, cdataEnd - tagStart - 9), false))
                    return std::unexpected(textLimitExceeded ? textLimitError("DOCX text exceeds the extraction limit.")
                                                             : documentError("DOCX text is malformed."));
                cursor = cdataEnd + 3;
                continue;
            }
            if (xml.substr(tagStart).starts_with("<?")) {
                const std::size_t instructionEnd = xml.find("?>", tagStart + 2);
                if (instructionEnd == std::string_view::npos)
                    return std::unexpected(documentError("DOCX XML contains an unterminated processing instruction."));
                cursor = instructionEnd + 2;
                continue;
            }
            if (xml.substr(tagStart).starts_with("<!"))
                return std::unexpected(documentError("DOCX XML declarations and doctypes are unsupported."));

            const std::size_t tagEnd = xml.find('>', tagStart + 1);
            if (tagEnd == std::string_view::npos)
                return std::unexpected(documentError("DOCX XML contains an unterminated tag."));
            std::string_view tag = xml.substr(tagStart + 1, tagEnd - tagStart - 1);
            bool closing = false;
            bool selfClosing = false;
            if (!tag.empty() && tag.front() == '/') {
                closing = true;
                tag.remove_prefix(1);
            }
            if (!tag.empty() && tag.back() == '/') {
                selfClosing = true;
                tag.remove_suffix(1);
            }
            const std::size_t nameEnd = tag.find_first_of(" \t\r\n/");
            const std::string_view name = tag.substr(0, nameEnd);
            if (name.empty() || name.size() > 256U)
                return std::unexpected(documentError("DOCX XML contains an invalid element name."));

            if (closing) {
                if (selfClosing || elements.empty() || elements.back() != name)
                    return std::unexpected(documentError("DOCX XML element nesting is invalid."));
                if (name == "w:t")
                    insideWordText = false;
                if (name == "w:p" && !output.empty() && output.back() != '\n' && output.size() < documentExtractionTextLimit) {
                    output.push_back('\n');
                }
                if (elements.size() == 1U)
                    sawRootClose = true;
                elements.pop_back();
            } else {
                if (!sawDocumentRoot && elements.empty()) {
                    if (name != "w:document")
                        return std::unexpected(documentError("DOCX package does not contain a Word document root."));
                    sawDocumentRoot = true;
                }
                if (sawRootClose || elements.size() >= 256U)
                    return std::unexpected(documentError("DOCX XML nesting exceeds the supported limit."));
                if (name == "w:t")
                    insideWordText = !selfClosing;
                if ((name == "w:tab" || name == "w:br" || name == "w:cr") && output.size() < documentExtractionTextLimit) {
                    output.push_back(name == "w:tab" ? '\t' : '\n');
                }
                if (!selfClosing)
                    elements.push_back(name);
                else if (name == "w:p" && !output.empty() && output.back() != '\n' && output.size() < documentExtractionTextLimit) {
                    output.push_back('\n');
                }
            }

            // Attribute syntax is checked by requiring each quote to close before the tag end.
            char quote = 0;
            for (std::size_t position = name.size(); position < tag.size(); ++position) {
                const char character = tag[position];
                if (quote != 0) {
                    if (character == quote)
                        quote = 0;
                } else if (character == '\'' || character == '"') {
                    quote = character;
                } else if (character == '<') {
                    return std::unexpected(documentError("DOCX XML contains an invalid attribute."));
                }
            }
            if (quote != 0)
                return std::unexpected(documentError("DOCX XML contains an unterminated attribute."));
            cursor = tagEnd + 1;
        }
        if (!elements.empty() || !sawDocumentRoot || !sawRootClose)
            return std::unexpected(documentError("DOCX XML document is incomplete."));
        while (!output.empty() && (output.back() == '\n' || output.back() == '\r'))
            output.pop_back();
        return output;
    }

    core::Result<std::string> extractDocxText(std::span<const std::byte> archiveBytes) {
        constexpr std::uint32_t endSignature = 0x06054b50U;
        constexpr std::uint32_t centralSignature = 0x02014b50U;
        constexpr std::uint32_t localSignature = 0x04034b50U;
        if (archiveBytes.size() < 22U)
            return std::unexpected(documentError("DOCX ZIP directory is missing."));

        const std::size_t searchBegin = archiveBytes.size() > 65557U ? archiveBytes.size() - 65557U : 0U;
        std::optional<std::size_t> endOffset;
        for (std::size_t cursor = archiveBytes.size() - 22U;; --cursor) {
            if (readLe32(archiveBytes, cursor) == endSignature) {
                const std::uint16_t commentLength = readLe16(archiveBytes, cursor + 20U);
                if (cursor + 22U + commentLength == archiveBytes.size()) {
                    endOffset = cursor;
                    break;
                }
            }
            if (cursor == searchBegin)
                break;
        }
        if (!endOffset)
            return std::unexpected(documentError("DOCX ZIP end directory is invalid."));
        const std::size_t eocd = *endOffset;
        const std::uint16_t disk = readLe16(archiveBytes, eocd + 4U);
        const std::uint16_t directoryDisk = readLe16(archiveBytes, eocd + 6U);
        const std::uint16_t diskEntries = readLe16(archiveBytes, eocd + 8U);
        const std::uint16_t entryCount = readLe16(archiveBytes, eocd + 10U);
        const std::uint32_t directorySize = readLe32(archiveBytes, eocd + 12U);
        const std::uint32_t directoryOffset = readLe32(archiveBytes, eocd + 16U);
        if (disk != 0 || directoryDisk != 0 || diskEntries != entryCount || entryCount == 0 || entryCount > docxEntryLimit ||
            entryCount == 0xffffU || directorySize == 0xffffffffU || directoryOffset == 0xffffffffU ||
            static_cast<std::uint64_t>(directoryOffset) + directorySize > eocd) {
            return std::unexpected(documentError("DOCX ZIP directory uses unsupported or invalid bounds."));
        }
        const std::size_t directoryEnd = static_cast<std::size_t>(directoryOffset) + directorySize;
        std::size_t cursor = directoryOffset;
        std::optional<std::size_t> documentLocalOffset;
        std::uint32_t expectedCrc = 0;
        std::uint32_t compressedSize = 0;
        std::uint32_t uncompressedSize = 0;
        std::uint16_t compressionMethod = 0;
        std::uint16_t generalFlags = 0;
        std::string documentName;
        for (std::uint16_t index = 0; index < entryCount; ++index) {
            if (cursor > directoryEnd || directoryEnd - cursor < 46U || readLe32(archiveBytes, cursor) != centralSignature) {
                return std::unexpected(documentError("DOCX ZIP central directory entry is invalid."));
            }
            const std::uint16_t flags = readLe16(archiveBytes, cursor + 8U);
            const std::uint16_t method = readLe16(archiveBytes, cursor + 10U);
            const std::uint32_t crc = readLe32(archiveBytes, cursor + 16U);
            const std::uint32_t packed = readLe32(archiveBytes, cursor + 20U);
            const std::uint32_t unpacked = readLe32(archiveBytes, cursor + 24U);
            const std::uint16_t nameLength = readLe16(archiveBytes, cursor + 28U);
            const std::uint16_t extraLength = readLe16(archiveBytes, cursor + 30U);
            const std::uint16_t commentLength = readLe16(archiveBytes, cursor + 32U);
            const std::uint16_t diskStart = readLe16(archiveBytes, cursor + 34U);
            const std::uint32_t localOffset = readLe32(archiveBytes, cursor + 42U);
            const std::size_t recordSize = 46U + nameLength + extraLength + commentLength;
            if (recordSize > directoryEnd - cursor || diskStart != 0)
                return std::unexpected(documentError("DOCX ZIP central directory entry exceeds its bounds."));
            const char* nameData = reinterpret_cast<const char*>(archiveBytes.data() + cursor + 46U);
            const std::string_view name(nameData, nameLength);
            if (name == "word/document.xml") {
                if (documentLocalOffset)
                    return std::unexpected(documentError("DOCX ZIP contains duplicate main document entries."));
                documentLocalOffset = localOffset;
                expectedCrc = crc;
                compressedSize = packed;
                uncompressedSize = unpacked;
                compressionMethod = method;
                generalFlags = flags;
                documentName.assign(name);
            }
            cursor += recordSize;
        }
        if (cursor != directoryEnd || !documentLocalOffset)
            return std::unexpected(documentError("DOCX ZIP has no valid word/document.xml entry."));
        if ((generalFlags & 1U) != 0 || (generalFlags & 0x40U) != 0 || (compressionMethod != 0 && compressionMethod != 8) ||
            compressedSize > documentExtractionInputLimit || uncompressedSize > docxXmlLimit || compressedSize == 0 ||
            uncompressedSize == 0 || *documentLocalOffset > directoryOffset || *documentLocalOffset > archiveBytes.size() ||
            archiveBytes.size() - *documentLocalOffset < 30U || readLe32(archiveBytes, *documentLocalOffset) != localSignature) {
            if (uncompressedSize > docxXmlLimit)
                return std::unexpected(textLimitError("DOCX main document exceeds the extraction limit."));
            return std::unexpected(documentError("DOCX main document uses unsupported or invalid ZIP features."));
        }
        const std::size_t local = *documentLocalOffset;
        const std::uint16_t localFlags = readLe16(archiveBytes, local + 6U);
        const std::uint16_t localMethod = readLe16(archiveBytes, local + 8U);
        const std::uint16_t localNameLength = readLe16(archiveBytes, local + 26U);
        const std::uint16_t localExtraLength = readLe16(archiveBytes, local + 28U);
        const std::size_t dataOffset = local + 30U + localNameLength + localExtraLength;
        if (localFlags != generalFlags || localMethod != compressionMethod || localNameLength != documentName.size() ||
            dataOffset > directoryOffset || compressedSize > directoryOffset - dataOffset ||
            std::string_view(reinterpret_cast<const char*>(archiveBytes.data() + local + 30U), localNameLength) != documentName) {
            return std::unexpected(documentError("DOCX main document local header is inconsistent."));
        }

        std::vector<std::byte> xmlBytes(uncompressedSize);
        const auto compressed = reinterpret_cast<const Bytef*>(archiveBytes.data() + dataOffset);
        if (compressionMethod == 0) {
            if (compressedSize != uncompressedSize)
                return std::unexpected(documentError("DOCX stored document has inconsistent sizes."));
            std::copy_n(archiveBytes.data() + dataOffset, uncompressedSize, xmlBytes.data());
        } else {
            z_stream stream{};
            stream.next_in = const_cast<Bytef*>(compressed);
            stream.avail_in = compressedSize;
            stream.next_out = reinterpret_cast<Bytef*>(xmlBytes.data());
            stream.avail_out = uncompressedSize;
            if (inflateInit2(&stream, -MAX_WBITS) != Z_OK)
                return std::unexpected(documentError("DOCX deflate decoder could not be initialized."));
            const int result = inflate(&stream, Z_FINISH);
            const bool valid = result == Z_STREAM_END && stream.total_in == compressedSize && stream.total_out == uncompressedSize;
            inflateEnd(&stream);
            if (!valid)
                return std::unexpected(documentError("DOCX main document deflate stream is invalid."));
        }
        const auto actualCrc = crc32(0L, reinterpret_cast<const Bytef*>(xmlBytes.data()), static_cast<uInt>(xmlBytes.size()));
        if (actualCrc != expectedCrc)
            return std::unexpected(documentError("DOCX main document checksum does not match."));
        return extractDocxXmlText(std::string_view(reinterpret_cast<const char*>(xmlBytes.data()), xmlBytes.size()));
    }

#if defined(TUTORUX_WITH_PDF) && TUTORUX_WITH_PDF && !defined(__EMSCRIPTEN__)
    core::Result<std::string> extractPdfText(std::span<const std::byte> bytes) {
        if (bytes.empty())
            return std::unexpected(documentError("PDF file is empty."));
        try {
            PoDoFo::PdfMemDocument document;
            document.LoadFromBuffer(PoDoFo::bufferview(reinterpret_cast<const char*>(bytes.data()), bytes.size()));
            const unsigned pageCount = document.GetPages().GetCount();
            if (pageCount > pdfPageLimit)
                return std::unexpected(textLimitError("PDF exceeds the bounded text extraction page limit."));
            std::string output;
            for (unsigned pageIndex = 0; pageIndex < pageCount; ++pageIndex) {
                std::vector<PoDoFo::PdfTextEntry> entries;
                bool operationLimitReached = false;
                PoDoFo::PdfTextExtractParams parameters;
                parameters.AbortCheck = [&](const PoDoFo::AbortCheckInfo& info) {
                    operationLimitReached = info.ReadCount >= pdfOperatorLimit;
                    return operationLimitReached;
                };
                document.GetPages().GetPageAt(pageIndex).ExtractTextTo(entries, parameters);
                if (operationLimitReached)
                    return std::unexpected(textLimitError("PDF exceeds the bounded text extraction operation limit."));
                for (const auto& entry : entries) {
                    if (entry.Text.size() > documentExtractionTextLimit - output.size())
                        return std::unexpected(textLimitError("PDF text exceeds the extraction limit."));
                    output += entry.Text;
                    if (!entry.Text.empty() && output.back() != '\n' && output.size() < documentExtractionTextLimit) {
                        output.push_back('\n');
                    }
                }
            }
            while (!output.empty() && output.back() == '\n')
                output.pop_back();
            return output;
        } catch (const std::exception&) {
            return std::unexpected(documentError("PDF is malformed, encrypted, or cannot be parsed."));
        } catch (...) {
            return std::unexpected(documentError("PDF could not be parsed safely."));
        }
    }
#endif

    core::Result<ExtractedDocumentText> extractDocumentText(const std::filesystem::path& path, const FileInspection& inspection) {
        const bool isPdf = inspection.mimeType == "application/pdf";
        const bool isDocx = inspection.mimeType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        if (!isPdf && !isDocx)
            return ExtractedDocumentText{};
        if (inspection.byteSize > documentExtractionInputLimit) {
            return ExtractedDocumentText{{}, "size-limit"};
        }
#if !defined(TUTORUX_WITH_PDF) || !TUTORUX_WITH_PDF || defined(__EMSCRIPTEN__)
        if (isPdf)
            return ExtractedDocumentText{{}, "extractor-unavailable"};
#endif
        auto bytes = readVerifiedFile(path, inspection);
        if (!bytes)
            return std::unexpected(bytes.error());
        core::Result<std::string> extracted = std::string{};
        if (isPdf) {
#if defined(TUTORUX_WITH_PDF) && TUTORUX_WITH_PDF && !defined(__EMSCRIPTEN__)
            extracted = extractPdfText(*bytes);
#endif
        } else {
            extracted = extractDocxText(*bytes);
        }
        if (!extracted && extracted.error().code == "asset_text_limit")
            return ExtractedDocumentText{{}, "size-limit"};
        if (!extracted)
            return std::unexpected(extracted.error());
        if (extracted->size() > documentExtractionTextLimit)
            return ExtractedDocumentText{{}, "size-limit"};
        const bool hasText = std::any_of(extracted->begin(), extracted->end(), [](unsigned char value) {
            return value != ' ' && value != '\t' && value != '\r' && value != '\n';
        });
        return ExtractedDocumentText{hasText ? std::move(*extracted) : std::string{}, hasText ? "extracted" : "no-text"};
    }

    void setDocumentTextFields(archive::Record& metadata, const ExtractedDocumentText& extracted) {
        if (extracted.status.empty())
            return;
        metadata.fields["text_extraction_status"] = extracted.status;
        if (!extracted.text.empty())
            metadata.fields["extracted_text"] = extracted.text;
    }

} // namespace

core::Result<FileInspection> inspectFile(const std::filesystem::path& path, std::uint64_t maximumBytes) {
    if (auto status = validateImportSource(path); !status)
        return std::unexpected(status.error());

    std::error_code errorCode;
    const std::uint64_t expectedSize = std::filesystem::file_size(path, errorCode);
    if (errorCode) {
        return std::unexpected(fileError("asset_read_failed", "Unable to read the selected asset file."));
    }
    if (expectedSize > maximumBytes) {
        return std::unexpected(fileError("asset_size_limit", "The selected asset exceeds the configured size limit."));
    }

    std::ifstream input(path, std::ios::binary);
    if (!input) {
        return std::unexpected(fileError("asset_read_failed", "Unable to open the selected asset file."));
    }

    domain::Sha256Builder hash;
    std::array<std::byte, ioBufferSize> buffer{};
    std::array<std::byte, signaturePrefixSize> prefix{};
    std::uint64_t byteSize = 0;
    std::size_t prefixSize = 0;
    while (input) {
        input.read(reinterpret_cast<char*>(buffer.data()), static_cast<std::streamsize>(buffer.size()));
        const std::streamsize count = input.gcount();
        if (count < 0) {
            return std::unexpected(fileError("asset_read_failed", "The selected asset could not be read."));
        }
        const std::size_t chunkSize = static_cast<std::size_t>(count);
        if (chunkSize > maximumBytes - byteSize) {
            return std::unexpected(fileError("asset_size_limit", "The selected asset grew beyond the configured size limit."));
        }
        const auto chunk = std::span<const std::byte>(buffer.data(), chunkSize);
        hash.update(chunk);
        const std::size_t prefixCount = std::min(prefix.size() - prefixSize, chunkSize);
        std::copy_n(chunk.begin(), prefixCount, prefix.begin() + prefixSize);
        prefixSize += prefixCount;
        byteSize += static_cast<std::uint64_t>(chunkSize);
        if (input.bad()) {
            return std::unexpected(fileError("asset_read_failed", "The selected asset could not be read completely."));
        }
    }
    if (byteSize != expectedSize) {
        return std::unexpected(fileError("asset_source_changed", "The selected asset changed while it was being inspected."));
    }

    const auto prefixSpan = std::span<const std::byte>(prefix.data(), prefixSize);
    FileInspection inspection;
    inspection.byteSize = byteSize;
    inspection.sha256 = domain::hexHash(hash.finish());
    inspection.mimeType = detectMimeType(pathFileNameUtf8(path), prefixSpan);
    return inspection;
}

core::Result<std::vector<std::byte>> readVerifiedFile(const std::filesystem::path& path, const FileInspection& inspection) {
    if (auto status = validateImportSource(path); !status)
        return std::unexpected(status.error());

    if (inspection.byteSize > std::numeric_limits<std::size_t>::max() ||
        inspection.byteSize > static_cast<std::uint64_t>(std::numeric_limits<std::streamsize>::max())) {
        return std::unexpected(fileError("asset_size_limit", "The selected asset cannot fit in one archive record."));
    }

    std::ifstream input(path, std::ios::binary);
    if (!input) {
        return std::unexpected(fileError("asset_read_failed", "Unable to reopen the selected asset file."));
    }
    std::vector<std::byte> content(static_cast<std::size_t>(inspection.byteSize));
    if (!content.empty()) {
        input.read(reinterpret_cast<char*>(content.data()), static_cast<std::streamsize>(content.size()));
        if (input.gcount() != static_cast<std::streamsize>(content.size())) {
            return std::unexpected(fileError("asset_source_changed", "The selected asset changed while it was being imported."));
        }
    }
    char extraByte{};
    if (input.get(extraByte)) {
        return std::unexpected(fileError("asset_source_changed", "The selected asset grew while it was being imported."));
    }
    if (input.bad()) {
        return std::unexpected(fileError("asset_read_failed", "The selected asset could not be read completely."));
    }

    domain::Sha256Builder hash;
    hash.update(content);
    if (domain::hexHash(hash.finish()) != inspection.sha256) {
        return std::unexpected(fileError("asset_source_changed", "The selected asset changed while it was being imported."));
    }
    return content;
}

core::Result<ArchiveAssetImport> importIntoArchive(archive::Archive& archive, const std::filesystem::path& path, std::string_view sessionId,
                                                   std::uint64_t maximumBytes) {
    auto inspection = inspectFile(path, maximumBytes);
    if (!inspection)
        return std::unexpected(inspection.error());
    auto extractedText = extractDocumentText(path, *inspection);
    if (!extractedText)
        return std::unexpected(extractedText.error());

    archive::Uuid blobId{};
    bool deduplicated = false;
    std::uint32_t chunkCount = 0;
    auto existingBlob = archive.getByIndexKey("BLOB:" + inspection->sha256);
    if (!existingBlob)
        return std::unexpected(existingBlob.error());
    if (*existingBlob) {
        const archive::Record& existing = **existingBlob;
        if (existing.type != archive::RecordType::AssetBlob || domain::getField(existing, "content_hash") != inspection->sha256) {
            return std::unexpected(fileError("asset_blob_index_invalid", "Content hash index points to an invalid asset blob."));
        }
        archive::Record candidate;
        candidate.type = archive::RecordType::AssetMetadata;
        candidate.fields = {
            {"blob_id",      archive::uuidToString(existing.id)  },
            {"content_hash", inspection->sha256                  },
            {"byte_size",    std::to_string(inspection->byteSize)}
        };
        if (auto status = visitArchiveAsset(archive, candidate,
                                            [](std::span<const std::byte>) -> core::Status {
                                                return {};
                                            });
            !status) {
            return std::unexpected(status.error());
        }
        blobId = existing.id;
        deduplicated = true;
        if (domain::getField(existing, "record_role") == "asset-blob-manifest") {
            auto parsedCount = parseUnsigned(domain::getField(existing, "chunk_count"), "chunk count");
            if (!parsedCount)
                return std::unexpected(parsedCount.error());
            if (*parsedCount > std::numeric_limits<std::uint32_t>::max())
                return std::unexpected(fileError("asset_chunk_count_invalid", "Asset chunk count exceeds the supported range."));
            chunkCount = static_cast<std::uint32_t>(*parsedCount);
        } else {
            chunkCount = 1;
        }
    } else {
        if (auto status = validateImportSource(path); !status)
            return std::unexpected(status.error());

        std::ifstream input(path, std::ios::binary);
        if (!input)
            return std::unexpected(fileError("asset_read_failed", "Unable to reopen the selected asset."));

        blobId = archive::randomUuid();
        domain::Sha256Builder sourceHash;
        std::vector<std::string> chunkIds;
        std::vector<archive::Record> chunkBatch;
        chunkBatch.reserve(archiveAssetBatchChunkCount);
        std::uint64_t bytesRemaining = inspection->byteSize;
        std::uint64_t bytesRead = 0;
        while (bytesRemaining > 0) {
            const std::size_t chunkSize = static_cast<std::size_t>(std::min<std::uint64_t>(bytesRemaining, archiveAssetChunkBytes));
            archive::Record chunk;
            chunk.type = archive::RecordType::AssetBlob;
            chunk.id = archive::randomUuid();
            chunk.fields = {
                {"record_role", "asset-blob-chunk"             },
                {"manifest_id", archive::uuidToString(blobId)  },
                {"chunk_index", std::to_string(chunkIds.size())},
                {"byte_size",   std::to_string(chunkSize)      }
            };
            chunk.blob.resize(chunkSize);
            input.read(reinterpret_cast<char*>(chunk.blob.data()), static_cast<std::streamsize>(chunkSize));
            if (input.gcount() != static_cast<std::streamsize>(chunkSize))
                return std::unexpected(fileError("asset_source_changed", "The selected asset changed during archive import."));

            sourceHash.update(chunk.blob);
            chunkIds.push_back(archive::uuidToString(chunk.id));
            bytesRead += static_cast<std::uint64_t>(chunkSize);
            bytesRemaining -= static_cast<std::uint64_t>(chunkSize);
            chunkBatch.push_back(std::move(chunk));
            if (chunkBatch.size() == archiveAssetBatchChunkCount || bytesRemaining == 0) {
                if (auto status = archive.putMany(std::move(chunkBatch)); !status)
                    return std::unexpected(status.error());
                chunkBatch.clear();
                chunkBatch.reserve(archiveAssetBatchChunkCount);
            }
        }

        char extraByte{};
        if (input.get(extraByte) || input.bad() || bytesRead != inspection->byteSize ||
            domain::hexHash(sourceHash.finish()) != inspection->sha256) {
            return std::unexpected(fileError("asset_source_changed", "The selected asset changed during archive import."));
        }
        if (chunkIds.size() > std::numeric_limits<std::uint32_t>::max()) {
            return std::unexpected(fileError("asset_chunk_count_invalid", "The asset requires too many archive chunks."));
        }

        std::string encodedChunkIds;
        for (const auto& chunkId : chunkIds) {
            if (!encodedChunkIds.empty())
                encodedChunkIds.push_back(',');
            encodedChunkIds += chunkId;
        }
        chunkCount = static_cast<std::uint32_t>(chunkIds.size());
        archive::Record manifest;
        manifest.type = archive::RecordType::AssetBlob;
        manifest.id = blobId;
        manifest.fields = {
            {"record_role",  "asset-blob-manifest"               },
            {"content_hash", inspection->sha256                  },
            {"byte_size",    std::to_string(inspection->byteSize)},
            {"chunk_count",  std::to_string(chunkCount)          },
            {"chunk_ids",    std::move(encodedChunkIds)          }
        };

        archive::Record metadata;
        metadata.type = archive::RecordType::AssetMetadata;
        metadata.id = archive::randomUuid();
        const std::string fileName = pathFileNameUtf8(path);
        metadata.fields = {
            {"filename",      fileName                             },
            {"mime_type",     inspection->mimeType                 },
            {"byte_size",     std::to_string(inspection->byteSize) },
            {"content_hash",  inspection->sha256                   },
            {"blob_id",       archive::uuidToString(blobId)        },
            {"blob_count",    std::to_string(chunkCount)           },
            {"origin",        "user-import"                        },
            {"created_at_us", std::to_string(nowUnixMicroseconds())}
        };
        if (!sessionId.empty())
            metadata.fields["session_id"] = std::string(sessionId);
        setDocumentTextFields(metadata, *extractedText);
        if (auto status = archive.putMany({std::move(manifest), metadata}); !status)
            return std::unexpected(status.error());
        return ArchiveAssetImport{std::move(metadata), false, chunkCount};
    }

    archive::Record metadata;
    metadata.type = archive::RecordType::AssetMetadata;
    metadata.id = archive::randomUuid();
    metadata.fields = {
        {"filename",      pathFileNameUtf8(path)               },
        {"mime_type",     inspection->mimeType                 },
        {"byte_size",     std::to_string(inspection->byteSize) },
        {"content_hash",  inspection->sha256                   },
        {"blob_id",       archive::uuidToString(blobId)        },
        {"blob_count",    std::to_string(chunkCount)           },
        {"origin",        "user-import"                        },
        {"created_at_us", std::to_string(nowUnixMicroseconds())}
    };
    if (!sessionId.empty())
        metadata.fields["session_id"] = std::string(sessionId);
    setDocumentTextFields(metadata, *extractedText);
    if (auto status = archive.put(metadata); !status)
        return std::unexpected(status.error());
    return ArchiveAssetImport{std::move(metadata), deduplicated, chunkCount};
}

core::Status visitArchiveAsset(const archive::Archive& archive, const archive::Record& metadata,
                               const std::function<core::Status(std::span<const std::byte>)>& visitor) {
    if (!visitor)
        return std::unexpected(fileError("asset_visitor_invalid", "Asset visitor is required."));
    auto manifestId = archive::uuidFromString(domain::getField(metadata, "blob_id"));
    if (!manifestId)
        return std::unexpected(fileError("asset_blob_id_invalid", "Asset blob ID is invalid."));
    auto manifest = archive.get(archive::RecordType::AssetBlob, *manifestId);
    if (!manifest || !*manifest || domain::isDeleted(**manifest))
        return std::unexpected(fileError("asset_blob_missing", "Asset content is missing."));

    domain::Sha256Builder hash;
    std::uint64_t byteCount = 0;
    const std::string expectedHash = domain::getField(metadata, "content_hash");
    const std::string role = domain::getField(**manifest, "record_role");
    if (role != "asset-blob-manifest") {
        hash.update((*manifest)->blob);
        byteCount = (*manifest)->blob.size();
        if (auto status = visitor((*manifest)->blob); !status)
            return status;
    } else {
        const auto chunkIds = splitIdentifiers(domain::getField(**manifest, "chunk_ids"));
        auto expectedChunkCount = parseUnsigned(domain::getField(**manifest, "chunk_count"), "chunk count");
        if (!expectedChunkCount || *expectedChunkCount != chunkIds.size())
            return std::unexpected(fileError("asset_chunk_manifest_invalid", "Asset chunk manifest count is inconsistent."));
        for (std::size_t index = 0; index < chunkIds.size(); ++index) {
            auto chunkId = archive::uuidFromString(chunkIds[index]);
            if (!chunkId)
                return std::unexpected(fileError("asset_chunk_id_invalid", "Asset manifest contains an invalid chunk ID."));
            auto chunk = archive.get(archive::RecordType::AssetBlob, *chunkId);
            if (!chunk || !*chunk || domain::isDeleted(**chunk) || domain::getField(**chunk, "record_role") != "asset-blob-chunk" ||
                domain::getField(**chunk, "manifest_id") != archive::uuidToString(*manifestId) ||
                domain::getField(**chunk, "chunk_index") != std::to_string(index)) {
                return std::unexpected(fileError("asset_chunk_missing", "An asset chunk is missing or out of sequence."));
            }
            if ((*chunk)->blob.size() > std::numeric_limits<std::uint64_t>::max() - byteCount)
                return std::unexpected(fileError("asset_size_invalid", "Asset content size exceeds the supported range."));
            byteCount += static_cast<std::uint64_t>((*chunk)->blob.size());
            hash.update((*chunk)->blob);
            if (auto status = visitor((*chunk)->blob); !status)
                return status;
        }
    }
    auto expectedByteCount = parseUnsigned(domain::getField(metadata, "byte_size"), "byte size");
    if (!expectedByteCount || *expectedByteCount != byteCount || domain::hexHash(hash.finish()) != expectedHash) {
        return std::unexpected(fileError("asset_content_integrity_failed", "Asset byte count or SHA-256 does not match."));
    }
    return {};
}

} // namespace tutorux::assets

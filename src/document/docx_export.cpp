#include "tutorux/document/docx_export.hpp"

#include "tutorux/archive/format.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <limits>
#include <map>
#include <optional>
#include <span>
#include <string_view>
#include <vector>

namespace tutorux::document {
namespace {

    struct ZipEntry final {
        std::string name;
        std::string contents;
        std::uint32_t checksum{};
        std::uint32_t localOffset{};
    };

    constexpr std::uint16_t kZipVersion = 20;
    constexpr std::uint16_t kZipDate = 0x0021;
    constexpr std::uint64_t kMaximumDocxSize = 0xffff'ffffULL;

    void appendU16(std::string& output, std::uint16_t value) {
        output.push_back(static_cast<char>(value & 0xffU));
        output.push_back(static_cast<char>((value >> 8U) & 0xffU));
    }

    void appendU32(std::string& output, std::uint32_t value) {
        for (std::size_t index = 0; index < sizeof(value); ++index) {
            output.push_back(static_cast<char>((value >> (index * 8U)) & 0xffU));
        }
    }

    std::uint32_t checksum(std::string_view contents) {
        const auto* bytes = reinterpret_cast<const std::byte*>(contents.data());
        return archive::crc32(std::span<const std::byte>(bytes, contents.size()));
    }

    core::Result<std::string> escapeXml(std::string_view text) {
        std::string escaped;
        escaped.reserve(text.size());
        for (std::size_t index = 0; index < text.size();) {
            const auto lead = static_cast<unsigned char>(text[index]);
            std::size_t length = 0;
            std::uint32_t codePoint = 0;
            if (lead <= 0x7fU) {
                length = 1;
                codePoint = lead;
            } else if ((lead & 0xe0U) == 0xc0U) {
                length = 2;
                codePoint = lead & 0x1fU;
            } else if ((lead & 0xf0U) == 0xe0U) {
                length = 3;
                codePoint = lead & 0x0fU;
            } else if ((lead & 0xf8U) == 0xf0U) {
                length = 4;
                codePoint = lead & 0x07U;
            } else {
                return std::unexpected(core::error("docx_text_encoding_invalid",
                                                   "Guide text contains invalid UTF-8."));
            }
            if (text.size() - index < length) {
                return std::unexpected(core::error("docx_text_encoding_invalid",
                                                   "Guide text contains truncated UTF-8."));
            }
            for (std::size_t continuation = 1; continuation < length; ++continuation) {
                const auto byte = static_cast<unsigned char>(text[index + continuation]);
                if ((byte & 0xc0U) != 0x80U) {
                    return std::unexpected(core::error("docx_text_encoding_invalid",
                                                       "Guide text contains invalid UTF-8."));
                }
                codePoint = (codePoint << 6U) | (byte & 0x3fU);
            }
            const bool overlong = (length == 2 && codePoint < 0x80U) ||
                                  (length == 3 && codePoint < 0x800U) ||
                                  (length == 4 && codePoint < 0x1'0000U);
            const bool invalidXmlCharacter = codePoint == 0 ||
                                             (codePoint < 0x20U && codePoint != 0x09U &&
                                              codePoint != 0x0aU && codePoint != 0x0dU) ||
                                             (codePoint >= 0xd800U && codePoint <= 0xdfffU) ||
                                             codePoint > 0x10'ffffU || codePoint == 0xfffeU ||
                                             codePoint == 0xffffU;
            if (overlong || invalidXmlCharacter) {
                return std::unexpected(
                    core::error("docx_text_encoding_invalid",
                                "Guide text contains a character that XML cannot represent."));
            }
            if (length == 1) {
                switch (static_cast<char>(lead)) {
                    case '&':
                        escaped += "&amp;";
                        break;
                    case '<':
                        escaped += "&lt;";
                        break;
                    case '>':
                        escaped += "&gt;";
                        break;
                    case '"':
                        escaped += "&quot;";
                        break;
                    case '\'':
                        escaped += "&apos;";
                        break;
                    default:
                        escaped.push_back(static_cast<char>(lead));
                        break;
                }
            } else {
                escaped.append(text.substr(index, length));
            }
            index += length;
        }
        return escaped;
    }

    core::Result<std::string> textRuns(std::string_view text) {
        auto escaped = escapeXml(text);
        if (!escaped)
            return std::unexpected(escaped.error());
        std::string runs;
        std::size_t start = 0;
        while (start <= escaped->size()) {
            const std::size_t newline = escaped->find('\n', start);
            const std::size_t end = newline == std::string::npos ? escaped->size() : newline;
            if (end > start) {
                runs += "<w:r><w:t xml:space=\"preserve\">";
                runs.append(escaped->substr(start, end - start));
                runs += "</w:t></w:r>";
            }
            if (newline == std::string::npos)
                break;
            runs += "<w:r><w:br/></w:r>";
            start = newline + 1;
        }
        return runs;
    }

    core::Result<std::string> paragraph(std::string_view text, std::string_view style,
                                        std::string_view prefix = {}) {
        std::string completeText(prefix);
        completeText.append(text);
        auto runs = textRuns(completeText);
        if (!runs)
            return std::unexpected(runs.error());
        std::string result = "<w:p>";
        if (!style.empty()) {
            result += "<w:pPr><w:pStyle w:val=\"";
            result.append(style);
            result += "\"/></w:pPr>";
        }
        result += *runs;
        result += "</w:p>";
        return result;
    }

    core::Result<std::string> tableXml(const domain::GuideTable& table) {
        if (table.empty() || table.front().empty()) {
            return std::unexpected(
                core::error("docx_table_invalid", "Cannot export an empty guide table."));
        }
        std::string xml = "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/>"
                          "<w:tblBorders><w:top w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "<w:left w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "<w:bottom w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "<w:right w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "<w:insideH w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "<w:insideV w:val=\"single\" w:sz=\"4\" w:color=\"CBD5E1\"/>"
                          "</w:tblBorders></w:tblPr>";
        for (std::size_t rowIndex = 0; rowIndex < table.size(); ++rowIndex) {
            if (table[rowIndex].size() != table.front().size()) {
                return std::unexpected(core::error(
                    "docx_table_invalid", "Guide table rows must have matching cell counts."));
            }
            xml += "<w:tr>";
            for (const auto& cell : table[rowIndex]) {
                std::string cellProperties = "<w:tcPr>";
                if (rowIndex == 0)
                    cellProperties += "<w:shd w:fill=\"E8EEF5\"/>";
                cellProperties += "</w:tcPr>";
                auto cellParagraph = paragraph(domain::renderGuideInlineText(cell), "");
                if (!cellParagraph)
                    return std::unexpected(cellParagraph.error());
                xml += "<w:tc>" + cellProperties + *cellParagraph + "</w:tc>";
            }
            xml += "</w:tr>";
        }
        xml += "</w:tbl>";
        return xml;
    }

    std::uint16_t readLittleEndian16(std::span<const std::byte> bytes, std::size_t offset) {
        return static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(bytes[offset])) |
               static_cast<std::uint16_t>(std::to_integer<std::uint8_t>(bytes[offset + 1U]) << 8U);
    }

    std::uint32_t readBigEndian32(std::span<const std::byte> bytes, std::size_t offset) {
        return (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset])) << 24U) |
               (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 1U]))
                << 16U) |
               (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 2U]))
                << 8U) |
               static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 3U]));
    }

    core::Result<std::pair<std::uint32_t, std::uint32_t>>
    imagePixelDimensions(const GuideImageAsset& image) {
        const std::span<const std::byte> bytes(image.bytes);
        if (image.mimeType == "image/png" && bytes.size() >= 24 &&
            std::to_integer<std::uint8_t>(bytes[0]) == 0x89U &&
            std::to_integer<std::uint8_t>(bytes[1]) == 'P' &&
            std::to_integer<std::uint8_t>(bytes[2]) == 'N' &&
            std::to_integer<std::uint8_t>(bytes[3]) == 'G') {
            const auto width = readBigEndian32(bytes, 16);
            const auto height = readBigEndian32(bytes, 20);
            if (width != 0 && height != 0)
                return std::pair{width, height};
        } else if (image.mimeType == "image/gif" && bytes.size() >= 10 &&
                   std::to_integer<std::uint8_t>(bytes[0]) == 'G' &&
                   std::to_integer<std::uint8_t>(bytes[1]) == 'I' &&
                   std::to_integer<std::uint8_t>(bytes[2]) == 'F') {
            const auto width = readLittleEndian16(bytes, 6);
            const auto height = readLittleEndian16(bytes, 8);
            if (width != 0 && height != 0)
                return std::pair{static_cast<std::uint32_t>(width),
                                 static_cast<std::uint32_t>(height)};
        } else if (image.mimeType == "image/webp" && bytes.size() >= 30) {
            const auto byteAt = [&](std::size_t offset) {
                return std::to_integer<std::uint8_t>(bytes[offset]);
            };
            if (byteAt(12) == 'V' && byteAt(13) == 'P' && byteAt(14) == '8' && byteAt(15) == 'X') {
                const std::uint32_t width = 1U + static_cast<std::uint32_t>(byteAt(24)) +
                                            (static_cast<std::uint32_t>(byteAt(25)) << 8U) +
                                            (static_cast<std::uint32_t>(byteAt(26)) << 16U);
                const std::uint32_t height = 1U + static_cast<std::uint32_t>(byteAt(27)) +
                                             (static_cast<std::uint32_t>(byteAt(28)) << 8U) +
                                             (static_cast<std::uint32_t>(byteAt(29)) << 16U);
                return std::pair{width, height};
            }
            if (bytes.size() >= 25 && byteAt(12) == 'V' && byteAt(13) == 'P' && byteAt(14) == '8' &&
                byteAt(15) == 'L' && byteAt(20) == 0x2fU) {
                const std::uint32_t bits = static_cast<std::uint32_t>(byteAt(21)) |
                                           (static_cast<std::uint32_t>(byteAt(22)) << 8U) |
                                           (static_cast<std::uint32_t>(byteAt(23)) << 16U) |
                                           (static_cast<std::uint32_t>(byteAt(24)) << 24U);
                const std::uint32_t width = 1U + (bits & 0x3fffU);
                const std::uint32_t height = 1U + ((bits >> 14U) & 0x3fffU);
                return std::pair{width, height};
            }
            if (bytes.size() >= 30 && byteAt(12) == 'V' && byteAt(13) == 'P' && byteAt(14) == '8' &&
                byteAt(15) == ' ') {
                const std::uint32_t width = (static_cast<std::uint32_t>(byteAt(26)) |
                                             (static_cast<std::uint32_t>(byteAt(27)) << 8U)) &
                                            0x3fffU;
                const std::uint32_t height = (static_cast<std::uint32_t>(byteAt(28)) |
                                              (static_cast<std::uint32_t>(byteAt(29)) << 8U)) &
                                             0x3fffU;
                if (width != 0 && height != 0)
                    return std::pair{width, height};
            }
        } else if ((image.mimeType == "image/jpeg" || image.mimeType == "image/jpg") &&
                   bytes.size() >= 4 && std::to_integer<std::uint8_t>(bytes[0]) == 0xffU &&
                   std::to_integer<std::uint8_t>(bytes[1]) == 0xd8U) {
            std::size_t offset = 2;
            while (offset + 4U <= bytes.size()) {
                if (std::to_integer<std::uint8_t>(bytes[offset]) != 0xffU) {
                    ++offset;
                    continue;
                }
                while (offset < bytes.size() &&
                       std::to_integer<std::uint8_t>(bytes[offset]) == 0xffU) {
                    ++offset;
                }
                if (offset >= bytes.size())
                    break;
                const std::uint8_t marker = std::to_integer<std::uint8_t>(bytes[offset++]);
                if (marker == 0xd8U || marker == 0xd9U || marker == 0x01U ||
                    (marker >= 0xd0U && marker <= 0xd7U)) {
                    continue;
                }
                if (offset + 2U > bytes.size())
                    break;
                const std::uint16_t segmentLength = static_cast<std::uint16_t>(
                    (std::to_integer<std::uint8_t>(bytes[offset]) << 8U) |
                    std::to_integer<std::uint8_t>(bytes[offset + 1U]));
                if (segmentLength < 2 || segmentLength > bytes.size() - offset)
                    break;
                const bool startOfFrame = marker == 0xc0U || marker == 0xc1U || marker == 0xc2U ||
                                          marker == 0xc3U || marker == 0xc5U || marker == 0xc6U ||
                                          marker == 0xc7U || marker == 0xc9U || marker == 0xcaU ||
                                          marker == 0xcbU || marker == 0xcdU || marker == 0xceU ||
                                          marker == 0xcfU;
                if (startOfFrame && segmentLength >= 7) {
                    const std::uint32_t height = static_cast<std::uint32_t>(
                        (std::to_integer<std::uint8_t>(bytes[offset + 3U]) << 8U) |
                        std::to_integer<std::uint8_t>(bytes[offset + 4U]));
                    const std::uint32_t width = static_cast<std::uint32_t>(
                        (std::to_integer<std::uint8_t>(bytes[offset + 5U]) << 8U) |
                        std::to_integer<std::uint8_t>(bytes[offset + 6U]));
                    if (width != 0 && height != 0)
                        return std::pair{width, height};
                    break;
                }
                offset += segmentLength;
            }
        }
        return std::unexpected(core::error("docx_image_dimensions_invalid",
                                           "The guide image dimensions could not be read."));
    }

    std::string imageFileExtension(std::string_view mimeType) {
        if (mimeType == "image/png")
            return "png";
        if (mimeType == "image/jpeg" || mimeType == "image/jpg")
            return "jpeg";
        if (mimeType == "image/gif")
            return "gif";
        if (mimeType == "image/webp")
            return "webp";
        return {};
    }

    core::Result<std::string> imageDrawingXml(const GuideImageAsset& image,
                                              std::string_view alternativeText,
                                              std::string_view relationshipId,
                                              std::uint32_t drawingId) {
        auto dimensions = imagePixelDimensions(image);
        if (!dimensions)
            return std::unexpected(dimensions.error());
        auto escapedAlternativeText = escapeXml(alternativeText);
        if (!escapedAlternativeText)
            return std::unexpected(escapedAlternativeText.error());

        constexpr std::uint64_t maximumWidthEmu = 4'572'000;
        constexpr std::uint64_t maximumHeightEmu = 5'486'400;
        constexpr std::uint64_t emuPerPixelAt96Dpi = 9'525;
        const std::uint64_t pixelWidth = dimensions->first;
        const std::uint64_t pixelHeight = dimensions->second;
        std::uint64_t widthEmu = pixelWidth * emuPerPixelAt96Dpi;
        std::uint64_t heightEmu = pixelHeight * emuPerPixelAt96Dpi;
        if (widthEmu > maximumWidthEmu || heightEmu > maximumHeightEmu) {
            if (maximumWidthEmu * pixelHeight <= maximumHeightEmu * pixelWidth) {
                widthEmu = maximumWidthEmu;
                heightEmu = maximumWidthEmu * pixelHeight / pixelWidth;
            } else {
                heightEmu = maximumHeightEmu;
                widthEmu = maximumHeightEmu * pixelWidth / pixelHeight;
            }
        }

        const std::string id = std::to_string(drawingId);
        std::string xml = "<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" "
                          "distL=\"0\" distR=\"0\"><wp:extent cx=\"";
        xml += std::to_string(widthEmu);
        xml += "\" cy=\"" + std::to_string(heightEmu) + "\"/><wp:docPr id=\"" + id +
               "\" name=\"Tutorux image " + id + "\" descr=\"" + *escapedAlternativeText +
               "\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/>"
               "</wp:cNvGraphicFramePr><a:graphic><a:graphicData "
               "uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">"
               "<pic:pic><pic:nvPicPr><pic:cNvPr id=\"" +
               id + "\" name=\"Tutorux image " + id +
               "\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"" +
               std::string(relationshipId) +
               "\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm>"
               "<a:off x=\"0\" y=\"0\"/><a:ext cx=\"" +
               std::to_string(widthEmu) + "\" cy=\"" + std::to_string(heightEmu) +
               "\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr>"
               "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>";
        return xml;
    }

    core::Result<std::string> makeDocumentXml(const domain::GuideDocument& guide,
                                              std::span<const GuideImageAsset> images,
                                              std::string& imageRelationships,
                                              std::vector<ZipEntry>& imageEntries) {
        std::string xml =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
            "<w:document "
            "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" "
            "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" "
            "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" "
            "xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" "
            "xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\">"
            "<w:body>";
        std::map<std::string, std::string, std::less<>> relationshipByAsset;
        std::uint32_t nextRelationshipId = 2;
        std::uint32_t nextDrawingId = 1;
        auto title = paragraph(guide.title, "Title");
        auto subtitle = paragraph("Tutorux study guide · " + guide.templateId + " template · " +
                                      guide.approvalState,
                                  "Subtitle");
        if (!title || !subtitle)
            return std::unexpected(!title ? title.error() : subtitle.error());
        xml += *title;
        xml += *subtitle;
        for (const auto& section : guide.sections) {
            auto heading = paragraph(section.heading, "Heading1");
            if (!heading)
                return std::unexpected(heading.error());
            xml += *heading;
            for (const auto& block : section.blocks) {
                if (block.kind == "image" || block.kind == "figure" ||
                    block.text.starts_with("![")) {
                    auto imageReference = domain::parseGuideImageReference(block.text);
                    if (!imageReference)
                        return std::unexpected(imageReference.error());
                    const auto image = std::find_if(
                        images.begin(), images.end(), [&](const GuideImageAsset& candidate) {
                            return candidate.assetId == imageReference->assetId;
                        });
                    if (image == images.end()) {
                        return std::unexpected(core::error(
                            "docx_image_missing", "An embedded guide image was not loaded."));
                    }
                    const std::string label = domain::guideBlockLabel(block);
                    if (!label.empty()) {
                        auto labelParagraph = paragraph(label, "Source");
                        if (!labelParagraph)
                            return std::unexpected(labelParagraph.error());
                        xml += *labelParagraph;
                    }
                    auto relationship = relationshipByAsset.find(image->assetId);
                    if (relationship == relationshipByAsset.end()) {
                        const std::string extension = imageFileExtension(image->mimeType);
                        if (extension.empty()) {
                            return std::unexpected(
                                core::error("docx_image_type_unsupported",
                                            "This image format cannot be embedded in DOCX."));
                        }
                        const std::string relationshipId =
                            "rId" + std::to_string(nextRelationshipId++);
                        const std::string fileName = image->assetId + "." + extension;
                        imageRelationships +=
                            "<Relationship Id=\"" + relationshipId +
                            "\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/"
                            "relationships/image\" Target=\"media/" +
                            fileName + "\"/>";
                        std::string binaryContents(
                            reinterpret_cast<const char*>(image->bytes.data()),
                            image->bytes.size());
                        imageEntries.push_back(
                            {"word/media/" + fileName, std::move(binaryContents)});
                        relationship =
                            relationshipByAsset.emplace(image->assetId, relationshipId).first;
                    }
                    auto drawing = imageDrawingXml(*image, imageReference->alternativeText,
                                                   relationship->second, nextDrawingId++);
                    if (!drawing)
                        return std::unexpected(drawing.error());
                    xml += *drawing;
                    if (!block.sourceIds.empty()) {
                        std::string sourceText = "Source: ";
                        for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                            if (index > 0)
                                sourceText += ", ";
                            sourceText += block.sourceIds[index];
                        }
                        auto sourceParagraph = paragraph(sourceText, "Source");
                        if (!sourceParagraph)
                            return std::unexpected(sourceParagraph.error());
                        xml += *sourceParagraph;
                    }
                    continue;
                }
                if (block.kind == "table") {
                    auto parsedTable = domain::parseGuideTable(block.text);
                    if (!parsedTable)
                        return std::unexpected(parsedTable.error());
                    const std::string label = domain::guideBlockLabel(block);
                    if (!label.empty()) {
                        auto labelParagraph = paragraph(label, "Source");
                        if (!labelParagraph)
                            return std::unexpected(labelParagraph.error());
                        xml += *labelParagraph;
                    }
                    auto blockTable = tableXml(*parsedTable);
                    if (!blockTable)
                        return std::unexpected(blockTable.error());
                    xml += *blockTable;
                    if (!block.sourceIds.empty()) {
                        std::string sourceText = "Source: ";
                        for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                            if (index > 0)
                                sourceText += ", ";
                            sourceText += block.sourceIds[index];
                        }
                        auto sourceParagraph = paragraph(sourceText, "Source");
                        if (!sourceParagraph)
                            return std::unexpected(sourceParagraph.error());
                        xml += *sourceParagraph;
                    }
                    continue;
                }
                std::string_view style;
                std::string_view prefix;
                std::string labeledPrefix;
                if (block.kind == "quote")
                    style = "Quote";
                else if (block.kind == "code" || block.kind == "equation")
                    style = "Code";
                else if (block.kind == "list-item")
                    prefix = "• ";
                const std::string label = domain::guideBlockLabel(block);
                if (!label.empty()) {
                    labeledPrefix = label + ": ";
                    prefix = labeledPrefix;
                }
                auto blockParagraph =
                    paragraph(domain::renderGuideInlineText(block.text), style, prefix);
                if (!blockParagraph)
                    return std::unexpected(blockParagraph.error());
                xml += *blockParagraph;
                if (!block.sourceIds.empty()) {
                    std::string sourceText = "Source: ";
                    for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                        if (index > 0)
                            sourceText += ", ";
                        sourceText += block.sourceIds[index];
                    }
                    auto sourceParagraph = paragraph(sourceText, "Source");
                    if (!sourceParagraph)
                        return std::unexpected(sourceParagraph.error());
                    xml += *sourceParagraph;
                }
            }
        }
        xml += "<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>"
               "<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" "
               "w:left=\"1440\" w:header=\"720\" w:footer=\"720\" "
               "w:gutter=\"0\"/></w:sectPr></w:body></w:document>";
        return xml;
    }

    std::string stylesXml() {
        return "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
               "<w:styles "
               "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">"
               "<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\">"
               "<w:name w:val=\"Normal\"/><w:rPr><w:rFonts w:ascii=\"Aptos\" "
               "w:hAnsi=\"Aptos\"/><w:sz w:val=\"22\"/></w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/>"
               "<w:pPr><w:keepNext/></w:pPr><w:rPr><w:b/><w:sz w:val=\"40\"/>"
               "</w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Subtitle\"><w:name "
               "w:val=\"Subtitle\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"360\"/>"
               "<w:keepNext/></w:pPr><w:rPr><w:i/><w:color w:val=\"64748B\"/>"
               "<w:sz w:val=\"20\"/></w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Heading1\"><w:name w:val=\"heading "
               "1\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:next w:val=\"Normal\"/>"
               "<w:pPr><w:spacing w:before=\"420\" w:after=\"180\"/><w:keepNext/>"
               "</w:pPr><w:rPr><w:b/><w:sz w:val=\"30\"/>"
               "<w:color w:val=\"1E293B\"/></w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"480\"/>"
               "<w:spacing w:before=\"120\" w:after=\"120\"/></w:pPr>"
               "<w:rPr><w:i/><w:color w:val=\"475569\"/></w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Code\"><w:name w:val=\"Code\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:pPr>"
               "<w:spacing w:before=\"120\" w:after=\"120\"/></w:pPr>"
               "<w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/>"
               "<w:sz w:val=\"20\"/></w:rPr></w:style>"
               "<w:style w:type=\"paragraph\" w:styleId=\"Source\"><w:name w:val=\"Source\"/>"
               "<w:basedOn w:val=\"Normal\"/><w:pPr>"
               "<w:spacing w:before=\"40\" w:after=\"180\"/></w:pPr>"
               "<w:rPr><w:i/><w:color w:val=\"64748B\"/><w:sz w:val=\"18\"/>"
               "</w:rPr></w:style></w:styles>";
    }

    std::vector<ZipEntry> makeEntries(std::string documentXml, std::string imageRelationships,
                                      std::vector<ZipEntry> imageEntries) {
        std::string documentRelationships =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
            "<Relationships "
            "xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
            "<Relationship Id=\"rId1\" "
            "Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
            "styles\" Target=\"styles.xml\"/>" +
            imageRelationships + "</Relationships>";
        std::vector<ZipEntry> entries{
            {"[Content_Types].xml",
             "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
             "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
             "<Default Extension=\"rels\" "
             "ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
             "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
             "<Default Extension=\"png\" ContentType=\"image/png\"/>"
             "<Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/>"
             "<Default Extension=\"gif\" ContentType=\"image/gif\"/>"
             "<Default Extension=\"webp\" ContentType=\"image/webp\"/>"
             "<Override PartName=\"/word/document.xml\" "
             "ContentType=\"application/"
             "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
             "<Override PartName=\"/word/styles.xml\" "
             "ContentType=\"application/"
             "vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>"
             "<Override PartName=\"/docProps/core.xml\" "
             "ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
             "</Types>"                                                      },
            {"_rels/.rels",
             "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
             "<Relationships "
             "xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
             "<Relationship Id=\"rId1\" "
             "Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
             "officeDocument\" Target=\"word/document.xml\"/>"
             "<Relationship Id=\"rId2\" "
             "Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/"
             "core-properties\" Target=\"docProps/core.xml\"/>"
             "</Relationships>"                                              },
            {"word/document.xml",            std::move(documentXml)          },
            {"word/styles.xml",              stylesXml()                     },
            {"word/_rels/document.xml.rels", std::move(documentRelationships)},
            {"docProps/core.xml",
             "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
             "<cp:coreProperties "
             "xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/"
             "core-properties\" "
             "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
             "xmlns:dcterms=\"http://purl.org/dc/terms/\" "
             "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
             "<dc:creator>Tutorux</dc:creator><cp:lastModifiedBy>Tutorux</cp:lastModifiedBy>"
             "</cp:coreProperties>"                                          },
        };
        entries.insert(entries.end(), std::make_move_iterator(imageEntries.begin()),
                       std::make_move_iterator(imageEntries.end()));
        return entries;
    }

    core::Result<std::string> makeZip(std::vector<ZipEntry> entries) {
        if (entries.size() > std::numeric_limits<std::uint16_t>::max()) {
            return std::unexpected(
                core::error("docx_package_too_large", "DOCX contains too many package entries."));
        }
        std::string output;
        for (auto& entry : entries) {
            if (entry.name.size() > std::numeric_limits<std::uint16_t>::max() ||
                entry.contents.size() > kMaximumDocxSize) {
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX entry exceeds the ZIP v1 size limits."));
            }
            const std::uint64_t localRecordSize = 30ULL + entry.name.size() + entry.contents.size();
            if (localRecordSize > kMaximumDocxSize - output.size()) {
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX exceeds the ZIP 32-bit size limit."));
            }
            entry.checksum = checksum(entry.contents);
            entry.localOffset = static_cast<std::uint32_t>(output.size());
            appendU32(output, 0x04034b50U);
            appendU16(output, kZipVersion);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, kZipDate);
            appendU32(output, entry.checksum);
            appendU32(output, static_cast<std::uint32_t>(entry.contents.size()));
            appendU32(output, static_cast<std::uint32_t>(entry.contents.size()));
            appendU16(output, static_cast<std::uint16_t>(entry.name.size()));
            appendU16(output, 0);
            output += entry.name;
            output += entry.contents;
        }
        if (output.size() > kMaximumDocxSize)
            return std::unexpected(
                core::error("docx_package_too_large", "DOCX exceeds the ZIP 32-bit size limit."));
        std::uint64_t directorySizeEstimate = 0;
        for (const auto& entry : entries)
            directorySizeEstimate += 46ULL + entry.name.size();
        if (output.size() + directorySizeEstimate + 22ULL > kMaximumDocxSize) {
            return std::unexpected(
                core::error("docx_package_too_large", "DOCX exceeds the ZIP 32-bit size limit."));
        }
        const auto directoryOffset = static_cast<std::uint32_t>(output.size());
        for (const auto& entry : entries) {
            appendU32(output, 0x02014b50U);
            appendU16(output, kZipVersion);
            appendU16(output, kZipVersion);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, kZipDate);
            appendU32(output, entry.checksum);
            appendU32(output, static_cast<std::uint32_t>(entry.contents.size()));
            appendU32(output, static_cast<std::uint32_t>(entry.contents.size()));
            appendU16(output, static_cast<std::uint16_t>(entry.name.size()));
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU16(output, 0);
            appendU32(output, 0);
            appendU32(output, entry.localOffset);
            output += entry.name;
        }
        if (output.size() > kMaximumDocxSize) {
            return std::unexpected(
                core::error("docx_package_too_large", "DOCX exceeds the ZIP 32-bit size limit."));
        }
        const auto directorySize = static_cast<std::uint32_t>(output.size() - directoryOffset);
        appendU32(output, 0x06054b50U);
        appendU16(output, 0);
        appendU16(output, 0);
        appendU16(output, static_cast<std::uint16_t>(entries.size()));
        appendU16(output, static_cast<std::uint16_t>(entries.size()));
        appendU32(output, directorySize);
        appendU32(output, directoryOffset);
        appendU16(output, 0);
        return output;
    }

} // namespace

core::Result<std::string> renderGuideDocx(const domain::GuideDocument& guide,
                                          std::span<const GuideImageAsset> images) {
    if (guide.title.empty()) {
        return std::unexpected(
            core::error("docx_guide_invalid", "Cannot export a guide without a title."));
    }
    std::string imageRelationships;
    std::vector<ZipEntry> imageEntries;
    auto documentXml = makeDocumentXml(guide, images, imageRelationships, imageEntries);
    if (!documentXml)
        return std::unexpected(documentXml.error());
    return makeZip(makeEntries(std::move(*documentXml), std::move(imageRelationships),
                               std::move(imageEntries)));
}

} // namespace tutorux::document

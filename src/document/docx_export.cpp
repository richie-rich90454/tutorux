#include "tutorux/document/docx_export.hpp"

#include "tutorux/archive/format.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
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

        core::Result<std::string> makeDocumentXml(const domain::GuideDocument& guide) {
            std::string xml =
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                "<w:document "
                "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" "
                "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">"
                "<w:body>";
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
                    std::string_view style;
                    std::string_view prefix;
                    std::string labeledPrefix;
                    if (block.kind == "quote")
                        style = "Quote";
                    else if (block.kind == "code" || block.kind == "equation")
                        style = "Code";
                    else if (block.kind == "list-item")
                        prefix = "• ";
                    const std::string_view label = domain::guideBlockLabel(block.kind);
                    if (!label.empty()) {
                        labeledPrefix = std::string(label) + ": ";
                        prefix = labeledPrefix;
                    }
                    auto blockParagraph = paragraph(block.text, style, prefix);
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

        std::vector<ZipEntry> makeEntries(std::string documentXml) {
            return {
                {"[Content_Types].xml",
                 "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                 "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">"
                 "<Default Extension=\"rels\" "
                 "ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>"
                 "<Default Extension=\"xml\" ContentType=\"application/xml\"/>"
                 "<Override PartName=\"/word/document.xml\" "
                 "ContentType=\"application/"
                 "vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>"
                 "<Override PartName=\"/word/styles.xml\" "
                 "ContentType=\"application/"
                 "vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>"
                 "<Override PartName=\"/docProps/core.xml\" "
                 "ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>"
                 "</Types>"},
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
                 "</Relationships>"},
                {"word/document.xml", std::move(documentXml)},
                {"word/styles.xml", stylesXml()},
                {"word/_rels/document.xml.rels",
                 "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                 "<Relationships "
                 "xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">"
                 "<Relationship Id=\"rId1\" "
                 "Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
                 "styles\" Target=\"styles.xml\"/>"
                 "</Relationships>"},
                {"docProps/core.xml",
                 "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
                 "<cp:coreProperties "
                 "xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/"
                 "core-properties\" "
                 "xmlns:dc=\"http://purl.org/dc/elements/1.1/\" "
                 "xmlns:dcterms=\"http://purl.org/dc/terms/\" "
                 "xmlns:xsi=\"http://www.w3.org/2001/XMLSchema-instance\">"
                 "<dc:creator>Tutorux</dc:creator><cp:lastModifiedBy>Tutorux</cp:lastModifiedBy>"
                 "</cp:coreProperties>"},
            };
        }

        core::Result<std::string> makeZip(std::vector<ZipEntry> entries) {
            if (entries.size() > std::numeric_limits<std::uint16_t>::max()) {
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX contains too many package entries."));
            }
            std::string output;
            for (auto& entry : entries) {
                if (entry.name.size() > std::numeric_limits<std::uint16_t>::max() ||
                    entry.contents.size() > kMaximumDocxSize) {
                    return std::unexpected(core::error(
                        "docx_package_too_large", "DOCX entry exceeds the ZIP v1 size limits."));
                }
                const std::uint64_t localRecordSize =
                    30ULL + entry.name.size() + entry.contents.size();
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
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX exceeds the ZIP 32-bit size limit."));
            std::uint64_t directorySizeEstimate = 0;
            for (const auto& entry : entries)
                directorySizeEstimate += 46ULL + entry.name.size();
            if (output.size() + directorySizeEstimate + 22ULL > kMaximumDocxSize) {
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX exceeds the ZIP 32-bit size limit."));
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
                return std::unexpected(core::error("docx_package_too_large",
                                                   "DOCX exceeds the ZIP 32-bit size limit."));
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

    core::Result<std::string> renderGuideDocx(const domain::GuideDocument& guide) {
        if (guide.title.empty()) {
            return std::unexpected(
                core::error("docx_guide_invalid", "Cannot export a guide without a title."));
        }
        auto documentXml = makeDocumentXml(guide);
        if (!documentXml)
            return std::unexpected(documentXml.error());
        return makeZip(makeEntries(std::move(*documentXml)));
    }

} // namespace tutorux::document

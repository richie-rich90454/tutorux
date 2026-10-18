#include "tutorux/document/pdf_export.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace tutorux::document {
namespace {

    struct Character final {
        char32_t value{};
        std::string_view bytes;
    };

    struct Page final {
        std::string content;
        double y{744.0};
    };

    core::Result<std::vector<Character>> decodeUtf8(std::string_view text) {
        std::vector<Character> characters;
        characters.reserve(text.size());
        for (std::size_t offset = 0; offset < text.size();) {
            const auto lead = static_cast<unsigned char>(text[offset]);
            std::size_t length = 0;
            char32_t value = 0;
            if (lead < 0x80U) {
                length = 1;
                value = lead;
            } else if ((lead & 0xe0U) == 0xc0U) {
                length = 2;
                value = lead & 0x1fU;
            } else if ((lead & 0xf0U) == 0xe0U) {
                length = 3;
                value = lead & 0x0fU;
            } else if ((lead & 0xf8U) == 0xf0U) {
                length = 4;
                value = lead & 0x07U;
            } else {
                return std::unexpected(core::error("pdf_text_encoding_invalid",
                                                   "Guide text contains malformed UTF-8."));
            }
            if (length > text.size() - offset) {
                return std::unexpected(core::error("pdf_text_encoding_invalid",
                                                   "Guide text contains truncated UTF-8."));
            }
            for (std::size_t index = 1; index < length; ++index) {
                const auto continuation = static_cast<unsigned char>(text[offset + index]);
                if ((continuation & 0xc0U) != 0x80U) {
                    return std::unexpected(core::error("pdf_text_encoding_invalid",
                                                       "Guide text contains malformed UTF-8."));
                }
                value = (value << 6U) | (continuation & 0x3fU);
            }
            const bool overlong = (length == 2U && value < 0x80U) ||
                                  (length == 3U && value < 0x800U) ||
                                  (length == 4U && value < 0x10000U);
            if (overlong || value > 0x10ffffU || (value >= 0xd800U && value <= 0xdfffU)) {
                return std::unexpected(
                    core::error("pdf_text_encoding_invalid", "Guide text contains invalid UTF-8."));
            }
            characters.push_back(Character{value, text.substr(offset, length)});
            offset += length;
        }
        return characters;
    }

    void appendHexUnit(std::string& output, std::uint16_t value) {
        constexpr std::array<char, 16>
            digits{'0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'};
        output.push_back(digits[(value >> 12U) & 0x0fU]);
        output.push_back(digits[(value >> 8U) & 0x0fU]);
        output.push_back(digits[(value >> 4U) & 0x0fU]);
        output.push_back(digits[value & 0x0fU]);
    }

    core::Result<std::string> encodePdfText(std::string_view text) {
        auto characters = decodeUtf8(text);
        if (!characters)
            return std::unexpected(characters.error());
        std::string encoded;
        encoded.reserve(characters->size() * 4U);
        for (const Character& character : *characters) {
            if (character.value <= 0xffffU) {
                appendHexUnit(encoded, static_cast<std::uint16_t>(character.value));
                continue;
            }
            const char32_t scalar = character.value - 0x10000U;
            appendHexUnit(encoded, static_cast<std::uint16_t>(0xd800U + (scalar >> 10U)));
            appendHexUnit(encoded, static_cast<std::uint16_t>(0xdc00U + (scalar & 0x3ffU)));
        }
        return encoded;
    }

    double characterWidth(char32_t value, double size) {
        if (value == '\t')
            return size * 1.5;
        if (value <= 0x7fU)
            return size * ((value == ' ' || value == 'i' || value == 'l' || value == '.' ||
                            value == ',' || value == ':' || value == ';')
                               ? 0.28
                               : 0.52);
        return size;
    }

    core::Result<std::vector<std::string>>
    wrapText(std::string_view text, double width, double size) {
        auto characters = decodeUtf8(text);
        if (!characters)
            return std::unexpected(characters.error());
        std::vector<std::string> lines;
        std::string line;
        std::string word;
        double lineWidth = 0.0;
        double wordWidth = 0.0;

        const auto flushWord = [&]() {
            if (word.empty())
                return;
            if (!line.empty() && lineWidth + size * 0.28 + wordWidth > width) {
                lines.push_back(std::move(line));
                line.clear();
                lineWidth = 0.0;
            }
            if (!line.empty()) {
                line.push_back(' ');
                lineWidth += size * 0.28;
            }
            if (wordWidth <= width) {
                line += word;
                lineWidth += wordWidth;
            } else {
                auto wordCharacters = decodeUtf8(word);
                if (wordCharacters) {
                    for (const Character& character : *wordCharacters) {
                        const double nextWidth = characterWidth(character.value, size);
                        if (!line.empty() && lineWidth + nextWidth > width) {
                            lines.push_back(std::move(line));
                            line.clear();
                            lineWidth = 0.0;
                        }
                        line.append(character.bytes);
                        lineWidth += nextWidth;
                    }
                }
            }
            word.clear();
            wordWidth = 0.0;
        };

        for (const Character& character : *characters) {
            if (character.value == '\r')
                continue;
            if (character.value == '\n') {
                flushWord();
                lines.push_back(std::move(line));
                line.clear();
                lineWidth = 0.0;
                continue;
            }
            if (character.value == ' ' || character.value == '\t') {
                flushWord();
                continue;
            }
            word.append(character.bytes);
            wordWidth += characterWidth(character.value, size);
        }
        flushWord();
        if (!line.empty() || lines.empty())
            lines.push_back(std::move(line));
        return lines;
    }

    core::Status ensurePageSpace(std::vector<Page>& pages, double height) {
        if (pages.back().y - height >= 52.0)
            return {};
        if (pages.size() >= 10'000U) {
            return std::unexpected(core::error("pdf_page_limit_exceeded",
                                               "The guide exceeds the 10,000-page export limit."));
        }
        pages.emplace_back();
        return {};
    }

    core::Status drawText(std::vector<Page>& pages,
                          std::string_view text,
                          double size,
                          double lineHeight,
                          std::string_view color = "0.13 0.20 0.18") {
        auto lines = wrapText(text, 500.0, size);
        if (!lines)
            return std::unexpected(lines.error());
        for (const std::string& line : *lines) {
            if (auto status = ensurePageSpace(pages, lineHeight); !status)
                return status;
            auto encoded = encodePdfText(line);
            if (!encoded)
                return std::unexpected(encoded.error());
            Page& page = pages.back();
            page.content += "BT /F1 " + std::to_string(size) + " Tf " + std::string(color) +
                            " rg 1 0 0 1 56 " + std::to_string(page.y) + " Tm <" + *encoded +
                            "> Tj ET\n";
            page.y -= lineHeight;
        }
        return {};
    }

    std::string makeToUnicodeCMap() {
        return "/CIDInit /ProcSet findresource begin\n"
               "12 dict begin\n"
               "begincmap\n"
               "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
               "/CMapName /TutoruxIdentity def\n"
               "/CMapType 2 def\n"
               "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n"
               "1 beginbfrange\n<0000> <FFFF> <0000>\nendbfrange\n"
               "endcmap\n"
               "CMapName currentdict /CMap defineresource pop\n"
               "end\nend\n";
    }

    void setObject(std::vector<std::string>& objects, std::size_t objectId, std::string body) {
        objects[objectId - 1U] = std::move(body);
    }

    std::string pdfDocument(const std::vector<std::string>& objects) {
        std::string output{"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n"};
        std::vector<std::size_t> offsets(objects.size() + 1U);
        for (std::size_t index = 0; index < objects.size(); ++index) {
            offsets[index + 1U] = output.size();
            output += std::to_string(index + 1U) + " 0 obj\n";
            output += objects[index];
            output += "\nendobj\n";
        }
        const std::size_t crossReferenceOffset = output.size();
        output += "xref\n0 " + std::to_string(objects.size() + 1U) + "\n";
        output += "0000000000 65535 f \n";
        for (std::size_t objectId = 1; objectId < offsets.size(); ++objectId) {
            std::array<char, 32> offset{};
            const auto [end, errorCode] =
                std::to_chars(offset.data(), offset.data() + offset.size(), offsets[objectId]);
            if (errorCode != std::errc{})
                return {};
            const std::size_t digits = static_cast<std::size_t>(end - offset.data());
            if (digits > 10U)
                return {};
            output.append(10U - digits, '0');
            output.append(offset.data(), digits);
            output += " 00000 n \n";
        }
        output += "trailer\n<< /Size " + std::to_string(objects.size() + 1U) +
                  " /Root 1 0 R >>\nstartxref\n" + std::to_string(crossReferenceOffset) +
                  "\n%%EOF\n";
        return output;
    }

} // namespace

core::Result<std::string> renderGuidePdf(const domain::GuideDocument& guide) {
    std::vector<Page> pages(1);
    if (guide.title.empty()) {
        return std::unexpected(
            core::error("pdf_guide_title_required", "A guide needs a title before PDF export."));
    }
    if (auto status = drawText(pages, "TUTORUX  /  STUDY GUIDE", 9.0, 20.0, "0.20 0.40 0.34");
        !status) {
        return std::unexpected(status.error());
    }
    if (auto status = drawText(pages, guide.title, 26.0, 34.0, "0.12 0.20 0.18"); !status)
        return std::unexpected(status.error());
    if (auto status = drawText(pages,
                               "Session " + guide.sessionId + "   |   Template " +
                                   guide.templateId + "   |   " + guide.approvalState,
                               9.0,
                               20.0,
                               "0.36 0.43 0.40");
        !status) {
        return std::unexpected(status.error());
    }

    for (const domain::GuideSection& section : guide.sections) {
        if (auto status = ensurePageSpace(pages, 42.0); !status)
            return std::unexpected(status.error());
        pages.back().y -= 10.0;
        if (auto status = drawText(pages, section.heading, 16.0, 23.0, "0.20 0.40 0.34"); !status) {
            return std::unexpected(status.error());
        }
        for (const domain::GuideBlock& block : section.blocks) {
            std::string content;
            if (block.kind == "list-item")
                content = "• ";
            else if (block.kind == "quote")
                content = "“";
            if (block.stale)
                content += "[SOURCE CHANGED — REVIEW] ";
            const std::string_view label = domain::guideBlockLabel(block.kind);
            if (!label.empty())
                content += std::string(label) + ": ";
            content += block.text;
            if (block.kind == "quote")
                content += "”";
            if (auto status = drawText(pages, content, 10.2, 15.0); !status)
                return std::unexpected(status.error());
            if (!block.sourceIds.empty()) {
                std::string sources = "Sources: ";
                for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                    if (index != 0)
                        sources += ", ";
                    sources += block.sourceIds[index];
                }
                if (auto status = drawText(pages, sources, 8.0, 12.0, "0.40 0.47 0.43"); !status)
                    return std::unexpected(status.error());
            }
            pages.back().y -= 6.0;
        }
    }

    constexpr std::size_t catalogId = 1;
    constexpr std::size_t pagesId = 2;
    constexpr std::size_t type0FontId = 3;
    constexpr std::size_t cidFontId = 4;
    constexpr std::size_t unicodeMapId = 5;
    const std::size_t firstPageId = 6;
    const std::size_t objectCount = 5U + pages.size() * 2U;
    std::vector<std::string> objects(objectCount);

    setObject(objects, catalogId, "<< /Type /Catalog /Pages 2 0 R >>");
    std::string pageTree = "<< /Type /Pages /Count " + std::to_string(pages.size()) + " /Kids [";
    for (std::size_t index = 0; index < pages.size(); ++index)
        pageTree += " " + std::to_string(firstPageId + index * 2U) + " 0 R";
    pageTree += " ] >>";
    setObject(objects, pagesId, std::move(pageTree));
    setObject(objects,
              type0FontId,
              "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
              "/Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>");
    setObject(objects,
              cidFontId,
              "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
              "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>");

    const std::string unicodeMap = makeToUnicodeCMap();
    setObject(objects,
              unicodeMapId,
              "<< /Length " + std::to_string(unicodeMap.size()) + " >>\nstream\n" + unicodeMap +
                  "endstream");

    for (std::size_t index = 0; index < pages.size(); ++index) {
        Page& page = pages[index];
        const double footerY = 30.0;
        auto pageNumber = encodePdfText("Tutorux  |  Page " + std::to_string(index + 1U));
        if (!pageNumber)
            return std::unexpected(pageNumber.error());
        page.content += "BT /F1 8 Tf 0.42 0.48 0.45 rg 1 0 0 1 56 " + std::to_string(footerY) +
                        " Tm <" + *pageNumber + "> Tj ET\n";
        const std::size_t pageId = firstPageId + index * 2U;
        const std::size_t contentId = pageId + 1U;
        setObject(objects,
                  pageId,
                  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                  "/Resources << /Font << /F1 3 0 R >> >> /Contents " +
                      std::to_string(contentId) + " 0 R >>");
        setObject(objects,
                  contentId,
                  "<< /Length " + std::to_string(page.content.size()) + " >>\nstream\n" +
                      std::move(page.content) + "endstream");
    }

    std::string output = pdfDocument(objects);
    if (output.empty()) {
        return std::unexpected(
            core::error("pdf_export_failed", "Unable to serialize the portable PDF document."));
    }
    return output;
}

} // namespace tutorux::document

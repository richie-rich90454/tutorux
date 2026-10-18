#include "tutorux/document/pdf_export.hpp"

#include <podofo/podofo.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <functional>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <sstream>
#include <string_view>
#include <vector>

namespace tutorux::document {
namespace {

    using core::Result;

    struct Utf8Character final {
        char32_t value{};
        std::size_t offset{};
        std::size_t length{};
    };

    Result<std::vector<Utf8Character>> decodeUtf8(std::string_view text) {
        std::vector<Utf8Character> characters;
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
            const bool overlong = (length == 2 && value < 0x80U) ||
                                  (length == 3 && value < 0x800U) ||
                                  (length == 4 && value < 0x10000U);
            if (overlong || value > 0x10ffffU || (value >= 0xd800U && value <= 0xdfffU)) {
                return std::unexpected(
                    core::error("pdf_text_encoding_invalid", "Guide text contains invalid UTF-8."));
            }
            characters.push_back(Utf8Character{value, offset, length});
            offset += length;
        }
        return characters;
    }

    std::vector<std::string_view> guideText(const domain::GuideDocument& guide) {
        std::vector<std::string_view> values{
            guide.title,
            guide.templateId,
            guide.approvalState,
            guide.sessionId,
            "TUTORUX | STUDY GUIDE",
            "TUTORUX | TEACHING GUIDE",
            "A session-linked learning guide",
            "SESSION",
            "TEMPLATE",
            "REVIEW STATE",
            "Source: ",
            "Tutorux | ",
            "Page ",
        };
        for (const auto& section : guide.sections) {
            values.push_back(section.heading);
            for (const auto& block : section.blocks) {
                values.push_back(block.kind);
                values.push_back(domain::renderGuideInlineText(block.text));
                for (const auto& sourceId : block.sourceIds)
                    values.push_back(sourceId);
            }
        }
        return values;
    }

    Result<PoDoFo::PdfFont*> selectFont(PoDoFo::PdfDocument& document,
                                        const domain::GuideDocument& guide) {
        std::set<char32_t> requiredCharacters;
        for (const std::string_view value : guideText(guide)) {
            auto decoded = decodeUtf8(value);
            if (!decoded)
                return std::unexpected(decoded.error());
            for (const auto& character : *decoded) {
                if (character.value >= 0x20U && character.value != 0x7fU)
                    requiredCharacters.insert(character.value);
            }
        }

#ifdef _WIN32
        constexpr std::array<std::string_view, 7> fontPatterns{
            "Microsoft YaHei",  "Yu Gothic",        "Meiryo", "Malgun Gothic",
            "Noto Sans CJK SC", "Arial Unicode MS", "Arial"};
#elif defined(__APPLE__)
        constexpr std::array<std::string_view, 6> fontPatterns{
            "PingFang SC",      "Hiragino Sans",    "Yu Gothic",
            "Noto Sans CJK SC", "Arial Unicode MS", "Arial"};
#else
        constexpr std::array<std::string_view, 6> fontPatterns{
            "Noto Sans CJK SC", "Noto Sans CJK JP", "Noto Sans CJK KR",
            "Noto Sans",        "DejaVu Sans",      "Liberation Sans"};
#endif
        std::string fontSearchDetails;
        const auto coversGuide = [&requiredCharacters](const PoDoFo::PdfFont& font) {
            return std::all_of(
                requiredCharacters.begin(), requiredCharacters.end(), [&](char32_t character) {
                    unsigned glyph = 0;
                    return font.TryGetGID(character, PoDoFo::PdfGlyphAccess::FontProgram, glyph) &&
                           glyph != 0;
                });
        };
        for (const std::string_view pattern : fontPatterns) {
            PoDoFo::PdfFont* font = document.GetFonts().SearchFont(pattern);
            if (!font) {
                if (!fontSearchDetails.empty())
                    fontSearchDetails += "; ";
                fontSearchDetails += pattern;
                fontSearchDetails += " was not found";
                continue;
            }
            if (coversGuide(*font))
                return font;
            if (!fontSearchDetails.empty())
                fontSearchDetails += "; ";
            fontSearchDetails += pattern;
            fontSearchDetails += " does not cover all guide characters";
        }
#ifdef _WIN32
        if (const char* windowsDirectory = std::getenv("WINDIR")) {
            const std::filesystem::path fontDirectory =
                std::filesystem::path(windowsDirectory) / "Fonts";
            constexpr std::array<std::string_view, 2> windowsFontFileNames{"msyh.ttc",
                                                                           "NotoSansSC-VF.ttf"};
            for (const std::string_view fontName : windowsFontFileNames) {
                const std::filesystem::path fontPath = fontDirectory / fontName;
                std::error_code status;
                if (!std::filesystem::is_regular_file(fontPath, status))
                    continue;
                try {
                    PoDoFo::PdfFont& font =
                        document.GetFonts().GetOrCreateFont(fontPath.string(), 0);
                    if (coversGuide(font))
                        return &font;
                } catch (const std::exception&) {
                }
            }
        }
#endif
        return std::unexpected(core::error(
            "pdf_font_missing",
            "No installed Unicode font covers all guide text. Install a CJK-capable font and "
            "try the PDF export again. Font search: " +
                fontSearchDetails + "."));
    }

    std::vector<std::string> wrapText(std::string_view text, const PoDoFo::PdfFont& font,
                                      const PoDoFo::PdfTextState& textState, double width) {
        auto decoded = decodeUtf8(text);
        if (!decoded)
            return {};
        std::vector<std::string> lines;
        std::string line;
        const auto trimRight = [](std::string& value) {
            while (!value.empty() && (value.back() == ' ' || value.back() == '\t'))
                value.pop_back();
        };
        const auto trimLeft = [](std::string& value) {
            while (!value.empty() && (value.front() == ' ' || value.front() == '\t'))
                value.erase(value.begin());
        };
        for (const auto& character : *decoded) {
            if (character.value == '\r')
                continue;
            if (character.value == '\n') {
                trimRight(line);
                lines.push_back(std::move(line));
                line.clear();
                continue;
            }
            const std::string_view codepoint = text.substr(character.offset, character.length);
            std::string candidate = line;
            candidate.append(codepoint);
            if (font.GetStringLength(candidate, textState) <= width || line.empty()) {
                line = std::move(candidate);
                continue;
            }
            const std::size_t breakAt = line.find_last_of(" \t");
            if (breakAt != std::string::npos) {
                std::string next = line.substr(breakAt + 1);
                line.resize(breakAt);
                trimRight(line);
                trimLeft(next);
                lines.push_back(std::move(line));
                line = std::move(next);
                line.append(codepoint);
            } else {
                lines.push_back(std::move(line));
                line.assign(codepoint);
            }
        }
        trimRight(line);
        if (!line.empty() || lines.empty())
            lines.push_back(std::move(line));
        return lines;
    }

    class GuidePdfLayout final {
      public:
        GuidePdfLayout(PoDoFo::PdfStreamedDocument& document, PoDoFo::PdfFont& font,
                       std::span<const GuideImageAsset> images, std::string_view title,
                       std::string_view approvalState)
            : document_(document)
            , font_(font)
            , images_(images)
            , title_(title)
            , approvalState_(approvalState) {}

        core::Status render(const domain::GuideDocument& guide) {
            beginPage(true);
            drawCover(guide);
            finishPage();
            beginPage(false);
            for (const auto& section : guide.sections) {
                drawSectionHeading(section.heading);
                for (std::size_t index = 0; index < section.blocks.size(); ++index) {
                    const double followingBlockSpace =
                        index + 1 < section.blocks.size() ? 48.0 : 0.0;
                    drawBlock(section.blocks[index], followingBlockSpace);
                    if (renderError_)
                        return std::unexpected(*renderError_);
                }
            }
            finishPage();
            return {};
        }

      private:
        static constexpr double pageWidth = 595.28;
        static constexpr double pageHeight = 841.89;
        static constexpr double margin = 54.0;
        static constexpr double contentWidth = pageWidth - margin * 2.0;
        static constexpr double footerLimit = 42.0;

        void beginPage(bool cover) {
            ++pageNumber_;
            auto& page = document_.GetPages().CreatePage(PoDoFo::PdfPageSize::A4);
            painter_.SetCanvas(page);
            y_ = pageHeight - margin;
            if (cover) {
                painter_.GraphicsState.SetNonStrokingColor(PoDoFo::PdfColor(0.24, 0.40, 0.34));
                painter_.DrawRectangle(0.0, pageHeight - 13.0, pageWidth, 13.0,
                                       PoDoFo::PdfPathDrawMode::Fill);
            } else {
                drawText("TUTORUX | STUDY GUIDE", margin, y_, 8.5,
                         PoDoFo::PdfColor(0.31, 0.43, 0.37));
                drawText(title_, pageWidth - margin - 210.0, y_, 8.5,
                         PoDoFo::PdfColor(0.40, 0.45, 0.43));
                y_ -= 14.0;
                drawRule(y_);
                y_ -= 24.0;
            }
        }

        void finishPage() {
            painter_.GraphicsState.SetStrokingColor(PoDoFo::PdfColor(0.72, 0.77, 0.73));
            painter_.GraphicsState.SetLineWidth(0.6);
            painter_.DrawLine(margin, 31.0, pageWidth - margin, 31.0);
            drawText("Tutorux | " + std::string(approvalState_), margin, 18.0, 8.0,
                     PoDoFo::PdfColor(0.42, 0.48, 0.45));
            drawText("Page " + std::to_string(pageNumber_), pageWidth - margin - 62.0, 18.0, 8.0,
                     PoDoFo::PdfColor(0.42, 0.48, 0.45));
            painter_.FinishDrawing();
        }

        void ensureSpace(double height) {
            if (y_ - height < footerLimit) {
                finishPage();
                beginPage(false);
            }
        }

        void drawText(std::string_view text, double x, double y, double size,
                      const PoDoFo::PdfColor& color) {
            painter_.GraphicsState.SetNonStrokingColor(color);
            painter_.TextState.SetFont(font_, size);
            painter_.DrawText(text, x, y);
        }

        void drawRule(double y) {
            painter_.GraphicsState.SetStrokingColor(PoDoFo::PdfColor(0.81, 0.85, 0.81));
            painter_.GraphicsState.SetLineWidth(0.8);
            painter_.DrawLine(margin, y, pageWidth - margin, y);
        }

        void drawCover(const domain::GuideDocument& guide) {
            y_ -= 58.0;
            drawText("TUTORUX | TEACHING GUIDE", margin, y_, 9.5,
                     PoDoFo::PdfColor(0.24, 0.40, 0.34));
            y_ -= 56.0;
            drawWrapped(guide.title, margin, contentWidth, 29.0, 37.0,
                        PoDoFo::PdfColor(0.13, 0.20, 0.19));
            y_ -= 18.0;
            drawText("A session-linked learning guide", margin, y_, 12.0,
                     PoDoFo::PdfColor(0.35, 0.43, 0.39));
            y_ -= 34.0;
            drawRule(y_);
            y_ -= 28.0;
            drawText("SESSION", margin, y_, 8.0, PoDoFo::PdfColor(0.46, 0.53, 0.49));
            y_ -= 17.0;
            drawWrapped(guide.sessionId, margin, contentWidth, 10.0, 14.0,
                        PoDoFo::PdfColor(0.18, 0.25, 0.23));
            y_ -= 23.0;
            drawText("TEMPLATE", margin, y_, 8.0, PoDoFo::PdfColor(0.46, 0.53, 0.49));
            y_ -= 17.0;
            drawText(guide.templateId, margin, y_, 10.0, PoDoFo::PdfColor(0.18, 0.25, 0.23));
            y_ -= 23.0;
            drawText("REVIEW STATE", margin, y_, 8.0, PoDoFo::PdfColor(0.46, 0.53, 0.49));
            y_ -= 17.0;
            drawText(guide.approvalState, margin, y_, 10.0, PoDoFo::PdfColor(0.18, 0.25, 0.23));
            y_ -= 28.0;
            drawText(std::to_string(guide.sections.size()) + " sections", margin, y_, 9.0,
                     PoDoFo::PdfColor(0.38, 0.46, 0.42));
            y_ -= 40.0;
            drawRule(y_);
            y_ -= 42.0;
        }

        void drawSectionHeading(std::string_view heading) {
            ensureSpace(48.0);
            y_ -= 10.0;
            drawWrapped(heading, margin, contentWidth, 16.5, 22.0,
                        PoDoFo::PdfColor(0.22, 0.40, 0.34));
            y_ -= 5.0;
            drawRule(y_);
            y_ -= 18.0;
        }

        void drawWrapped(std::string_view text, double x, double width, double size,
                         double lineHeight, const PoDoFo::PdfColor& color) {
            painter_.TextState.SetFont(font_, size);
            const auto lines = wrapText(text, font_, painter_.TextState.GetState(), width);
            for (const std::string& line : lines) {
                ensureSpace(lineHeight);
                drawText(line, x, y_, size, color);
                y_ -= lineHeight;
            }
        }

        core::Result<PoDoFo::PdfImage*> getImage(std::string_view assetId) {
            const auto cached = imageCache_.find(assetId);
            if (cached != imageCache_.end())
                return cached->second.get();
            const auto asset =
                std::find_if(images_.begin(), images_.end(), [&](const GuideImageAsset& candidate) {
                    return candidate.assetId == assetId;
                });
            if (asset == images_.end()) {
                return std::unexpected(
                    core::error("pdf_image_missing", "An embedded guide image was not loaded."));
            }
            auto image = document_.CreateImage();
            const char* data = reinterpret_cast<const char*>(asset->bytes.data());
            image->LoadFromBuffer(PoDoFo::bufferview(data, asset->bytes.size()));
            auto [inserted, wasInserted] = imageCache_.emplace(asset->assetId, std::move(image));
            static_cast<void>(wasInserted);
            return inserted->second.get();
        }

        void drawImageBlock(const domain::GuideBlock& block,
                            const domain::GuideImageReference& imageReference,
                            double followingBlockSpace) {
            auto image = getImage(imageReference.assetId);
            if (!image) {
                renderError_ = image.error();
                return;
            }
            const double nativeWidth = static_cast<double>((*image)->GetWidth());
            const double nativeHeight = static_cast<double>((*image)->GetHeight());
            if (nativeWidth <= 0.0 || nativeHeight <= 0.0) {
                renderError_ = core::error("pdf_image_dimensions_invalid",
                                           "The guide image has invalid dimensions.");
                return;
            }

            constexpr double maximumImageHeight = 360.0;
            const double scale =
                std::min({1.0, contentWidth / nativeWidth, maximumImageHeight / nativeHeight});
            const double imageWidth = nativeWidth * scale;
            const double imageHeight = nativeHeight * scale;
            const double captionHeight = imageReference.alternativeText.empty() ? 0.0 : 18.0;
            const std::string label = domain::guideBlockLabel(block);
            ensureSpace(imageHeight + captionHeight + followingBlockSpace + 10.0 +
                        (label.empty() ? 0.0 : 14.0));
            if (!label.empty()) {
                drawWrapped(label, margin, contentWidth, 8.1, 11.0,
                            PoDoFo::PdfColor(0.40, 0.47, 0.43));
                y_ -= 3.0;
            }
            painter_.DrawImage(**image, margin + (contentWidth - imageWidth) / 2.0,
                               y_ - imageHeight, scale, scale);
            y_ -= imageHeight + 7.0;
            if (!imageReference.alternativeText.empty()) {
                drawWrapped(imageReference.alternativeText, margin, contentWidth, 8.7, 11.0,
                            PoDoFo::PdfColor(0.40, 0.47, 0.43));
            }
            if (!block.sourceIds.empty()) {
                std::string sources = "Source: ";
                for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                    if (index != 0)
                        sources += ", ";
                    sources += block.sourceIds[index];
                }
                drawWrapped(sources, margin, contentWidth, 8.1, 11.0,
                            PoDoFo::PdfColor(0.40, 0.47, 0.43));
            }
            y_ -= 7.0 + followingBlockSpace;
        }

        void drawTable(const domain::GuideTable& table) {
            if (table.empty() || table.front().empty())
                return;
            constexpr double fontSize = 8.4;
            constexpr double lineHeight = 10.4;
            constexpr double cellPadding = 5.0;
            const std::size_t columnCount = table.front().size();
            const double columnWidth = contentWidth / static_cast<double>(columnCount);

            for (std::size_t rowIndex = 0; rowIndex < table.size(); ++rowIndex) {
                const auto& row = table[rowIndex];
                if (row.size() != columnCount)
                    return;
                std::vector<std::vector<std::string>> cellLines;
                cellLines.reserve(columnCount);
                std::size_t maximumLineCount = 1;
                painter_.TextState.SetFont(font_, fontSize);
                for (const auto& cell : row) {
                    const std::string cellText = domain::renderGuideInlineText(cell);
                    auto lines = wrapText(cellText, font_, painter_.TextState.GetState(),
                                          columnWidth - 2.0 * cellPadding);
                    if (lines.empty())
                        lines.emplace_back();
                    maximumLineCount = std::max(maximumLineCount, lines.size());
                    cellLines.push_back(std::move(lines));
                }

                const double rowHeight =
                    static_cast<double>(maximumLineCount) * lineHeight + 2.0 * cellPadding;
                ensureSpace(rowHeight + 3.0);
                const double rowTop = y_;
                const double rowBottom = rowTop - rowHeight;
                if (rowIndex == 0) {
                    painter_.GraphicsState.SetNonStrokingColor(PoDoFo::PdfColor(0.91, 0.94, 0.91));
                    painter_.DrawRectangle(margin, rowBottom, contentWidth, rowHeight,
                                           PoDoFo::PdfPathDrawMode::Fill);
                }
                painter_.GraphicsState.SetStrokingColor(PoDoFo::PdfColor(0.76, 0.81, 0.77));
                painter_.GraphicsState.SetLineWidth(0.55);
                painter_.DrawLine(margin, rowTop, margin + contentWidth, rowTop);
                painter_.DrawLine(margin, rowBottom, margin + contentWidth, rowBottom);
                for (std::size_t columnIndex = 0; columnIndex <= columnCount; ++columnIndex) {
                    const double x = margin + static_cast<double>(columnIndex) * columnWidth;
                    painter_.DrawLine(x, rowTop, x, rowBottom);
                }

                painter_.TextState.SetFont(font_, fontSize);
                for (std::size_t columnIndex = 0; columnIndex < columnCount; ++columnIndex) {
                    const double x =
                        margin + static_cast<double>(columnIndex) * columnWidth + cellPadding;
                    double baseline = rowTop - cellPadding - fontSize;
                    for (const auto& line : cellLines[columnIndex]) {
                        drawText(line, x, baseline, fontSize, PoDoFo::PdfColor(0.18, 0.24, 0.22));
                        baseline -= lineHeight;
                    }
                }
                y_ = rowBottom - 3.0;
            }
        }

        void drawBlock(const domain::GuideBlock& block, double followingBlockSpace) {
            constexpr double fontSize = 10.2;
            constexpr double lineHeight = 15.0;
            constexpr double sourceLineHeight = 11.0;
            if (block.kind == "image" || block.kind == "figure" || block.text.starts_with("![")) {
                auto image = domain::parseGuideImageReference(block.text);
                if (!image) {
                    renderError_ = image.error();
                    return;
                }
                drawImageBlock(block, *image, followingBlockSpace);
                return;
            }
            if (block.kind == "table") {
                auto table = domain::parseGuideTable(block.text);
                if (table) {
                    const std::string label = domain::guideBlockLabel(block);
                    if (!label.empty()) {
                        drawWrapped(label, margin, contentWidth, 8.1, sourceLineHeight,
                                    PoDoFo::PdfColor(0.40, 0.47, 0.43));
                        y_ -= 3.0;
                    }
                    drawTable(*table);
                }
                if (!block.sourceIds.empty()) {
                    std::string sources = "Source: ";
                    for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                        if (index != 0)
                            sources += ", ";
                        sources += block.sourceIds[index];
                    }
                    drawWrapped(sources, margin, contentWidth, 8.1, sourceLineHeight,
                                PoDoFo::PdfColor(0.40, 0.47, 0.43));
                }
                y_ -= 7.0 + followingBlockSpace;
                return;
            }
            const bool listItem = block.kind == "list-item";
            const bool quote = block.kind == "quote";
            const double indent = listItem ? 17.0 : (quote ? 12.0 : 0.0);
            painter_.TextState.SetFont(font_, fontSize);
            const std::string label = domain::guideBlockLabel(block);
            const std::string body = domain::renderGuideInlineText(block.text);
            const std::string displayText = label.empty() ? body : std::string(label) + ": " + body;
            const auto lines =
                wrapText(displayText, font_, painter_.TextState.GetState(), contentWidth - indent);

            std::string sources;
            std::vector<std::string> sourceLines;
            if (!block.sourceIds.empty()) {
                sources = "Source: ";
                for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                    if (index != 0)
                        sources += ", ";
                    sources += block.sourceIds[index];
                }
                painter_.TextState.SetFont(font_, 8.1);
                sourceLines =
                    wrapText(sources, font_, painter_.TextState.GetState(), contentWidth - indent);
            }

            const double blockHeight = static_cast<double>(lines.size()) * lineHeight +
                                       static_cast<double>(sourceLines.size()) * sourceLineHeight +
                                       7.0;
            ensureSpace(blockHeight + followingBlockSpace);
            bool firstLine = true;
            painter_.TextState.SetFont(font_, fontSize);
            for (const std::string& line : lines) {
                if (quote) {
                    painter_.GraphicsState.SetNonStrokingColor(PoDoFo::PdfColor(0.94, 0.96, 0.93));
                    painter_.DrawRectangle(margin, y_ - 4.0, contentWidth, lineHeight + 7.0,
                                           PoDoFo::PdfPathDrawMode::Fill);
                    painter_.GraphicsState.SetStrokingColor(PoDoFo::PdfColor(0.36, 0.56, 0.45));
                    painter_.GraphicsState.SetLineWidth(2.0);
                    painter_.DrawLine(margin + 2.0, y_ + 2.0, margin + 2.0, y_ - lineHeight + 1.0);
                } else if (listItem && firstLine) {
                    painter_.GraphicsState.SetNonStrokingColor(PoDoFo::PdfColor(0.78, 0.48, 0.28));
                    painter_.DrawCircle(margin + 4.0, y_ + 3.2, 2.0, PoDoFo::PdfPathDrawMode::Fill);
                }
                const PoDoFo::PdfColor textColor =
                    quote ? PoDoFo::PdfColor(0.28, 0.37, 0.33) : PoDoFo::PdfColor(0.18, 0.24, 0.22);
                drawText(line, margin + indent, y_, fontSize, textColor);
                y_ -= lineHeight;
                firstLine = false;
            }

            if (!sources.empty()) {
                drawWrapped(sources, margin + indent, contentWidth - indent, 8.1, sourceLineHeight,
                            PoDoFo::PdfColor(0.40, 0.47, 0.43));
            }
            y_ -= 7.0;
        }

        PoDoFo::PdfStreamedDocument& document_;
        PoDoFo::PdfFont& font_;
        PoDoFo::PdfPainter painter_;
        std::span<const GuideImageAsset> images_;
        std::map<std::string, std::unique_ptr<PoDoFo::PdfImage>, std::less<>> imageCache_;
        std::optional<core::Error> renderError_;
        std::string_view title_;
        std::string_view approvalState_;
        unsigned pageNumber_{};
        double y_{};
    };

} // namespace

core::Result<std::string> renderGuidePdf(const domain::GuideDocument& guide,
                                         std::span<const GuideImageAsset> images) {
    if (guide.title.empty()) {
        return std::unexpected(
            core::error("guide_title_required", "Guide title is required for PDF export."));
    }
    try {
        std::stringstream buffer(std::ios::in | std::ios::out | std::ios::binary);
        auto outputDevice = std::make_shared<PoDoFo::StandardStreamDevice>(buffer);
        {
            PoDoFo::PdfStreamedDocument document(outputDevice);
            auto font = selectFont(document, guide);
            if (!font)
                return std::unexpected(font.error());
            auto& metadata = document.GetMetadata();
            metadata.SetTitle(PoDoFo::PdfString(guide.title));
            metadata.SetCreator(PoDoFo::PdfString("Tutorux"));
            metadata.SetSubject(PoDoFo::PdfString("Session-linked teaching guide"));
            GuidePdfLayout layout(document, **font, images, guide.title, guide.approvalState);
            auto rendered = layout.render(guide);
            if (!rendered)
                return std::unexpected(rendered.error());
        }
        return buffer.str();
    } catch (const std::exception& exception) {
        return std::unexpected(core::error(
            "pdf_export_failed", std::string("Unable to render guide PDF: ") + exception.what()));
    }
}

} // namespace tutorux::document

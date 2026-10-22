// DOCX rendering coverage for every supported guide block shape.
#include "tutorux/document/docx_export.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <iostream>
#include <string>
#include <string_view>
#include <vector>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "docx export: " << label << '\n';
    return false;
}

bool contains(std::string_view haystack, std::string_view needle) {
    return haystack.find(needle) != std::string_view::npos;
}

std::vector<std::byte> pngBytes() {
    constexpr unsigned char data[] = {
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
        0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
        0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xdd, 0x8d, 0xb4, 0x00, 0x00, 0x00,
        0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82};
    std::vector<std::byte> bytes;
    bytes.reserve(sizeof(data));
    for (const unsigned char value : data)
        bytes.push_back(static_cast<std::byte>(value));
    return bytes;
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    domain::GuideDocument guide;
    guide.id = archive::randomUuid();
    guide.entryId = archive::uuidToString(archive::randomUuid());
    guide.sessionId = archive::uuidToString(archive::randomUuid());
    guide.title = "Fractions and number lines";
    guide.templateId = "mathematics";
    guide.approvalState = "approved";
    guide.sections.push_back(
        {"overview",
         "Overview",
         {
             domain::GuideBlock("paragraph", "Compare fractions using a number line.", {}, false,
                                "tutor-authored"),
             domain::GuideBlock("instruction", "Draw the number line first.", {}, false,
                                "tutor-authored"),
             domain::GuideBlock("recommendation", "Try two more examples.", {}, false,
                                "ai-generated"),
         }});
    guide.sections.push_back(
        {"practice",
         "Practice",
         {
             domain::GuideBlock("list-item", "One half", {}, false, "tutor-authored"),
             domain::GuideBlock("quote", "A student response.", {}, false, "tutor-authored"),
             domain::GuideBlock("code", "1/2 < 2/3", {}, false, "tutor-authored"),
             domain::GuideBlock("table", "| Fraction | Decimal |\n| --- | --- |\n| 1/2 | 0.5 |\n",
                                {}, false, "tutor-authored"),
             domain::GuideBlock("image", "![Number line](asset:" +
                                             archive::uuidToString(archive::randomUuid()) + ")",
                                {}, false, "tutor-authored"),
         }});

    const auto imageId = guide.sections.back().blocks.back().text;
    std::vector<document::GuideImageAsset> images;
    document::GuideImageAsset image;
    const auto assetStart = imageId.find("asset:");
    image.assetId = imageId.substr(assetStart + 6, imageId.size() - assetStart - 7);
    image.mimeType = "image/png";
    image.bytes = pngBytes();
    images.push_back(image);

    auto rendered = document::renderGuideDocx(guide, images);
    okay &= expect(rendered.has_value(), "DOCX rendering failed");
    if (rendered) {
        okay &= expect(rendered->size() > 1000, "DOCX output is too small");
        okay &= expect(rendered->starts_with("PK\x03\x04"), "DOCX is not a ZIP container");
        okay &= expect(contains(*rendered, "word/document.xml"),
                       "DOCX document part is missing");
        okay &= expect(contains(*rendered, "[Content_Types].xml"),
                       "DOCX content types are missing");
        okay &= expect(contains(*rendered, "Fractions and number lines"),
                       "DOCX title is missing");
    }

    auto missingImage = document::renderGuideDocx(guide, {});
    okay &= expect(!missingImage, "DOCX accepted a missing image asset");

    guide.sections.back().blocks.back().kind = "paragraph";
    guide.sections.back().blocks.back().text = "No image.";
    auto textOnly = document::renderGuideDocx(guide);
    okay &= expect(textOnly.has_value(), "text-only DOCX rendering failed");

    return okay ? 0 : 1;
}

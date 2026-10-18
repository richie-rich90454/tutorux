#include "tutorux/document/pdf_export.hpp"

#include "image_decoder.hpp"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace tutorux::document {
namespace {

    struct Character final {
        char32_t value{};
        std::string_view bytes;
    };

    struct Page final {
        std::string content;
        std::vector<std::size_t> imageIndexes;
        double y{744.0};
    };

    struct EmbeddedImage final {
        std::string assetId;
        std::string resourceName;
        std::string colorSpace;
        std::string filter;
        std::string decodeParameters;
        std::string bytes;
        std::string alphaBytes;
        std::uint32_t width{};
        std::uint32_t height{};
    };

    std::uint32_t readBigEndian32(std::span<const std::byte> bytes, std::size_t offset) {
        return (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset])) << 24U) |
               (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 1U]))
                << 16U) |
               (static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 2U]))
                << 8U) |
               static_cast<std::uint32_t>(std::to_integer<std::uint8_t>(bytes[offset + 3U]));
    }

    core::Status decodeImageIntoPdf(EmbeddedImage& image, const GuideImageAsset& asset) {
        const std::span<const std::byte> encoded(asset.bytes);
        auto decoded = detail::decodePortableImage(asset.mimeType, encoded);
        if (!decoded)
            return std::unexpected(decoded.error());

        image.width = decoded->width;
        image.height = decoded->height;
        image.colorSpace = "/DeviceRGB";
        image.filter.clear();
        image.decodeParameters.clear();
        const std::size_t pixelCount =
            static_cast<std::size_t>(image.width) * static_cast<std::size_t>(image.height);
        image.bytes.resize(pixelCount * 3U);
        image.alphaBytes.resize(pixelCount);
        bool hasTransparency = false;
        for (std::size_t pixel = 0; pixel < pixelCount; ++pixel) {
            const std::size_t sourceOffset = pixel * 4U;
            const std::size_t targetOffset = pixel * 3U;
            std::memcpy(image.bytes.data() + targetOffset, decoded->pixels.data() + sourceOffset,
                        3U);
            std::memcpy(image.alphaBytes.data() + pixel, decoded->pixels.data() + sourceOffset + 3U,
                        1U);
            hasTransparency = hasTransparency || decoded->pixels[sourceOffset + 3U] != 0xffU;
        }
        if (!hasTransparency)
            image.alphaBytes.clear();
        return {};
    }

    core::Result<EmbeddedImage> preparePdfImage(const GuideImageAsset& asset,
                                                std::string resourceName) {
        constexpr std::size_t maximumImageBytes = 64U * 1024U * 1024U;
        constexpr std::uint64_t maximumImagePixels = 100'000'000U;
        const std::span<const std::byte> bytes(asset.bytes);
        if (bytes.empty() || bytes.size() > maximumImageBytes) {
            return std::unexpected(core::error("pdf_image_size_invalid",
                                               "The guide image is empty or exceeds 64 MiB."));
        }

        EmbeddedImage image;
        image.assetId = asset.assetId;
        image.resourceName = std::move(resourceName);
        if ((asset.mimeType == "image/jpeg" || asset.mimeType == "image/jpg") &&
            bytes.size() >= 4U && std::to_integer<std::uint8_t>(bytes[0]) == 0xffU &&
            std::to_integer<std::uint8_t>(bytes[1]) == 0xd8U) {
            std::size_t offset = 2U;
            bool dimensionsFound = false;
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
                if (segmentLength < 2U || segmentLength > bytes.size() - offset)
                    break;
                const bool startOfFrame = marker == 0xc0U || marker == 0xc1U || marker == 0xc2U ||
                                          marker == 0xc3U || marker == 0xc5U || marker == 0xc6U ||
                                          marker == 0xc7U || marker == 0xc9U || marker == 0xcaU ||
                                          marker == 0xcbU || marker == 0xcdU || marker == 0xceU ||
                                          marker == 0xcfU;
                if (startOfFrame && segmentLength >= 8U) {
                    const std::uint8_t precision =
                        std::to_integer<std::uint8_t>(bytes[offset + 2U]);
                    image.height = static_cast<std::uint32_t>(
                        (std::to_integer<std::uint8_t>(bytes[offset + 3U]) << 8U) |
                        std::to_integer<std::uint8_t>(bytes[offset + 4U]));
                    image.width = static_cast<std::uint32_t>(
                        (std::to_integer<std::uint8_t>(bytes[offset + 5U]) << 8U) |
                        std::to_integer<std::uint8_t>(bytes[offset + 6U]));
                    const std::uint8_t components =
                        std::to_integer<std::uint8_t>(bytes[offset + 7U]);
                    if (precision != 8U || segmentLength < 8U + 3U * components) {
                        return std::unexpected(
                            core::error("pdf_jpeg_features_unsupported",
                                        "Portable PDF export supports valid 8-bit JPEG images."));
                    }
                    if (components == 1U)
                        image.colorSpace = "/DeviceGray";
                    else if (components == 3U)
                        image.colorSpace = "/DeviceRGB";
                    else {
                        return std::unexpected(core::error(
                            "pdf_image_components_unsupported",
                            "Portable PDF export supports grayscale and RGB JPEG images."));
                    }
                    dimensionsFound = true;
                    break;
                }
                offset += segmentLength;
            }
            if (!dimensionsFound) {
                return std::unexpected(core::error("pdf_image_dimensions_invalid",
                                                   "The JPEG image dimensions are invalid."));
            }
            image.filter = "/DCTDecode";
            image.bytes.assign(reinterpret_cast<const char*>(bytes.data()), bytes.size());
        } else if (asset.mimeType == "image/png" && bytes.size() >= 33U &&
                   std::to_integer<std::uint8_t>(bytes[0]) == 0x89U &&
                   std::to_integer<std::uint8_t>(bytes[1]) == 'P' &&
                   std::to_integer<std::uint8_t>(bytes[2]) == 'N' &&
                   std::to_integer<std::uint8_t>(bytes[3]) == 'G' &&
                   std::to_integer<std::uint8_t>(bytes[4]) == 0x0dU &&
                   std::to_integer<std::uint8_t>(bytes[5]) == 0x0aU &&
                   std::to_integer<std::uint8_t>(bytes[6]) == 0x1aU &&
                   std::to_integer<std::uint8_t>(bytes[7]) == 0x0aU) {
            bool decodeRequired = false;
            std::size_t offset = 8U;
            bool headerFound = false;
            bool endFound = false;
            bool imageDataStarted = false;
            bool imageDataEnded = false;
            std::uint8_t colorType{};
            std::uint8_t bitDepth{};
            std::string compressedData;
            while (offset < bytes.size()) {
                if (bytes.size() - offset < 12U) {
                    return std::unexpected(core::error("pdf_png_chunk_invalid",
                                                       "The PNG contains a truncated chunk."));
                }
                const std::uint32_t chunkLength = readBigEndian32(bytes, offset);
                const std::size_t dataOffset = offset + 8U;
                if (chunkLength > bytes.size() - dataOffset - 4U) {
                    return std::unexpected(core::error("pdf_png_chunk_invalid",
                                                       "The PNG chunk exceeds the image data."));
                }
                const std::string_view chunkType(
                    reinterpret_cast<const char*>(bytes.data() + offset + 4U), 4U);
                if (chunkType == "IHDR") {
                    if (headerFound || offset != 8U || chunkLength != 13U) {
                        return std::unexpected(core::error("pdf_png_header_invalid",
                                                           "The PNG image header is invalid."));
                    }
                    image.width = readBigEndian32(bytes, dataOffset);
                    image.height = readBigEndian32(bytes, dataOffset + 4U);
                    bitDepth = std::to_integer<std::uint8_t>(bytes[dataOffset + 8U]);
                    colorType = std::to_integer<std::uint8_t>(bytes[dataOffset + 9U]);
                    const std::uint8_t compression =
                        std::to_integer<std::uint8_t>(bytes[dataOffset + 10U]);
                    const std::uint8_t filtering =
                        std::to_integer<std::uint8_t>(bytes[dataOffset + 11U]);
                    const std::uint8_t interlace =
                        std::to_integer<std::uint8_t>(bytes[dataOffset + 12U]);
                    if (bitDepth != 8U || (colorType != 0U && colorType != 2U) ||
                        compression != 0U || filtering != 0U || interlace != 0U) {
                        decodeRequired = true;
                        break;
                    }
                    image.colorSpace = colorType == 0U ? "/DeviceGray" : "/DeviceRGB";
                    headerFound = true;
                } else if (chunkType == "IDAT") {
                    if (!headerFound || endFound || imageDataEnded) {
                        return std::unexpected(core::error("pdf_png_data_invalid",
                                                           "The PNG image data is out of order."));
                    }
                    imageDataStarted = true;
                    compressedData.append(reinterpret_cast<const char*>(bytes.data() + dataOffset),
                                          chunkLength);
                } else if (chunkType == "PLTE") {
                    if (!headerFound || imageDataStarted || colorType == 0U || chunkLength == 0U ||
                        chunkLength > 768U || chunkLength % 3U != 0U) {
                        return std::unexpected(
                            core::error("pdf_png_palette_invalid", "The PNG palette is invalid."));
                    }
                } else if (chunkType == "IEND") {
                    if (chunkLength != 0U || !imageDataStarted) {
                        return std::unexpected(core::error(
                            "pdf_png_end_invalid", "The PNG image is missing valid image data."));
                    }
                    endFound = true;
                    break;
                } else if (chunkType == "tRNS") {
                    decodeRequired = true;
                    break;
                } else if (imageDataStarted) {
                    imageDataEnded = true;
                    if ((static_cast<unsigned char>(chunkType.front()) & 0x20U) == 0U) {
                        return std::unexpected(
                            core::error("pdf_png_chunk_unsupported",
                                        "The PNG contains an unsupported critical chunk."));
                    }
                } else if (!headerFound ||
                           (static_cast<unsigned char>(chunkType.front()) & 0x20U) == 0U) {
                    return std::unexpected(
                        core::error("pdf_png_chunk_unsupported",
                                    "The PNG contains an unsupported critical chunk."));
                }
                offset = dataOffset + static_cast<std::size_t>(chunkLength) + 4U;
            }
            if (decodeRequired) {
                if (auto status = decodeImageIntoPdf(image, asset); !status)
                    return std::unexpected(status.error());
            } else {
                if (!headerFound || !endFound || compressedData.empty()) {
                    return std::unexpected(
                        core::error("pdf_png_invalid", "The PNG image is incomplete."));
                }
                image.filter = "/FlateDecode";
                image.decodeParameters = " /DecodeParms << /Predictor 15 /Colors " +
                                         std::string(colorType == 0U ? "1" : "3") +
                                         " /BitsPerComponent 8 /Columns " +
                                         std::to_string(image.width) + " >>";
                image.bytes = std::move(compressedData);
            }
        } else if (asset.mimeType == "image/gif" || asset.mimeType == "image/webp") {
            if (auto status = decodeImageIntoPdf(image, asset); !status)
                return std::unexpected(status.error());
        } else {
            return std::unexpected(core::error(
                "pdf_image_format_unsupported",
                "Portable PDF export supports JPEG and PNG, GIF, or WebP guide images."));
        }
        if (image.width == 0U || image.height == 0U || image.width > 100'000U ||
            image.height > 100'000U ||
            static_cast<std::uint64_t>(image.width) * image.height > maximumImagePixels) {
            return std::unexpected(core::error("pdf_image_dimensions_invalid",
                                               "The guide image dimensions exceed safe limits."));
        }
        return image;
    }

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
        constexpr std::array<char, 16> digits{'0', '1', '2', '3', '4', '5', '6', '7',
                                              '8', '9', 'A', 'B', 'C', 'D', 'E', 'F'};
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

    core::Result<std::vector<std::string>> wrapText(std::string_view text, double width,
                                                    double size) {
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

    core::Status drawText(std::vector<Page>& pages, std::string_view text, double size,
                          double lineHeight, std::string_view color = "0.13 0.20 0.18") {
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

core::Result<std::string> renderGuidePdf(const domain::GuideDocument& guide,
                                         std::span<const GuideImageAsset> imageAssets) {
    constexpr std::size_t maximumTotalImageStreamBytes = 128U * 1024U * 1024U;
    std::vector<Page> pages(1);
    std::vector<EmbeddedImage> embeddedImages;
    std::size_t totalImageStreamBytes{};
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
                               9.0, 20.0, "0.36 0.43 0.40");
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
            if (block.kind == "image" || block.kind == "figure" || block.text.starts_with("![")) {
                auto image = domain::parseGuideImageReference(block.text);
                if (!image)
                    return std::unexpected(image.error());
                const auto asset = std::find_if(imageAssets.begin(), imageAssets.end(),
                                                [&](const GuideImageAsset& candidate) {
                                                    return candidate.assetId == image->assetId;
                                                });
                if (asset == imageAssets.end()) {
                    return std::unexpected(core::error("pdf_image_missing",
                                                       "An embedded guide image was not loaded."));
                }
                auto embedded = std::find_if(embeddedImages.begin(), embeddedImages.end(),
                                             [&](const EmbeddedImage& candidate) {
                                                 return candidate.assetId == image->assetId;
                                             });
                std::size_t imageIndex{};
                if (embedded == embeddedImages.end()) {
                    auto prepared =
                        preparePdfImage(*asset, "Im" + std::to_string(embeddedImages.size() + 1U));
                    if (!prepared)
                        return std::unexpected(prepared.error());
                    const std::size_t streamBytes =
                        prepared->bytes.size() + prepared->alphaBytes.size();
                    if (streamBytes > maximumTotalImageStreamBytes - totalImageStreamBytes) {
                        return std::unexpected(core::error("pdf_image_output_limit",
                                                           "The combined guide image streams "
                                                           "exceed the 128 MiB PDF export limit."));
                    }
                    totalImageStreamBytes += streamBytes;
                    embeddedImages.push_back(std::move(*prepared));
                    imageIndex = embeddedImages.size() - 1U;
                } else {
                    imageIndex = static_cast<std::size_t>(embedded - embeddedImages.begin());
                }
                const EmbeddedImage& imageData = embeddedImages[imageIndex];
                constexpr double maximumImageWidth = 500.0;
                constexpr double maximumImageHeight = 320.0;
                const double scale =
                    std::min({1.0, maximumImageWidth / static_cast<double>(imageData.width),
                              maximumImageHeight / static_cast<double>(imageData.height)});
                const double drawWidth = static_cast<double>(imageData.width) * scale;
                const double drawHeight = static_cast<double>(imageData.height) * scale;
                const std::string label = domain::guideBlockLabel(block);
                const double labelSpace = (block.stale ? 14.0 : 0.0) + (label.empty() ? 0.0 : 14.0);
                const double captionSpace = image->alternativeText.empty() ? 0.0 : 14.0;
                const double sourceSpace = block.sourceIds.empty() ? 0.0 : 14.0;
                if (auto status = ensurePageSpace(pages, drawHeight + labelSpace + captionSpace +
                                                             sourceSpace + 15.0);
                    !status) {
                    return std::unexpected(status.error());
                }
                if (block.stale) {
                    if (auto status = drawText(pages, "[SOURCE CHANGED — REVIEW]", 8.0, 12.0,
                                               "0.62 0.22 0.18");
                        !status) {
                        return std::unexpected(status.error());
                    }
                }
                if (!label.empty()) {
                    if (auto status = drawText(pages, label, 8.1, 12.0, "0.40 0.47 0.43");
                        !status) {
                        return std::unexpected(status.error());
                    }
                }
                Page& page = pages.back();
                const double drawX = 56.0 + (maximumImageWidth - drawWidth) / 2.0;
                const double drawY = page.y - drawHeight;
                page.content += "q " + std::to_string(drawWidth) + " 0 0 " +
                                std::to_string(drawHeight) + " " + std::to_string(drawX) + " " +
                                std::to_string(drawY) + " cm /" + imageData.resourceName +
                                " Do Q\n";
                if (std::find(page.imageIndexes.begin(), page.imageIndexes.end(), imageIndex) ==
                    page.imageIndexes.end()) {
                    page.imageIndexes.push_back(imageIndex);
                }
                page.y -= drawHeight + 7.0;
                if (!image->alternativeText.empty()) {
                    if (auto status =
                            drawText(pages, image->alternativeText, 8.7, 11.0, "0.40 0.47 0.43");
                        !status) {
                        return std::unexpected(status.error());
                    }
                }
                if (!block.sourceIds.empty()) {
                    std::string sources = "Sources: ";
                    for (std::size_t index = 0; index < block.sourceIds.size(); ++index) {
                        if (index != 0)
                            sources += ", ";
                        sources += block.sourceIds[index];
                    }
                    if (auto status = drawText(pages, sources, 8.0, 12.0, "0.40 0.47 0.43");
                        !status) {
                        return std::unexpected(status.error());
                    }
                }
                pages.back().y -= 6.0;
                continue;
            }
            if (block.kind == "list-item")
                content = "• ";
            else if (block.kind == "quote")
                content = "“";
            if (block.stale)
                content += "[SOURCE CHANGED — REVIEW] ";
            const std::string label = domain::guideBlockLabel(block);
            if (!label.empty())
                content += label + ": ";
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
    const std::size_t pageObjectCount = 5U + pages.size() * 2U;
    const std::size_t firstImageId = pageObjectCount + 1U;
    std::vector<std::size_t> imageObjectIds(embeddedImages.size());
    std::vector<std::size_t> alphaMaskObjectIds(embeddedImages.size());
    std::size_t nextImageObjectId = firstImageId;
    for (std::size_t index = 0; index < embeddedImages.size(); ++index) {
        imageObjectIds[index] = nextImageObjectId++;
        if (!embeddedImages[index].alphaBytes.empty())
            alphaMaskObjectIds[index] = nextImageObjectId++;
    }
    const std::size_t objectCount = nextImageObjectId - 1U;
    std::vector<std::string> objects(objectCount);

    setObject(objects, catalogId, "<< /Type /Catalog /Pages 2 0 R >>");
    std::string pageTree = "<< /Type /Pages /Count " + std::to_string(pages.size()) + " /Kids [";
    for (std::size_t index = 0; index < pages.size(); ++index)
        pageTree += " " + std::to_string(firstPageId + index * 2U) + " 0 R";
    pageTree += " ] >>";
    setObject(objects, pagesId, std::move(pageTree));
    setObject(objects, type0FontId,
              "<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light "
              "/Encoding /UniGB-UCS2-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>");
    setObject(objects, cidFontId,
              "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light "
              "/CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> >>");

    const std::string unicodeMap = makeToUnicodeCMap();
    setObject(objects, unicodeMapId,
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
        std::string resources = "/Font << /F1 3 0 R >>";
        if (!page.imageIndexes.empty()) {
            resources += " /XObject <<";
            for (const std::size_t imageIndex : page.imageIndexes) {
                resources += " /" + embeddedImages[imageIndex].resourceName + " " +
                             std::to_string(imageObjectIds[imageIndex]) + " 0 R";
            }
            resources += " >>";
        }
        setObject(objects, pageId,
                  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << " +
                      resources + " >> /Contents " + std::to_string(contentId) + " 0 R >>");
        setObject(objects, contentId,
                  "<< /Length " + std::to_string(page.content.size()) + " >>\nstream\n" +
                      std::move(page.content) + "endstream");
    }
    for (std::size_t index = 0; index < embeddedImages.size(); ++index) {
        const EmbeddedImage& image = embeddedImages[index];
        std::string dictionary = "<< /Type /XObject /Subtype /Image /Width " +
                                 std::to_string(image.width) + " /Height " +
                                 std::to_string(image.height) + " /ColorSpace " + image.colorSpace +
                                 " /BitsPerComponent 8";
        if (!image.filter.empty())
            dictionary += " /Filter " + image.filter + image.decodeParameters;
        if (alphaMaskObjectIds[index] != 0U)
            dictionary += " /SMask " + std::to_string(alphaMaskObjectIds[index]) + " 0 R";
        dictionary += " /Length " + std::to_string(image.bytes.size()) + " >>\nstream\n" +
                      image.bytes + "\nendstream";
        setObject(objects, imageObjectIds[index], std::move(dictionary));
        if (alphaMaskObjectIds[index] != 0U) {
            const std::string& alpha = image.alphaBytes;
            const std::string maskDictionary =
                "<< /Type /XObject /Subtype /Image /Width " + std::to_string(image.width) +
                " /Height " + std::to_string(image.height) +
                " /ColorSpace /DeviceGray /BitsPerComponent 8 /Length " +
                std::to_string(alpha.size()) + " >>\nstream\n" + alpha + "\nendstream";
            setObject(objects, alphaMaskObjectIds[index], maskDictionary);
        }
    }

    std::string output = pdfDocument(objects);
    if (output.empty()) {
        return std::unexpected(
            core::error("pdf_export_failed", "Unable to serialize the portable PDF document."));
    }
    return output;
}

} // namespace tutorux::document

#include "image_decoder.hpp"

#include <gif_lib.h>
#include <png.h>
#include <webp/decode.h>
#include <webp/demux.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <span>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::document::detail {
namespace {

    constexpr std::size_t maximumEncodedBytes = 64U * 1024U * 1024U;
    constexpr std::uint64_t maximumDecodedPixels = 16'000'000U;
    constexpr std::uint32_t maximumDimension = 100'000U;

    core::Error imageDecodeError(std::string code, std::string message) {
        return core::error(std::move(code), std::move(message));
    }

    bool dimensionsAreSafe(std::uint32_t width, std::uint32_t height) {
        return width != 0U && height != 0U && width <= maximumDimension &&
               height <= maximumDimension &&
               static_cast<std::uint64_t>(width) * height <= maximumDecodedPixels;
    }

    std::size_t rgbaByteCount(std::uint32_t width, std::uint32_t height) {
        return static_cast<std::size_t>(width) * static_cast<std::size_t>(height) * 4U;
    }

    core::Result<DecodedRgbaImage> decodePng(std::span<const std::byte> encoded) {
        if (encoded.empty() || encoded.size() > maximumEncodedBytes) {
            return std::unexpected(
                imageDecodeError("pdf_image_size_invalid",
                                 "The encoded guide image exceeds the portable decoder limit."));
        }

        struct PngImage final {
            png_image image{};

            ~PngImage() {
                png_image_free(&image);
            }
        } png;
        png.image.version = PNG_IMAGE_VERSION;
        if (!png_image_begin_read_from_memory(&png.image, encoded.data(), encoded.size()) ||
            !dimensionsAreSafe(png.image.width, png.image.height)) {
            return std::unexpected(
                imageDecodeError("pdf_image_dimensions_invalid",
                                 "The PNG dimensions are invalid or exceed the decoder limit."));
        }

        png.image.format = PNG_FORMAT_RGBA;
        DecodedRgbaImage decoded;
        decoded.width = png.image.width;
        decoded.height = png.image.height;
        decoded.pixels.resize(rgbaByteCount(decoded.width, decoded.height));
        if (!png_image_finish_read(&png.image, nullptr, decoded.pixels.data(), 0, nullptr)) {
            return std::unexpected(imageDecodeError("pdf_image_decode_failed",
                                                    "The PNG guide image could not be decoded."));
        }
        return decoded;
    }

    struct GifMemoryReader final {
        std::span<const std::byte> bytes;
        std::size_t offset{};
    };

    int readGifBytes(GifFileType* file, GifByteType* output, int requested) {
        if (!file || !file->UserData || !output || requested <= 0)
            return 0;

        auto& reader = *static_cast<GifMemoryReader*>(file->UserData);
        const std::size_t remaining = reader.bytes.size() - reader.offset;
        const std::size_t count = std::min(remaining, static_cast<std::size_t>(requested));
        if (count != 0U) {
            std::copy_n(reinterpret_cast<const GifByteType*>(reader.bytes.data()) + reader.offset,
                        count, output);
            reader.offset += count;
        }
        return static_cast<int>(count);
    }

    struct GifCloser final {
        void operator()(GifFileType* file) const {
            if (file) {
                int ignoredError{};
                DGifCloseFile(file, &ignoredError);
            }
        }
    };

    core::Result<DecodedRgbaImage> decodeGif(std::span<const std::byte> encoded) {
        if (encoded.empty() || encoded.size() > maximumEncodedBytes) {
            return std::unexpected(
                imageDecodeError("pdf_image_size_invalid",
                                 "The encoded guide image exceeds the portable decoder limit."));
        }

        GifMemoryReader reader{encoded};
        int gifError{};
        std::unique_ptr<GifFileType, GifCloser> gif(DGifOpen(&reader, readGifBytes, &gifError));
        if (!gif || !dimensionsAreSafe(static_cast<std::uint32_t>(std::max(gif->SWidth, 0)),
                                       static_cast<std::uint32_t>(std::max(gif->SHeight, 0)))) {
            return std::unexpected(
                imageDecodeError("pdf_image_dimensions_invalid",
                                 "The GIF dimensions are invalid or exceed the decoder limit."));
        }

        bool hasTransparentIndex = false;
        GifByteType transparentIndex{};
        bool imageFound = false;
        while (!imageFound) {
            GifRecordType record{};
            if (DGifGetRecordType(gif.get(), &record) == GIF_ERROR) {
                return std::unexpected(imageDecodeError(
                    "pdf_image_decode_failed", "The GIF ended before its first image frame."));
            }

            if (record == IMAGE_DESC_RECORD_TYPE) {
                if (DGifGetImageDesc(gif.get()) == GIF_ERROR) {
                    return std::unexpected(imageDecodeError(
                        "pdf_image_decode_failed", "The first GIF frame descriptor is invalid."));
                }
                imageFound = true;
                continue;
            }
            if (record == TERMINATE_RECORD_TYPE) {
                return std::unexpected(imageDecodeError("pdf_image_decode_failed",
                                                        "The GIF contains no image frame."));
            }
            if (record != EXTENSION_RECORD_TYPE)
                continue;

            int extensionCode{};
            GifByteType* extension{};
            if (DGifGetExtension(gif.get(), &extensionCode, &extension) == GIF_ERROR) {
                return std::unexpected(imageDecodeError("pdf_image_decode_failed",
                                                        "A GIF extension block is malformed."));
            }
            if (extensionCode == GRAPHICS_EXT_FUNC_CODE && extension) {
                if (extension[0] != 4U) {
                    return std::unexpected(imageDecodeError(
                        "pdf_image_decode_failed", "The GIF transparency extension is malformed."));
                }
                hasTransparentIndex = (extension[1] & 0x01U) != 0U;
                transparentIndex = extension[4];
            }
            while (extension) {
                if (DGifGetExtensionNext(gif.get(), &extension) == GIF_ERROR) {
                    return std::unexpected(imageDecodeError("pdf_image_decode_failed",
                                                            "A GIF extension block is truncated."));
                }
            }
        }

        const GifImageDesc& frame = gif->Image;
        const auto canvasWidth = static_cast<std::uint32_t>(gif->SWidth);
        const auto canvasHeight = static_cast<std::uint32_t>(gif->SHeight);
        if (frame.Width <= 0 || frame.Height <= 0 || frame.Left < 0 || frame.Top < 0 ||
            static_cast<std::uint64_t>(frame.Left) + static_cast<std::uint64_t>(frame.Width) >
                canvasWidth ||
            static_cast<std::uint64_t>(frame.Top) + static_cast<std::uint64_t>(frame.Height) >
                canvasHeight) {
            return std::unexpected(imageDecodeError(
                "pdf_image_dimensions_invalid", "The first GIF frame lies outside its canvas."));
        }

        const ColorMapObject* colorMap = frame.ColorMap ? frame.ColorMap : gif->SColorMap;
        if (!colorMap || colorMap->ColorCount <= 0 || !colorMap->Colors) {
            return std::unexpected(imageDecodeError(
                "pdf_image_decode_failed", "The first GIF frame has no valid color table."));
        }

        DecodedRgbaImage decoded;
        decoded.width = canvasWidth;
        decoded.height = canvasHeight;
        decoded.pixels.assign(rgbaByteCount(canvasWidth, canvasHeight), 0U);

        if (gif->SColorMap && gif->SBackGroundColor >= 0 &&
            gif->SBackGroundColor < gif->SColorMap->ColorCount &&
            !(hasTransparentIndex &&
              transparentIndex == static_cast<GifByteType>(gif->SBackGroundColor))) {
            const GifColorType background = gif->SColorMap->Colors[gif->SBackGroundColor];
            for (std::size_t offset = 0; offset < decoded.pixels.size(); offset += 4U) {
                decoded.pixels[offset] = background.Red;
                decoded.pixels[offset + 1U] = background.Green;
                decoded.pixels[offset + 2U] = background.Blue;
                decoded.pixels[offset + 3U] = 0xffU;
            }
        }

        std::vector<GifPixelType> row(static_cast<std::size_t>(frame.Width));
        const auto decodeRow = [&](int sourceY) -> bool {
            if (DGifGetLine(gif.get(), row.data(), frame.Width) == GIF_ERROR)
                return false;
            const std::size_t targetY = static_cast<std::size_t>(frame.Top + sourceY);
            for (int x = 0; x < frame.Width; ++x) {
                const GifPixelType colorIndex = row[static_cast<std::size_t>(x)];
                if (static_cast<int>(colorIndex) >= colorMap->ColorCount)
                    return false;

                const std::size_t targetX = static_cast<std::size_t>(frame.Left + x);
                const std::size_t pixelOffset = (targetY * canvasWidth + targetX) * 4U;
                if (hasTransparentIndex && colorIndex == transparentIndex) {
                    decoded.pixels[pixelOffset + 3U] = 0U;
                    continue;
                }

                const GifColorType color = colorMap->Colors[static_cast<std::size_t>(colorIndex)];
                decoded.pixels[pixelOffset] = color.Red;
                decoded.pixels[pixelOffset + 1U] = color.Green;
                decoded.pixels[pixelOffset + 2U] = color.Blue;
                decoded.pixels[pixelOffset + 3U] = 0xffU;
            }
            return true;
        };

        bool decodedRows = true;
        if (frame.Interlace) {
            constexpr std::array<int, 4> starts{0, 4, 2, 1};
            constexpr std::array<int, 4> steps{8, 8, 4, 2};
            for (std::size_t pass = 0; pass < starts.size() && decodedRows; ++pass) {
                for (int y = starts[pass]; y < frame.Height; y += steps[pass]) {
                    if (!decodeRow(y)) {
                        decodedRows = false;
                        break;
                    }
                }
            }
        } else {
            for (int y = 0; y < frame.Height; ++y) {
                if (!decodeRow(y)) {
                    decodedRows = false;
                    break;
                }
            }
        }
        if (!decodedRows) {
            return std::unexpected(imageDecodeError(
                "pdf_image_decode_failed", "The first GIF frame contains invalid pixel data."));
        }
        return decoded;
    }

    core::Result<DecodedRgbaImage> decodeWebp(std::span<const std::byte> encoded) {
        if (encoded.empty() || encoded.size() > maximumEncodedBytes) {
            return std::unexpected(
                imageDecodeError("pdf_image_size_invalid",
                                 "The encoded guide image exceeds the portable decoder limit."));
        }

        const WebPData data{
            reinterpret_cast<const std::uint8_t*>(encoded.data()),
            encoded.size(),
        };
        std::unique_ptr<WebPDemuxer, decltype(&WebPDemuxDelete)> demuxer(WebPDemux(&data),
                                                                         &WebPDemuxDelete);
        if (!demuxer) {
            return std::unexpected(imageDecodeError("pdf_image_decode_failed",
                                                    "The WebP guide image container is invalid."));
        }

        const auto width = WebPDemuxGetI(demuxer.get(), WEBP_FF_CANVAS_WIDTH);
        const auto height = WebPDemuxGetI(demuxer.get(), WEBP_FF_CANVAS_HEIGHT);
        if (!dimensionsAreSafe(width, height)) {
            return std::unexpected(
                imageDecodeError("pdf_image_dimensions_invalid",
                                 "The WebP guide image dimensions are invalid or too large."));
        }

        const std::size_t byteCount = rgbaByteCount(width, height);
        DecodedRgbaImage decoded;
        decoded.width = width;
        decoded.height = height;
        const std::uint32_t formatFlags = WebPDemuxGetI(demuxer.get(), WEBP_FF_FORMAT_FLAGS);
        if ((formatFlags & ANIMATION_FLAG) != 0U) {
            WebPAnimDecoderOptions options{};
            if (!WebPAnimDecoderOptionsInit(&options)) {
                return std::unexpected(
                    imageDecodeError("pdf_image_decoder_unavailable",
                                     "The WebP animation decoder is incompatible."));
            }
            options.color_mode = MODE_RGBA;
            options.use_threads = 0;
            std::unique_ptr<WebPAnimDecoder, decltype(&WebPAnimDecoderDelete)> animation(
                WebPAnimDecoderNew(&data, &options), &WebPAnimDecoderDelete);
            WebPAnimInfo info{};
            if (!animation || !WebPAnimDecoderGetInfo(animation.get(), &info) ||
                info.canvas_width != width || info.canvas_height != height ||
                !WebPAnimDecoderHasMoreFrames(animation.get())) {
                return std::unexpected(imageDecodeError(
                    "pdf_image_decode_failed", "The animated WebP guide image is invalid."));
            }

            std::uint8_t* firstFrame{};
            int timestamp{};
            if (!WebPAnimDecoderGetNext(animation.get(), &firstFrame, &timestamp) || !firstFrame) {
                return std::unexpected(
                    imageDecodeError("pdf_image_decode_failed",
                                     "The first WebP animation frame could not be decoded."));
            }
            decoded.pixels.assign(firstFrame, firstFrame + byteCount);
        } else {
            int decodedWidth{};
            int decodedHeight{};
            std::unique_ptr<std::uint8_t, decltype(&WebPFree)> pixels(
                WebPDecodeRGBA(data.bytes, data.size, &decodedWidth, &decodedHeight), &WebPFree);
            if (!pixels || decodedWidth <= 0 || decodedHeight <= 0 ||
                static_cast<std::uint32_t>(decodedWidth) != width ||
                static_cast<std::uint32_t>(decodedHeight) != height) {
                return std::unexpected(imageDecodeError(
                    "pdf_image_decode_failed", "The WebP guide image could not be decoded."));
            }
            decoded.pixels.assign(pixels.get(), pixels.get() + byteCount);
        }
        return decoded;
    }

} // namespace

core::Result<DecodedRgbaImage> decodePortableImage(std::string_view mimeType,
                                                   std::span<const std::byte> encoded) {
    if (mimeType == "image/png")
        return decodePng(encoded);
    if (mimeType == "image/gif")
        return decodeGif(encoded);
    if (mimeType == "image/webp")
        return decodeWebp(encoded);
    return std::unexpected(
        imageDecodeError("pdf_image_format_unsupported",
                         "The portable decoder does not support this image format."));
}

} // namespace tutorux::document::detail

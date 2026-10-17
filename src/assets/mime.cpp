#include "tutorux/assets/mime.hpp"

#include <algorithm>
#include <cctype>

namespace tutorux::assets {
    namespace {

        bool matches(std::span<const std::byte> content, std::size_t offset,
                     std::string_view signature) noexcept {
            if (offset > content.size() || content.size() - offset < signature.size())
                return false;
            for (std::size_t index = 0; index < signature.size(); ++index) {
                if (std::to_integer<unsigned char>(content[offset + index]) !=
                    static_cast<unsigned char>(signature[index])) {
                    return false;
                }
            }
            return true;
        }

        std::string_view extensionOf(std::string_view fileName) noexcept {
            const std::size_t separator = fileName.find_last_of("/\\");
            const std::size_t dot = fileName.find_last_of('.');
            if (dot == std::string_view::npos ||
                (separator != std::string_view::npos && dot < separator)) {
                return {};
            }
            return fileName.substr(dot);
        }

        bool extensionEquals(std::string_view extension, std::string_view expected) noexcept {
            if (extension.size() != expected.size())
                return false;
            for (std::size_t index = 0; index < extension.size(); ++index) {
                const auto character = static_cast<unsigned char>(extension[index]);
                const auto expectedCharacter = static_cast<unsigned char>(expected[index]);
                if (std::tolower(character) != std::tolower(expectedCharacter))
                    return false;
            }
            return true;
        }

        bool containsNul(std::span<const std::byte> content) noexcept {
            return std::find(content.begin(), content.end(), std::byte{}) != content.end();
        }

    } // namespace

    std::string_view detectMimeType(std::string_view fileName,
                                    std::span<const std::byte> content) noexcept {
        const std::string_view extension = extensionOf(fileName);

        if (matches(content, 0, std::string_view("\x89PNG\r\n\x1a\n", 8)))
            return "image/png";
        if (matches(content, 0, std::string_view("\xff\xd8\xff", 3)))
            return "image/jpeg";
        if (matches(content, 0, "GIF87a") || matches(content, 0, "GIF89a"))
            return "image/gif";
        if (matches(content, 0, "BM"))
            return "image/bmp";
        if (matches(content, 0, std::string_view("II*\0", 4)) ||
            matches(content, 0, std::string_view("MM\0*", 4)))
            return "image/tiff";
        if (matches(content, 0, "%PDF-"))
            return "application/pdf";
        if (matches(content, 0, std::string_view("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1", 8)))
            return "application/x-ole-storage";

        if (matches(content, 0, "RIFF") && matches(content, 8, "WEBP"))
            return "image/webp";
        if (matches(content, 0, "RIFF") && matches(content, 8, "WAVE"))
            return "audio/wav";
        if (matches(content, 0, "fLaC"))
            return "audio/flac";
        if (matches(content, 0, "OggS"))
            return "audio/ogg";
        if (matches(content, 0, "ID3"))
            return "audio/mpeg";
        if (matches(content, 0, std::string_view("\x1a\x45\xdf\xa3", 4))) {
            return extensionEquals(extension, ".webm") ? "video/webm" : "video/x-matroska";
        }
        if (matches(content, 0, "PK\x03\x04")) {
            if (extensionEquals(extension, ".docx"))
                return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
            if (extensionEquals(extension, ".xlsx"))
                return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
            if (extensionEquals(extension, ".pptx"))
                return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
            return "application/zip";
        }
        if (matches(content, 4, "ftyp")) {
            return extensionEquals(extension, ".m4a") || extensionEquals(extension, ".m4b")
                       ? "audio/mp4"
                       : "video/mp4";
        }
        if (content.size() >= 2 && std::to_integer<unsigned char>(content[0]) == 0xffU &&
            (std::to_integer<unsigned char>(content[1]) & 0xe0U) == 0xe0U) {
            return "audio/mpeg";
        }

        if (extensionEquals(extension, ".txt"))
            return containsNul(content) ? "application/octet-stream" : "text/plain";
        if (extensionEquals(extension, ".md") || extensionEquals(extension, ".markdown"))
            return containsNul(content) ? "application/octet-stream" : "text/markdown";
        if (extensionEquals(extension, ".csv"))
            return containsNul(content) ? "application/octet-stream" : "text/csv";
        if (extensionEquals(extension, ".json"))
            return containsNul(content) ? "application/octet-stream" : "application/json";
        if (extensionEquals(extension, ".html") || extensionEquals(extension, ".htm"))
            return containsNul(content) ? "application/octet-stream" : "text/html";
        if (extensionEquals(extension, ".xml"))
            return containsNul(content) ? "application/octet-stream" : "application/xml";
        if (extensionEquals(extension, ".css"))
            return containsNul(content) ? "application/octet-stream" : "text/css";
        if (extensionEquals(extension, ".js"))
            return containsNul(content) ? "application/octet-stream" : "text/javascript";
        return "application/octet-stream";
    }

} // namespace tutorux::assets

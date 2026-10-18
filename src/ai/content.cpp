#include "tutorux/ai/openai_compatible.hpp"

#include "tutorux/command/json.hpp"

#include <sodium.h>

#include <algorithm>
#include <array>
#include <limits>
#include <string_view>
#include <type_traits>

namespace tutorux::ai {
namespace {

    constexpr std::size_t maximumSerializedContentBytes = 16U * 1024U * 1024U;

    enum class PartKind {
        text,
        image,
        audio,
        document,
        video,
    };

    struct EncodedPart final {
        PartKind kind{PartKind::text};
        std::string text;
        std::string mediaType;
        std::string fileName;
        std::string base64;
        std::int64_t timestampUs{};
    };

    class EncodedPartsWiper final {
      public:
        explicit EncodedPartsWiper(std::vector<EncodedPart>& parts) noexcept
            : parts_(parts) {}
        ~EncodedPartsWiper() {
            for (EncodedPart& part : parts_) {
                for (std::string* value :
                     {&part.text, &part.mediaType, &part.fileName, &part.base64}) {
                    if (!value->empty())
                        sodium_memzero(value->data(), value->size());
                }
            }
        }

      private:
        std::vector<EncodedPart>& parts_;
    };

    bool isAllowedImageType(std::string_view mediaType, ContentSerialization serialization) {
        static constexpr std::array commonTypes{
            "image/png",
            "image/jpeg",
            "image/webp",
            "image/gif",
        };
        if (std::find(commonTypes.begin(), commonTypes.end(), mediaType) != commonTypes.end())
            return true;
        return serialization == ContentSerialization::gemini &&
               (mediaType == "image/heic" || mediaType == "image/heif");
    }

    core::Result<std::string> encodeBase64(std::span<const std::byte> bytes) {
        if (bytes.empty()) {
            return std::unexpected(core::error("ai_content_empty_asset",
                                               "A multimodal content part has no asset bytes."));
        }
        if (bytes.size() > std::numeric_limits<std::size_t>::max() / 4U * 3U) {
            return std::unexpected(
                core::error("ai_content_too_large", "A content asset is too large to encode."));
        }
        const std::size_t encodedLength =
            sodium_base64_encoded_len(bytes.size(), sodium_base64_VARIANT_ORIGINAL);
        if (encodedLength == 0 || encodedLength > maximumSerializedContentBytes) {
            return std::unexpected(
                core::error("ai_content_too_large",
                            "A content asset exceeds the 16 MiB request limit."));
        }
        std::string encoded(encodedLength, '\0');
        if (!sodium_bin2base64(encoded.data(),
                               encoded.size(),
                               reinterpret_cast<const unsigned char*>(bytes.data()),
                               bytes.size(),
                               sodium_base64_VARIANT_ORIGINAL)) {
            return std::unexpected(core::error("ai_content_encoding_failed",
                                               "Encoding a content asset as base64 failed."));
        }
        encoded.resize(std::char_traits<char>::length(encoded.c_str()));
        return encoded;
    }

    core::Status appendImage(std::vector<EncodedPart>& parts,
                             const ImageContentPart& image,
                             std::int64_t timestampUs,
                             ContentSerialization serialization) {
        if (!isAllowedImageType(image.mediaType, serialization)) {
            return std::unexpected(core::error(
                "ai_content_media_type_unsupported",
                "The image format is not supported for model input: " + image.mediaType));
        }
        if (serialization == ContentSerialization::textOnly) {
            return std::unexpected(
                core::error("ai_model_capability_unsupported",
                            "The selected protocol cannot accept image content."));
        }
        if (serialization == ContentSerialization::openAiChat ||
            serialization == ContentSerialization::openAiResponses ||
            serialization == ContentSerialization::anthropicMessages ||
            serialization == ContentSerialization::gemini ||
            serialization == ContentSerialization::ollama) {
            auto encoded = encodeBase64(image.bytes);
            if (!encoded)
                return std::unexpected(encoded.error());
            parts.push_back({PartKind::image,
                             {},
                             image.mediaType,
                             image.fileName,
                             std::move(*encoded),
                             timestampUs});
            return {};
        }
        return std::unexpected(core::error("ai_model_capability_unsupported",
                                           "The selected protocol cannot accept images."));
    }

    core::Status appendDocument(std::vector<EncodedPart>& parts,
                                const DocumentContentPart& document,
                                ContentSerialization serialization) {
        if (document.extractedText.empty() && document.bytes.empty()) {
            return std::unexpected(
                core::error("ai_document_content_unavailable",
                            "The document has neither extracted text nor embedded content."));
        }
        const bool nativePdf = document.mediaType == "application/pdf" &&
                               (serialization == ContentSerialization::anthropicMessages ||
                                serialization == ContentSerialization::gemini ||
                                serialization == ContentSerialization::openAiResponses);
        if (!document.bytes.empty() && !nativePdf) {
            return std::unexpected(
                core::error("ai_model_capability_unsupported",
                            "The selected protocol cannot accept this document's binary content."));
        }
        if (!document.extractedText.empty()) {
            std::string label = "Document";
            if (!document.fileName.empty())
                label += " " + document.fileName;
            label += ":\n";
            parts.push_back({PartKind::text, std::move(label) + document.extractedText});
        }
        if (!document.bytes.empty()) {
            auto encoded = encodeBase64(document.bytes);
            if (!encoded)
                return std::unexpected(encoded.error());
            parts.push_back({PartKind::document,
                             {},
                             document.mediaType,
                             document.fileName,
                             std::move(*encoded),
                             0});
        }
        return {};
    }

    core::Result<std::vector<EncodedPart>> encodeParts(std::span<const ContentPart> content,
                                                       std::string_view fallbackText,
                                                       ContentSerialization serialization) {
        std::vector<EncodedPart> parts;
        EncodedPartsWiper partsWiper(parts);
        if (content.empty()) {
            parts.push_back({PartKind::text, std::string(fallbackText)});
            return parts;
        }
        for (const ContentPart& item : content) {
            const auto status = std::visit(
                [&](const auto& value) -> core::Status {
                    using Value = std::decay_t<decltype(value)>;
                    if constexpr (std::is_same_v<Value, TextContentPart>) {
                        if (!value.text.empty())
                            parts.push_back({PartKind::text, value.text});
                        return {};
                    } else if constexpr (std::is_same_v<Value, ImageContentPart>) {
                        return appendImage(parts, value, 0, serialization);
                    } else if constexpr (std::is_same_v<Value, AudioContentPart>) {
                        if (!value.bytes.empty()) {
                            if (serialization != ContentSerialization::gemini ||
                                !value.mediaType.starts_with("audio/")) {
                                return std::unexpected(core::error(
                                    "ai_model_capability_unsupported",
                                    "The selected protocol cannot accept raw audio content."));
                            }
                            auto encoded = encodeBase64(value.bytes);
                            if (!encoded)
                                return std::unexpected(encoded.error());
                            parts.push_back({PartKind::audio,
                                             {},
                                             value.mediaType,
                                             value.fileName,
                                             std::move(*encoded),
                                             0});
                        }
                        if (!value.transcript.empty())
                            parts.push_back(
                                {PartKind::text, "Audio transcript:\n" + value.transcript});
                        if (value.bytes.empty() && value.transcript.empty()) {
                            return std::unexpected(core::error(
                                "ai_audio_content_unavailable",
                                "The audio part has neither source bytes nor a transcript."));
                        }
                        return {};
                    } else if constexpr (std::is_same_v<Value, DocumentContentPart>) {
                        return appendDocument(parts, value, serialization);
                    } else {
                        if (value.bytes.empty() && value.frames.empty() &&
                            value.transcript.empty()) {
                            return std::unexpected(
                                core::error("ai_video_content_unavailable",
                                            "The video part has neither frames nor a transcript."));
                        }
                        if (!value.bytes.empty()) {
                            if (serialization != ContentSerialization::gemini ||
                                !value.mediaType.starts_with("video/")) {
                                return std::unexpected(core::error(
                                    "ai_model_capability_unsupported",
                                    "The selected protocol cannot accept raw video content."));
                            }
                            auto encoded = encodeBase64(value.bytes);
                            if (!encoded)
                                return std::unexpected(encoded.error());
                            parts.push_back({PartKind::video,
                                             {},
                                             value.mediaType,
                                             value.fileName,
                                             std::move(*encoded),
                                             0});
                        }
                        if (!value.transcript.empty()) {
                            parts.push_back(
                                {PartKind::text, "Video transcript:\n" + value.transcript});
                        }
                        for (const auto& frame : value.frames) {
                            parts.push_back(
                                {PartKind::text,
                                 "Video frame at " + std::to_string(frame.timestampUs) + " us:"});
                            if (auto status = appendImage(parts,
                                                          frame.image,
                                                          frame.timestampUs,
                                                          serialization);
                                !status) {
                                return status;
                            }
                        }
                        return {};
                    }
                },
                item);
            if (!status)
                return std::unexpected(status.error());
        }
        if (parts.empty())
            parts.push_back({PartKind::text, std::string(fallbackText)});
        return parts;
    }

    std::string imageDataUrl(const EncodedPart& part) {
        return "data:" + part.mediaType + ";base64," + part.base64;
    }

    std::string joinedText(const std::vector<EncodedPart>& parts) {
        std::string text;
        for (const auto& part : parts) {
            if (part.kind != PartKind::text)
                continue;
            if (!text.empty())
                text.push_back('\n');
            text += part.text;
        }
        return "\"" + command::jsonEscape(text) + "\"";
    }

    std::string serializeOpenAiChat(const std::vector<EncodedPart>& parts) {
        const bool hasBinary = std::any_of(parts.begin(), parts.end(), [](const EncodedPart& p) {
            return p.kind != PartKind::text;
        });
        if (!hasBinary)
            return joinedText(parts);
        std::string json = "[";
        bool first = true;
        for (const auto& part : parts) {
            if (!first)
                json.push_back(',');
            first = false;
            if (part.kind == PartKind::text) {
                json += "{\"type\":\"text\",\"text\":\"" + command::jsonEscape(part.text) + "\"}";
            } else if (part.kind == PartKind::image) {
                json += "{\"type\":\"image_url\",\"image_url\":{\"url\":\"" +
                        command::jsonEscape(imageDataUrl(part)) + "\"}}";
            }
        }
        json.push_back(']');
        return json;
    }

    std::string serializeAnthropic(const std::vector<EncodedPart>& parts) {
        const bool hasBinary = std::any_of(parts.begin(), parts.end(), [](const EncodedPart& p) {
            return p.kind != PartKind::text;
        });
        if (!hasBinary)
            return joinedText(parts);
        std::string json = "[";
        bool first = true;
        for (const auto& part : parts) {
            if (!first)
                json.push_back(',');
            first = false;
            if (part.kind == PartKind::text) {
                json += "{\"type\":\"text\",\"text\":\"" + command::jsonEscape(part.text) + "\"}";
            } else if (part.kind == PartKind::image) {
                json += "{\"type\":\"" +
                        std::string(part.kind == PartKind::document ? "document" : "image") +
                        "\",\"source\":{\"type\":\"base64\",\"media_type\":\"" +
                        command::jsonEscape(part.mediaType) + "\",\"data\":\"" + part.base64 +
                        "\"}}";
            } else {
                json += "{\"type\":\"document\",\"source\":{\"type\":\"base64\","
                        "\"media_type\":\"" +
                        command::jsonEscape(part.mediaType) + "\",\"data\":\"" + part.base64 +
                        "\"}}";
            }
        }
        json.push_back(']');
        return json;
    }

    std::string serializeGemini(const std::vector<EncodedPart>& parts) {
        std::string json = "[";
        bool first = true;
        for (const auto& part : parts) {
            if (!first)
                json.push_back(',');
            first = false;
            if (part.kind == PartKind::text) {
                json += "{\"text\":\"" + command::jsonEscape(part.text) + "\"}";
            } else {
                json += "{\"inline_data\":{\"mime_type\":\"" + command::jsonEscape(part.mediaType) +
                        "\",\"data\":\"" + part.base64 + "\"}}";
            }
        }
        json.push_back(']');
        return json;
    }

    std::string serializeResponses(const std::vector<EncodedPart>& parts) {
        std::string json = "[";
        bool first = true;
        for (const auto& part : parts) {
            if (!first)
                json.push_back(',');
            first = false;
            if (part.kind == PartKind::text) {
                json +=
                    "{\"type\":\"input_text\",\"text\":\"" + command::jsonEscape(part.text) + "\"}";
            } else if (part.kind == PartKind::image) {
                json += "{\"type\":\"input_image\",\"image_url\":\"" +
                        command::jsonEscape(imageDataUrl(part)) + "\"}";
            } else if (part.kind == PartKind::document) {
                json += "{\"type\":\"input_file\",\"filename\":\"" +
                        command::jsonEscape(part.fileName) + "\",\"file_data\":\"" +
                        command::jsonEscape(imageDataUrl(part)) + "\"}";
            } else {
                return "[]";
            }
        }
        json.push_back(']');
        return json;
    }

    std::string serializeOllama(const std::vector<EncodedPart>& parts) {
        std::string json = "{\"role\":\"user\",\"content\":\"";
        bool firstText = true;
        std::vector<std::string_view> images;
        for (const auto& part : parts) {
            if (part.kind == PartKind::text) {
                if (!firstText)
                    json += "\\n";
                json += command::jsonEscape(part.text);
                firstText = false;
            } else if (part.kind == PartKind::image) {
                images.push_back(part.base64);
            } else if (part.kind == PartKind::video || part.kind == PartKind::audio ||
                       part.kind == PartKind::document) {
                return "{}";
            }
        }
        json += "\"";
        if (!images.empty()) {
            json += ",\"images\":[";
            for (std::size_t index = 0; index < images.size(); ++index) {
                if (index != 0)
                    json.push_back(',');
                json += "\"" + std::string(images[index]) + "\"";
            }
            json.push_back(']');
        }
        json.push_back('}');
        return json;
    }

} // namespace

core::Result<std::string> serializeContentParts(std::span<const ContentPart> content,
                                                std::string_view fallbackText,
                                                ContentSerialization serialization) {
    auto parts = encodeParts(content, fallbackText, serialization);
    if (!parts)
        return std::unexpected(parts.error());
    EncodedPartsWiper partsWiper(*parts);
    std::string serialized;
    switch (serialization) {
        case ContentSerialization::openAiChat:
            serialized = serializeOpenAiChat(*parts);
            break;
        case ContentSerialization::openAiResponses:
            serialized = serializeResponses(*parts);
            break;
        case ContentSerialization::anthropicMessages:
            serialized = serializeAnthropic(*parts);
            break;
        case ContentSerialization::gemini:
            serialized = serializeGemini(*parts);
            break;
        case ContentSerialization::ollama:
            serialized = serializeOllama(*parts);
            break;
        case ContentSerialization::textOnly:
            for (const auto& part : *parts) {
                if (part.kind != PartKind::text) {
                    return std::unexpected(
                        core::error("ai_model_capability_unsupported",
                                    "The selected provider accepts text content only."));
                }
                if (!serialized.empty())
                    serialized.push_back('\n');
                serialized += part.text;
            }
            serialized = "\"" + command::jsonEscape(serialized) + "\"";
            break;
    }
    if (serialized.size() > maximumSerializedContentBytes) {
        return std::unexpected(core::error("ai_content_too_large",
                                           "The serialized model input exceeds the 16 MiB limit."));
    }
    return serialized;
}

void wipeContentParts(std::vector<ContentPart>& content) noexcept {
    const auto wipeString = [](std::string& value) noexcept {
        if (!value.empty())
            sodium_memzero(value.data(), value.size());
    };
    for (ContentPart& part : content) {
        std::visit(
            [&](auto& value) noexcept {
                using Value = std::decay_t<decltype(value)>;
                if constexpr (std::is_same_v<Value, TextContentPart>) {
                    wipeString(value.text);
                } else if constexpr (std::is_same_v<Value, ImageContentPart>) {
                    wipeString(value.mediaType);
                    wipeString(value.fileName);
                    if (!value.bytes.empty())
                        sodium_memzero(value.bytes.data(), value.bytes.size());
                } else if constexpr (std::is_same_v<Value, AudioContentPart>) {
                    wipeString(value.mediaType);
                    wipeString(value.fileName);
                    wipeString(value.transcript);
                    if (!value.bytes.empty())
                        sodium_memzero(value.bytes.data(), value.bytes.size());
                } else if constexpr (std::is_same_v<Value, DocumentContentPart>) {
                    wipeString(value.mediaType);
                    wipeString(value.fileName);
                    wipeString(value.extractedText);
                    if (!value.bytes.empty())
                        sodium_memzero(value.bytes.data(), value.bytes.size());
                } else {
                    wipeString(value.fileName);
                    wipeString(value.mediaType);
                    wipeString(value.transcript);
                    if (!value.bytes.empty())
                        sodium_memzero(value.bytes.data(), value.bytes.size());
                    for (VideoFrameContentPart& frame : value.frames) {
                        wipeString(frame.image.mediaType);
                        wipeString(frame.image.fileName);
                        if (!frame.image.bytes.empty())
                            sodium_memzero(frame.image.bytes.data(), frame.image.bytes.size());
                    }
                }
            },
            part);
    }
}

void wipeGenerationInput(GenerationRequest& request) noexcept {
    const auto wipeString = [](std::string& value) noexcept {
        if (!value.empty())
            sodium_memzero(value.data(), value.size());
    };
    wipeString(request.apiKey);
    wipeString(request.systemPrompt);
    wipeString(request.userContent);
    wipeContentParts(request.content);
}

} // namespace tutorux::ai

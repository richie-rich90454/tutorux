// Focused unit coverage for pure product logic. These are real assertions
// against the production implementations, not snapshots or mocks.
#include "tutorux/ai/http_retry.hpp"
#include "tutorux/ai/models_dev.hpp"
#include "tutorux/assets/mime.hpp"
#include "tutorux/command/zip.hpp"
#include "tutorux/diagnostics/system.hpp"
#include "tutorux/domain/guide.hpp"
#include "tutorux/domain/journal.hpp"
#include "tutorux/transcription/import.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::vector<std::byte> bytes(std::string_view text) {
    std::vector<std::byte> output;
    output.reserve(text.size());
    for (const char character : text)
        output.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
    return output;
}

bool writeText(const std::filesystem::path& path, std::string_view text) {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    output.write(text.data(), static_cast<std::streamsize>(text.size()));
    return output.good();
}

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "core units: " << label << '\n';
    return false;
}

template <typename T>
bool expectError(const tutorux::core::Result<T>& status, std::string_view label,
                 std::string_view code = {}) {
    if (status)
        return expect(false, label);
    if (!code.empty() && status.error().code != code)
        return expect(false, std::string(label) + ": unexpected code " + status.error().code);
    return true;
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    // ZIP encoder: valid stored archive, path safety, duplicate rejection.
    {
        std::array<command::ZipEntry, 2> entries{{
            {"guide/guide.md", bytes("# Guide\n")},
            {"manifest.json", bytes("{}\n")},
        }};
        auto zip = command::encodeStoredZip(entries);
        okay &= expect(zip.has_value(), "valid ZIP encoding failed");
        if (zip) {
            okay &= expect(zip->size() > 22, "ZIP output is truncated");
            okay &= expect(static_cast<unsigned char>((*zip)[0]) == 0x50 &&
                              static_cast<unsigned char>((*zip)[1]) == 0x4b,
                          "ZIP signature is missing");
        }
        std::array<command::ZipEntry, 1> empty{{{"", bytes("x")}}};
        okay &= expectError(command::encodeStoredZip(empty), "empty ZIP path accepted",
                            "zip_entry_path_invalid");
        std::array<command::ZipEntry, 2> duplicate{{
            {"same.txt", bytes("a")},
            {"same.txt", bytes("b")},
        }};
        okay &= expectError(command::encodeStoredZip(duplicate),
                            "duplicate ZIP path accepted", "zip_entry_path_invalid");
        for (const std::string path : {"/absolute", "../escape", "a\\b", "a:b"}) {
            std::array<command::ZipEntry, 1> unsafe{{{path, bytes("x")}}};
            okay &= expectError(command::encodeStoredZip(unsafe),
                                "unsafe ZIP path accepted: " + path,
                                "zip_entry_path_invalid");
        }
        std::span<const command::ZipEntry> noEntries;
        okay &= expectError(command::encodeStoredZip(noEntries), "empty ZIP accepted",
                            "zip_entry_count_invalid");
    }

    // Diagnostics snapshot is real platform data, not a placeholder.
    {
        auto snapshot = diagnostics::readSystemSnapshot();
        okay &= expect(snapshot.has_value(), "system snapshot failed");
        if (snapshot) {
            okay &= expect(!snapshot->operatingSystem.empty(), "operating system is empty");
            okay &= expect(!snapshot->architecture.empty(), "architecture is empty");
            okay &= expect(snapshot->hardwareThreads > 0, "hardware thread count is zero");
        }
    }

    // models.dev catalog mapping.
    {
        okay &= expect(ai::modelsDevProviderCatalogId("openai") == "openai",
                       "openai catalog mapping missing");
        okay &= expect(ai::modelsDevProviderCatalogId("google-gemini") == "google",
                       "gemini catalog mapping missing");
        okay &= expect(!ai::modelsDevProviderCatalogId("not-a-provider").has_value(),
                       "unknown catalog provider mapped");
    }

    // HTTP retry policy.
    {
        using namespace std::chrono_literals;
        ai::HttpResponse response;
        response.statusCode = 200;
        okay &= expect(!ai::detail::isTransientHttpFailure(response),
                       "HTTP 200 marked transient");
        response.statusCode = 429;
        okay &= expect(ai::detail::isTransientHttpFailure(response),
                       "HTTP 429 not marked transient");
        response.statusCode = 200;
        response.transportError = "reset";
        okay &= expect(ai::detail::isTransientHttpFailure(response),
                       "transport error not marked transient");
        response.cancelled = true;
        okay &= expect(!ai::detail::isTransientHttpFailure(response),
                       "cancelled request marked transient");

        const auto numericRetry = ai::detail::retryAfterDelay("5", 0);
        okay &= expect(numericRetry && *numericRetry == 5000ms,
                       "numeric retry-after was not honored");
        okay &= expect(!ai::detail::retryAfterDelay("999999", 0).has_value(),
                       "oversized retry-after accepted");
        const auto exponentialRetry = ai::detail::retryAfterDelay("invalid", 3);
        okay &= expect(exponentialRetry && *exponentialRetry == 2000ms,
                       "exponential retry fallback is wrong");
        const auto pastRetry =
            ai::detail::retryAfterDelay("Wed, 21 Oct 2015 07:28:00 GMT", 0);
        okay &= expect(pastRetry && *pastRetry == 0ms,
                       "past HTTP-date retry-after was not zero");

        bool invoked = false;
        auto cancelled = ai::detail::checkCancellation([&] {
            invoked = true;
            return true;
        });
        okay &= expect(invoked && cancelled.requested && !cancelled.callbackFailed,
                       "cancellation callback was not observed");
        auto throwing = ai::detail::checkCancellation([]() -> bool {
            throw std::runtime_error("stop");
        });
        okay &= expect(!throwing.requested && throwing.callbackFailed,
                       "throwing cancellation was not contained");
    }

    // Journal and guide pure helpers.
    {
        okay &= expect(domain::isValidJournalDate("2026-10-22"),
                       "valid journal date rejected");
        okay &= expect(!domain::isValidJournalDate("2026-02-30"),
                       "invalid journal date accepted");
        okay &= expect(!domain::isValidJournalDate("22/10/2026"),
                       "non-ISO journal date accepted");
        okay &= expect(domain::isValidJournalNoteBlockKind("paragraph"),
                       "paragraph block kind rejected");
        okay &= expect(domain::isValidJournalNoteBlockKind("bullet-list"),
                       "bullet-list block kind rejected");
        okay &= expect(!domain::isValidJournalNoteBlockKind("random"),
                       "unknown block kind accepted");

        okay &= expect(domain::guideBlockLabel("instruction") == "Tutor instruction",
                       "instruction guide label missing");
        domain::GuideBlock ai{"recommendation", "Try this", {}, false, "ai-generated"};
        okay &= expect(domain::guideBlockLabel(ai) == "AI recommendation",
                       "AI recommendation label missing");
        domain::GuideBlock edited{"example", "Worked", {}, false, "human-edited"};
        okay &= expect(domain::guideBlockLabel(edited) == "Tutor-edited example",
                       "tutor-edited example label missing");

        auto table = domain::parseGuideTable(
            "| Topic | Detail |\n| --- | --- |\n| Fractions | Compare |\n");
        okay &= expect(table.has_value() && table->size() == 2 &&
                           (*table)[1][0] == "Fractions",
                       "valid guide table failed");
        okay &= expectError(domain::parseGuideTable("| Topic |\n| x |"),
                            "malformed guide table accepted",
                            "guide_table_invalid");

        auto image = domain::parseGuideImageReference(
            "![Number line](asset:1ca880c2-3b9a-4d06-bed0-d63d03d10f68)");
        okay &= expect(image.has_value() &&
                           image->alternativeText == "Number line" &&
                           image->assetId == "1ca880c2-3b9a-4d06-bed0-d63d03d10f68",
                       "valid guide image reference failed");
        okay &= expectError(domain::parseGuideImageReference("![bad](asset:no)"),
                            "invalid guide image reference accepted");

        auto inlineIds = domain::guideInlineSourceIds(
            "Text [[source:1ca880c2-3b9a-4d06-bed0-d63d03d10f68]] and "
            "[[source:1ca880c2-3b9a-4d06-bed0-d63d03d10f68]]");
        okay &= expect(inlineIds && inlineIds->size() == 1,
                       "inline guide sources were not deduplicated");
        okay &= expect(domain::renderGuideInlineText(
                           "See [[source:1ca880c2-3b9a-4d06-bed0-d63d03d10f68]].") ==
                           "See [source: 1ca880c2-3b9a-4d06-bed0-d63d03d10f68].",
                       "inline guide source rendering is wrong");
    }

    // Asset MIME detection by extension and magic bytes.
    {
        const auto png = bytes(std::string_view("\x89PNG\r\n\x1a\n", 8));
        okay &= expect(assets::detectMimeType("image.png", png) == "image/png",
                       "PNG MIME detection failed");
        const auto pdf = bytes("%PDF-1.7\n");
        okay &= expect(assets::detectMimeType("file.pdf", pdf) == "application/pdf",
                       "PDF MIME detection failed");
        okay &= expect(assets::detectMimeType("notes.txt", bytes("text")) ==
                           "text/plain",
                       "text MIME detection failed");
        okay &= expect(assets::detectMimeType("unknown.bin", bytes("")) ==
                           "application/octet-stream",
                       "fallback MIME detection failed");
    }

    // Transcript source parsers for text, SRT, and WebVTT.
    {
        const auto directory =
            std::filesystem::temp_directory_path() /
            ("tutorux-core-units-" +
             std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
        std::error_code errorCode;
        std::filesystem::create_directories(directory, errorCode);
        if (errorCode) {
            std::cerr << "core units: temporary directory failed\n";
            return 1;
        }
        const auto textPath = directory / "source.txt";
        const auto srtPath = directory / "source.srt";
        const auto vttPath = directory / "source.vtt";
        okay &= expect(writeText(textPath, "First line\nSecond line\n"),
                       "text source fixture failed");
        okay &= expect(writeText(srtPath,
                                 "1\n00:00:01,000 --> 00:00:02,500\nHello\n\n"
                                 "2\n00:00:03,000 --> 00:00:04,000\nWorld\n"),
                       "SRT source fixture failed");
        okay &= expect(writeText(vttPath,
                                 "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n"),
                       "VTT source fixture failed");

        std::vector<transcription::TranscriptSourceCue> cues;
        auto textStatus = transcription::visitTranscriptSource(
            textPath, "text", [&](transcription::TranscriptSourceCue&& cue) {
                cues.push_back(std::move(cue));
                return core::Status{};
            });
        okay &= expect(textStatus && cues.size() == 2,
                       "plain text transcript source failed");
        cues.clear();
        auto srtStatus = transcription::visitTranscriptSource(
            srtPath, "srt", [&](transcription::TranscriptSourceCue&& cue) {
                cues.push_back(std::move(cue));
                return core::Status{};
            });
        okay &= expect(srtStatus && cues.size() == 2 &&
                           cues.front().startTimeUs == 1'000'000 &&
                           cues.front().endTimeUs == 2'500'000,
                       "SRT transcript source failed");
        cues.clear();
        auto vttStatus = transcription::visitTranscriptSource(
            vttPath, "vtt", [&](transcription::TranscriptSourceCue&& cue) {
                cues.push_back(std::move(cue));
                return core::Status{};
            });
        okay &= expect(vttStatus && cues.size() == 1 && cues.front().text == "Hi",
                       "WebVTT transcript source failed");
        okay &= expectError(transcription::visitTranscriptSource(
                                textPath, "invalid-format",
                                [](transcription::TranscriptSourceCue&&) {
                                    return core::Status{};
                                }),
                            "unknown transcript format accepted",
                            "transcript_import_format_invalid");
        okay &= expectError(transcription::visitTranscriptSource(
                                directory / "missing.txt", "text",
                                [](transcription::TranscriptSourceCue&&) {
                                    return core::Status{};
                                }),
                            "missing transcript source accepted");
        std::filesystem::remove_all(directory, errorCode);
    }

    return okay ? 0 : 1;
}

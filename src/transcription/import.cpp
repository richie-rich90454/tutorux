#include "tutorux/transcription/import.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <fstream>
#include <istream>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::transcription {
    namespace {

        constexpr std::uint64_t maximumSourceBytes = 256ULL * 1024ULL * 1024ULL;
        constexpr std::size_t maximumCueBytes = 16ULL * 1024ULL * 1024ULL;

        class BoundedLineReader final {
          public:
            BoundedLineReader(std::istream& input, std::size_t maximumLineBytes,
                              std::string errorCode, std::string errorMessage)
                : input_(input), maximumLineBytes_(maximumLineBytes),
                  errorCode_(std::move(errorCode)), errorMessage_(std::move(errorMessage)) {}

            core::Result<bool> next(std::string& line) {
                line.clear();
                while (true) {
                    if (bufferPosition_ == bufferSize_) {
                        if (input_.eof())
                            return !line.empty();
                        input_.read(buffer_.data(), static_cast<std::streamsize>(buffer_.size()));
                        const auto bytesRead = input_.gcount();
                        if (input_.bad() || (input_.fail() && !input_.eof())) {
                            return std::unexpected(core::error(
                                "input_file_read_failed", "Unable to read the transcript source."));
                        }
                        if (bytesRead <= 0)
                            return !line.empty();
                        bufferSize_ = static_cast<std::size_t>(bytesRead);
                        bufferPosition_ = 0;
                    }

                    const auto bufferEnd =
                        buffer_.begin() + static_cast<std::ptrdiff_t>(bufferSize_);
                    const auto lineEnd =
                        std::find(buffer_.begin() + static_cast<std::ptrdiff_t>(bufferPosition_),
                                  bufferEnd, '\n');
                    const std::size_t chunkSize = static_cast<std::size_t>(
                        lineEnd - (buffer_.begin() + static_cast<std::ptrdiff_t>(bufferPosition_)));
                    if (chunkSize > maximumLineBytes_ - line.size()) {
                        return std::unexpected(core::error(errorCode_, errorMessage_));
                    }
                    line.append(buffer_.data() + bufferPosition_, chunkSize);
                    bufferPosition_ += chunkSize;
                    if (lineEnd != bufferEnd) {
                        ++bufferPosition_;
                        return true;
                    }
                }
            }

          private:
            std::istream& input_;
            std::size_t maximumLineBytes_;
            std::string errorCode_;
            std::string errorMessage_;
            std::array<char, 8192> buffer_{};
            std::size_t bufferPosition_{};
            std::size_t bufferSize_{};
        };

        bool isValidTranscriptUtf8(std::string_view value) {
            std::size_t index = 0;
            while (index < value.size()) {
                const auto first = static_cast<unsigned char>(value[index]);
                if (first < 0x80U) {
                    if (first == 0 || first == 0x7fU ||
                        (first < 0x20U && first != '\t' && first != '\n'))
                        return false;
                    ++index;
                    continue;
                }

                std::size_t continuationCount = 0;
                unsigned char secondMinimum = 0x80U;
                unsigned char secondMaximum = 0xbfU;
                if (first >= 0xc2U && first <= 0xdfU) {
                    continuationCount = 1;
                } else if (first >= 0xe0U && first <= 0xefU) {
                    continuationCount = 2;
                    if (first == 0xe0U)
                        secondMinimum = 0xa0U;
                    else if (first == 0xedU)
                        secondMaximum = 0x9fU;
                } else if (first >= 0xf0U && first <= 0xf4U) {
                    continuationCount = 3;
                    if (first == 0xf0U)
                        secondMinimum = 0x90U;
                    else if (first == 0xf4U)
                        secondMaximum = 0x8fU;
                } else {
                    return false;
                }

                if (value.size() - index <= continuationCount)
                    return false;
                const auto second = static_cast<unsigned char>(value[index + 1]);
                if (second < secondMinimum || second > secondMaximum)
                    return false;
                for (std::size_t offset = 2; offset <= continuationCount; ++offset) {
                    const auto continuation = static_cast<unsigned char>(value[index + offset]);
                    if (continuation < 0x80U || continuation > 0xbfU)
                        return false;
                }
                index += continuationCount + 1;
            }
            return true;
        }

        core::Status validateTranscriptCue(const TranscriptSourceCue& cue) {
            if (!isValidTranscriptUtf8(cue.text) || !isValidTranscriptUtf8(cue.sourceId)) {
                return std::unexpected(
                    core::error("transcript_encoding_invalid",
                                "Transcript text and cue identifiers must be valid UTF-8 without "
                                "prohibited control bytes."));
            }
            return {};
        }

        std::string_view trimWhitespace(std::string_view value) {
            while (!value.empty() && std::isspace(static_cast<unsigned char>(value.front())) != 0)
                value.remove_prefix(1);
            while (!value.empty() && std::isspace(static_cast<unsigned char>(value.back())) != 0)
                value.remove_suffix(1);
            return value;
        }

        core::Result<std::pair<std::int64_t, std::int64_t>>
        parseSubtitleTimeRange(std::string_view line) {
            const std::size_t arrow = line.find("-->");
            if (arrow == std::string_view::npos ||
                line.find("-->", arrow + 3) != std::string_view::npos) {
                return std::unexpected(core::error(
                    "transcript_subtitle_timestamp_invalid",
                    "Subtitle cue must contain exactly one '-->' timestamp separator."));
            }

            std::string_view startText = trimWhitespace(line.substr(0, arrow));
            std::string_view endText = trimWhitespace(line.substr(arrow + 3));
            const std::size_t settings = endText.find_first_of(" \t");
            if (settings != std::string_view::npos)
                endText = endText.substr(0, settings);

            const auto normalizeTime = [](std::string_view value) {
                std::string normalized(value);
                std::replace(normalized.begin(), normalized.end(), ',', '.');
                if (std::count(normalized.begin(), normalized.end(), ':') == 1)
                    normalized.insert(0, "00:");
                return normalized;
            };

            const std::string normalizedStart = normalizeTime(startText);
            const std::string normalizedEnd = normalizeTime(endText);
            auto start = domain::parseTimestamp(normalizedStart);
            auto end = domain::parseTimestamp(normalizedEnd);
            if (!start || !end || *end < *start) {
                return std::unexpected(
                    core::error("transcript_subtitle_timestamp_invalid",
                                "Subtitle cue timestamps are invalid or end before they start."));
            }
            return std::pair{*start, *end};
        }

        bool isVttMetadataBlock(const std::vector<std::string>& lines) {
            if (lines.empty())
                return false;
            if (std::any_of(lines.begin(), lines.end(), [](const std::string& line) {
                    return line.find("-->") != std::string::npos;
                })) {
                return false;
            }
            const std::string_view firstLine = lines.front();
            return firstLine == "NOTE" || firstLine.starts_with("NOTE ") ||
                   firstLine.starts_with("NOTE\t") || firstLine == "STYLE" || firstLine == "REGION";
        }

    } // namespace

    core::Status
    visitTranscriptSource(const std::filesystem::path& path, std::string_view format,
                          const std::function<core::Status(TranscriptSourceCue&&)>& visitor) {
        if (!visitor) {
            return std::unexpected(core::error("transcript_import_visitor_invalid",
                                               "Transcript import requires a cue visitor."));
        }
        std::error_code errorCode;
        const auto fileStatus = std::filesystem::symlink_status(path, errorCode);
        if (errorCode || std::filesystem::is_symlink(fileStatus) ||
            !std::filesystem::is_regular_file(fileStatus)) {
            return std::unexpected(
                core::error("input_file_invalid", "Input must be a regular, non-symlink file."));
        }

        const auto size = std::filesystem::file_size(path, errorCode);
        if (errorCode)
            return std::unexpected(core::error("input_file_read_failed", errorCode.message()));
        if (size > maximumSourceBytes) {
            return std::unexpected(core::error("input_file_too_large",
                                               "Input file exceeds the configured size limit."));
        }

        const bool subtitleFormat = format == "srt" || format == "vtt";
        if (format != "text" && !subtitleFormat) {
            return std::unexpected(
                core::error("transcript_import_format_invalid",
                            "Transcript format must be text, srt, vtt, or auto."));
        }

        std::ifstream input(path, std::ios::binary);
        if (!input)
            return std::unexpected(
                core::error("input_file_read_failed", "Unable to open the transcript source."));

        std::uint64_t sourceIndex = 0;
        std::uint64_t sourceLine = 0;
        std::string line;
        if (format == "text") {
            BoundedLineReader reader(input, maximumCueBytes, "transcript_line_too_large",
                                     "Transcript line exceeds 16 MiB.");
            bool firstLine = true;
            while (true) {
                auto hasLine = reader.next(line);
                if (!hasLine)
                    return std::unexpected(hasLine.error());
                if (!*hasLine)
                    break;
                ++sourceLine;
                if (!line.empty() && line.back() == '\r')
                    line.pop_back();
                if (firstLine && line.starts_with("\xef\xbb\xbf"))
                    line.erase(0, 3);
                firstLine = false;
                if (line.empty())
                    continue;

                TranscriptSourceCue cue;
                cue.text = std::move(line);
                cue.sourceIndex = sourceIndex++;
                cue.sourceId = std::to_string(sourceLine);
                if (auto status = validateTranscriptCue(cue); !status)
                    return status;
                if (auto status = visitor(std::move(cue)); !status)
                    return status;
            }
            return {};
        }

        bool firstLine = true;
        bool vttHeaderSeen = false;
        bool vttHeaderBlock = false;
        std::vector<std::string> cueLines;
        std::size_t cueBytes = 0;
        BoundedLineReader reader(input, maximumCueBytes, "transcript_subtitle_cue_too_large",
                                 "Subtitle cue exceeds 16 MiB.");

        const auto flushCue = [&]() -> core::Status {
            if (cueLines.empty())
                return {};
            if (format == "vtt" && isVttMetadataBlock(cueLines)) {
                cueLines.clear();
                cueBytes = 0;
                return {};
            }

            std::size_t timingLine = cueLines.size();
            for (std::size_t index = 0; index < cueLines.size(); ++index) {
                if (cueLines[index].find("-->") != std::string::npos) {
                    timingLine = index;
                    break;
                }
            }
            if (timingLine > 1 || timingLine >= cueLines.size()) {
                return std::unexpected(core::error(
                    "transcript_subtitle_cue_invalid",
                    "Subtitle cue must have an optional identifier followed by a timestamp."));
            }

            auto timeRange = parseSubtitleTimeRange(cueLines[timingLine]);
            if (!timeRange)
                return std::unexpected(timeRange.error());
            if (timingLine + 1 >= cueLines.size()) {
                return std::unexpected(core::error("transcript_subtitle_cue_invalid",
                                                   "Subtitle cue contains no text."));
            }

            TranscriptSourceCue cue;
            cue.startTimeUs = timeRange->first;
            cue.endTimeUs = timeRange->second;
            cue.sourceIndex = sourceIndex++;
            if (timingLine == 1)
                cue.sourceId = cueLines.front();
            for (std::size_t index = timingLine + 1; index < cueLines.size(); ++index) {
                if (!cue.text.empty())
                    cue.text.push_back('\n');
                cue.text += cueLines[index];
            }
            if (auto status = validateTranscriptCue(cue); !status)
                return status;

            cueLines.clear();
            cueBytes = 0;
            return visitor(std::move(cue));
        };

        while (true) {
            auto hasLine = reader.next(line);
            if (!hasLine)
                return std::unexpected(hasLine.error());
            if (!*hasLine)
                break;
            ++sourceLine;
            if (!line.empty() && line.back() == '\r')
                line.pop_back();
            if (firstLine && line.starts_with("\xef\xbb\xbf"))
                line.erase(0, 3);
            firstLine = false;

            if (format == "vtt" && !vttHeaderSeen) {
                const bool validHeader =
                    line == "WEBVTT" || line.starts_with("WEBVTT ") || line.starts_with("WEBVTT\t");
                if (!validHeader) {
                    return std::unexpected(
                        core::error("transcript_subtitle_header_invalid",
                                    "WebVTT source must begin with a valid WEBVTT header."));
                }
                vttHeaderSeen = true;
                vttHeaderBlock = true;
                continue;
            }
            if (format == "vtt" && vttHeaderBlock) {
                if (trimWhitespace(line).empty())
                    vttHeaderBlock = false;
                continue;
            }
            if (trimWhitespace(line).empty()) {
                if (auto status = flushCue(); !status)
                    return status;
                continue;
            }
            if (!cueLines.empty()) {
                if (cueBytes == maximumCueBytes) {
                    return std::unexpected(core::error("transcript_subtitle_cue_too_large",
                                                       "Subtitle cue exceeds 16 MiB."));
                }
                ++cueBytes;
            }
            if (line.size() > maximumCueBytes - cueBytes) {
                return std::unexpected(core::error("transcript_subtitle_cue_too_large",
                                                   "Subtitle cue exceeds 16 MiB."));
            }
            cueBytes += line.size();
            cueLines.push_back(std::move(line));
        }

        if (format == "vtt" && !vttHeaderSeen) {
            return std::unexpected(core::error("transcript_subtitle_header_invalid",
                                               "WebVTT source is missing its header."));
        }
        if (format == "vtt" && vttHeaderBlock) {
            return std::unexpected(
                core::error("transcript_subtitle_header_invalid",
                            "WebVTT header metadata must end with a blank line."));
        }
        return flushCue();
    }

} // namespace tutorux::transcription

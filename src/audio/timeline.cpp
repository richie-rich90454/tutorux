#include "tutorux/audio/timeline.hpp"

#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <unordered_set>
#include <utility>
#include <vector>

namespace tutorux::audio {
namespace {

    using detail::AudioChunkReference;

    std::string_view field(const archive::Record& record, std::string_view name) {
        const auto found = record.fields.find(name);
        return found == record.fields.end() ? std::string_view{} : found->second;
    }

    core::Result<std::uint64_t> readInteger(const archive::Record& record, std::string_view name,
                                            bool optional = false) {
        const auto value = field(record, name);
        if (value.empty() && optional)
            return std::uint64_t{0};
        if (value.empty()) {
            return std::unexpected(
                core::error("audio_timeline_record_invalid",
                            "Audio chunk is missing the '" + std::string(name) + "' field."));
        }
        std::uint64_t parsed = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), parsed);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                core::error("audio_timeline_record_invalid",
                            "Audio chunk has an invalid '" + std::string(name) + "' field."));
        }
        return parsed;
    }

    std::uint64_t framesToMicroseconds(std::uint64_t frames, std::uint32_t sampleRateHz) {
        const std::uint64_t wholeSeconds = frames / sampleRateHz;
        const std::uint64_t remainingFrames = frames % sampleRateHz;
        if (wholeSeconds > std::numeric_limits<std::uint64_t>::max() / 1'000'000ULL)
            return std::numeric_limits<std::uint64_t>::max();
        return wholeSeconds * 1'000'000ULL + (remainingFrames * 1'000'000ULL) / sampleRateHz;
    }

    std::string fingerprintChunks(std::span<const AudioChunkReference> chunks) {
        domain::Sha256Builder fingerprint;
        for (const auto& chunk : chunks) {
            const std::string signature =
                archive::uuidToString(chunk.id) + ":" + std::to_string(chunk.revision) + ":" +
                std::to_string(chunk.sequence) + ":" + std::to_string(chunk.firstFrame) + ":" +
                std::to_string(chunk.frameCount) + ":" + std::to_string(chunk.gapBeforeFrames) +
                "\n";
            fingerprint.update(std::as_bytes(std::span(signature.data(), signature.size())));
        }
        return domain::hexHash(fingerprint.finish());
    }

    core::Result<std::vector<AudioChunkReference>> collectChunks(archive::Archive& archive,
                                                                 const archive::Uuid& sessionId,
                                                                 const archive::Uuid& trackId,
                                                                 AudioTimelineInfo& info) {
        std::vector<AudioChunkReference> chunks;
        std::optional<core::Error> callbackError;
        auto status = archive.forEachAudioChunk(sessionId, trackId, [&](archive::Record&& record) {
            auto sequence = readInteger(record, "sequence_number");
            auto firstFrame = readInteger(record, "first_sample_index");
            auto frameCount = readInteger(record, "sample_count");
            auto gapBefore = readInteger(record, "gap_before_samples", true);
            auto sampleRate = readInteger(record, "sample_rate_hz");
            auto channelCount = readInteger(record, "channel_count");
            if (!sequence || !firstFrame || !frameCount || !gapBefore || !sampleRate ||
                !channelCount) {
                callbackError = !sequence     ? sequence.error()
                                : !firstFrame ? firstFrame.error()
                                : !frameCount ? frameCount.error()
                                : !gapBefore  ? gapBefore.error()
                                : !sampleRate ? sampleRate.error()
                                              : channelCount.error();
                return false;
            }
            if (field(record, "sample_format") != "pcm_s16le") {
                callbackError = core::error("audio_timeline_format_unsupported",
                                            "The audio timeline currently requires PCM signed "
                                            "16-bit little-endian chunks.");
                return false;
            }
            if (*sampleRate < 8'000 || *sampleRate > 384'000 ||
                *sampleRate > std::numeric_limits<std::uint32_t>::max() || *channelCount == 0 ||
                *channelCount > 8 || *channelCount > std::numeric_limits<std::uint16_t>::max() ||
                *frameCount == 0) {
                callbackError = core::error("audio_timeline_record_invalid",
                                            "Audio chunk metadata is outside supported limits.");
                return false;
            }
            const auto rate = static_cast<std::uint32_t>(*sampleRate);
            const auto channels = static_cast<std::uint16_t>(*channelCount);
            if (info.chunkCount == 0) {
                info.sampleRateHz = rate;
                info.channelCount = channels;
            } else if (info.sampleRateHz != rate || info.channelCount != channels) {
                callbackError = core::error(
                    "audio_timeline_format_mismatch",
                    "A recording track contains chunks with inconsistent audio formats.");
                return false;
            }
            chunks.push_back(
                {record.id, *sequence, *firstFrame, *frameCount, *gapBefore, record.revision});
            ++info.chunkCount;
            return true;
        });
        if (!status)
            return std::unexpected(status.error());
        if (callbackError)
            return std::unexpected(std::move(*callbackError));
        if (chunks.empty()) {
            return std::unexpected(
                core::error("audio_track_not_found",
                            "The selected session track has no committed audio chunks."));
        }

        std::ranges::sort(chunks, {}, &AudioChunkReference::sequence);
        std::uint64_t expectedSequence = 0;
        std::uint64_t expectedFirstFrame = 0;
        for (const auto& chunk : chunks) {
            if (chunk.sequence != expectedSequence ||
                chunk.gapBeforeFrames >
                    std::numeric_limits<std::uint64_t>::max() - expectedFirstFrame ||
                chunk.firstFrame != expectedFirstFrame + chunk.gapBeforeFrames ||
                chunk.frameCount > std::numeric_limits<std::uint64_t>::max() - chunk.firstFrame ||
                chunk.frameCount >
                    std::numeric_limits<std::uint64_t>::max() - info.storedFrameCount ||
                expectedSequence == std::numeric_limits<std::uint64_t>::max()) {
                return std::unexpected(core::error(
                    "audio_timeline_sequence_invalid",
                    "Audio chunks contain duplicate sequence numbers or an invalid timeline."));
            }
            info.storedFrameCount += chunk.frameCount;
            expectedFirstFrame = chunk.firstFrame + chunk.frameCount;
            ++expectedSequence;
        }
        info.sourceFingerprint = fingerprintChunks(chunks);
        info.timelineFrameCount = expectedFirstFrame;
        info.durationUs = framesToMicroseconds(expectedFirstFrame, info.sampleRateHz);
        return chunks;
    }

    core::Result<archive::Uuid> selectTrack(archive::Archive& archive,
                                            const archive::Uuid& sessionId,
                                            std::optional<archive::Uuid> requestedTrack) {
        if (requestedTrack)
            return *requestedTrack;
        std::unordered_set<std::string> trackIds;
        std::optional<core::Error> callbackError;
        auto status = archive.forEachAudioChunk(sessionId, {}, [&](archive::Record&& record) {
            const auto value = field(record, "track_id");
            if (value.empty()) {
                callbackError = core::error("audio_timeline_record_invalid",
                                            "An audio chunk is missing its track ID.");
                return false;
            }
            trackIds.emplace(value);
            return true;
        });
        if (!status)
            return std::unexpected(status.error());
        if (callbackError)
            return std::unexpected(std::move(*callbackError));
        if (trackIds.empty()) {
            return std::unexpected(core::error("audio_track_not_found",
                                               "The selected session contains no audio tracks."));
        }
        if (trackIds.size() != 1) {
            return std::unexpected(
                core::error("audio_track_selection_required",
                            "This session has multiple audio tracks. Select one explicitly."));
        }
        return archive::uuidFromString(*trackIds.begin());
    }

} // namespace

AudioTimelineReader::AudioTimelineReader(archive::Archive& archive, archive::Uuid sessionId,
                                         AudioTimelineInfo info,
                                         std::vector<detail::AudioChunkReference> chunks)
    : archive_(&archive)
    , sessionId_(sessionId)
    , info_(std::move(info))
    , chunks_(std::move(chunks)) {}

core::Result<AudioTimelineReader>
AudioTimelineReader::open(archive::Archive& archive, const archive::Uuid& sessionId,
                          std::optional<archive::Uuid> requestedTrackId) {
    auto trackId = selectTrack(archive, sessionId, requestedTrackId);
    if (!trackId)
        return std::unexpected(trackId.error());
    AudioTimelineInfo info;
    info.trackId = *trackId;
    auto chunks = collectChunks(archive, sessionId, *trackId, info);
    if (!chunks)
        return std::unexpected(chunks.error());
    return AudioTimelineReader(archive, sessionId, std::move(info), std::move(*chunks));
}

const AudioTimelineInfo& AudioTimelineReader::info() const noexcept {
    return info_;
}

std::uint64_t AudioTimelineReader::position() const noexcept {
    return position_;
}

core::Status AudioTimelineReader::seek(std::uint64_t frameIndex) {
    if (frameIndex > info_.timelineFrameCount) {
        return std::unexpected(
            core::error("audio_timeline_seek_invalid",
                        "The requested seek position is beyond the end of the audio track."));
    }
    position_ = frameIndex;
    nextChunkIndex_ = static_cast<std::size_t>(std::distance(
        chunks_.begin(),
        std::lower_bound(chunks_.begin(), chunks_.end(), frameIndex,
                         [](const detail::AudioChunkReference& chunk, std::uint64_t position) {
                             return chunk.firstFrame + chunk.frameCount <= position;
                         })));
    loadedChunk_.reset();
    loadedChunkIndex_ = static_cast<std::size_t>(-1);
    return {};
}

core::Result<const archive::Record*> AudioTimelineReader::loadChunk(std::size_t chunkIndex) {
    if (chunkIndex >= chunks_.size())
        return static_cast<const archive::Record*>(nullptr);
    if (loadedChunk_ && loadedChunkIndex_ == chunkIndex)
        return &*loadedChunk_;
    auto record = archive_->get(archive::RecordType::AudioChunk, chunks_[chunkIndex].id);
    if (!record)
        return std::unexpected(record.error());
    if (!*record || domain::isDeleted(**record)) {
        return std::unexpected(core::error("audio_timeline_chunk_missing",
                                           "An audio chunk disappeared from the selected track."));
    }
    const auto& loaded = **record;
    if (field(loaded, "session_id") != archive::uuidToString(sessionId_) ||
        field(loaded, "track_id") != archive::uuidToString(info_.trackId) ||
        field(loaded, "sample_format") != "pcm_s16le") {
        return std::unexpected(
            core::error("audio_timeline_chunk_invalid",
                        "An audio chunk no longer matches the selected session track."));
    }
    const auto& reference = chunks_[chunkIndex];
    const std::uint64_t bytesPerFrame = static_cast<std::uint64_t>(info_.channelCount) * 2U;
    if (reference.frameCount > std::numeric_limits<std::uint64_t>::max() / bytesPerFrame ||
        loaded.blob.size() != reference.frameCount * bytesPerFrame) {
        return std::unexpected(
            core::error("audio_timeline_chunk_invalid",
                        "An audio chunk payload size does not match its timeline metadata."));
    }
    const auto checksum = field(loaded, "payload_checksum");
    if (!checksum.empty()) {
        auto expectedChecksum = readInteger(loaded, "payload_checksum");
        if (!expectedChecksum || *expectedChecksum > UINT32_MAX ||
            archive::crc32(loaded.blob) != *expectedChecksum) {
            return std::unexpected(core::error("audio_timeline_checksum_failed",
                                               "An audio chunk failed its payload checksum."));
        }
    }
    loadedChunk_ = std::move(**record);
    loadedChunkIndex_ = chunkIndex;
    return &*loadedChunk_;
}

core::Result<AudioReadResult>
AudioTimelineReader::readFrames(std::span<std::int16_t> interleavedSamples,
                                std::span<std::uint8_t> gapFlags) {
    if (interleavedSamples.size() % info_.channelCount != 0) {
        return std::unexpected(core::error(
            "audio_timeline_buffer_invalid",
            "The playback buffer must contain a whole number of interleaved audio frames."));
    }
    const std::size_t requestedFrames = interleavedSamples.size() / info_.channelCount;
    if (!gapFlags.empty() && gapFlags.size() < requestedFrames) {
        return std::unexpected(core::error(
            "audio_timeline_buffer_invalid",
            "The gap-flag buffer must contain one entry for every requested audio frame."));
    }
    AudioReadResult result;
    std::size_t outputFrame = 0;
    while (outputFrame < requestedFrames && position_ < info_.timelineFrameCount) {
        while (nextChunkIndex_ < chunks_.size() &&
               chunks_[nextChunkIndex_].firstFrame + chunks_[nextChunkIndex_].frameCount <=
                   position_) {
            ++nextChunkIndex_;
        }
        if (nextChunkIndex_ >= chunks_.size())
            break;

        const detail::AudioChunkReference& reference = chunks_[nextChunkIndex_];
        if (position_ < reference.firstFrame) {
            const std::uint64_t gapFrames = reference.firstFrame - position_;
            const std::size_t framesToFill = static_cast<std::size_t>(
                std::min<std::uint64_t>(gapFrames, requestedFrames - outputFrame));
            const std::size_t sampleOffset = outputFrame * info_.channelCount;
            const std::size_t sampleCount = framesToFill * info_.channelCount;
            std::fill_n(interleavedSamples.begin() + static_cast<std::ptrdiff_t>(sampleOffset),
                        sampleCount, 0);
            if (!gapFlags.empty()) {
                std::fill_n(gapFlags.begin() + static_cast<std::ptrdiff_t>(outputFrame),
                            framesToFill, std::uint8_t{1});
            }
            result.framesRead += framesToFill;
            result.gapFramesRead += framesToFill;
            outputFrame += framesToFill;
            position_ += framesToFill;
            continue;
        }

        auto record = loadChunk(nextChunkIndex_);
        if (!record)
            return std::unexpected(record.error());
        const std::uint64_t frameOffset = position_ - reference.firstFrame;
        const std::uint64_t chunkFramesRemaining = reference.frameCount - frameOffset;
        const std::size_t framesToCopy = static_cast<std::size_t>(
            std::min<std::uint64_t>(chunkFramesRemaining, requestedFrames - outputFrame));
        const std::size_t bytesPerFrame = static_cast<std::size_t>(info_.channelCount) * 2U;
        const std::size_t sourceOffset = static_cast<std::size_t>(frameOffset) * bytesPerFrame;
        const auto* source = (*record)->blob.data() + sourceOffset;
        auto* destination = interleavedSamples.data() + outputFrame * info_.channelCount;
        if (!gapFlags.empty()) {
            std::fill_n(gapFlags.begin() + static_cast<std::ptrdiff_t>(outputFrame), framesToCopy,
                        std::uint8_t{0});
        }
        for (std::size_t sampleIndex = 0; sampleIndex < framesToCopy * info_.channelCount;
             ++sampleIndex) {
            const std::size_t byteOffset = sampleIndex * 2U;
            const auto low = std::to_integer<std::uint8_t>(source[byteOffset]);
            const auto high = std::to_integer<std::uint8_t>(source[byteOffset + 1U]);
            const std::uint16_t bits = static_cast<std::uint16_t>(low | (high << 8U));
            destination[sampleIndex] = static_cast<std::int16_t>(bits);
        }
        result.framesRead += framesToCopy;
        outputFrame += framesToCopy;
        position_ += framesToCopy;
    }
    return result;
}

} // namespace tutorux::audio

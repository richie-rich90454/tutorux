#include "tutorux/audio/waveform.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace tutorux::audio {
namespace {

    constexpr std::size_t maximumWaveformBuckets = 8'192;
    constexpr std::size_t maximumFramesPerRead = 4'096;
    constexpr std::array<std::byte, 8> cacheMagic{
        static_cast<std::byte>('T'), static_cast<std::byte>('U'),
        static_cast<std::byte>('X'), static_cast<std::byte>('W'),
        static_cast<std::byte>('F'), static_cast<std::byte>('P'),
        static_cast<std::byte>('2'), std::byte{0},
    };

    struct WaveformPyramid final {
        std::vector<std::vector<WaveformBucket>> levels;
    };

    std::string_view field(const archive::Record& record, std::string_view name) {
        const auto found = record.fields.find(name);
        return found == record.fields.end() ? std::string_view{} : found->second;
    }

    template <typename Unsigned>
    void appendLittleEndian(std::vector<std::byte>& output, Unsigned value) {
        static_assert(std::is_unsigned_v<Unsigned>);
        for (std::size_t index = 0; index < sizeof(Unsigned); ++index) {
            const auto shift = static_cast<unsigned int>(index * 8U);
            output.push_back(static_cast<std::byte>((value >> shift) & 0xffU));
        }
    }

    template <typename Unsigned>
    bool readLittleEndian(std::span<const std::byte> bytes, std::size_t& offset, Unsigned& value) {
        static_assert(std::is_unsigned_v<Unsigned>);
        if (offset > bytes.size() || bytes.size() - offset < sizeof(Unsigned))
            return false;
        value = 0;
        for (std::size_t index = 0; index < sizeof(Unsigned); ++index) {
            const auto shift = static_cast<unsigned int>(index * 8U);
            const auto byteValue = std::to_integer<std::uint8_t>(bytes[offset + index]);
            value |= static_cast<Unsigned>(static_cast<Unsigned>(byteValue) << shift);
        }
        offset += sizeof(Unsigned);
        return true;
    }

    void encodeBucket(std::vector<std::byte>& output, const WaveformBucket& bucket) {
        appendLittleEndian(output, bucket.startFrame);
        appendLittleEndian(output, bucket.endFrame);
        appendLittleEndian(output, std::bit_cast<std::uint16_t>(bucket.minimum));
        appendLittleEndian(output, std::bit_cast<std::uint16_t>(bucket.maximum));
        output.push_back(bucket.containsGap ? std::byte{1} : std::byte{0});
    }

    bool decodeBucket(std::span<const std::byte> bytes, std::size_t& offset,
                      WaveformBucket& bucket) {
        std::uint16_t minimum = 0;
        std::uint16_t maximum = 0;
        if (!readLittleEndian(bytes, offset, bucket.startFrame) ||
            !readLittleEndian(bytes, offset, bucket.endFrame) ||
            !readLittleEndian(bytes, offset, minimum) ||
            !readLittleEndian(bytes, offset, maximum) || offset >= bytes.size()) {
            return false;
        }
        bucket.minimum = std::bit_cast<std::int16_t>(minimum);
        bucket.maximum = std::bit_cast<std::int16_t>(maximum);
        const auto gap = std::to_integer<std::uint8_t>(bytes[offset++]);
        if (gap > 1 || bucket.endFrame <= bucket.startFrame)
            return false;
        bucket.containsGap = gap != 0;
        return true;
    }

    std::vector<std::byte> encodePyramid(const WaveformPyramid& pyramid) {
        std::vector<std::byte> bytes(cacheMagic.begin(), cacheMagic.end());
        appendLittleEndian(bytes, static_cast<std::uint32_t>(pyramid.levels.size()));
        for (const auto& level : pyramid.levels) {
            appendLittleEndian(bytes, static_cast<std::uint32_t>(level.size()));
            for (const auto& bucket : level)
                encodeBucket(bytes, bucket);
        }
        return bytes;
    }

    core::Result<WaveformPyramid> decodePyramid(std::span<const std::byte> bytes,
                                                std::uint64_t expectedFrameCount) {
        if (bytes.size() < cacheMagic.size() + sizeof(std::uint32_t) ||
            !std::ranges::equal(cacheMagic, bytes.first(cacheMagic.size()))) {
            return std::unexpected(
                core::error("audio_waveform_cache_invalid",
                            "The saved waveform index has an unsupported or incomplete format."));
        }
        std::size_t offset = cacheMagic.size();
        std::uint32_t levelCount = 0;
        if (!readLittleEndian(bytes, offset, levelCount) || levelCount == 0 || levelCount > 14) {
            return std::unexpected(core::error("audio_waveform_cache_invalid",
                                               "The saved waveform index has invalid levels."));
        }

        WaveformPyramid pyramid;
        pyramid.levels.reserve(levelCount);
        for (std::uint32_t levelIndex = 0; levelIndex < levelCount; ++levelIndex) {
            std::uint32_t bucketCount = 0;
            if (!readLittleEndian(bytes, offset, bucketCount) || bucketCount == 0 ||
                bucketCount > maximumWaveformBuckets ||
                static_cast<std::uint64_t>(bucketCount) > (bytes.size() - offset) / 21U) {
                return std::unexpected(
                    core::error("audio_waveform_cache_invalid",
                                "The saved waveform index contains an invalid bucket count."));
            }
            auto& level = pyramid.levels.emplace_back();
            level.reserve(bucketCount);
            for (std::uint32_t bucketIndex = 0; bucketIndex < bucketCount; ++bucketIndex) {
                WaveformBucket bucket;
                if (!decodeBucket(bytes, offset, bucket)) {
                    return std::unexpected(
                        core::error("audio_waveform_cache_invalid",
                                    "The saved waveform index contains a truncated bucket."));
                }
                if (!level.empty() && level.back().endFrame != bucket.startFrame) {
                    return std::unexpected(core::error(
                        "audio_waveform_cache_invalid",
                        "The saved waveform index contains a discontinuous bucket range."));
                }
                level.push_back(bucket);
            }
            if (level.front().startFrame != 0 || level.back().endFrame != expectedFrameCount) {
                return std::unexpected(core::error(
                    "audio_waveform_cache_invalid",
                    "The saved waveform index does not cover the complete audio timeline."));
            }
            if (levelIndex != 0 && level.size() >= pyramid.levels[levelIndex - 1U].size()) {
                return std::unexpected(core::error(
                    "audio_waveform_cache_invalid",
                    "The saved waveform pyramid levels are not progressively coarser."));
            }
        }
        if (offset != bytes.size()) {
            return std::unexpected(
                core::error("audio_waveform_cache_invalid",
                            "The saved waveform index has unexpected trailing data."));
        }
        return pyramid;
    }

    bool cacheMatches(const archive::Record& record, const archive::Uuid& sessionId,
                      const AudioTimelineInfo& timeline) {
        const auto numericMatches = [&](std::string_view key, std::uint64_t expected) {
            std::uint64_t actual = 0;
            const auto value = field(record, key);
            const auto [end, errorCode] =
                std::from_chars(value.data(), value.data() + value.size(), actual);
            return !value.empty() && errorCode == std::errc{} &&
                   end == value.data() + value.size() && actual == expected;
        };
        return field(record, "record_role") == "waveform-pyramid" &&
               field(record, "format_version") == "2" &&
               field(record, "session_id") == archive::uuidToString(sessionId) &&
               field(record, "track_id") == archive::uuidToString(timeline.trackId) &&
               numericMatches("sample_rate_hz", timeline.sampleRateHz) &&
               numericMatches("channel_count", timeline.channelCount) &&
               numericMatches("stored_frame_count", timeline.storedFrameCount) &&
               numericMatches("timeline_frame_count", timeline.timelineFrameCount) &&
               numericMatches("chunk_count", timeline.chunkCount) &&
               field(record, "source_fingerprint") == timeline.sourceFingerprint;
    }

    core::Result<std::optional<WaveformPyramid>>
    loadCachedPyramid(archive::Archive& archive, const archive::Uuid& sessionId,
                      const AudioTimelineInfo& timeline) {
        std::optional<WaveformPyramid> cached;
        auto status =
            archive.forEach(archive::RecordType::WaveformIndex, [&](archive::Record&& record) {
                if (!cacheMatches(record, sessionId, timeline))
                    return true;
                auto pyramid = decodePyramid(record.blob, timeline.timelineFrameCount);
                if (pyramid)
                    cached = std::move(*pyramid);
                return false;
            });
        if (!status)
            return std::unexpected(status.error());
        return cached;
    }

    WaveformPyramid makePyramid(std::vector<WaveformBucket> baseLevel) {
        WaveformPyramid pyramid;
        pyramid.levels.reserve(14);
        pyramid.levels.push_back(std::move(baseLevel));
        while (pyramid.levels.back().size() > 1) {
            const auto& source = pyramid.levels.back();
            auto& next = pyramid.levels.emplace_back();
            next.reserve((source.size() + 1U) / 2U);
            for (std::size_t index = 0; index < source.size(); index += 2U) {
                WaveformBucket combined = source[index];
                if (index + 1U < source.size()) {
                    const auto& following = source[index + 1U];
                    combined.endFrame = following.endFrame;
                    combined.minimum = std::min(combined.minimum, following.minimum);
                    combined.maximum = std::max(combined.maximum, following.maximum);
                    combined.containsGap = combined.containsGap || following.containsGap;
                }
                next.push_back(combined);
            }
        }
        return pyramid;
    }

    WaveformSummary selectResolution(const WaveformPyramid& pyramid,
                                     const AudioTimelineInfo& timeline,
                                     std::size_t maximumBuckets) {
        WaveformSummary summary;
        summary.timeline = timeline;
        const std::uint64_t frameCount = timeline.timelineFrameCount;
        const std::size_t targetCount =
            static_cast<std::size_t>(std::min<std::uint64_t>(maximumBuckets, frameCount));
        if (targetCount == 0 || pyramid.levels.empty())
            return summary;
        const std::vector<WaveformBucket>* source = &pyramid.levels.front();
        for (const auto& level : pyramid.levels) {
            if (level.size() < targetCount)
                break;
            source = &level;
        }

        summary.buckets.reserve(targetCount);
        const std::uint64_t width = frameCount / targetCount;
        const std::uint64_t remainder = frameCount % targetCount;
        std::size_t sourceIndex = 0;
        for (std::size_t bucketIndex = 0; bucketIndex < targetCount; ++bucketIndex) {
            const auto index = static_cast<std::uint64_t>(bucketIndex);
            const std::uint64_t startFrame = width * index + (remainder * index) / targetCount;
            const std::uint64_t nextIndex = index + 1U;
            const std::uint64_t endFrame =
                width * nextIndex + (remainder * nextIndex) / targetCount;
            WaveformBucket bucket;
            bucket.startFrame = startFrame;
            bucket.endFrame = endFrame;
            bucket.minimum = std::numeric_limits<std::int16_t>::max();
            bucket.maximum = std::numeric_limits<std::int16_t>::min();
            while (sourceIndex < source->size() && (*source)[sourceIndex].endFrame <= startFrame) {
                ++sourceIndex;
            }
            std::size_t candidate = sourceIndex;
            while (candidate < source->size() && (*source)[candidate].startFrame < endFrame) {
                const auto& sourceBucket = (*source)[candidate];
                bucket.minimum = std::min(bucket.minimum, sourceBucket.minimum);
                bucket.maximum = std::max(bucket.maximum, sourceBucket.maximum);
                bucket.containsGap = bucket.containsGap || sourceBucket.containsGap;
                ++candidate;
            }
            summary.buckets.push_back(bucket);
        }
        return summary;
    }

    archive::Record makeCacheRecord(const archive::Uuid& sessionId,
                                    const AudioTimelineInfo& timeline,
                                    const WaveformPyramid& pyramid,
                                    std::optional<archive::Uuid> existingId) {
        archive::Record record;
        record.type = archive::RecordType::WaveformIndex;
        record.id = existingId.value_or(archive::randomUuid());
        record.fields = {
            {"record_role",          "waveform-pyramid"                           },
            {"format_version",       "2"                                          },
            {"source_fingerprint",   timeline.sourceFingerprint                   },
            {"session_id",           archive::uuidToString(sessionId)             },
            {"track_id",             archive::uuidToString(timeline.trackId)      },
            {"sample_rate_hz",       std::to_string(timeline.sampleRateHz)        },
            {"channel_count",        std::to_string(timeline.channelCount)        },
            {"stored_frame_count",   std::to_string(timeline.storedFrameCount)    },
            {"timeline_frame_count", std::to_string(timeline.timelineFrameCount)  },
            {"chunk_count",          std::to_string(timeline.chunkCount)          },
            {"level_count",          std::to_string(pyramid.levels.size())        },
            {"base_bucket_count",    std::to_string(pyramid.levels.front().size())}
        };
        record.blob = encodePyramid(pyramid);
        return record;
    }

    core::Status storePyramid(archive::Archive& archive, const archive::Uuid& sessionId,
                              const AudioTimelineInfo& timeline, const WaveformPyramid& pyramid) {
        if (!archive.writable())
            return {};
        std::optional<archive::Uuid> existingId;
        auto status =
            archive.forEach(archive::RecordType::WaveformIndex, [&](archive::Record&& record) {
                if (field(record, "record_role") == "waveform-pyramid" &&
                    field(record, "session_id") == archive::uuidToString(sessionId) &&
                    field(record, "track_id") == archive::uuidToString(timeline.trackId)) {
                    existingId = record.id;
                    return false;
                }
                return true;
            });
        if (!status)
            return std::unexpected(status.error());
        return archive.put(makeCacheRecord(sessionId, timeline, pyramid, existingId));
    }

} // namespace

core::Result<WaveformSummary> buildWaveform(archive::Archive& archive,
                                            const archive::Uuid& sessionId,
                                            std::optional<archive::Uuid> trackId,
                                            std::size_t maximumBuckets,
                                            std::function<bool()> stopRequested) {
    if (maximumBuckets == 0 || maximumBuckets > maximumWaveformBuckets) {
        return std::unexpected(
            core::error("audio_waveform_bucket_limit",
                        "Waveform resolution must be between 1 and 8,192 buckets."));
    }

    auto reader = AudioTimelineReader::open(archive, sessionId, trackId);
    if (!reader)
        return std::unexpected(reader.error());
    const auto cancellationCheck = [&]() -> core::Status {
        if (!stopRequested)
            return {};
        try {
            if (!stopRequested())
                return {};
        } catch (...) {
            return std::unexpected(core::error("audio_waveform_cancellation_failed",
                                               "Checking waveform cancellation failed."));
        }
        return std::unexpected(
            core::error("audio_waveform_cancelled", "Waveform generation was cancelled."));
    };
    if (auto status = cancellationCheck(); !status)
        return std::unexpected(status.error());
    const AudioTimelineInfo timeline = reader->info();
    if (timeline.timelineFrameCount == 0 || maximumBuckets == 0)
        return WaveformSummary{timeline, {}};
    auto cached = loadCachedPyramid(archive, sessionId, timeline);
    if (!cached)
        return std::unexpected(cached.error());
    if (auto status = cancellationCheck(); !status)
        return std::unexpected(status.error());
    if (*cached)
        return selectResolution(**cached, timeline, maximumBuckets);

    const std::uint64_t timelineFrames = timeline.timelineFrameCount;
    const std::size_t baseBucketCount =
        static_cast<std::size_t>(std::min<std::uint64_t>(maximumWaveformBuckets, timelineFrames));
    std::vector<WaveformBucket> baseLevel;
    baseLevel.reserve(baseBucketCount);
    const std::uint64_t bucketWidth = timelineFrames / baseBucketCount;
    const std::uint64_t bucketRemainder = timelineFrames % baseBucketCount;
    const std::size_t channelCount = timeline.channelCount;

    std::vector<std::int16_t> samples(maximumFramesPerRead * channelCount);
    std::vector<std::uint8_t> gapFlags(maximumFramesPerRead);
    for (std::size_t bucketIndex = 0; bucketIndex < baseBucketCount; ++bucketIndex) {
        if (auto status = cancellationCheck(); !status)
            return std::unexpected(status.error());
        const auto index = static_cast<std::uint64_t>(bucketIndex);
        const std::uint64_t startFrame =
            bucketWidth * index + (bucketRemainder * index) / baseBucketCount;
        const std::uint64_t nextIndex = index + 1U;
        const std::uint64_t endFrame =
            bucketWidth * nextIndex + (bucketRemainder * nextIndex) / baseBucketCount;
        WaveformBucket bucket;
        bucket.startFrame = startFrame;
        bucket.endFrame = endFrame;
        bucket.minimum = std::numeric_limits<std::int16_t>::max();
        bucket.maximum = std::numeric_limits<std::int16_t>::min();

        std::uint64_t remainingFrames = endFrame - startFrame;
        while (remainingFrames != 0) {
            if (auto status = cancellationCheck(); !status)
                return std::unexpected(status.error());
            const std::size_t requestedFrames = static_cast<std::size_t>(
                std::min<std::uint64_t>(remainingFrames, maximumFramesPerRead));
            auto read = reader->readFrames(
                std::span<std::int16_t>(samples.data(), requestedFrames * channelCount),
                std::span<std::uint8_t>(gapFlags.data(), requestedFrames));
            if (!read)
                return std::unexpected(read.error());
            if (read->framesRead == 0) {
                return std::unexpected(core::error(
                    "audio_waveform_read_incomplete",
                    "The audio timeline ended before the waveform was fully generated."));
            }

            for (std::size_t frame = 0; frame < read->framesRead; ++frame) {
                bucket.containsGap = bucket.containsGap || gapFlags[frame] != 0;
                const std::size_t firstSample = frame * channelCount;
                for (std::size_t channel = 0; channel < channelCount; ++channel) {
                    const auto sample = samples[firstSample + channel];
                    bucket.minimum = std::min(bucket.minimum, sample);
                    bucket.maximum = std::max(bucket.maximum, sample);
                }
            }
            remainingFrames -= read->framesRead;
        }
        baseLevel.push_back(bucket);
    }

    auto pyramid = makePyramid(std::move(baseLevel));
    if (auto status = cancellationCheck(); !status)
        return std::unexpected(status.error());
    if (auto status = storePyramid(archive, sessionId, timeline, pyramid); !status)
        return std::unexpected(status.error());
    return selectResolution(pyramid, timeline, maximumBuckets);
}

} // namespace tutorux::audio

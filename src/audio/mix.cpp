#include "tutorux/audio/mix.hpp"

#include "tutorux/audio/recording_take.hpp"
#include "tutorux/audio/timeline.hpp"
#include "tutorux/audio/waveform.hpp"
#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <bit>
#include <charconv>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <span>
#include <string_view>
#include <chrono>
#include <utility>
#include <vector>

namespace tutorux::audio {
namespace {

    constexpr std::size_t outputBlockFrames = 2048;
    constexpr std::size_t chunksPerCommit = 16;
    constexpr std::uint16_t outputChannels = 2;

    std::string_view field(const archive::Record& record, std::string_view key) {
        const auto found = record.fields.find(key);
        return found == record.fields.end() ? std::string_view{} : found->second;
    }

    std::vector<std::string> splitIds(std::string_view encoded) {
        std::vector<std::string> result;
        for (std::size_t start = 0; start < encoded.size();) {
            const auto comma = encoded.find(',', start);
            const auto end = comma == std::string_view::npos ? encoded.size() : comma;
            if (end > start)
                result.emplace_back(encoded.substr(start, end - start));
            if (comma == std::string_view::npos)
                break;
            start = comma + 1;
        }
        return result;
    }

    std::string joinIds(const std::vector<std::string>& ids) {
        std::string result;
        for (const auto& id : ids) {
            if (!result.empty())
                result.push_back(',');
            result += id;
        }
        return result;
    }

    std::uint64_t framesToUs(std::uint64_t frames, std::uint32_t rate) {
        const auto seconds = frames / rate;
        const auto remainder = frames % rate;
        if (seconds > std::numeric_limits<std::uint64_t>::max() / 1'000'000ULL)
            return std::numeric_limits<std::uint64_t>::max();
        return seconds * 1'000'000ULL + remainder * 1'000'000ULL / rate;
    }

    std::uint64_t usToFrames(std::uint64_t microseconds, std::uint32_t rate) {
        const auto seconds = microseconds / 1'000'000ULL;
        const auto remainder = microseconds % 1'000'000ULL;
        if (seconds > std::numeric_limits<std::uint64_t>::max() / rate)
            return std::numeric_limits<std::uint64_t>::max();
        return seconds * rate + remainder * rate / 1'000'000ULL;
    }

    std::uint64_t rescaleFrames(std::uint64_t frames, std::uint32_t sourceRate,
                                std::uint32_t targetRate) {
        return (frames / targetRate) * sourceRate + (frames % targetRate) * sourceRate / targetRate;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
    }

    archive::Bytes encodeSamples(std::span<const std::int16_t> samples) {
        archive::Bytes bytes;
        bytes.reserve(samples.size() * sizeof(std::int16_t));
        for (const auto sample : samples) {
            const auto bits = std::bit_cast<std::uint16_t>(sample);
            bytes.push_back(static_cast<std::byte>(bits & 0xffU));
            bytes.push_back(static_cast<std::byte>((bits >> 8U) & 0xffU));
        }
        return bytes;
    }

    struct SourceTrack final {
        archive::Uuid id{};
        AudioTimelineReader reader;
        std::vector<std::int16_t> samples;
        std::vector<std::uint8_t> gaps;
        std::size_t framesRead{};
        std::uint64_t currentStart{};
        std::uint64_t currentEnd{};

        SourceTrack(archive::Uuid trackId, AudioTimelineReader timeline)
            : id(trackId)
            , reader(std::move(timeline)) {}
    };

    archive::Record makeChunk(const archive::Uuid& sessionId, const archive::Uuid& trackId,
                              std::uint64_t sequence, std::uint64_t firstFrame,
                              std::uint64_t gapBeforeFrames, std::span<const std::int16_t> samples,
                              std::uint32_t sampleRate) {
        const std::uint64_t frameCount = samples.size() / outputChannels;
        archive::Record chunk;
        chunk.type = archive::RecordType::AudioChunk;
        chunk.id = archive::randomUuid();
        chunk.fields = {
            {"session_id", archive::uuidToString(sessionId)},
            {"track_id", archive::uuidToString(trackId)},
            {"sequence_number", std::to_string(sequence)},
            {"first_sample_index", std::to_string(firstFrame)},
            {"sample_count", std::to_string(frameCount)},
            {"gap_before_samples", std::to_string(gapBeforeFrames)},
            {"timeline_start_us", std::to_string(framesToUs(firstFrame, sampleRate))},
            {"timeline_end_us", std::to_string(framesToUs(firstFrame + frameCount, sampleRate))},
            {"sample_format", "pcm_s16le"},
            {"sample_rate_hz", std::to_string(sampleRate)},
            {"channel_count", std::to_string(outputChannels)},
            {"channel_mask", "3"},
            {"codec", "none"},
            {"source", "mixdown"},
        };
        chunk.blob = encodeSamples(samples);
        chunk.fields["payload_checksum"] = std::to_string(archive::crc32(chunk.blob));
        return chunk;
    }

} // namespace

core::Result<TrackMixSummary> mixTracksIntoTake(archive::Archive& archive,
                                                const archive::Uuid& sessionId,
                                                const archive::Uuid& takeId,
                                                const std::vector<archive::Uuid>& trackIds,
                                                std::string label) {
    if (!archive.writable())
        return std::unexpected(core::error("archive_read_only", "This archive is read-only."));
    if (trackIds.size() < 2 || trackIds.size() > 8) {
        return std::unexpected(core::error("audio_mix_track_count_invalid",
                                           "Choose between 2 and 8 tracks from this take to mix."));
    }
    if (label.empty())
        label = "Mixdown";
    if (label.size() > 120 || label.find_first_of("\r\n") != std::string::npos ||
        label.find('\0') != std::string::npos) {
        return std::unexpected(
            core::error("audio_mix_label_invalid",
                        "A mix name must contain no more than 120 characters on one line."));
    }

    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult))
        return std::unexpected(
            core::error("session_not_found", "The selected session is unavailable."));
    auto takeResult = archive.get(archive::RecordType::AssetMetadata, takeId);
    if (!takeResult)
        return std::unexpected(takeResult.error());
    if (!*takeResult || domain::isDeleted(**takeResult) ||
        field(**takeResult, "record_role") != "recording-take" ||
        field(**takeResult, "session_id") != archive::uuidToString(sessionId)) {
        return std::unexpected(
            core::error("recording_take_not_found", "Choose a saved take in this session."));
    }

    auto take = std::move(**takeResult);
    auto linkedIds = splitIds(field(take, "track_ids"));
    std::vector<SourceTrack> sources;
    sources.reserve(trackIds.size());
    std::uint32_t targetRate{};
    std::uint64_t durationUs{};
    for (const auto& trackId : trackIds) {
        const auto encodedId = archive::uuidToString(trackId);
        if (std::any_of(sources.begin(), sources.end(), [&](const auto& source) {
                return source.id == trackId;
            })) {
            return std::unexpected(
                core::error("audio_mix_tracks_duplicate", "Select each source track once."));
        }
        if (std::find(linkedIds.begin(), linkedIds.end(), encodedId) == linkedIds.end()) {
            return std::unexpected(
                core::error("audio_mix_track_outside_take",
                            "Every source track must belong to the selected take."));
        }
        auto metadata = archive.get(archive::RecordType::AssetMetadata, trackId);
        if (!metadata)
            return std::unexpected(metadata.error());
        if (!*metadata || domain::isDeleted(**metadata) ||
            field(**metadata, "record_role") != "audio-track" ||
            field(**metadata, "session_id") != archive::uuidToString(sessionId) ||
            field(**metadata, "recording_take_id") != archive::uuidToString(takeId)) {
            return std::unexpected(
                core::error("audio_mix_track_unavailable",
                            "A selected source track no longer belongs to this take."));
        }
        auto reader = AudioTimelineReader::open(archive, sessionId, trackId);
        if (!reader)
            return std::unexpected(reader.error());
        const auto info = reader->info();
        targetRate = std::max(targetRate, info.sampleRateHz);
        durationUs = std::max(durationUs, info.durationUs);
        sources.emplace_back(trackId, std::move(*reader));
    }
    if (targetRate < 8'000 || targetRate > 384'000 || durationUs == 0) {
        return std::unexpected(
            core::error("audio_mix_source_empty", "The selected tracks contain no mixable audio."));
    }

    const std::uint64_t totalFrames = usToFrames(durationUs, targetRate);
    if (totalFrames == 0 || totalFrames == std::numeric_limits<std::uint64_t>::max()) {
        return std::unexpected(
            core::error("audio_mix_duration_invalid", "The selected audio is too long to mix."));
    }
    const auto outputTrackId = archive::randomUuid();
    const auto now = nowUnixMicroseconds();
    archive::Record outputTrack;
    outputTrack.type = archive::RecordType::AssetMetadata;
    outputTrack.id = outputTrackId;
    outputTrack.fields = {
        {"record_role",       "audio-track"                       },
        {"session_id",        archive::uuidToString(sessionId)    },
        {"track_id",          archive::uuidToString(outputTrackId)},
        {"recording_take_id", archive::uuidToString(takeId)       },
        {"source",            "mixdown"                           },
        {"label",             std::move(label)                    },
        {"state",             "mixing"                            },
        {"sample_rate_hz",    std::to_string(targetRate)          },
        {"sample_format",     "pcm_s16le"                         },
        {"channel_count",     std::to_string(outputChannels)      },
        {"updated_at_us",     std::to_string(now)                 },
    };
    const auto outputTrackText = archive::uuidToString(outputTrackId);
    linkedIds.push_back(outputTrackText);
    take.fields["track_ids"] = joinIds(linkedIds);
    take.fields["updated_at_us"] = std::to_string(now);
    auto session = std::move(**sessionResult);
    auto sessionTrackIds = splitIds(field(session, "recording_track_ids"));
    if (std::find(sessionTrackIds.begin(), sessionTrackIds.end(), outputTrackText) ==
        sessionTrackIds.end())
        sessionTrackIds.push_back(outputTrackText);
    session.fields["recording_track_ids"] = joinIds(sessionTrackIds);
    session.fields["updated_at_us"] = std::to_string(now);
    if (auto status = archive.putMany({std::move(outputTrack), take, session}); !status)
        return std::unexpected(status.error());

    const auto markPartial = [&](core::Error failure) -> core::Result<TrackMixSummary> {
        auto partialResult = archive.get(archive::RecordType::AssetMetadata, outputTrackId);
        if (partialResult && *partialResult) {
            auto partial = std::move(**partialResult);
            partial.fields["state"] = "partial";
            partial.fields["failure_code"] = failure.code;
            partial.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
            static_cast<void>(archive.put(std::move(partial)));
        }
        return std::unexpected(std::move(failure));
    };

    TrackMixSummary summary;
    summary.trackId = outputTrackId;
    summary.sampleRateHz = targetRate;
    summary.channelCount = outputChannels;
    summary.frameCount = totalFrames;
    summary.durationUs = durationUs;

    std::vector<archive::Record> pendingRecords;
    pendingRecords.reserve(chunksPerCommit + 1);
    std::vector<std::int16_t> mixedSamples;
    mixedSamples.reserve(outputBlockFrames * outputChannels);
    std::uint64_t outputStart{};
    std::uint64_t pendingGap{};
    std::uint64_t activeStart{};
    std::uint64_t activeGapBefore{};
    std::uint64_t sequence{};
    const auto flushChunk = [&]() -> core::Status {
        if (mixedSamples.empty())
            return {};
        pendingRecords.push_back(makeChunk(sessionId, outputTrackId, sequence++, activeStart,
                                           activeGapBefore, mixedSamples, targetRate));
        summary.chunkCount = sequence;
        activeGapBefore = 0;
        mixedSamples.clear();
        if (pendingRecords.size() >= chunksPerCommit) {
            if (auto status = archive.putMany(std::move(pendingRecords)); !status)
                return status;
            pendingRecords.clear();
            pendingRecords.reserve(chunksPerCommit + 1);
        }
        return {};
    };

    while (outputStart < totalFrames) {
        const auto blockFrames = static_cast<std::size_t>(
            std::min<std::uint64_t>(outputBlockFrames, totalFrames - outputStart));
        const auto outputEnd = outputStart + blockFrames;
        for (auto& source : sources) {
            const auto rate = source.reader.info().sampleRateHz;
            source.currentStart = rescaleFrames(outputStart, rate, targetRate);
            source.currentEnd = rescaleFrames(outputEnd, rate, targetRate);
            // The last output frame maps to floor((outputEnd - 1) * rate / targetRate).
            // At an upsampling block boundary that frame can be one source frame beyond
            // floor(outputEnd * rate / targetRate), so include it in the read window.
            const auto lastMappedFrame = rescaleFrames(outputEnd - 1U, rate, targetRate);
            if (lastMappedFrame == std::numeric_limits<std::uint64_t>::max()) {
                return markPartial(core::error(
                    "audio_mix_buffer_invalid", "A mix block exceeds this computer's memory range."));
            }
            source.currentEnd = std::max(source.currentEnd, lastMappedFrame + 1U);
            const auto count64 = source.currentEnd - source.currentStart;
            if (count64 >
                std::numeric_limits<std::size_t>::max() / source.reader.info().channelCount) {
                return markPartial(
                    core::error("audio_mix_buffer_invalid",
                                "A mix block exceeds this computer's memory range."));
            }
            const auto frames = static_cast<std::size_t>(count64);
            source.samples.assign(frames * source.reader.info().channelCount, 0);
            source.gaps.assign(frames, 0);
            if (source.reader.position() != source.currentStart) {
                if (auto status = source.reader.seek(source.currentStart); !status)
                    return markPartial(status.error());
            }
            if (frames > 0) {
                auto read = source.reader.readFrames(source.samples, source.gaps);
                if (!read)
                    return markPartial(read.error());
                source.framesRead = read->framesRead;
                source.samples.resize(source.framesRead * source.reader.info().channelCount);
                source.gaps.resize(source.framesRead);
            } else {
                source.framesRead = 0;
            }
        }

        for (std::size_t local = 0; local < blockFrames; ++local) {
            std::array<std::int64_t, outputChannels> sums{};
            std::uint32_t contributingTracks{};
            for (const auto& source : sources) {
                const auto rate = source.reader.info().sampleRateHz;
                const auto globalOutput = outputStart + local;
                const auto sourceFrame =
                    rescaleFrames(globalOutput, rate, targetRate) - source.currentStart;
                const auto frameIndex = static_cast<std::size_t>(sourceFrame);
                if (frameIndex >= source.framesRead || frameIndex >= source.gaps.size() ||
                    source.gaps[frameIndex] != 0)
                    continue;
                const auto channels = source.reader.info().channelCount;
                const auto offset = frameIndex * channels;
                std::int64_t left{};
                std::int64_t right{};
                if (channels == 1) {
                    left = source.samples[offset];
                    right = left;
                } else {
                    left = source.samples[offset];
                    right = source.samples[offset + 1];
                    if (channels > 2) {
                        std::int64_t extra{};
                        for (std::uint16_t channel = 2; channel < channels; ++channel)
                            extra += source.samples[offset + channel];
                        const auto averaged = extra / static_cast<std::int64_t>(channels - 2U);
                        left = (left + averaged) / 2;
                        right = (right + averaged) / 2;
                    }
                }
                sums[0] += left;
                sums[1] += right;
                ++contributingTracks;
            }

            if (contributingTracks == 0) {
                if (auto status = flushChunk(); !status)
                    return markPartial(status.error());
                ++pendingGap;
                continue;
            }

            if (mixedSamples.empty()) {
                activeStart = outputStart + local;
                activeGapBefore = pendingGap;
                pendingGap = 0;
            }
            for (const auto sum : sums) {
                const auto normalized = sum / static_cast<std::int64_t>(contributingTracks);
                mixedSamples.push_back(static_cast<std::int16_t>(
                    std::clamp<std::int64_t>(normalized, INT16_MIN, INT16_MAX)));
            }
            if (mixedSamples.size() >= outputBlockFrames * outputChannels) {
                if (auto status = flushChunk(); !status)
                    return markPartial(status.error());
            }
        }
        outputStart = outputEnd;
    }
    if (auto status = flushChunk(); !status)
        return markPartial(status.error());
    if (!pendingRecords.empty()) {
        if (auto status = archive.putMany(std::move(pendingRecords)); !status)
            return markPartial(status.error());
    }

    if (auto waveform = buildWaveform(archive, sessionId, outputTrackId); !waveform)
        return markPartial(waveform.error());

    auto finalMetadata = archive.get(archive::RecordType::AssetMetadata, outputTrackId);
    if (!finalMetadata || !*finalMetadata)
        return markPartial(finalMetadata ? core::error("audio_mix_track_lost",
                                                       "The new mix track could not be reopened.")
                                         : finalMetadata.error());
    auto finalized = std::move(**finalMetadata);
    finalized.fields["state"] = "completed";
    finalized.fields["sample_count"] = std::to_string(summary.frameCount);
    finalized.fields["timeline_sample_count"] = std::to_string(summary.frameCount);
    finalized.fields["chunk_count"] = std::to_string(summary.chunkCount);
    finalized.fields["duration_us"] = std::to_string(summary.durationUs);
    finalized.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = archive.put(std::move(finalized)); !status)
        return markPartial(status.error());
    return summary;
}

} // namespace tutorux::audio

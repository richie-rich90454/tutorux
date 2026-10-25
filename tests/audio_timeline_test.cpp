#include "tutorux/archive/archive.hpp"
#include "tutorux/application/recording-service.hpp"
#include "tutorux/audio/timeline.hpp"
#include "tutorux/audio/wav_export.hpp"
#include "tutorux/audio/wav_import.hpp"
#include "tutorux/audio/recording_take.hpp"
#include "tutorux/audio/waveform.hpp"
#include "tutorux/domain/entities.hpp"

#include <array>
#include <algorithm>
#include <bit>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <span>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

void appendAscii(std::vector<std::byte>& bytes, std::string_view value) {
    for (const char character : value)
        bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
}

template <typename Integer> void appendLittleEndian(std::vector<std::byte>& bytes, Integer value) {
    using Unsigned = std::make_unsigned_t<Integer>;
    Unsigned bits = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(Integer); ++index) {
        bytes.push_back(static_cast<std::byte>(bits & static_cast<Unsigned>(0xffU)));
        bits >>= 8U;
    }
}

bool writeWave(const std::filesystem::path& path, std::span<const std::int16_t> samples) {
    const auto dataBytes = static_cast<std::uint32_t>(samples.size() * sizeof(std::int16_t));
    std::vector<std::byte> bytes;
    bytes.reserve(44U + dataBytes);
    appendAscii(bytes, "RIFF");
    appendLittleEndian(bytes, std::uint32_t{36U + dataBytes});
    appendAscii(bytes, "WAVEfmt ");
    appendLittleEndian(bytes, std::uint32_t{16});
    appendLittleEndian(bytes, std::uint16_t{1});
    appendLittleEndian(bytes, std::uint16_t{1});
    appendLittleEndian(bytes, std::uint32_t{8'000});
    appendLittleEndian(bytes, std::uint32_t{16'000});
    appendLittleEndian(bytes, std::uint16_t{2});
    appendLittleEndian(bytes, std::uint16_t{16});
    appendAscii(bytes, "data");
    appendLittleEndian(bytes, dataBytes);
    for (const std::int16_t sample : samples)
        appendLittleEndian(bytes, sample);

    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output)
        return false;
    output.write(reinterpret_cast<const char*>(bytes.data()),
                 static_cast<std::streamsize>(bytes.size()));
    return output.good();
}

tutorux::archive::Record makeAudioChunk(const tutorux::archive::Uuid& sessionId,
                                        const tutorux::archive::Uuid& trackId,
                                        std::uint64_t sequence, std::uint64_t firstSample,
                                        std::uint64_t gapBefore,
                                        std::span<const std::int16_t> samples) {
    using namespace tutorux;
    archive::Record record;
    record.type = archive::RecordType::AudioChunk;
    record.id = archive::randomUuid();
    record.fields = {
        {"session_id",         archive::uuidToString(sessionId)},
        {"track_id",           archive::uuidToString(trackId)  },
        {"sequence_number",    std::to_string(sequence)        },
        {"first_sample_index", std::to_string(firstSample)     },
        {"sample_count",       std::to_string(samples.size())  },
        {"gap_before_samples", std::to_string(gapBefore)       },
        {"sample_rate_hz",     "8000"                          },
        {"channel_count",      "1"                             },
        {"sample_format",      "pcm_s16le"                     },
        {"codec",              "none"                          },
    };
    record.blob.reserve(samples.size() * sizeof(std::int16_t));
    for (const std::int16_t sample : samples) {
        const auto bits = std::bit_cast<std::uint16_t>(sample);
        record.blob.push_back(static_cast<std::byte>(bits & 0xffU));
        record.blob.push_back(static_cast<std::byte>(bits >> 8U));
    }
    record.fields["payload_checksum"] = std::to_string(archive::crc32(record.blob));
    return record;
}

std::int16_t readLittleEndianSample(const std::vector<char>& bytes, std::size_t offset) {
    const auto low = static_cast<std::uint8_t>(bytes[offset]);
    const auto high = static_cast<std::uint8_t>(bytes[offset + 1U]);
    const auto bits = static_cast<std::uint16_t>(static_cast<std::uint16_t>(low) |
                                                 static_cast<std::uint16_t>(high << 8U));
    return std::bit_cast<std::int16_t>(bits);
}

int fail(std::string_view message) {
    std::cerr << message << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-audio-timeline-" + std::to_string(uniqueSuffix))};
    std::error_code filesystemError;
    std::filesystem::create_directories(temporary.path, filesystemError);
    if (filesystemError)
        return fail("Unable to create the audio timeline test directory.");

    const auto archivePath = temporary.path / "audio.tux";
    const auto sourceWavePath = temporary.path / "source.wav";
    const auto silentWavePath = temporary.path / "silent.wav";
    const auto exportedWavePath = temporary.path / "exported.wav";
    auto archive = archive::Archive::create(archivePath, "Audio timeline test");
    if (!archive)
        return fail(archive.error().message);

    domain::Session session;
    session.id = archive::randomUuid();
    session.studentId = "anonymous";
    session.subject = "Audio";
    session.title = "Timeline regression";
    if (auto status = archive->put(domain::toRecord(session)); !status)
        return fail(status.error().message);

    constexpr std::array<std::int16_t, 4> firstSamples{-1'000, 500, -20, 1'000};
    if (!writeWave(sourceWavePath, firstSamples))
        return fail("Unable to create the source WAV fixture.");
    auto imported = audio::importWave(*archive, session.id, sourceWavePath);
    if (!imported || !imported->completed || imported->sampleCount != firstSamples.size())
        return fail(imported ? "The source WAV was not completely imported."
                             : imported.error().message);

    const archive::Uuid secondTakeId = archive::randomUuid();
    const archive::Uuid microphoneTrackId = archive::randomUuid();
    const archive::Uuid systemTrackId = archive::randomUuid();
    auto synchronizedTake = audio::makeRecordingTakeRecord(
        secondTakeId, session.id, "microphone+system-audio", "completed",
        {microphoneTrackId, systemTrackId}, 2);
    if (auto status = archive->put(std::move(synchronizedTake)); !status)
        return fail(status.error().message);
    for (const auto& [trackId, source] :
         std::array<std::pair<archive::Uuid, std::string_view>, 2>{
             std::pair{microphoneTrackId, "microphone"},
             std::pair{systemTrackId, "system-audio-loopback"}}) {
        archive::Record track;
        track.type = archive::RecordType::AssetMetadata;
        track.id = trackId;
        track.fields = {{"record_role", "audio-track"},
                        {"session_id", archive::uuidToString(session.id)},
                        {"track_id", archive::uuidToString(trackId)},
                        {"recording_take_id", archive::uuidToString(secondTakeId)},
                        {"source", std::string(source)}};
        if (auto status = archive->put(std::move(track)); !status)
            return fail(status.error().message);
    }
    constexpr std::array<std::int16_t, 4> synchronizedSamples{-8'000, -2'000, 4'000, 12'000};
    if (auto status = archive->put(makeAudioChunk(session.id, microphoneTrackId, 0, 0, 0,
                                                   synchronizedSamples));
        !status)
        return fail(status.error().message);
    if (auto status = archive->put(makeAudioChunk(session.id, systemTrackId, 0, 0, 0,
                                                   firstSamples));
        !status)
        return fail(status.error().message);
    auto takes = audio::listRecordingTakes(*archive, session.id);
    bool synchronizedGroupingPreserved = false;
    if (takes) {
        const auto synchronized = std::find_if(takes->begin(), takes->end(), [&](const auto& take) {
            return take.id == archive::uuidToString(secondTakeId);
        });
        synchronizedGroupingPreserved =
            synchronized != takes->end() && synchronized->trackIds.size() == 2 &&
            synchronized->trackIds[0] == archive::uuidToString(microphoneTrackId) &&
            synchronized->trackIds[1] == archive::uuidToString(systemTrackId);
    }
    if (!takes || takes->size() != 2 || !synchronizedGroupingPreserved) {
        return fail(takes ? "Two sequential takes or synchronized track grouping were not preserved."
                          : takes.error().message);
    }
    if (auto status = audio::renameRecordingTake(*archive, secondTakeId, "Synced interview");
        !status)
        return fail(status.error().message);
    if (auto status = audio::setRecordingTakeDeleted(*archive, secondTakeId, true); !status)
        return fail(status.error().message);
    auto takesAfterDelete = audio::listRecordingTakes(*archive, session.id);
    if (!takesAfterDelete || takesAfterDelete->size() != 1 ||
        takesAfterDelete->front().trackIds.size() != 1) {
        return fail(takesAfterDelete
                        ? "A take in Trash remained selectable or hid an unrelated take."
                        : takesAfterDelete.error().message);
    }
    if (auto status = audio::setRecordingTakeDeleted(*archive, secondTakeId, false); !status)
        return fail(status.error().message);
    takes = audio::listRecordingTakes(*archive, session.id);
    bool restoredTakeFound = false;
    if (takes) {
        const auto restoredTake = std::find_if(takes->begin(), takes->end(), [&](const auto& take) {
            return take.id == archive::uuidToString(secondTakeId);
        });
        restoredTakeFound = restoredTake != takes->end() &&
                            restoredTake->label == "Synced interview" &&
                            restoredTake->trackIds.size() == 2;
    }
    if (!takes || takes->size() != 2 || !restoredTakeFound) {
        return fail(takes ? "Restoring a take did not restore its name and synchronized tracks."
                          : takes.error().message);
    }

    constexpr std::array<std::int16_t, 4> secondSamples{2'000, -3'000, 50, 100};
    auto secondChunk = makeAudioChunk(session.id, imported->trackId, 1, 7, 3, secondSamples);
    const archive::Uuid secondChunkId = secondChunk.id;
    if (auto status = archive->put(secondChunk); !status)
        return fail(status.error().message);

    auto timeline = audio::AudioTimelineReader::open(*archive, session.id, imported->trackId);
    if (!timeline)
        return fail(timeline.error().message);
    if (timeline->info().storedFrameCount != 8 || timeline->info().timelineFrameCount != 11 ||
        timeline->info().chunkCount != 2) {
        return fail("The audio timeline summary does not include the expected gap and chunks.");
    }

    std::array<std::int16_t, 11> timelineSamples{};
    std::array<std::uint8_t, 11> gapFlags{};
    auto read = timeline->readFrames(timelineSamples, gapFlags);
    if (!read || read->framesRead != timelineSamples.size() || read->gapFramesRead != 3 ||
        timelineSamples[0] != firstSamples[0] || timelineSamples[3] != firstSamples[3] ||
        timelineSamples[4] != 0 || timelineSamples[6] != 0 ||
        timelineSamples[7] != secondSamples[0] || timelineSamples[10] != secondSamples[3] ||
        gapFlags[3] != 0 || gapFlags[4] != 1 || gapFlags[6] != 1 || gapFlags[7] != 0) {
        return fail("Timeline reading did not preserve samples and mark the missing interval.");
    }

    auto waveform = audio::buildWaveform(*archive, session.id, imported->trackId, 11);
    if (!waveform || waveform->buckets.size() != 11 ||
        waveform->buckets[0].minimum != firstSamples[0] ||
        waveform->buckets[3].maximum != firstSamples[3] || !waveform->buckets[4].containsGap ||
        !waveform->buckets[6].containsGap || waveform->buckets[7].maximum != secondSamples[0] ||
        waveform->buckets[8].minimum != secondSamples[1]) {
        return fail(waveform ? "Waveform buckets lost source samples or gap markers."
                             : waveform.error().message);
    }
    auto indexes = archive->list(archive::RecordType::WaveformIndex);
    if (!indexes || indexes->size() != 1)
        return fail("Waveform generation did not save its dedicated archive index.");

    auto cachedWaveform = audio::buildWaveform(*archive, session.id, imported->trackId, 11);
    if (!cachedWaveform ||
        cachedWaveform->timeline.sourceFingerprint != waveform->timeline.sourceFingerprint ||
        cachedWaveform->buckets[8].minimum != secondSamples[1]) {
        return fail(cachedWaveform ? "The saved waveform index returned different values."
                                   : cachedWaveform.error().message);
    }

    auto editedChunk = archive->get(archive::RecordType::AudioChunk, secondChunkId);
    if (!editedChunk || !*editedChunk)
        return fail(editedChunk ? "The second audio chunk was not found."
                                : editedChunk.error().message);
    constexpr std::array<std::int16_t, 4> editedSamples{2'000, -5'000, 50, 100};
    auto revisedChunk = makeAudioChunk(session.id, imported->trackId, 1, 7, 3, editedSamples);
    revisedChunk.id = secondChunkId;
    if (auto status = archive->put(std::move(revisedChunk)); !status)
        return fail(status.error().message);

    auto refreshedWaveform = audio::buildWaveform(*archive, session.id, imported->trackId, 11);
    if (!refreshedWaveform ||
        refreshedWaveform->timeline.sourceFingerprint == waveform->timeline.sourceFingerprint ||
        refreshedWaveform->buckets[8].minimum != editedSamples[1]) {
        return fail(refreshedWaveform ? "A revised audio chunk did not invalidate the waveform."
                                      : refreshedWaveform.error().message);
    }

    auto rejectedGapExport =
        audio::exportWave(*archive, session.id, exportedWavePath, imported->trackId, false, false);
    if (rejectedGapExport ||
        rejectedGapExport.error().code != "audio_export_gaps_require_confirmation") {
        return fail("WAV export did not require explicit confirmation for timeline gaps.");
    }
    auto exported =
        audio::exportWave(*archive, session.id, exportedWavePath, imported->trackId, true, false);
    if (!exported || !exported->insertedSilenceForGaps || exported->sampleCount != 11 ||
        exported->dataBytes != 22) {
        return fail(exported ? "WAV export returned unexpected timeline metadata."
                             : exported.error().message);
    }

    std::ifstream exportedFile(exportedWavePath, std::ios::binary);
    if (!exportedFile)
        return fail("Unable to open the exported WAV file.");
    std::vector<char> exportedBytes((std::istreambuf_iterator<char>(exportedFile)),
                                    std::istreambuf_iterator<char>());
    if (exportedBytes.size() != 66 || std::string_view(exportedBytes.data(), 4) != "RIFF" ||
        std::string_view(exportedBytes.data() + 8, 4) != "WAVE" ||
        readLittleEndianSample(exportedBytes, 44) != firstSamples[0] ||
        readLittleEndianSample(exportedBytes, 50) != firstSamples[3] ||
        readLittleEndianSample(exportedBytes, 52) != 0 ||
        readLittleEndianSample(exportedBytes, 56) != 0 ||
        readLittleEndianSample(exportedBytes, 58) != editedSamples[0] ||
        readLittleEndianSample(exportedBytes, 60) != editedSamples[1]) {
        return fail("WAV export did not preserve PCM samples and insert timeline silence.");
    }

    constexpr std::array<std::int16_t, 8> silentSamples{};
    if (!writeWave(silentWavePath, silentSamples))
        return fail("Unable to write the deterministic silent WAV fixture.");
    auto silentImport = audio::importWave(*archive, session.id, silentWavePath, true);
    if (!silentImport || !silentImport->completed)
        return fail(silentImport ? "The silent WAV fixture was not fully imported."
                                 : silentImport.error().message);
    if (auto status = archive->compact(); !status)
        return fail(status.error().message);
    auto verification = archive->verify(true);
    if (!verification || !verification->valid)
        return fail("Archive verification failed after waveform-index compaction.");

    // Release the writer lock so the same read-only service path used by the
    // desktop can reopen the archive from disk.
    archive = std::unexpected(core::error("test_archive_closed", "Test archive closed."));
    const auto silentOverview = application::RecordingService{}.snapshot(
        archivePath, {}, archive::uuidToString(session.id),
        archive::uuidToString(silentImport->takeId),
        archive::uuidToString(silentImport->trackId), 8);
    if (silentOverview.waveformState != "silent" || silentOverview.buckets.size() != 8 ||
        std::any_of(silentOverview.buckets.begin(), silentOverview.buckets.end(),
                    [](const auto& bucket) { return bucket.minimum != 0 || bucket.maximum != 0; })) {
        return fail("A persisted silent take did not return explicit silent waveform data: " +
                    silentOverview.waveformState + " · " + silentOverview.errorMessage + " · " +
                    std::to_string(silentOverview.buckets.size()) + " buckets.");
    }
    return 0;
}

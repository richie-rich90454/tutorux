#include "tutorux/application/recording-service.hpp"

#include "tutorux/archive/archive.hpp"
#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <charconv>
#include <iomanip>
#include <sstream>

namespace tutorux::application {
namespace {

    std::string friendlySource(std::string_view source) {
        if (source == "microphone")
            return "Microphone";
        if (source == "system-audio" || source == "system-audio-loopback")
            return "System audio";
        if (source == "application-audio")
            return "Application audio";
        if (source.starts_with("microphone+"))
            return "Microphone + " + friendlySource(source.substr(std::string_view("microphone+").size()));
        if (source == "imported-file")
            return "Imported audio";
        if (source == "legacy")
            return "Earlier audio";
        return source.empty() ? "Audio" : std::string(source);
    }

    std::string durationLabel(std::uint64_t durationUs) {
        const std::uint64_t total = durationUs / 1'000'000ULL;
        std::ostringstream output;
        output << std::setfill('0') << std::setw(2) << total / 3600 << ':'
               << std::setw(2) << (total / 60) % 60 << ':' << std::setw(2) << total % 60;
        return output.str();
    }

    bool parseUuid(std::string_view text, archive::Uuid& id) {
        auto parsed = archive::uuidFromString(text);
        if (!parsed)
            return false;
        id = *parsed;
        return true;
    }

} // namespace

RecordingOverview RecordingService::snapshot(const std::filesystem::path& archivePath,
                                              std::string_view passphrase,
                                              std::string_view sessionId,
                                              std::string_view selectedTakeId,
                                              std::string_view selectedTrackId,
                                              std::size_t maximumBuckets) const {
    RecordingOverview overview;
    archive::Uuid sessionUuid{};
    if (!parseUuid(sessionId, sessionUuid)) {
        overview.waveformState = "unavailable";
        overview.errorMessage = "Select a session to load its recordings.";
        return overview;
    }
    auto opened = archive::Archive::open(archivePath, true, passphrase);
    if (!opened) {
        overview.waveformState = "error";
        overview.errorMessage = opened.error().message;
        return overview;
    }
    auto takes = audio::listRecordingTakes(*opened, sessionUuid);
    if (!takes) {
        overview.waveformState = "error";
        overview.errorMessage = takes.error().message;
        return overview;
    }

    for (const auto& take : *takes) {
        RecordingTakeChoice choice;
        choice.id = take.id;
        choice.source = take.source;
        choice.state = take.state;
        choice.durationUs = take.durationUs;
        choice.legacy = take.legacy;
        const std::string source = friendlySource(take.source);
        choice.label = take.label + " · " + source;
        if (take.durationUs != 0)
            choice.label += " · " + durationLabel(take.durationUs);
        for (std::size_t index = 0; index < take.trackIds.size(); ++index) {
            const auto& trackId = take.trackIds[index];
            std::string trackSource;
            archive::Uuid parsedTrack{};
            if (parseUuid(trackId, parsedTrack)) {
                auto metadata = opened->get(archive::RecordType::AssetMetadata, parsedTrack);
                if (metadata && *metadata && !domain::isDeleted(**metadata))
                    trackSource = domain::getField(**metadata, "source");
            }
            std::string label = friendlySource(trackSource);
            if (label == "Audio")
                label = source == "Earlier audio" || source == "Imported audio" ? source : "Track";
            if (take.trackIds.size() > 1)
                label += " " + std::to_string(index + 1);
            choice.tracks.push_back({trackId, std::move(label)});
        }
        overview.takes.push_back(std::move(choice));
    }
    if (overview.takes.empty()) {
        overview.waveformState = "empty";
        return overview;
    }

    auto take = std::find_if(overview.takes.begin(), overview.takes.end(), [&](const auto& value) {
        return value.id == selectedTakeId;
    });
    if (take == overview.takes.end())
        take = std::prev(overview.takes.end());
    overview.selectedTakeId = take->id;
    if (take->tracks.empty()) {
        overview.waveformState = take->state == "recording" || take->state == "initializing"
                                     ? "recording"
                                     : "empty";
        return overview;
    }
    auto track = std::find_if(take->tracks.begin(), take->tracks.end(), [&](const auto& value) {
        return value.id == selectedTrackId;
    });
    if (track == take->tracks.end())
        track = take->tracks.begin();
    overview.selectedTrackId = track->id;

    archive::Uuid trackUuid{};
    if (!parseUuid(track->id, trackUuid)) {
        overview.waveformState = "unavailable";
        overview.errorMessage = "This recording uses a legacy track identifier that cannot be loaded.";
        return overview;
    }
    auto waveform = audio::buildWaveform(*opened, sessionUuid, trackUuid, maximumBuckets);
    if (!waveform) {
        overview.waveformState = waveform.error().code == "audio_timeline_empty" ? "empty" : "error";
        overview.errorMessage = waveform.error().message;
        return overview;
    }
    overview.sampleRateHz = waveform->timeline.sampleRateHz;
    overview.durationUs = waveform->timeline.durationUs;
    overview.timelineFrameCount = waveform->timeline.timelineFrameCount;
    overview.buckets = std::move(waveform->buckets);
    if (overview.buckets.empty()) {
        overview.waveformState = "empty";
    } else {
        const bool silent = std::all_of(overview.buckets.begin(), overview.buckets.end(),
                                        [](const auto& bucket) {
                                            return !bucket.containsGap && bucket.minimum == 0 &&
                                                   bucket.maximum == 0;
                                        });
        overview.waveformState = silent ? "silent" : "ready";
    }
    return overview;
}

core::Status RecordingService::mutateTake(
    const std::filesystem::path& archivePath, std::string_view passphrase,
    const RecordingTakeMutationRequest& request) const {
    archive::Uuid sessionId{};
    archive::Uuid takeId{};
    if (!parseUuid(request.sessionId, sessionId) || !parseUuid(request.takeId, takeId)) {
        return std::unexpected(core::error("recording_take_id_invalid",
                                           "Select a valid session and saved recording take."));
    }
    auto opened = archive::Archive::open(archivePath, true, passphrase);
    if (!opened)
        return std::unexpected(opened.error());
    auto session = opened->get(archive::RecordType::Session, sessionId);
    if (!session)
        return std::unexpected(session.error());
    if (!*session || domain::isDeleted(**session)) {
        return std::unexpected(core::error("session_not_found",
                                           "The selected session is not available in this archive."));
    }
    auto take = opened->get(archive::RecordType::AssetMetadata, takeId);
    if (!take)
        return std::unexpected(take.error());
    if (!*take || domain::getField(**take, "record_role") != "recording-take" ||
        domain::getField(**take, "session_id") != request.sessionId) {
        return std::unexpected(core::error("recording_take_not_found",
                                           "The selected take does not belong to this session."));
    }
    switch (request.mutation) {
    case RecordingTakeMutation::rename:
        return audio::renameRecordingTake(*opened, takeId, request.label);
    case RecordingTakeMutation::moveToTrash:
        return audio::setRecordingTakeDeleted(*opened, takeId, true);
    case RecordingTakeMutation::restore:
        return audio::setRecordingTakeDeleted(*opened, takeId, false);
    }
    return std::unexpected(core::error("recording_take_mutation_invalid",
                                       "The requested take change is not supported."));
}

} // namespace tutorux::application

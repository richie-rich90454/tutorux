#include "tutorux/audio/capture.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <condition_variable>
#include <exception>
#include <limits>
#include <mutex>
#include <thread>

namespace tutorux::audio {
namespace {

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    std::uint64_t addSaturated(std::uint64_t left, std::uint64_t right) noexcept {
        return right > std::numeric_limits<std::uint64_t>::max() - left ? std::numeric_limits<std::uint64_t>::max() : left + right;
    }

    std::string sourceName(DeviceKind source) {
        return source == DeviceKind::microphone ? "microphone" : source == DeviceKind::application ? "application-audio" : "system-audio";
    }

    class SynchronizedStartGate final {
      public:
        explicit SynchronizedStartGate(std::size_t participants)
            : participants_(participants) {}

        bool arriveAndWait() {
            std::unique_lock lock(mutex_);
            ++arrived_;
            condition_.notify_all();
            condition_.wait(lock, [&] {
                return cancelled_ || peerFailed_ || arrived_ == participants_;
            });
            return !cancelled_;
        }

        void cancel() {
            std::lock_guard lock(mutex_);
            cancelled_ = true;
            condition_.notify_all();
        }

        void releaseForSurvivingPeer() {
            std::lock_guard lock(mutex_);
            peerFailed_ = true;
            condition_.notify_all();
        }

      private:
        std::mutex mutex_;
        std::condition_variable condition_;
        const std::size_t participants_;
        std::size_t arrived_{};
        bool cancelled_{};
        bool peerFailed_{};
    };

    archive::Record makeTrackRecord(const archive::Uuid& sessionId, const archive::Uuid& trackId, DeviceKind source, std::string state,
                                    std::string message = {}) {
        archive::Record record;
        record.type = archive::RecordType::AssetMetadata;
        record.id = trackId;
        record.fields = {
            {"record_role",   "audio-track"                        },
            {"session_id",    archive::uuidToString(sessionId)     },
            {"track_id",      archive::uuidToString(trackId)       },
            {"source",        sourceName(source)                   },
            {"state",         std::move(state)                     },
            {"message",       std::move(message)                   },
            {"updated_at_us", std::to_string(nowUnixMicroseconds())}
        };
        return record;
    }

    core::Status updateTrackRecord(archive::Archive& archive, const archive::Uuid& sessionId, const archive::Uuid& trackId,
                                   DeviceKind source, std::string state, std::string message, const CaptureSummary* summary = nullptr) {
        auto stored = archive.get(archive::RecordType::AssetMetadata, trackId);
        if (!stored)
            return std::unexpected(stored.error());
        archive::Record record = *stored && domain::getField(**stored, "record_role") == "audio-track"
                                     ? std::move(**stored)
                                     : makeTrackRecord(sessionId, trackId, source, state, message);
        record.fields["record_role"] = "audio-track";
        record.fields["session_id"] = archive::uuidToString(sessionId);
        record.fields["track_id"] = archive::uuidToString(trackId);
        record.fields["source"] = sourceName(source);
        record.fields["state"] = std::move(state);
        record.fields["message"] = std::move(message);
        record.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        if (summary) {
            record.fields["device_id"] = summary->deviceId;
            record.fields["sample_rate_hz"] = std::to_string(summary->sampleRateHz);
            record.fields["sample_format"] = summary->sampleFormat;
            record.fields["channel_count"] = std::to_string(summary->channelCount);
            record.fields["channel_mask"] = std::to_string(summary->channelMask);
            record.fields["sample_count"] = std::to_string(summary->sampleCount);
            record.fields["timeline_sample_count"] = std::to_string(summary->timelineSampleCount);
            record.fields["chunk_count"] = std::to_string(summary->chunkCount);
            record.fields["duration_us"] = std::to_string(summary->durationUs);
            record.fields["byte_count"] = std::to_string(summary->byteCount);
        }
        return archive.put(std::move(record));
    }

} // namespace

core::Result<MultiTrackCaptureSummary> captureNativeTracks(archive::Archive& archive, const archive::Uuid& sessionId,
                                                           CaptureOptions microphone, CaptureOptions systemAudio) {
    if (microphone.source != DeviceKind::microphone ||
        (systemAudio.source != DeviceKind::playback && systemAudio.source != DeviceKind::application)) {
        return std::unexpected(core::error("audio_track_sources_invalid",
                                           "Synchronized capture requires a microphone and one system-audio or application-audio track."));
    }
    if (microphone.maximumDuration != systemAudio.maximumDuration) {
        return std::unexpected(
            core::error("audio_track_duration_mismatch", "Synchronized tracks must use the same maximum recording duration."));
    }

    auto storedSession = archive.get(archive::RecordType::Session, sessionId);
    if (!storedSession)
        return std::unexpected(storedSession.error());
    if (!*storedSession || domain::isDeleted(**storedSession)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    }
    archive::Record session = std::move(**storedSession);
    const std::string oldState = domain::getField(session, "recording_state");
    if (oldState == "initializing" || oldState == "recording" || oldState == "paused" || oldState == "finalizing" ||
        oldState == "multi-track-initializing") {
        return std::unexpected(core::error("audio_capture_session_busy", "Session already has an active recording."));
    }

    std::array<archive::Uuid, 2> trackIds{archive::randomUuid(), archive::randomUuid()};
    const std::string microphoneId = archive::uuidToString(trackIds[0]);
    const std::string systemAudioId = archive::uuidToString(trackIds[1]);
    session.fields["recording_track_id"] = microphoneId;
    session.fields["recording_track_ids"] = microphoneId + "," + systemAudioId;
    session.fields["recording_track_count"] = "2";
    session.fields["recording_track_mode"] = "synchronized-separate";
    const std::string combinedSource = "microphone+" + sourceName(systemAudio.source);
    session.fields["recording_source"] = combinedSource;
    session.fields["recording_state"] = "multi-track-initializing";
    session.fields["recording_started_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_error"] = "";
    std::vector<archive::Record> initialRecords;
    initialRecords.reserve(3);
    initialRecords.push_back(std::move(session));
    auto microphoneTrack = makeTrackRecord(sessionId, trackIds[0], DeviceKind::microphone, "initializing");
    microphoneTrack.fields["device_id"] = microphone.deviceId;
    microphoneTrack.fields["consent_confirmed_by"] = microphone.consentConfirmedBy;
    microphoneTrack.fields["durability"] = microphone.durability == DurabilityPolicy::maximum        ? "maximum"
                                           : microphone.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                     : "default";
    microphoneTrack.fields["consent"] = "explicit";
    microphoneTrack.fields["consent_policy_version"] = "1";
    auto systemAudioTrack = makeTrackRecord(sessionId, trackIds[1], systemAudio.source, "initializing");
    systemAudioTrack.fields["device_id"] = systemAudio.deviceId;
    systemAudioTrack.fields["consent_confirmed_by"] = systemAudio.consentConfirmedBy;
    systemAudioTrack.fields["durability"] = systemAudio.durability == DurabilityPolicy::maximum        ? "maximum"
                                            : systemAudio.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                       : "default";
    systemAudioTrack.fields["consent"] = "explicit";
    systemAudioTrack.fields["consent_policy_version"] = "1";
    initialRecords.push_back(std::move(microphoneTrack));
    initialRecords.push_back(std::move(systemAudioTrack));
    if (auto status = archive.putMany(std::move(initialRecords)); !status)
        return std::unexpected(status.error());

    SynchronizedStartGate startGate(2);
    std::mutex callbackMutex;
    std::mutex trackStateMutex;
    std::mutex persistenceMutex;
    std::optional<core::Error> persistenceFailure;
    MultiTrackCaptureSummary combined;
    combined.tracks.resize(2);
    combined.tracks[0].source = DeviceKind::microphone;
    combined.tracks[1].source = systemAudio.source;
    std::array<std::optional<CaptureSummary>, 2> latestSummaries;
    std::array<std::string, 2> trackStates{"initializing", "initializing"};

    const auto configureCallbacks = [&](CaptureOptions& options, std::size_t index, archive::Uuid trackId) {
        auto previousStateChanged = std::move(options.stateChanged);
        options.trackId = trackId;
        options.waitForSynchronizedStart = [&startGate] {
            return startGate.arriveAndWait();
        };
        options.stateChanged = [&, index, trackId, callback = std::move(previousStateChanged)](std::string state,
                                                                                               std::string message) mutable {
            if (state == "failed")
                startGate.releaseForSurvivingPeer();
            std::string combinedState;
            std::string combinedMessage;
            {
                std::lock_guard lock(trackStateMutex);
                trackStates[index] = state;
                const bool hasActiveTrack = std::any_of(trackStates.begin(), trackStates.end(), [](const std::string& value) {
                    return value == "initializing" || value == "recording" || value == "paused" || value == "finalizing";
                });
                if (hasActiveTrack) {
                    combinedState = std::any_of(trackStates.begin(), trackStates.end(),
                                                [](const std::string& value) {
                                                    return value == "recording" || value == "finalizing";
                                                })
                                        ? "recording"
                                    : std::any_of(trackStates.begin(), trackStates.end(),
                                                  [](const std::string& value) {
                                                      return value == "paused";
                                                  })
                                        ? "paused"
                                        : "initializing";
                } else {
                    combinedState = std::all_of(trackStates.begin(), trackStates.end(),
                                                [](const std::string& value) {
                                                    return value == "completed";
                                                })
                                        ? "completed"
                                    : std::any_of(trackStates.begin(), trackStates.end(),
                                                  [](const std::string& value) {
                                                      return value == "interrupted" || value == "completed";
                                                  })
                                        ? "interrupted"
                                        : "failed";
                }
                combinedMessage = "Microphone: " + trackStates[0] + "; system audio: " + trackStates[1] + ".";
                if (!message.empty())
                    combinedMessage += " " + message;
            }
            if (auto status = updateTrackRecord(archive, sessionId, trackId, combined.tracks[index].source, state, message); !status) {
                std::lock_guard lock(persistenceMutex);
                if (!persistenceFailure)
                    persistenceFailure = status.error();
            }
            if (callback) {
                std::lock_guard lock(callbackMutex);
                callback(std::move(combinedState), std::move(combinedMessage));
            }
        };

        auto previousProgress = std::move(options.progress);
        options.progress = [&, index, trackId, callback = std::move(previousProgress)](const CaptureSummary& summary) mutable {
            latestSummaries[index] = summary;
            if (auto status = updateTrackRecord(archive, sessionId, trackId, combined.tracks[index].source, "recording", {}, &summary);
                !status) {
                std::lock_guard lock(persistenceMutex);
                if (!persistenceFailure)
                    persistenceFailure = status.error();
            }
            if (callback) {
                std::lock_guard lock(callbackMutex);
                callback(summary);
            }
        };
    };
    configureCallbacks(microphone, 0, trackIds[0]);
    configureCallbacks(systemAudio, 1, trackIds[1]);

    std::array<CaptureOptions, 2> options{std::move(microphone), std::move(systemAudio)};
    std::array<std::thread, 2> workers;
    try {
        for (std::size_t index = 0; index < workers.size(); ++index) {
            workers[index] = std::thread([&, index, trackId = trackIds[index], trackOptions = std::move(options[index])]() mutable {
                try {
                    auto captured = captureNative(archive, sessionId, std::move(trackOptions));
                    if (captured) {
                        combined.tracks[index].summary = std::move(*captured);
                    } else {
                        combined.tracks[index].failure = captured.error();
                        if (latestSummaries[index]) {
                            latestSummaries[index]->completed = false;
                            latestSummaries[index]->state = "interrupted";
                            combined.tracks[index].summary = latestSummaries[index];
                        }
                        startGate.releaseForSurvivingPeer();
                    }
                } catch (const std::exception& exception) {
                    combined.tracks[index].failure =
                        core::error("audio_capture_unhandled_exception", "Capture worker failed: " + std::string(exception.what()));
                    startGate.releaseForSurvivingPeer();
                } catch (...) {
                    combined.tracks[index].failure =
                        core::error("audio_capture_unhandled_exception", "Capture worker failed with an unknown exception.");
                    startGate.releaseForSurvivingPeer();
                }

                const auto& outcome = combined.tracks[index];
                const std::string state = outcome.summary && outcome.summary->completed ? "completed"
                                          : outcome.summary                             ? "interrupted"
                                                                                        : "failed";
                const std::string message = outcome.failure ? outcome.failure->message : "";
                if (auto status = updateTrackRecord(archive, sessionId, trackId, outcome.source, state, message,
                                                    outcome.summary ? &*outcome.summary : nullptr);
                    !status) {
                    std::lock_guard lock(persistenceMutex);
                    if (!persistenceFailure)
                        persistenceFailure = status.error();
                }
            });
        }
    } catch (const std::exception& exception) {
        startGate.cancel();
        for (auto& worker : workers) {
            if (worker.joinable())
                worker.join();
        }
        return std::unexpected(core::error("audio_capture_worker_start_failed",
                                           "Unable to start synchronized capture workers: " + std::string(exception.what())));
    }
    for (auto& worker : workers) {
        if (worker.joinable())
            worker.join();
    }

    std::string failureSummary;
    combined.completed = true;
    for (const auto& track : combined.tracks) {
        if (track.summary) {
            combined.durationUs = std::max(combined.durationUs, track.summary->durationUs);
            combined.chunkCount = addSaturated(combined.chunkCount, track.summary->chunkCount);
            combined.sampleCount = addSaturated(combined.sampleCount, track.summary->sampleCount);
            combined.byteCount = addSaturated(combined.byteCount, track.summary->byteCount);
            combined.completed = combined.completed && track.summary->completed;
        } else {
            combined.completed = false;
        }
        if (track.failure) {
            if (!failureSummary.empty())
                failureSummary.push_back('\n');
            failureSummary += sourceName(track.source) + ": " + track.failure->message;
        }
    }

    auto latestSession = archive.get(archive::RecordType::Session, sessionId);
    if (!latestSession)
        return std::unexpected(latestSession.error());
    if (!*latestSession) {
        return std::unexpected(core::error("session_not_found", "Session disappeared during audio capture."));
    }
    archive::Record finalSession = std::move(**latestSession);
    finalSession.fields["recording_track_id"] = microphoneId;
    finalSession.fields["recording_track_ids"] = microphoneId + "," + systemAudioId;
    finalSession.fields["recording_track_count"] = "2";
    finalSession.fields["recording_track_mode"] = "synchronized-separate";
    finalSession.fields["recording_source"] = combinedSource;
    finalSession.fields["recording_audio_chunks"] = std::to_string(combined.chunkCount);
    finalSession.fields["recording_samples"] = std::to_string(combined.sampleCount);
    finalSession.fields["recording_bytes"] = std::to_string(combined.byteCount);
    finalSession.fields["recording_duration_us"] = std::to_string(combined.durationUs);
    finalSession.fields["recording_state"] = combined.completed ? "completed" : combined.chunkCount > 0 ? "partial" : "failed";
    finalSession.fields["recording_error"] = std::move(failureSummary);
    finalSession.fields["recording_stopped_at_us"] = std::to_string(nowUnixMicroseconds());
    finalSession.fields["updated_at_us"] = finalSession.fields["recording_stopped_at_us"];
    if (auto status = archive.put(std::move(finalSession)); !status)
        return std::unexpected(status.error());
    if (persistenceFailure)
        return std::unexpected(*persistenceFailure);
    return combined;
}

} // namespace tutorux::audio

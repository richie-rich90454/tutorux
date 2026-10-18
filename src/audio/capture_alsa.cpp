#include "tutorux/audio/alsa_backend.hpp"

#include "tutorux/domain/entities.hpp"

#if defined(TUTORUX_HAS_ALSA)
#include <alsa/asoundlib.h>

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstddef>
#include <cstdlib>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#endif

namespace tutorux::audio {

#if defined(TUTORUX_HAS_ALSA)
namespace {

    constexpr std::uint32_t kPreferredSampleRateHz = 48'000;
    constexpr std::uint16_t kMaximumChannels = 8;

    core::Error alsaError(std::string code, std::string_view operation, int errorCode) {
        return core::error(std::move(code),
                           std::string(operation) + ": " + snd_strerror(errorCode));
    }

    std::uint64_t samplesToMicroseconds(std::uint64_t samples, std::uint32_t sampleRateHz) {
        const std::uint64_t seconds = samples / sampleRateHz;
        const std::uint64_t remainder = samples % sampleRateHz;
        return seconds * 1'000'000ULL + (remainder * 1'000'000ULL) / sampleRateHz;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
    }

    core::Status updateRecordingSession(archive::Archive& archive,
                                        archive::Record& session,
                                        std::string state,
                                        std::uint64_t chunks,
                                        std::uint64_t samples,
                                        std::uint64_t bytes,
                                        std::string error = {}) {
        session.fields["recording_state"] = std::move(state);
        session.fields["recording_audio_chunks"] = std::to_string(chunks);
        session.fields["recording_samples"] = std::to_string(samples);
        session.fields["recording_bytes"] = std::to_string(bytes);
        session.fields["recording_error"] = std::move(error);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        return archive.put(session);
    }

    class PcmHandle final {
      public:
        PcmHandle() = default;
        PcmHandle(const PcmHandle&) = delete;
        PcmHandle& operator=(const PcmHandle&) = delete;
        ~PcmHandle() {
            if (value_)
                snd_pcm_close(value_);
        }

        snd_pcm_t** put() {
            if (value_) {
                snd_pcm_close(value_);
                value_ = nullptr;
            }
            return &value_;
        }

        snd_pcm_t* get() const {
            return value_;
        }

      private:
        snd_pcm_t* value_{};
    };

    struct ConfiguredCapture final {
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
        snd_pcm_uframes_t periodFrames{};
    };

    core::Result<ConfiguredCapture> configureCapture(snd_pcm_t* pcm) {
        snd_pcm_hw_params_t* parameters = nullptr;
        int result = snd_pcm_hw_params_malloc(&parameters);
        if (result < 0)
            return std::unexpected(alsaError("audio_parameters_allocate_failed",
                                             "Allocating ALSA hardware parameters",
                                             result));

        const auto releaseParameters = [&] {
            snd_pcm_hw_params_free(parameters);
        };
        result = snd_pcm_hw_params_any(pcm, parameters);
        if (result >= 0)
            result = snd_pcm_hw_params_set_access(pcm, parameters, SND_PCM_ACCESS_RW_INTERLEAVED);
        if (result >= 0)
            result = snd_pcm_hw_params_set_format(pcm, parameters, SND_PCM_FORMAT_S16_LE);

        unsigned int channels = 1;
        int channelDirection = 0;
        if (result >= 0)
            result = snd_pcm_hw_params_set_channels_near(pcm, parameters, &channels);
        if (result >= 0 && (channels == 0 || channels > kMaximumChannels))
            result = -EINVAL;

        unsigned int sampleRate = kPreferredSampleRateHz;
        int rateDirection = 0;
        if (result >= 0)
            result = snd_pcm_hw_params_set_rate_near(pcm, parameters, &sampleRate, &rateDirection);
        if (result >= 0 && (sampleRate < 8'000 || sampleRate > 384'000))
            result = -EINVAL;

        snd_pcm_uframes_t periodFrames = std::max<snd_pcm_uframes_t>(sampleRate / 20, 1);
        int periodDirection = 0;
        if (result >= 0)
            result = snd_pcm_hw_params_set_period_size_near(pcm,
                                                            parameters,
                                                            &periodFrames,
                                                            &periodDirection);
        if (result >= 0)
            result = snd_pcm_hw_params(pcm, parameters);
        releaseParameters();
        if (result < 0) {
            return std::unexpected(alsaError("audio_format_unsupported",
                                             "Configuring a 16-bit interleaved ALSA capture stream",
                                             result));
        }

        snd_pcm_hw_params_t* activeParameters = nullptr;
        result = snd_pcm_hw_params_malloc(&activeParameters);
        if (result < 0)
            return std::unexpected(alsaError("audio_parameters_allocate_failed",
                                             "Allocating active ALSA parameters",
                                             result));
        result = snd_pcm_hw_params_current(pcm, activeParameters);
        if (result >= 0)
            result = snd_pcm_hw_params_get_period_size(activeParameters,
                                                       &periodFrames,
                                                       &periodDirection);
        snd_pcm_hw_params_free(activeParameters);
        if (result < 0)
            return std::unexpected(alsaError("audio_format_query_failed",
                                             "Reading the active ALSA period size",
                                             result));

        return ConfiguredCapture{static_cast<std::uint32_t>(sampleRate),
                                 static_cast<std::uint16_t>(channels),
                                 periodFrames};
    }

    core::Status appendCapturedChunk(archive::Archive& archive,
                                     archive::Record& session,
                                     const archive::Uuid& sessionId,
                                     const archive::Uuid& trackId,
                                     std::uint64_t sequence,
                                     std::uint64_t firstSample,
                                     std::uint64_t frameCount,
                                     std::uint64_t totalStoredSamples,
                                     std::uint64_t totalStoredBytes,
                                     std::uint64_t gapBeforeSamples,
                                     std::uint32_t sampleRateHz,
                                     std::uint16_t channelCount,
                                     bool containsDiscontinuity,
                                     archive::Bytes payload) {
        archive::Record chunk;
        chunk.type = archive::RecordType::AudioChunk;
        chunk.id = archive::randomUuid();
        chunk.fields = {
            {"session_id", archive::uuidToString(sessionId)},
            {"track_id", archive::uuidToString(trackId)},
            {"sequence_number", std::to_string(sequence)},
            {"first_sample_index", std::to_string(firstSample)},
            {"sample_count", std::to_string(frameCount)},
            {"gap_before_samples", std::to_string(gapBeforeSamples)},
            {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSample, sampleRateHz))},
            {"timeline_end_us",
             std::to_string(samplesToMicroseconds(firstSample + frameCount, sampleRateHz))},
            {"sample_format", "pcm_s16le"},
            {"sample_rate_hz", std::to_string(sampleRateHz)},
            {"channel_count", std::to_string(channelCount)},
            {"channel_mask", "0"},
            {"codec", "none"},
            {"source", domain::getField(session, "recording_source")},
            {"contains_device_discontinuity", containsDiscontinuity ? "true" : "false"},
            {"payload_checksum", std::to_string(archive::crc32(payload))}
        };
        chunk.blob = std::move(payload);

        if (chunk.blob.size() > std::numeric_limits<std::uint64_t>::max() - totalStoredBytes ||
            firstSample > std::numeric_limits<std::uint64_t>::max() - frameCount ||
            totalStoredSamples > std::numeric_limits<std::uint64_t>::max() - frameCount) {
            return std::unexpected(
                core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
        }
        session.fields["recording_audio_chunks"] = std::to_string(sequence + 1);
        session.fields["recording_samples"] = std::to_string(totalStoredSamples + frameCount);
        session.fields["recording_timeline_samples"] = std::to_string(firstSample + frameCount);
        session.fields["recording_bytes"] = std::to_string(totalStoredBytes + chunk.blob.size());
        session.fields["recording_state"] = "recording";
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        std::vector<archive::Record> transaction;
        transaction.reserve(2);
        transaction.push_back(std::move(chunk));
        transaction.push_back(session);
        return archive.putMany(std::move(transaction));
    }

} // namespace

core::Result<CaptureDeviceProbe> probeAlsaCaptureDevice(std::string deviceId) {
    if (deviceId.empty())
        deviceId = "default";
    PcmHandle pcm;
    const int openResult = snd_pcm_open(pcm.put(), deviceId.c_str(), SND_PCM_STREAM_CAPTURE, 0);
    if (openResult < 0) {
        return std::unexpected(alsaError("audio_device_open_failed",
                                         "Opening ALSA capture device '" + deviceId + "'",
                                         openResult));
    }
    auto configuration = configureCapture(pcm.get());
    if (!configuration)
        return std::unexpected(configuration.error());
    return CaptureDeviceProbe{std::move(deviceId),
                              "pcm_s16le",
                              configuration->sampleRateHz,
                              configuration->channelCount};
}

core::Result<CaptureSummary>
captureAlsa(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
    if (options.source == DeviceKind::playback && options.deviceId.empty()) {
        return std::unexpected(
            core::error("audio_monitor_required",
                        "Select an ALSA monitor PCM explicitly for system-audio capture."));
    }
    if (options.maximumDuration && options.maximumDuration->count() <= 0) {
        return std::unexpected(core::error("audio_capture_duration_invalid",
                                           "Maximum capture duration must be positive."));
    }

    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(
            core::error("session_not_found", "Session was not found in the archive."));
    }
    archive::Record session = std::move(**sessionResult);
    const std::string existingState = domain::getField(session, "recording_state");
    if (existingState == "initializing" || existingState == "recording" ||
        existingState == "paused" || existingState == "finalizing") {
        return std::unexpected(
            core::error("audio_capture_session_busy", "Session already has an active recording."));
    }
    bool hasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId,
                                                options.trackId,
                                                [&](archive::Record&&) {
                                                    hasAudio = true;
                                                    return false;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (hasAudio) {
        return std::unexpected(core::error(
            "audio_capture_audio_exists",
            "Session already contains audio. Create a new session or explicitly merge audio."));
    }

    std::string deviceId = options.deviceId.empty() ? "default" : options.deviceId;
    PcmHandle pcm;
    int result = snd_pcm_open(pcm.put(), deviceId.c_str(), SND_PCM_STREAM_CAPTURE, 0);
    if (result < 0) {
        return std::unexpected(alsaError("audio_device_open_failed",
                                         "Opening ALSA capture device '" + deviceId + "'",
                                         result));
    }
    auto configuration = configureCapture(pcm.get());
    if (!configuration)
        return std::unexpected(configuration.error());

    CaptureSummary summary;
    summary.trackId = options.trackId.value_or(archive::randomUuid());
    summary.deviceId = deviceId;
    summary.sampleFormat = "pcm_s16le";
    summary.sampleRateHz = configuration->sampleRateHz;
    summary.channelCount = configuration->channelCount;
    summary.channelMask = 0;
    session.fields["recording_track_id"] = archive::uuidToString(summary.trackId);
    const std::string sourceName =
        options.source == DeviceKind::microphone ? "microphone" : "system-audio-loopback";
    session.fields["recording_source"] = sourceName;
    session.fields["recording_durability"] =
        options.durability == DurabilityPolicy::maximum        ? "maximum"
        : options.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                               : "default";
    session.fields["recording_device_id"] = deviceId;
    session.fields["recording_consent"] = "explicit";
    session.fields["recording_consent_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
    session.fields["recording_consent_sources"] = sourceName;
    session.fields["recording_consent_policy_version"] = "1";
    session.fields["recording_sample_format"] = "pcm_s16le";
    session.fields["recording_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
    session.fields["recording_channel_count"] = std::to_string(summary.channelCount);
    session.fields["recording_channel_mask"] = "0";
    session.fields["recording_started_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_audio_chunks"] = "0";
    session.fields["recording_samples"] = "0";
    session.fields["recording_timeline_samples"] = "0";
    session.fields["recording_bytes"] = "0";
    session.fields["recording_discontinuities"] = "0";
    if (auto status = updateRecordingSession(archive, session, "initializing", 0, 0, 0); !status) {
        return std::unexpected(status.error());
    }
    if (options.stateChanged)
        options.stateChanged("initializing", "Preparing the selected ALSA input.");

    result = snd_pcm_prepare(pcm.get());
    if (result < 0) {
        const auto error =
            alsaError("audio_capture_prepare_failed", "Preparing ALSA capture", result);
        if (auto status =
                updateRecordingSession(archive, session, "failed", 0, 0, 0, error.message);
            !status) {
            return std::unexpected(status.error());
        }
        return std::unexpected(error);
    }
    if (options.waitForSynchronizedStart && !options.waitForSynchronizedStart()) {
        const auto error =
            core::error("audio_synchronized_start_cancelled",
                        "A synchronized capture peer failed before both tracks started.");
        if (auto status =
                updateRecordingSession(archive, session, "failed", 0, 0, 0, error.message);
            !status) {
            return std::unexpected(status.error());
        }
        return std::unexpected(error);
    }
    if (auto status = updateRecordingSession(archive, session, "recording", 0, 0, 0); !status) {
        return std::unexpected(status.error());
    }
    if (options.stateChanged)
        options.stateChanged("recording", "Microphone capture is active.");

    const std::uint64_t intervalMilliseconds =
        options.durability == DurabilityPolicy::maximum        ? 100U
        : options.durability == DurabilityPolicy::reducedWrite ? 2'000U
                                                               : 500U;
    const std::uint64_t framesPerChunk = std::max<std::uint64_t>(
        1,
        static_cast<std::uint64_t>(summary.sampleRateHz) * intervalMilliseconds / 1'000U);
    const std::uint64_t bytesPerFrame =
        static_cast<std::uint64_t>(summary.channelCount) * sizeof(std::int16_t);
    const std::uint64_t maximumChunkBytes = 1'048'576;
    const std::uint64_t safeFramesPerChunk =
        std::max<std::uint64_t>(1, std::min(framesPerChunk, maximumChunkBytes / bytesPerFrame));
    const snd_pcm_uframes_t readFrames = std::max<snd_pcm_uframes_t>(
        configuration->periodFrames,
        static_cast<snd_pcm_uframes_t>(std::min<std::uint64_t>(safeFramesPerChunk, 8'192)));
    const std::size_t readBytes = static_cast<std::size_t>(readFrames * bytesPerFrame);
    std::vector<std::byte> buffer(readBytes);
    archive::Bytes pending;
    pending.reserve(static_cast<std::size_t>(safeFramesPerChunk * bytesPerFrame));

    std::uint64_t sequence = 0;
    std::uint64_t storedSamples = 0;
    std::uint64_t storedBytes = 0;
    std::uint64_t timelineEndSample = 0;
    std::uint64_t discontinuities = 0;
    bool pendingDiscontinuity = false;
    bool paused = false;
    auto startedAt = std::chrono::steady_clock::now();
    auto pausedAt = std::chrono::steady_clock::time_point{};
    auto totalPause = std::chrono::steady_clock::duration::zero();
    std::optional<core::Error> streamFailure;

    const auto writePending = [&]() -> core::Status {
        if (pending.empty())
            return {};
        const std::uint64_t frames = pending.size() / bytesPerFrame;
        if (frames == 0 || frames > std::numeric_limits<std::uint64_t>::max() - storedSamples ||
            sequence == std::numeric_limits<std::uint64_t>::max() ||
            pending.size() > std::numeric_limits<std::uint64_t>::max() - storedBytes) {
            return std::unexpected(
                core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
        }
        archive::Bytes payload = std::move(pending);
        pending.clear();
        auto status = appendCapturedChunk(archive,
                                          session,
                                          sessionId,
                                          summary.trackId,
                                          sequence,
                                          timelineEndSample,
                                          frames,
                                          storedSamples,
                                          storedBytes,
                                          0,
                                          summary.sampleRateHz,
                                          summary.channelCount,
                                          pendingDiscontinuity,
                                          std::move(payload));
        if (!status)
            return status;
        ++sequence;
        storedSamples += frames;
        timelineEndSample += frames;
        storedBytes += static_cast<std::uint64_t>(frames * bytesPerFrame);
        pendingDiscontinuity = false;
        summary.chunkCount = sequence;
        summary.sampleCount = storedSamples;
        summary.timelineSampleCount = timelineEndSample;
        summary.byteCount = storedBytes;
        summary.durationUs = samplesToMicroseconds(timelineEndSample, summary.sampleRateHz);
        if (options.progress)
            options.progress(summary);
        return {};
    };

    while (true) {
        if (options.stopRequested && options.stopRequested())
            break;

        const auto now = std::chrono::steady_clock::now();
        const bool pauseRequested = options.pauseRequested && options.pauseRequested();
        if (pauseRequested && !paused) {
            if (auto status = writePending(); !status) {
                streamFailure = status.error();
                break;
            }
            result = snd_pcm_drop(pcm.get());
            if (result < 0) {
                streamFailure =
                    alsaError("audio_capture_pause_failed", "Pausing ALSA capture", result);
                break;
            }
            if (auto status = updateRecordingSession(archive,
                                                     session,
                                                     "paused",
                                                     sequence,
                                                     storedSamples,
                                                     storedBytes);
                !status) {
                streamFailure = status.error();
                break;
            }
            paused = true;
            pausedAt = now;
            if (options.stateChanged)
                options.stateChanged("paused", "Microphone capture is paused.");
        }
        if (paused) {
            if (options.stopRequested && options.stopRequested())
                break;
            if (options.pauseRequested && !options.pauseRequested()) {
                result = snd_pcm_prepare(pcm.get());
                if (result < 0) {
                    streamFailure =
                        alsaError("audio_capture_resume_failed", "Resuming ALSA capture", result);
                    break;
                }
                const auto resumedAt = std::chrono::steady_clock::now();
                totalPause += resumedAt - pausedAt;
                paused = false;
                if (auto status = updateRecordingSession(archive,
                                                         session,
                                                         "recording",
                                                         sequence,
                                                         storedSamples,
                                                         storedBytes);
                    !status) {
                    streamFailure = status.error();
                    break;
                }
                if (options.stateChanged)
                    options.stateChanged("recording", "Microphone capture resumed.");
            } else {
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }
        }
        if (options.maximumDuration && now - startedAt - totalPause >= *options.maximumDuration) {
            break;
        }

        const snd_pcm_sframes_t frames = snd_pcm_readi(pcm.get(), buffer.data(), readFrames);
        if (frames == -EPIPE) {
            ++discontinuities;
            pendingDiscontinuity = true;
            result = snd_pcm_prepare(pcm.get());
            if (result < 0) {
                streamFailure = alsaError("audio_capture_recovery_failed",
                                          "Recovering an ALSA input overrun",
                                          result);
                break;
            }
            continue;
        }
        if (frames == -EINTR)
            continue;
        if (frames < 0) {
            streamFailure = alsaError("audio_capture_read_failed",
                                      "Reading samples from ALSA",
                                      static_cast<int>(frames));
            break;
        }
        if (frames == 0)
            continue;

        const auto bytes =
            static_cast<std::size_t>(frames) * static_cast<std::size_t>(bytesPerFrame);
        pending.insert(pending.end(),
                       buffer.begin(),
                       buffer.begin() + static_cast<std::ptrdiff_t>(bytes));
        if (pending.size() >= safeFramesPerChunk * bytesPerFrame) {
            if (auto status = writePending(); !status) {
                streamFailure = status.error();
                break;
            }
        }
    }

    if (!streamFailure) {
        if (auto status = writePending(); !status)
            streamFailure = status.error();
    }
    if (streamFailure) {
        const std::string state = sequence == 0 ? "failed" : "interrupted";
        auto status = updateRecordingSession(archive,
                                             session,
                                             state,
                                             sequence,
                                             storedSamples,
                                             storedBytes,
                                             streamFailure->message);
        if (!status) {
            return std::unexpected(core::error(
                streamFailure->code,
                streamFailure->message +
                    " Unable to persist the capture failure state: " + status.error().message));
        }
        if (options.stateChanged)
            options.stateChanged(state, streamFailure->message);
        return std::unexpected(*streamFailure);
    }

    session.fields["recording_stopped_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_discontinuities"] = std::to_string(discontinuities);
    if (auto status = updateRecordingSession(archive,
                                             session,
                                             "completed",
                                             sequence,
                                             storedSamples,
                                             storedBytes);
        !status) {
        return std::unexpected(status.error());
    }
    summary.completed = true;
    summary.state = "completed";
    if (options.stateChanged)
        options.stateChanged("completed", "Recording is durably saved.");
    return summary;
}

#else

core::Result<CaptureDeviceProbe> probeAlsaCaptureDevice(std::string) {
    return std::unexpected(
        core::error("audio_backend_unavailable", "This build does not include the ALSA backend."));
}

core::Result<CaptureSummary> captureAlsa(archive::Archive&, const archive::Uuid&, CaptureOptions) {
    return std::unexpected(
        core::error("audio_backend_unavailable", "This build does not include the ALSA backend."));
}

#endif

} // namespace tutorux::audio

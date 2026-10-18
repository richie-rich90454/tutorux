#include "tutorux/transcription/whisper_backend.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <bit>
#include <charconv>
#include <chrono>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <span>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#ifdef TUTORUX_WITH_WHISPER
#include <whisper.h>
#endif

namespace tutorux::transcription {
namespace {

    using archive::Archive;
    using archive::Bytes;
    using archive::Record;
    using archive::RecordType;
    using archive::Uuid;
    using core::Result;
    using core::Status;

    std::uint64_t nowUnixMicroseconds();

    Status updateSessionProcessingState(Archive& archive, const Uuid& sessionId, std::string_view state, std::string_view detail = {}) {
        auto session = archive.get(RecordType::Session, sessionId);
        if (!session)
            return std::unexpected(session.error());
        if (!*session || domain::isDeleted(**session)) {
            return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
        }
        (**session).fields["processing_state"] = std::string(state);
        (**session).fields["processing_detail"] = std::string(detail);
        (**session).fields["processing_updated_at_us"] = std::to_string(nowUnixMicroseconds());
        return archive.put(**session);
    }

    bool hasHumanTranscriptEdits(const Record& segment) {
        const std::string verificationState = domain::getField(segment, "verification_state");
        const std::string speakerAssignmentState = domain::getField(segment, "speaker_assignment_state");
        return verificationState == "human-corrected" || verificationState == "human-verified" ||
               speakerAssignmentState == "tutor-labeled" || speakerAssignmentState == "unknown" ||
               !domain::getField(segment, "human_edited_at_us").empty() || !domain::getField(segment, "linked_asset_ids").empty();
    }

    class TranscriptionStateGuard final {
      public:
        TranscriptionStateGuard(Archive& archive, Uuid sessionId)
            : archive_(archive)
            , sessionId_(sessionId) {}

        TranscriptionStateGuard(const TranscriptionStateGuard&) = delete;
        TranscriptionStateGuard& operator=(const TranscriptionStateGuard&) = delete;

        ~TranscriptionStateGuard() {
            if (!active_)
                return;
            try {
                static_cast<void>(
                    updateSessionProcessingState(archive_, sessionId_, hasPartialOutput_ ? "review-required" : "not-processed",
                                                 hasPartialOutput_ ? "Transcription stopped before completion. Review saved provisional "
                                                                     "segments and retry if needed."
                                                                   : "Transcription stopped before saving any transcript segments."));
            } catch (...) {
                // Preserve the original transcription failure during stack unwinding.
            }
        }

        Status begin() {
            auto status = updateSessionProcessingState(archive_, sessionId_, "transcribing");
            if (status)
                active_ = true;
            return status;
        }

        Status finish() {
            auto status =
                updateSessionProcessingState(archive_, sessionId_, "review-required", "Provisional transcript is ready for tutor review.");
            if (status)
                active_ = false;
            return status;
        }

        void markPartialOutput() {
            hasPartialOutput_ = true;
        }

      private:
        Archive& archive_;
        Uuid sessionId_{};
        bool active_{};
        bool hasPartialOutput_{};
    };

    constexpr std::uint32_t kWhisperSampleRate = 16'000;
    constexpr std::uint32_t kMaximumSourceSampleRate = 384'000;
    constexpr std::uint16_t kMaximumChannelCount = 8;
    constexpr std::size_t kMaximumChunkBytes = 1024U * 1024U;
    constexpr std::size_t kWindowSeconds = 27;
    constexpr std::size_t kRecordsPerBatch = 64;
    constexpr std::size_t kMaximumTrackCount = 32;

#ifdef TUTORUX_WITH_WHISPER

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    Result<std::uint64_t> parseUnsigned(std::string_view value, std::string_view name) {
        std::uint64_t result = 0;
        const auto [end, errorCode] = std::from_chars(value.data(), value.data() + value.size(), result);
        if (errorCode != std::errc{} || end != value.data() + value.size()) {
            return std::unexpected(
                core::error("transcription_audio_metadata_invalid", "Audio chunk has an invalid " + std::string(name) + " field."));
        }
        return result;
    }

    Result<std::uint64_t> sampleToMicroseconds(std::uint64_t sample, std::uint32_t sampleRateHz) {
        if (sampleRateHz == 0)
            return std::unexpected(core::error("transcription_audio_metadata_invalid", "Audio sample rate cannot be zero."));
        const std::uint64_t wholeSeconds = sample / sampleRateHz;
        const std::uint64_t remainingSamples = sample % sampleRateHz;
        constexpr std::uint64_t maximum = static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max());
        if (wholeSeconds > maximum / 1'000'000ULL) {
            return std::unexpected(
                core::error("transcription_audio_timeline_invalid", "Audio timeline exceeds the supported timestamp range."));
        }
        const std::uint64_t microseconds = wholeSeconds * 1'000'000ULL + (remainingSamples * 1'000'000ULL) / sampleRateHz;
        if (microseconds > maximum) {
            return std::unexpected(
                core::error("transcription_audio_timeline_invalid", "Audio timeline exceeds the supported timestamp range."));
        }
        return microseconds;
    }

    Result<std::uint64_t> microsecondsToSample(std::uint64_t microseconds, std::uint32_t sampleRateHz, bool roundUp) {
        const std::uint64_t wholeSeconds = microseconds / 1'000'000ULL;
        const std::uint64_t remainingMicroseconds = microseconds % 1'000'000ULL;
        if (wholeSeconds > std::numeric_limits<std::uint64_t>::max() / sampleRateHz) {
            return std::unexpected(
                core::error("transcription_range_invalid", "Requested transcript range exceeds the supported audio timeline."));
        }
        const std::uint64_t wholeSamples = wholeSeconds * sampleRateHz;
        const std::uint64_t fractionalProduct = remainingMicroseconds * sampleRateHz;
        const std::uint64_t fractionalSamples = fractionalProduct / 1'000'000ULL;
        const std::uint64_t remainder = fractionalProduct % 1'000'000ULL;
        if (wholeSamples > std::numeric_limits<std::uint64_t>::max() - fractionalSamples) {
            return std::unexpected(
                core::error("transcription_range_invalid", "Requested transcript range exceeds the supported audio timeline."));
        }
        const std::uint64_t samples = wholeSamples + fractionalSamples;
        if (roundUp && remainder > 0) {
            if (samples == std::numeric_limits<std::uint64_t>::max()) {
                return std::unexpected(
                    core::error("transcription_range_invalid", "Requested transcript range exceeds the supported audio timeline."));
            }
            return samples + 1;
        }
        return samples;
    }

    std::uint32_t bytesPerSample(std::string_view sampleFormat) {
        if (sampleFormat == "pcm_u8")
            return 1;
        if (sampleFormat == "pcm_s16le")
            return 2;
        if (sampleFormat == "pcm_s24le")
            return 3;
        if (sampleFormat == "pcm_s32le" || sampleFormat == "pcm_f32le")
            return 4;
        return 0;
    }

    std::uint32_t readLittleEndian(std::span<const std::byte> bytes, std::size_t offset, std::size_t length) {
        std::uint32_t value = 0;
        for (std::size_t index = 0; index < length; ++index) {
            value |= static_cast<std::uint32_t>(std::to_integer<unsigned int>(bytes[offset + index])) << (index * 8U);
        }
        return value;
    }

    Result<float> decodeSample(std::span<const std::byte> bytes, std::size_t offset, std::string_view sampleFormat) {
        if (sampleFormat == "pcm_u8") {
            return (static_cast<float>(std::to_integer<unsigned int>(bytes[offset])) - 128.0F) / 128.0F;
        }
        if (sampleFormat == "pcm_s16le") {
            const auto value = static_cast<std::int16_t>(readLittleEndian(bytes, offset, 2));
            return static_cast<float>(value) / 32768.0F;
        }
        if (sampleFormat == "pcm_s24le") {
            std::int32_t value = static_cast<std::int32_t>(readLittleEndian(bytes, offset, 3));
            if ((value & 0x0080'0000) != 0)
                value |= static_cast<std::int32_t>(0xff00'0000U);
            return static_cast<float>(value) / 8'388'608.0F;
        }
        if (sampleFormat == "pcm_s32le") {
            const auto value = static_cast<std::int32_t>(readLittleEndian(bytes, offset, 4));
            return static_cast<float>(static_cast<double>(value) / 2'147'483'648.0);
        }
        if (sampleFormat == "pcm_f32le") {
            const float value = std::bit_cast<float>(readLittleEndian(bytes, offset, 4));
            if (!std::isfinite(value)) {
                return std::unexpected(core::error("transcription_audio_sample_invalid", "Audio contains a non-finite IEEE-float sample."));
            }
            return std::clamp(value, -1.0F, 1.0F);
        }
        return std::unexpected(core::error("transcription_audio_format_unsupported", "Audio sample format is unsupported."));
    }

    Status appendMonoFrames(const Record& chunk, std::string_view sampleFormat, std::uint16_t channelCount, std::uint64_t firstSample,
                            std::uint64_t sampleCount, std::uint64_t selectedStart, std::uint64_t selectedEnd, std::vector<float>& output) {
        if (sampleCount > std::numeric_limits<std::size_t>::max()) {
            return std::unexpected(
                core::error("transcription_audio_chunk_invalid", "Audio chunk sample count exceeds this platform's memory range."));
        }
        const std::uint32_t sampleBytes = bytesPerSample(sampleFormat);
        const std::size_t frameBytes = static_cast<std::size_t>(sampleBytes) * channelCount;
        const std::uint64_t overlapStart = std::max(firstSample, selectedStart);
        const std::uint64_t overlapEnd = std::min(firstSample + sampleCount, selectedEnd);
        if (overlapStart >= overlapEnd)
            return {};
        const std::uint64_t firstOffset = overlapStart - firstSample;
        const std::uint64_t framesToAppend = overlapEnd - overlapStart;
        if (framesToAppend > std::numeric_limits<std::size_t>::max() - output.size()) {
            return std::unexpected(core::error("transcription_audio_window_invalid", "Audio window exceeds this platform's memory range."));
        }
        output.reserve(output.size() + static_cast<std::size_t>(framesToAppend));
        const std::span<const std::byte> payload(chunk.blob);
        for (std::uint64_t frame = 0; frame < framesToAppend; ++frame) {
            const std::uint64_t sourceFrame = firstOffset + frame;
            const std::size_t frameOffset = static_cast<std::size_t>(sourceFrame) * frameBytes;
            double mixed = 0.0;
            for (std::uint16_t channel = 0; channel < channelCount; ++channel) {
                const std::size_t offset = frameOffset + static_cast<std::size_t>(channel) * sampleBytes;
                auto decoded = decodeSample(payload, offset, sampleFormat);
                if (!decoded)
                    return std::unexpected(decoded.error());
                mixed += *decoded;
            }
            output.push_back(static_cast<float>(mixed / channelCount));
        }
        return {};
    }

    struct WhisperContextDeleter final {
        void operator()(whisper_context* context) const {
            if (context)
                whisper_free(context);
        }
    };

    std::vector<float> resampleToWhisperRate(const std::vector<float>& input, std::uint32_t sourceRateHz) {
        if (input.empty())
            return {};
        const long double rateRatio = static_cast<long double>(sourceRateHz) / kWhisperSampleRate;
        const long double exactOutputSize = input.size() / rateRatio;
        const auto outputSize = static_cast<std::size_t>(std::ceil(exactOutputSize));
        std::vector<float> output;
        output.reserve(outputSize);
        const long double cutoff = std::min(1.0L, 1.0L / rateRatio) * 0.95L;
        const std::size_t radius = static_cast<std::size_t>(std::ceil(8.0L * std::max(1.0L, rateRatio)));
        constexpr std::size_t phaseCount = 1024;
        const std::size_t tapCount = radius * 2;
        std::vector<float> coefficients(phaseCount * tapCount);
        constexpr long double pi = 3.141592653589793238462643383279502884L;
        for (std::size_t phase = 0; phase < phaseCount; ++phase) {
            const long double fraction = static_cast<long double>(phase) / phaseCount;
            long double coefficientTotal = 0.0L;
            for (std::size_t tap = 0; tap < tapCount; ++tap) {
                const auto offset = static_cast<std::int64_t>(tap) - static_cast<std::int64_t>(radius) + 1;
                const long double distance = offset - fraction;
                const long double scaledDistance = cutoff * distance;
                const long double sinc = std::abs(scaledDistance) < 1.0e-12L ? 1.0L : std::sin(pi * scaledDistance) / (pi * scaledDistance);
                const long double windowPosition = distance / radius;
                const long double window = 0.42L + 0.5L * std::cos(pi * windowPosition) + 0.08L * std::cos(2.0L * pi * windowPosition);
                const long double coefficient = cutoff * sinc * window;
                coefficients[phase * tapCount + tap] = static_cast<float>(coefficient);
                coefficientTotal += coefficient;
            }
            if (std::abs(coefficientTotal) > 1.0e-12L) {
                const float normalization = static_cast<float>(1.0L / coefficientTotal);
                for (std::size_t tap = 0; tap < tapCount; ++tap)
                    coefficients[phase * tapCount + tap] *= normalization;
            }
        }

        for (std::size_t index = 0; index < outputSize; ++index) {
            const long double position = index * rateRatio;
            const auto center = static_cast<std::int64_t>(std::floor(position));
            const long double fraction = position - center;
            const auto phase = std::min(phaseCount - 1, static_cast<std::size_t>(fraction * static_cast<long double>(phaseCount)));
            double weightedSample = 0.0;
            for (std::size_t tap = 0; tap < tapCount; ++tap) {
                const auto offset = static_cast<std::int64_t>(tap) - static_cast<std::int64_t>(radius) + 1;
                const std::int64_t sourceIndex = std::clamp<std::int64_t>(center + offset, 0, static_cast<std::int64_t>(input.size()) - 1);
                weightedSample += input[static_cast<std::size_t>(sourceIndex)] * coefficients[phase * tapCount + tap];
            }
            output.push_back(static_cast<float>(weightedSample));
        }
        return output;
    }
#endif

} // namespace

struct LiveWhisperSession::Impl final {
    LiveWhisperOptions options;
    std::size_t windowSampleLimit{};
    std::vector<float> window;
    std::vector<LiveWhisperSegment> pendingSegments;
    std::int64_t windowStartUs{};
    std::int64_t expectedNextStartUs{};
    bool hasWindowStart{};
    bool hasExpectedNextStart{};
    bool finished{};
    std::string modelName;
    std::string backendVersion;
#ifdef TUTORUX_WITH_WHISPER
    std::unique_ptr<whisper_context, WhisperContextDeleter> context;
#endif
};

#ifdef TUTORUX_WITH_WHISPER
namespace {

    Status transcribeLiveWindow(whisper_context* context, const LiveWhisperOptions& options, std::string_view modelName,
                                std::string_view backendVersion, std::int64_t& windowStartUs, std::vector<float>& window,
                                std::size_t sampleCount, std::vector<LiveWhisperSegment>& emitted) {
        if (!context || sampleCount == 0 || sampleCount > window.size() ||
            sampleCount > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            return std::unexpected(
                core::error("transcription_audio_window_invalid", "Live audio window exceeds whisper.cpp's supported sample count."));
        }
        whisper_full_params parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        parameters.n_threads = static_cast<int>(options.threadCount);
        parameters.print_progress = false;
        parameters.print_realtime = false;
        parameters.print_timestamps = false;
        parameters.print_special = false;
        parameters.no_context = true;
        parameters.translate = false;
        parameters.detect_language = options.language == "auto";
        parameters.language = parameters.detect_language ? nullptr : options.language.c_str();
        parameters.tdrz_enable = options.diarizeSpeakerTurns;
        if (whisper_full(context, parameters, window.data(), static_cast<int>(sampleCount)) != 0) {
            return std::unexpected(core::error("transcription_inference_failed", "whisper.cpp failed to transcribe a live audio window."));
        }

        const char* detectedLanguage =
            parameters.detect_language ? whisper_lang_str(whisper_full_lang_id(context)) : options.language.c_str();
        const std::string resultLanguage = detectedLanguage ? detectedLanguage : options.language;
        const std::uint64_t windowDurationUs = (static_cast<std::uint64_t>(sampleCount) * 1'000'000ULL) / kWhisperSampleRate;
        const auto maximumTimestamp = std::numeric_limits<std::int64_t>::max();
        if (windowStartUs < 0 || windowDurationUs > static_cast<std::uint64_t>(maximumTimestamp - windowStartUs)) {
            return std::unexpected(
                core::error("transcription_audio_timeline_invalid", "Live audio window exceeds the supported timestamp range."));
        }
        const std::uint64_t maxSegmentTicks = windowDurationUs / 10'000ULL;
        const int segmentCount = whisper_full_n_segments(context);
        for (int index = 0; index < segmentCount; ++index) {
            const char* text = whisper_full_get_segment_text(context, index);
            const std::int64_t relativeStart = whisper_full_get_segment_t0(context, index);
            const std::int64_t relativeEnd = whisper_full_get_segment_t1(context, index);
            if (!text || *text == '\0' || relativeStart < 0 || relativeEnd <= relativeStart)
                continue;
            const std::uint64_t startOffsetUs = std::min(static_cast<std::uint64_t>(relativeStart), maxSegmentTicks) * 10'000ULL;
            const std::uint64_t endOffsetUs = std::min(static_cast<std::uint64_t>(relativeEnd), maxSegmentTicks) * 10'000ULL;
            if (startOffsetUs >= endOffsetUs || endOffsetUs > static_cast<std::uint64_t>(maximumTimestamp - windowStartUs)) {
                continue;
            }
            const auto startUs = windowStartUs + static_cast<std::int64_t>(startOffsetUs);
            const auto endUs = windowStartUs + static_cast<std::int64_t>(endOffsetUs);
            if (endUs <= startUs)
                continue;
            emitted.push_back(LiveWhisperSegment{
                startUs, endUs, text, resultLanguage, std::string(modelName), std::string(backendVersion), true,
                options.diarizeSpeakerTurns, options.diarizeSpeakerTurns && whisper_full_get_segment_speaker_turn_next(context, index)});
        }

        window.erase(window.begin(), window.begin() + static_cast<std::ptrdiff_t>(sampleCount));
        windowStartUs += static_cast<std::int64_t>(windowDurationUs);
        return {};
    }

} // namespace
#endif

LiveWhisperSession::LiveWhisperSession(std::unique_ptr<Impl> impl)
    : impl_(std::move(impl)) {}

LiveWhisperSession::~LiveWhisperSession() = default;

LiveWhisperSession::LiveWhisperSession(LiveWhisperSession&&) noexcept = default;

LiveWhisperSession& LiveWhisperSession::operator=(LiveWhisperSession&&) noexcept = default;

core::Result<LiveWhisperSession> LiveWhisperSession::create(LiveWhisperOptions options) {
#ifndef TUTORUX_WITH_WHISPER
    static_cast<void>(options);
    return std::unexpected(core::error("transcription_unavailable",
                                       "Local transcription was not enabled in this build. Rebuild with "
                                       "-DTUTORUX_ENABLE_WHISPER=ON and provide a compatible whisper.cpp model."));
#else
    constexpr std::uint32_t maximumWindowSeconds = 27;
    if (options.modelPath.empty()) {
        return std::unexpected(core::error("transcription_model_required", "Provide a local model file for live transcription."));
    }
    if (options.windowSeconds == 0 || options.windowSeconds > maximumWindowSeconds) {
        return std::unexpected(core::error("transcription_window_invalid", "Live Whisper windows must be between 1 and 27 seconds."));
    }
    if (options.language.empty())
        options.language = "auto";

    std::error_code filesystemError;
    const auto modelStatus = std::filesystem::symlink_status(options.modelPath, filesystemError);
    if (filesystemError || std::filesystem::is_symlink(modelStatus) || !std::filesystem::is_regular_file(modelStatus)) {
        return std::unexpected(
            core::error("transcription_model_unavailable", "The selected local Whisper model is missing, linked, or not a regular file."));
    }

    auto impl = std::make_unique<Impl>();
    impl->options = std::move(options);
    impl->windowSampleLimit = static_cast<std::size_t>(kWhisperSampleRate) * impl->options.windowSeconds;
    impl->window.reserve(impl->windowSampleLimit);
    impl->modelName = impl->options.modelPath.filename().string();
    impl->backendVersion = std::string("whisper.cpp ") + whisper_version();
    std::uint32_t threadCount = impl->options.threadCount;
    if (threadCount == 0) {
        const unsigned int available = std::thread::hardware_concurrency();
        threadCount = std::clamp(available == 0 ? 1U : available, 1U, 8U);
    }
    impl->options.threadCount = std::clamp(threadCount, 1U, 64U);
    impl->context = std::unique_ptr<whisper_context, WhisperContextDeleter>(
        whisper_init_from_file_with_params(impl->options.modelPath.string().c_str(), whisper_context_default_params()));
    if (!impl->context) {
        return std::unexpected(core::error("transcription_model_load_failed", "whisper.cpp could not load the selected model file."));
    }
    return LiveWhisperSession(std::move(impl));
#endif
}

core::Result<std::vector<LiveWhisperSegment>> LiveWhisperSession::push(std::span<const std::byte> pcm, std::string_view sampleFormat,
                                                                       std::uint32_t sampleRateHz, std::uint16_t channelCount,
                                                                       std::int64_t absoluteStartUs) {
#ifndef TUTORUX_WITH_WHISPER
    static_cast<void>(pcm);
    static_cast<void>(sampleFormat);
    static_cast<void>(sampleRateHz);
    static_cast<void>(channelCount);
    static_cast<void>(absoluteStartUs);
    return std::unexpected(core::error("transcription_unavailable",
                                       "Local transcription was not enabled in this build. Rebuild with "
                                       "-DTUTORUX_ENABLE_WHISPER=ON and provide a compatible whisper.cpp model."));
#else
    if (!impl_ || !impl_->context) {
        return std::unexpected(core::error("transcription_session_unavailable", "Live Whisper session is unavailable."));
    }
    if (impl_->finished) {
        return std::unexpected(core::error("transcription_session_finished", "Live Whisper session has already finished."));
    }
    if (pcm.empty() || pcm.size() > kMaximumChunkBytes) {
        return std::unexpected(
            core::error("transcription_audio_chunk_invalid", "Live audio input must contain between 1 byte and 1 MiB of PCM data."));
    }
    if (sampleRateHz < 8'000 || sampleRateHz > kMaximumSourceSampleRate || channelCount == 0 || channelCount > kMaximumChannelCount ||
        absoluteStartUs < 0) {
        return std::unexpected(core::error("transcription_audio_metadata_invalid",
                                           "Live audio requires an 8–384 kHz sample rate, 1–8 channels, and a non-negative timestamp."));
    }
    const std::uint32_t sampleBytes = bytesPerSample(sampleFormat);
    if (sampleBytes == 0) {
        return std::unexpected(core::error("transcription_audio_format_unsupported", "Audio sample format is unsupported."));
    }
    const std::size_t frameBytes = static_cast<std::size_t>(sampleBytes) * channelCount;
    if (pcm.size() % frameBytes != 0) {
        return std::unexpected(core::error("transcription_audio_chunk_invalid",
                                           "Live PCM byte length must contain a whole number of interleaved audio frames."));
    }
    const std::size_t frameCount = pcm.size() / frameBytes;
    const std::size_t maximumFrames = static_cast<std::size_t>(sampleRateHz) * 27U;
    if (frameCount == 0 || frameCount > maximumFrames) {
        return std::unexpected(
            core::error("transcription_audio_window_invalid", "Each live input block is limited to 27 seconds of source audio."));
    }
    const std::uint64_t durationUs = (static_cast<std::uint64_t>(frameCount) * 1'000'000ULL) / sampleRateHz;
    constexpr auto maximumTimestamp = std::numeric_limits<std::int64_t>::max();
    if (durationUs > static_cast<std::uint64_t>(maximumTimestamp - absoluteStartUs)) {
        return std::unexpected(
            core::error("transcription_audio_timeline_invalid", "Live audio timestamp exceeds the supported timeline range."));
    }
    const auto blockEndUs = absoluteStartUs + static_cast<std::int64_t>(durationUs);

    std::vector<LiveWhisperSegment> emitted;
    auto transcribeBuffered = [&](bool includePartial) -> core::Status {
        if (!impl_->hasWindowStart || impl_->window.empty() || (!includePartial && impl_->window.size() < impl_->windowSampleLimit)) {
            return {};
        }
        const std::size_t sampleCount = std::min(impl_->window.size(), impl_->windowSampleLimit);
        if (auto status = transcribeLiveWindow(impl_->context.get(), impl_->options, impl_->modelName, impl_->backendVersion,
                                               impl_->windowStartUs, impl_->window, sampleCount, emitted);
            !status) {
            return status;
        }
        impl_->hasWindowStart = !impl_->window.empty();
        return {};
    };

    if (impl_->hasExpectedNextStart) {
        if (absoluteStartUs < impl_->expectedNextStartUs && impl_->expectedNextStartUs - absoluteStartUs > 2) {
            return std::unexpected(core::error("transcription_audio_timeline_invalid", "Live PCM blocks overlap or arrive out of order."));
        }
    }

    std::vector<float> mono;
    mono.reserve(frameCount);
    const std::span<const std::byte> input(pcm);
    for (std::size_t frame = 0; frame < frameCount; ++frame) {
        const std::size_t frameOffset = frame * frameBytes;
        double mixed = 0.0;
        for (std::uint16_t channel = 0; channel < channelCount; ++channel) {
            const std::size_t offset = frameOffset + static_cast<std::size_t>(channel) * sampleBytes;
            auto decoded = decodeSample(input, offset, sampleFormat);
            if (!decoded)
                return std::unexpected(decoded.error());
            mixed += *decoded;
        }
        mono.push_back(static_cast<float>(mixed / channelCount));
    }
    std::vector<float> resampled = resampleToWhisperRate(mono, sampleRateHz);
    if (resampled.empty()) {
        return std::unexpected(core::error("transcription_audio_window_invalid", "Live audio resampling produced no samples."));
    }
    const std::uint64_t resampledDurationUs = (static_cast<std::uint64_t>(resampled.size()) * 1'000'000ULL) / kWhisperSampleRate;
    if (resampledDurationUs > static_cast<std::uint64_t>(maximumTimestamp - absoluteStartUs)) {
        return std::unexpected(
            core::error("transcription_audio_timeline_invalid", "Resampled live audio timestamp exceeds the supported timeline range."));
    }
    emitted = std::move(impl_->pendingSegments);
    impl_->pendingSegments.clear();
    if (impl_->hasExpectedNextStart && absoluteStartUs > impl_->expectedNextStartUs && absoluteStartUs - impl_->expectedNextStartUs > 2) {
        if (auto status = transcribeBuffered(true); !status) {
            impl_->pendingSegments = std::move(emitted);
            return std::unexpected(status.error());
        }
        impl_->window.clear();
        impl_->hasWindowStart = false;
    }

    std::size_t offset = 0;
    while (offset < resampled.size()) {
        if (!impl_->hasWindowStart) {
            const std::uint64_t offsetUs = (static_cast<std::uint64_t>(offset) * 1'000'000ULL) / kWhisperSampleRate;
            if (offsetUs > static_cast<std::uint64_t>(maximumTimestamp - absoluteStartUs)) {
                return std::unexpected(
                    core::error("transcription_audio_timeline_invalid", "Live audio timestamp exceeds the supported timeline range."));
            }
            impl_->windowStartUs = absoluteStartUs + static_cast<std::int64_t>(offsetUs);
            impl_->hasWindowStart = true;
        }
        const std::size_t available = impl_->windowSampleLimit - impl_->window.size();
        const std::size_t count = std::min(available, resampled.size() - offset);
        impl_->window.insert(impl_->window.end(), resampled.begin() + static_cast<std::ptrdiff_t>(offset),
                             resampled.begin() + static_cast<std::ptrdiff_t>(offset + count));
        offset += count;
        if (impl_->window.size() == impl_->windowSampleLimit) {
            if (auto status = transcribeBuffered(false); !status) {
                impl_->pendingSegments = std::move(emitted);
                return std::unexpected(status.error());
            }
        }
    }
    impl_->expectedNextStartUs = blockEndUs;
    impl_->hasExpectedNextStart = true;
    return emitted;
#endif
}

core::Result<std::vector<LiveWhisperSegment>> LiveWhisperSession::finish() {
#ifndef TUTORUX_WITH_WHISPER
    return std::unexpected(core::error("transcription_unavailable",
                                       "Local transcription was not enabled in this build. Rebuild with "
                                       "-DTUTORUX_ENABLE_WHISPER=ON and provide a compatible whisper.cpp model."));
#else
    if (!impl_ || !impl_->context) {
        return std::unexpected(core::error("transcription_session_unavailable", "Live Whisper session is unavailable."));
    }
    if (impl_->finished)
        return std::vector<LiveWhisperSegment>{};
    std::vector<LiveWhisperSegment> emitted = std::move(impl_->pendingSegments);
    impl_->pendingSegments.clear();
    if (!impl_->window.empty()) {
        const std::size_t sampleCount = impl_->window.size();
        if (auto status = transcribeLiveWindow(impl_->context.get(), impl_->options, impl_->modelName, impl_->backendVersion,
                                               impl_->windowStartUs, impl_->window, sampleCount, emitted);
            !status) {
            impl_->pendingSegments = std::move(emitted);
            return std::unexpected(status.error());
        }
    }
    impl_->finished = true;
    impl_->window.clear();
    impl_->hasWindowStart = false;
    return emitted;
#endif
}

#ifndef TUTORUX_WITH_WHISPER

core::Result<WhisperSummary> transcribeSession(archive::Archive&, const archive::Uuid&, WhisperOptions) {
    return std::unexpected(core::error("transcription_unavailable",
                                       "Local transcription was not enabled in this build. Rebuild with "
                                       "-DTUTORUX_ENABLE_WHISPER=ON and provide a compatible whisper.cpp model."));
}

#else

core::Result<WhisperSummary> transcribeSession(Archive& archive, const Uuid& sessionId, WhisperOptions options) {
    if (!archive.writable()) {
        return std::unexpected(core::error("archive_read_only", "Transcription requires a writable archive."));
    }
    if (options.modelPath.empty()) {
        return std::unexpected(core::error("transcription_model_required", "Provide a local model with --model FILE."));
    }
    if (options.startTimeUs.has_value() != options.endTimeUs.has_value() ||
        (options.startTimeUs && (*options.startTimeUs < 0 || *options.endTimeUs <= *options.startTimeUs))) {
        return std::unexpected(core::error("transcription_range_invalid", "Provide both --start and --end, with end later than start."));
    }
    if (options.language.empty())
        options.language = "auto";

    if (options.modelPath.is_relative())
        options.modelPath = archive.path().parent_path() / options.modelPath;
    std::error_code filesystemError;
    const auto modelStatus = std::filesystem::symlink_status(options.modelPath, filesystemError);
    if (filesystemError || std::filesystem::is_symlink(modelStatus) || !std::filesystem::is_regular_file(modelStatus)) {
        return std::unexpected(core::error("transcription_model_unavailable",
                                           "The selected local Whisper model is missing, linked, or not a regular "
                                           "file."));
    }

    auto sessionResult = archive.get(RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the selected archive."));
    }
    const std::string recordingState = domain::getField(**sessionResult, "recording_state");
    if (recordingState == "initializing" || recordingState == "recording" || recordingState == "paused" || recordingState == "finalizing") {
        return std::unexpected(core::error("transcription_session_busy", "Stop or finish the active recording before transcription."));
    }

    std::vector<Uuid> tracks;
    core::Error trackScanError;
    auto trackStatus = archive.forEachAudioChunk(sessionId, std::nullopt, [&](Record&& chunk) {
        auto track = archive::uuidFromString(domain::getField(chunk, "track_id"));
        if (!track) {
            trackScanError = core::error("transcription_audio_track_invalid", "An audio chunk contains an invalid track identifier.");
            return false;
        }
        if (std::find(tracks.begin(), tracks.end(), *track) == tracks.end()) {
            if (tracks.size() >= kMaximumTrackCount) {
                trackScanError = core::error("transcription_track_count_invalid", "Session exceeds the supported count of audio tracks.");
                return false;
            }
            tracks.push_back(*track);
        }
        return true;
    });
    if (!trackStatus)
        return std::unexpected(trackStatus.error());
    if (!trackScanError.code.empty())
        return std::unexpected(std::move(trackScanError));
    if (tracks.empty()) {
        return std::unexpected(core::error("transcription_audio_missing", "Session contains no readable audio tracks."));
    }

    std::optional<Uuid> trackId = options.trackId;
    if (!trackId) {
        for (const std::string_view field : {"recording_track_id", "audio_import_track_id"}) {
            auto saved = archive::uuidFromString(domain::getField(**sessionResult, field));
            if (saved && std::find(tracks.begin(), tracks.end(), *saved) != tracks.end()) {
                trackId = *saved;
                break;
            }
        }
    }
    if (!trackId && tracks.size() == 1)
        trackId = tracks.front();
    if (!trackId || std::find(tracks.begin(), tracks.end(), *trackId) == tracks.end()) {
        return std::unexpected(
            core::error("transcription_track_required", "Choose an audio track with --track; this session has multiple tracks."));
    }

    auto context = std::unique_ptr<whisper_context, WhisperContextDeleter>(
        whisper_init_from_file_with_params(options.modelPath.string().c_str(), whisper_context_default_params()));
    if (!context) {
        return std::unexpected(core::error("transcription_model_load_failed", "whisper.cpp could not load the selected model file."));
    }

    std::uint32_t threadCount = options.threadCount;
    if (threadCount == 0) {
        const unsigned int available = std::thread::hardware_concurrency();
        threadCount = std::clamp(available == 0 ? 1U : available, 1U, 8U);
    }
    threadCount = std::clamp(threadCount, 1U, 64U);
    const std::string language = options.language;
    const std::string runId = archive::uuidToString(archive::randomUuid());
    const std::string modelName = options.modelPath.filename().string();
    const std::string createdAt = std::to_string(nowUnixMicroseconds());
    const std::uint64_t selectedStartUs = options.startTimeUs ? static_cast<std::uint64_t>(*options.startTimeUs) : 0;
    const std::uint64_t selectedEndUs =
        options.endTimeUs ? static_cast<std::uint64_t>(*options.endTimeUs) : std::numeric_limits<std::uint64_t>::max();

    bool hasPriorProvisional = false;
    std::vector<std::pair<std::uint64_t, std::uint64_t>> humanEditedRanges;
    auto transcriptStatus = archive.forEach(RecordType::TranscriptSegment, [&](Record&& segment) {
        if (domain::getField(segment, "session_id") != archive::uuidToString(sessionId) ||
            domain::getField(segment, "source_audio_track_id") != archive::uuidToString(*trackId)) {
            return true;
        }
        std::uint64_t segmentStart = 0;
        std::uint64_t segmentEnd = 0;
        const std::string startValue = domain::getField(segment, "start_time_us", "0");
        const std::string endValue = domain::getField(segment, "end_time_us", "0");
        const auto [startEnd, startError] = std::from_chars(startValue.data(), startValue.data() + startValue.size(), segmentStart);
        const auto [endEnd, endError] = std::from_chars(endValue.data(), endValue.data() + endValue.size(), segmentEnd);
        const bool hasValidRange = startError == std::errc{} && startEnd == startValue.data() + startValue.size() &&
                                   endError == std::errc{} && endEnd == endValue.data() + endValue.size() && segmentEnd > segmentStart;
        if (hasValidRange && segmentStart < selectedEndUs && segmentEnd > selectedStartUs && hasHumanTranscriptEdits(segment)) {
            humanEditedRanges.emplace_back(segmentStart, segmentEnd);
        }
        if (domain::getField(segment, "origin") != "local-whisper" || domain::getField(segment, "verification_state") != "provisional") {
            return true;
        }
        if (hasValidRange && segmentStart < selectedEndUs && segmentEnd > selectedStartUs) {
            hasPriorProvisional = true;
            return false;
        }
        return true;
    });
    if (!transcriptStatus)
        return std::unexpected(transcriptStatus.error());
    const bool replacePrior = options.replaceProvisional;
    if (hasPriorProvisional && !replacePrior) {
        return std::unexpected(core::error("transcription_provisional_exists",
                                           "This track already has provisional local transcript segments. Use refine or "
                                           "--replace-provisional to create a new run."));
    }

    TranscriptionStateGuard processingState(archive, sessionId);
    if (auto status = processingState.begin(); !status)
        return std::unexpected(status.error());

    WhisperSummary summary;
    summary.trackId = *trackId;
    summary.modelName = modelName;
    summary.backendVersion = std::string("whisper.cpp ") + whisper_version();
    summary.diarizationEnabled = options.diarizeSpeakerTurns;
    std::vector<Record> batch;
    batch.reserve(kRecordsPerBatch);
    std::uint64_t committedSegments = 0;
    auto commitBatch = [&]() -> Status {
        if (batch.empty())
            return {};
        const std::size_t batchSize = batch.size();
        auto status = archive.putMany(std::move(batch));
        batch.clear();
        batch.reserve(kRecordsPerBatch);
        if (status)
            committedSegments += batchSize;
        if (status && batchSize > 0)
            processingState.markPartialOutput();
        return status;
    };

    std::uint32_t sourceRateHz = 0;
    std::uint16_t channelCount = 0;
    std::string sampleFormat;
    std::uint64_t expectedSequence = 0;
    std::uint64_t previousEndSample = 0;
    bool sawChunk = false;
    std::vector<float> sourceWindow;
    sourceWindow.reserve(static_cast<std::size_t>(kMaximumSourceSampleRate) * kWindowSeconds);
    std::uint64_t windowFirstSample = 0;
    std::uint64_t windowStoredSamples = 0;
    std::uint64_t selectedAudioSamples = 0;
    core::Error failureError;

    auto transcribeWindow = [&]() -> Status {
        if (sourceWindow.empty())
            return {};
        std::vector<float> whisperSamples = resampleToWhisperRate(sourceWindow, sourceRateHz);
        if (whisperSamples.empty() || whisperSamples.size() > static_cast<std::size_t>(std::numeric_limits<int>::max())) {
            return std::unexpected(
                core::error("transcription_audio_window_invalid", "Resampled audio window exceeds whisper.cpp's supported sample count."));
        }
        whisper_full_params parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        parameters.n_threads = static_cast<int>(threadCount);
        parameters.print_progress = false;
        parameters.print_realtime = false;
        parameters.print_timestamps = false;
        parameters.print_special = false;
        parameters.no_context = true;
        parameters.translate = false;
        parameters.detect_language = language == "auto";
        parameters.language = parameters.detect_language ? nullptr : language.c_str();
        parameters.tdrz_enable = options.diarizeSpeakerTurns;
        if (whisper_full(context.get(), parameters, whisperSamples.data(), static_cast<int>(whisperSamples.size())) != 0) {
            return std::unexpected(core::error("transcription_inference_failed", "whisper.cpp failed to transcribe an audio window."));
        }

        const char* detectedLanguage =
            parameters.detect_language ? whisper_lang_str(whisper_full_lang_id(context.get())) : language.c_str();
        const std::string resultLanguage = detectedLanguage ? detectedLanguage : language;
        const int segmentCount = whisper_full_n_segments(context.get());
        for (int index = 0; index < segmentCount; ++index) {
            const char* text = whisper_full_get_segment_text(context.get(), index);
            if (!text || *text == '\0')
                continue;
            const std::int64_t relativeStart = whisper_full_get_segment_t0(context.get(), index);
            const std::int64_t relativeEnd = whisper_full_get_segment_t1(context.get(), index);
            if (relativeStart < 0 || relativeEnd <= relativeStart)
                continue;
            const std::uint64_t relativeStartUs = static_cast<std::uint64_t>(relativeStart) * 10'000ULL;
            const std::uint64_t relativeEndUs = static_cast<std::uint64_t>(relativeEnd) * 10'000ULL;
            auto absoluteStart = sampleToMicroseconds(windowFirstSample, sourceRateHz);
            auto absoluteWindowEnd =
                sampleToMicroseconds(windowFirstSample + static_cast<std::uint64_t>(sourceWindow.size()), sourceRateHz);
            if (!absoluteStart || !absoluteWindowEnd)
                return std::unexpected(!absoluteStart ? absoluteStart.error() : absoluteWindowEnd.error());
            const std::uint64_t windowEndUs = std::min(selectedEndUs, *absoluteWindowEnd);
            if (relativeStartUs > windowEndUs - *absoluteStart || relativeEndUs > windowEndUs - *absoluteStart) {
                continue;
            }
            const std::uint64_t startUs = std::max(selectedStartUs, *absoluteStart + relativeStartUs);
            const std::uint64_t endUs = std::min(windowEndUs, *absoluteStart + relativeEndUs);
            if (endUs <= startUs)
                continue;

            const bool intersectsHumanEdit = std::any_of(humanEditedRanges.begin(), humanEditedRanges.end(), [&](const auto& range) {
                return startUs < range.second && endUs > range.first;
            });
            if (intersectsHumanEdit) {
                ++summary.segmentsSkippedForHumanEdits;
                continue;
            }

            const bool speakerTurnNext = options.diarizeSpeakerTurns && whisper_full_get_segment_speaker_turn_next(context.get(), index);

            Record segment;
            segment.type = RecordType::TranscriptSegment;
            segment.id = archive::randomUuid();
            segment.fields = {
                {"session_id",             archive::uuidToString(sessionId)},
                {"start_time_us",          std::to_string(startUs)         },
                {"end_time_us",            std::to_string(endUs)           },
                {"text",                   text                            },
                {"verification_state",     "provisional"                   },
                {"timestamp_state",        "timestamped"                   },
                {"origin",                 "local-whisper"                 },
                {"source_audio_track_id",  archive::uuidToString(*trackId) },
                {"source_model",           modelName                       },
                {"source_backend_version", summary.backendVersion          },
                {"source_run_id",          runId                           },
                {"source_window_start_us", std::to_string(*absoluteStart)  },
                {"language",               resultLanguage                  },
                {"created_at_us",          createdAt                       }
            };
            if (options.diarizeSpeakerTurns) {
                segment.fields["speaker_turn_next"] = speakerTurnNext ? "true" : "false";
                segment.fields["speaker_identity_state"] = "unassigned";
                segment.fields["diarization_method"] = "whisper.cpp-tinydiarize";
                segment.fields["diarization_model_requirement"] = "TDRZ-compatible Whisper model required";
                if (speakerTurnNext)
                    ++summary.speakerTurnBoundaries;
            }
            batch.push_back(std::move(segment));
            ++summary.segmentsCreated;
            if (batch.size() >= kRecordsPerBatch) {
                if (auto status = commitBatch(); !status)
                    return status;
            }
        }
        sourceWindow.clear();
        windowStoredSamples = 0;
        return {};
    };

    auto streamStatus = archive.forEachAudioChunk(sessionId, *trackId, [&](Record&& chunk) {
        if (domain::isDeleted(chunk))
            return true;
        auto sequence = parseUnsigned(domain::getField(chunk, "sequence_number"), "sequence_number");
        auto firstSample = parseUnsigned(domain::getField(chunk, "first_sample_index"), "first_sample_index");
        auto sampleCount = parseUnsigned(domain::getField(chunk, "sample_count"), "sample_count");
        auto sampleRate = parseUnsigned(domain::getField(chunk, "sample_rate_hz"), "sample_rate_hz");
        auto channels = parseUnsigned(domain::getField(chunk, "channel_count"), "channel_count");
        auto checksum = parseUnsigned(domain::getField(chunk, "payload_checksum"), "payload_checksum");
        auto gapBefore = parseUnsigned(domain::getField(chunk, "gap_before_samples", "0"), "gap_before_samples");
        if (!sequence || !firstSample || !sampleCount || !sampleRate || !channels || !checksum || !gapBefore ||
            *sequence != expectedSequence || *sampleCount == 0 || *sampleRate < 8'000 || *sampleRate > kMaximumSourceSampleRate ||
            *channels == 0 || *channels > kMaximumChannelCount || *checksum > std::numeric_limits<std::uint32_t>::max() ||
            domain::getField(chunk, "codec") != "none" || chunk.blob.empty() || chunk.blob.size() > kMaximumChunkBytes ||
            archive::crc32(chunk.blob) != *checksum) {
            failureError = core::error("transcription_audio_chunk_invalid",
                                       "An audio chunk is malformed, unsupported, or corrupt; transcription stopped.");
            return false;
        }
        const std::string currentFormat = domain::getField(chunk, "sample_format");
        const std::uint32_t currentSampleBytes = bytesPerSample(currentFormat);
        if (currentSampleBytes == 0 || *sampleCount > std::numeric_limits<std::uint64_t>::max() / (currentSampleBytes * *channels) ||
            *sampleCount * currentSampleBytes * *channels != chunk.blob.size()) {
            failureError = core::error("transcription_audio_chunk_invalid", "Audio sample metadata does not match the stored chunk bytes.");
            return false;
        }
        const bool firstChunk = !sawChunk;
        if (firstChunk) {
            sourceRateHz = static_cast<std::uint32_t>(*sampleRate);
            channelCount = static_cast<std::uint16_t>(*channels);
            sampleFormat = currentFormat;
            sawChunk = true;
        } else if (sourceRateHz != *sampleRate || channelCount != *channels || sampleFormat != currentFormat) {
            failureError = core::error("transcription_audio_format_changed", "Audio format changed within the selected track; split "
                                                                             "the recording into tracks.");
            return false;
        }
        if (*firstSample < previousEndSample || *gapBefore != *firstSample - previousEndSample || (firstChunk && *gapBefore != 0) ||
            *firstSample > std::numeric_limits<std::uint64_t>::max() - *sampleCount) {
            failureError =
                core::error("transcription_audio_timeline_invalid", "Audio chunk positions or recorded gap metadata are inconsistent.");
            return false;
        }
        const std::uint64_t chunkEnd = *firstSample + *sampleCount;
        auto chunkStartUs = sampleToMicroseconds(*firstSample, sourceRateHz);
        auto chunkEndUs = sampleToMicroseconds(chunkEnd, sourceRateHz);
        if (!chunkStartUs || !chunkEndUs) {
            failureError = !chunkStartUs ? chunkStartUs.error() : chunkEndUs.error();
            return false;
        }

        if (windowStoredSamples > 0 && *gapBefore > 0) {
            if (auto status = transcribeWindow(); !status) {
                failureError = status.error();
                return false;
            }
        }

        auto selectedStartSampleResult = microsecondsToSample(selectedStartUs, sourceRateHz, false);
        auto selectedEndSampleResult = options.endTimeUs ? microsecondsToSample(selectedEndUs, sourceRateHz, true)
                                                         : Result<std::uint64_t>(std::numeric_limits<std::uint64_t>::max());
        if (!selectedStartSampleResult || !selectedEndSampleResult) {
            failureError = !selectedStartSampleResult ? selectedStartSampleResult.error() : selectedEndSampleResult.error();
            return false;
        }
        const std::uint64_t selectedStartSample = *selectedStartSampleResult;
        const std::uint64_t selectedEndSample = *selectedEndSampleResult;
        if (chunkEnd > selectedStartSample && *firstSample < selectedEndSample) {
            const std::uint64_t overlapStart = std::max(*firstSample, selectedStartSample);
            const std::uint64_t overlapEnd = std::min(chunkEnd, selectedEndSample);
            if (windowStoredSamples == 0)
                windowFirstSample = overlapStart;
            if (auto status = appendMonoFrames(chunk, sampleFormat, channelCount, *firstSample, *sampleCount, selectedStartSample,
                                               selectedEndSample, sourceWindow);
                !status) {
                failureError = status.error();
                return false;
            }
            windowStoredSamples += overlapEnd - overlapStart;
            if (selectedAudioSamples > std::numeric_limits<std::uint64_t>::max() - (overlapEnd - overlapStart)) {
                failureError = core::error("transcription_audio_timeline_invalid", "Selected audio duration exceeds the supported range.");
                return false;
            }
            selectedAudioSamples += overlapEnd - overlapStart;
            const std::size_t windowCapacity = static_cast<std::size_t>(sourceRateHz) * kWindowSeconds;
            while (sourceWindow.size() >= windowCapacity) {
                std::vector<float> remainder(sourceWindow.begin() + static_cast<std::ptrdiff_t>(windowCapacity), sourceWindow.end());
                sourceWindow.resize(windowCapacity);
                if (auto status = transcribeWindow(); !status) {
                    failureError = status.error();
                    return false;
                }
                sourceWindow = std::move(remainder);
                if (!sourceWindow.empty()) {
                    windowFirstSample += windowCapacity;
                    windowStoredSamples = sourceWindow.size();
                }
            }
        }
        previousEndSample = chunkEnd;
        ++expectedSequence;
        return true;
    });
    if (!streamStatus)
        return std::unexpected(streamStatus.error());
    if (!failureError.code.empty()) {
        if (auto status = commitBatch(); !status) {
            return std::unexpected(core::error(
                status.error().code, failureError.message + " Saving completed transcript batches also failed: " + status.error().message));
        }
        if (committedSegments > 0) {
            failureError.message += " " + std::to_string(committedSegments) + " segment(s) were saved as provisional.";
        }
        return std::unexpected(std::move(failureError));
    }
    if (selectedAudioSamples == 0) {
        return std::unexpected(core::error("transcription_range_empty", "The selected time range does not overlap audio in this track."));
    }
    auto duration = sampleToMicroseconds(selectedAudioSamples, sourceRateHz);
    if (!duration)
        return std::unexpected(duration.error());
    summary.audioDurationUs = *duration;
    if (auto status = transcribeWindow(); !status) {
        if (auto commitStatus = commitBatch(); !commitStatus) {
            return std::unexpected(
                core::error(commitStatus.error().code,
                            status.error().message + " Saving completed transcript batches also failed: " + commitStatus.error().message));
        }
        return std::unexpected(core::error(
            status.error().code,
            status.error().message +
                (committedSegments > 0 ? " " + std::to_string(committedSegments) + " segment(s) were saved as provisional." : "")));
    }
    if (auto status = commitBatch(); !status)
        return std::unexpected(status.error());

    if (replacePrior) {
        std::vector<Record> superseded;
        superseded.reserve(kRecordsPerBatch);
        auto supersedeStatus = archive.forEach(
            RecordType::TranscriptSegment,
            [&](Record&& segment) {
                if (domain::getField(segment, "session_id") != archive::uuidToString(sessionId) ||
                    domain::getField(segment, "origin") != "local-whisper" ||
                    domain::getField(segment, "verification_state") != "provisional" || hasHumanTranscriptEdits(segment) ||
                    domain::getField(segment, "source_audio_track_id") != archive::uuidToString(*trackId) ||
                    domain::getField(segment, "source_run_id") == runId) {
                    return true;
                }
                std::uint64_t start = 0;
                std::uint64_t end = std::numeric_limits<std::uint64_t>::max();
                const std::string startField = domain::getField(segment, "start_time_us", "0");
                const std::string endField = domain::getField(segment, "end_time_us");
                const auto [startEnd, startError] = std::from_chars(startField.data(), startField.data() + startField.size(), start);
                const auto [rangeEnd, endError] = std::from_chars(endField.data(), endField.data() + endField.size(), end);
                if (startError != std::errc{} || startEnd != startField.data() + startField.size() || endError != std::errc{} ||
                    rangeEnd != endField.data() + endField.size() || start >= selectedEndUs || end <= selectedStartUs) {
                    return true;
                }
                segment.fields["_deleted"] = "true";
                segment.fields["superseded_by_run"] = runId;
                segment.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
                superseded.push_back(std::move(segment));
                if (superseded.size() < kRecordsPerBatch)
                    return true;
                const std::size_t batchCount = superseded.size();
                auto status = archive.putMany(std::move(superseded));
                superseded.clear();
                superseded.reserve(kRecordsPerBatch);
                if (status)
                    summary.segmentsSuperseded += batchCount;
                else {
                    failureError = status.error();
                    return false;
                }
                return true;
            },
            true);
        if (!supersedeStatus)
            return std::unexpected(supersedeStatus.error());
        if (!failureError.code.empty())
            return std::unexpected(
                core::error(failureError.code, "New transcript run was saved, but superseding earlier provisional segments "
                                               "stopped: " +
                                                   failureError.message));
        if (!superseded.empty()) {
            const std::size_t batchCount = superseded.size();
            if (auto status = archive.putMany(std::move(superseded)); !status) {
                return std::unexpected(
                    core::error(status.error().code, "New transcript run was saved, but earlier provisional segments could not "
                                                     "be fully superseded: " +
                                                         status.error().message));
            }
            summary.segmentsSuperseded += batchCount;
        }
    }
    if (auto status = processingState.finish(); !status)
        return std::unexpected(status.error());
    return summary;
}

#endif

} // namespace tutorux::transcription

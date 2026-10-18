#include "tutorux/audio/pipewire_backend.hpp"

#include "tutorux/domain/entities.hpp"
#include "capture_observer.hpp"
#include "preflight_metrics.hpp"

#if defined(__linux__) && defined(TUTORUX_HAS_PIPEWIRE)
#include <pipewire/pipewire.h>
#include <spa/param/audio/format-utils.h>
#include <spa/utils/dict.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>
#endif

namespace tutorux::audio {

bool isPipeWireDevice(std::string_view deviceId) noexcept {
    return deviceId.starts_with(kPipeWireDevicePrefix);
}

#if defined(__linux__) && defined(TUTORUX_HAS_PIPEWIRE)
namespace {

    constexpr std::uint32_t kPreferredSampleRateHz = 48'000;
    constexpr std::uint16_t kMaximumChannels = 8;
    constexpr std::size_t kRingCapacity = 8U * 1024U * 1024U;
    constexpr std::size_t kMaximumPendingBytes = 1U * 1024U * 1024U;

    void initializePipeWire() {
        static std::once_flag initialized;
        std::call_once(initialized, [] {
            pw_init(nullptr, nullptr);
        });
    }

    core::Error pipeWireError(std::string code, std::string_view operation, int errorCode) {
        return core::error(std::move(code), std::string(operation) + ": " + spa_strerror(errorCode));
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

    std::uint64_t samplesToMicroseconds(std::uint64_t samples, std::uint32_t sampleRateHz) {
        const std::uint64_t seconds = samples / sampleRateHz;
        const std::uint64_t remainder = samples % sampleRateHz;
        return seconds * 1'000'000ULL + (remainder * 1'000'000ULL) / sampleRateHz;
    }

    std::string pipeWireTarget(std::string_view deviceId) {
        return std::string(deviceId.substr(kPipeWireDevicePrefix.size()));
    }

    std::string deviceName(const spa_dict* properties, const char* primary, const char* fallback) {
        if (const char* value = spa_dict_lookup(properties, primary); value && *value)
            return value;
        if (const char* value = spa_dict_lookup(properties, fallback); value && *value)
            return value;
        return "PipeWire audio device";
    }

    struct Enumeration final {
        pw_main_loop* loop{};
        pw_context* context{};
        pw_core* core{};
        pw_registry* registry{};
        spa_hook coreListener{};
        spa_hook registryListener{};
        int sequence{};
        bool synchronized{};
        std::vector<DeviceInfo> devices;
    };

    void onRegistryGlobal(void* data, std::uint32_t, std::uint32_t, const char* type, std::uint32_t, const spa_dict* properties) {
        if (std::strcmp(type, PW_TYPE_INTERFACE_Node) != 0 || !properties)
            return;
        auto& state = *static_cast<Enumeration*>(data);
        const char* mediaClass = spa_dict_lookup(properties, PW_KEY_MEDIA_CLASS);
        if (!mediaClass)
            return;

        DeviceKind kind{};
        std::string label;
        if (std::strcmp(mediaClass, "Audio/Source") == 0) {
            kind = DeviceKind::microphone;
            label = deviceName(properties, PW_KEY_NODE_DESCRIPTION, PW_KEY_NODE_NAME);
        } else if (std::strcmp(mediaClass, "Audio/Sink") == 0) {
            kind = DeviceKind::playback;
            label = "System audio: " + deviceName(properties, PW_KEY_NODE_DESCRIPTION, PW_KEY_NODE_NAME);
        } else if (std::strcmp(mediaClass, "Stream/Output/Audio") == 0) {
            kind = DeviceKind::application;
            label = "Application audio: " + deviceName(properties, PW_KEY_APP_NAME, PW_KEY_NODE_DESCRIPTION);
        } else {
            return;
        }

        const char* target = spa_dict_lookup(properties, PW_KEY_OBJECT_SERIAL);
        if (!target || !*target)
            target = spa_dict_lookup(properties, PW_KEY_NODE_NAME);
        if (!target || !*target)
            return;

        const std::string id = std::string(kPipeWireDevicePrefix) + target;
        if (std::none_of(state.devices.begin(), state.devices.end(), [&](const DeviceInfo& device) {
                return device.id == id;
            })) {
            state.devices.push_back({id, std::move(label), kind, false});
        }
    }

    void onRegistryDone(void* data, std::uint32_t id, int sequence) {
        auto& state = *static_cast<Enumeration*>(data);
        if (id == PW_ID_CORE && sequence == state.sequence)
            state.synchronized = true;
    }

    core::Result<std::vector<DeviceInfo>> enumeratePipeWireNodes() {
        initializePipeWire();
        Enumeration state;
        state.loop = pw_main_loop_new(nullptr);
        if (!state.loop)
            return std::unexpected(core::error("audio_pipewire_loop_failed", "Creating the PipeWire event loop failed."));
        state.context = pw_context_new(pw_main_loop_get_loop(state.loop), nullptr, 0);
        if (!state.context) {
            pw_main_loop_destroy(state.loop);
            return std::unexpected(core::error("audio_pipewire_context_failed", "Creating the PipeWire context failed."));
        }
        state.core = pw_context_connect(state.context, nullptr, 0);
        if (!state.core) {
            pw_context_destroy(state.context);
            pw_main_loop_destroy(state.loop);
            return std::unexpected(core::error("audio_pipewire_connect_failed", "Connecting to the PipeWire audio service failed."));
        }
        state.registry = pw_core_get_registry(state.core, PW_VERSION_REGISTRY, 0);
        if (!state.registry) {
            pw_core_disconnect(state.core);
            pw_context_destroy(state.context);
            pw_main_loop_destroy(state.loop);
            return std::unexpected(core::error("audio_pipewire_registry_failed", "Opening the PipeWire device registry failed."));
        }

        static const pw_core_events coreEvents = [] {
            pw_core_events events{};
            events.version = PW_VERSION_CORE_EVENTS;
            events.done = onRegistryDone;
            return events;
        }();
        static const pw_registry_events registryEvents = [] {
            pw_registry_events events{};
            events.version = PW_VERSION_REGISTRY_EVENTS;
            events.global = onRegistryGlobal;
            return events;
        }();
        pw_core_add_listener(state.core, &state.coreListener, &coreEvents, &state);
        pw_registry_add_listener(state.registry, &state.registryListener, &registryEvents, &state);
        state.sequence = pw_core_sync(state.core, PW_ID_CORE, 0);
        if (state.sequence < 0) {
            spa_hook_remove(&state.registryListener);
            spa_hook_remove(&state.coreListener);
            pw_proxy_destroy(reinterpret_cast<pw_proxy*>(state.registry));
            pw_core_disconnect(state.core);
            pw_context_destroy(state.context);
            pw_main_loop_destroy(state.loop);
            return std::unexpected(pipeWireError("audio_pipewire_sync_failed", "Synchronizing the PipeWire device list", state.sequence));
        }

        const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
        while (!state.synchronized && std::chrono::steady_clock::now() < deadline) {
            if (pw_main_loop_iterate(state.loop, 100, true) < 0)
                break;
        }
        spa_hook_remove(&state.registryListener);
        spa_hook_remove(&state.coreListener);
        pw_proxy_destroy(reinterpret_cast<pw_proxy*>(state.registry));
        pw_core_disconnect(state.core);
        pw_context_destroy(state.context);
        pw_main_loop_destroy(state.loop);
        if (!state.synchronized) {
            return std::unexpected(core::error("audio_pipewire_timeout", "Timed out while enumerating PipeWire audio devices."));
        }
        return std::move(state.devices);
    }

    struct StreamState final {
        pw_stream* stream{};
        pw_stream_state state{PW_STREAM_STATE_UNCONNECTED};
        bool formatReady{};
        std::uint32_t sampleRateHz{};
        std::uint16_t channelCount{};
        std::string errorMessage;
        std::unique_ptr<std::byte[]> ring{std::make_unique<std::byte[]>(kRingCapacity)};
        std::atomic<std::uint64_t> writeIndex{};
        std::atomic<std::uint64_t> readIndex{};
        std::atomic<bool> ringOverflow{};
    };

    void onStreamStateChanged(void* data, pw_stream_state previousState, pw_stream_state state, const char* error) {
        auto& stream = *static_cast<StreamState*>(data);
        stream.state = state;
        if (state == PW_STREAM_STATE_ERROR) {
            stream.errorMessage = error && *error ? error : "The PipeWire stream entered an error state.";
        } else if (state == PW_STREAM_STATE_UNCONNECTED &&
                   (previousState == PW_STREAM_STATE_STREAMING || previousState == PW_STREAM_STATE_PAUSED)) {
            stream.errorMessage = error && *error ? error : "The PipeWire connection was lost during capture.";
        }
    }

    void onStreamParamChanged(void* data, std::uint32_t id, const spa_pod* parameter) {
        auto& stream = *static_cast<StreamState*>(data);
        if (id != SPA_PARAM_Format)
            return;
        if (!parameter) {
            stream.formatReady = false;
            stream.errorMessage = "PipeWire withdrew the negotiated audio format during capture.";
            return;
        }
        spa_audio_info format{};
        if (spa_format_parse(parameter, &format.media_type, &format.media_subtype) < 0 || format.media_type != SPA_MEDIA_TYPE_audio ||
            format.media_subtype != SPA_MEDIA_SUBTYPE_raw || spa_format_audio_raw_parse(parameter, &format.info.raw) < 0 ||
            format.info.raw.format != SPA_AUDIO_FORMAT_S16_LE || format.info.raw.rate < 8'000 || format.info.raw.rate > 384'000 ||
            format.info.raw.channels == 0 || format.info.raw.channels > kMaximumChannels) {
            stream.errorMessage = "PipeWire negotiated an unsupported audio format.";
            return;
        }
        stream.sampleRateHz = format.info.raw.rate;
        stream.channelCount = static_cast<std::uint16_t>(format.info.raw.channels);
        stream.formatReady = true;
    }

    void onStreamProcess(void* data) {
        auto& stream = *static_cast<StreamState*>(data);
        pw_buffer* pipeBuffer = pw_stream_dequeue_buffer(stream.stream);
        if (!pipeBuffer)
            return;

        spa_buffer* buffer = pipeBuffer->buffer;
        if (buffer && buffer->n_datas > 0) {
            spa_data& audioData = buffer->datas[0];
            if (audioData.data && audioData.chunk && audioData.chunk->size > 0 && stream.formatReady) {
                const std::size_t offset = audioData.chunk->offset;
                const std::size_t bytes = audioData.chunk->size;
                const std::size_t bytesPerFrame = static_cast<std::size_t>(stream.channelCount) * sizeof(std::int16_t);
                const std::size_t stride = audioData.chunk->stride > 0 ? static_cast<std::size_t>(audioData.chunk->stride) : bytesPerFrame;
                if (offset > audioData.maxsize || bytes > audioData.maxsize - offset || stride != bytesPerFrame || bytes % stride != 0) {
                    stream.errorMessage = "PipeWire returned a malformed interleaved PCM buffer.";
                } else {
                    const auto write = stream.writeIndex.load(std::memory_order_relaxed);
                    const auto read = stream.readIndex.load(std::memory_order_acquire);
                    const auto used = write - read;
                    if (bytes > kRingCapacity - used) {
                        stream.ringOverflow.store(true, std::memory_order_release);
                    } else {
                        const std::size_t ringOffset = static_cast<std::size_t>(write % kRingCapacity);
                        const std::size_t firstPart = std::min(bytes, kRingCapacity - ringOffset);
                        std::memcpy(stream.ring.get() + ringOffset, static_cast<const std::byte*>(audioData.data) + offset, firstPart);
                        if (bytes > firstPart) {
                            std::memcpy(stream.ring.get(), static_cast<const std::byte*>(audioData.data) + offset + firstPart,
                                        bytes - firstPart);
                        }
                        stream.writeIndex.store(write + bytes, std::memory_order_release);
                    }
                }
            }
        }
        if (pw_stream_queue_buffer(stream.stream, pipeBuffer) < 0 && stream.errorMessage.empty())
            stream.errorMessage = "Returning a PipeWire capture buffer failed.";
    }

    const pw_stream_events& streamEvents() {
        static const pw_stream_events events = [] {
            pw_stream_events value{};
            value.version = PW_VERSION_STREAM_EVENTS;
            value.state_changed = onStreamStateChanged;
            value.param_changed = onStreamParamChanged;
            value.process = onStreamProcess;
            return value;
        }();
        return events;
    }

    class PipeWireCapture final {
      public:
        PipeWireCapture() {
            initializePipeWire();
            loop_ = pw_main_loop_new(nullptr);
            if (!loop_)
                failure_ = core::error("audio_pipewire_loop_failed", "Creating the PipeWire event loop failed.");
        }
        PipeWireCapture(const PipeWireCapture&) = delete;
        PipeWireCapture& operator=(const PipeWireCapture&) = delete;
        ~PipeWireCapture() {
            if (stream_.stream)
                pw_stream_destroy(stream_.stream);
            if (loop_)
                pw_main_loop_destroy(loop_);
        }

        core::Status connect(DeviceKind source, std::string_view deviceId, bool inactive) {
            if (failure_)
                return std::unexpected(*failure_);
            if (!isPipeWireDevice(deviceId))
                return std::unexpected(core::error("audio_pipewire_device_invalid", "A PipeWire device ID is required."));

            pw_properties* properties =
                pw_properties_new(PW_KEY_MEDIA_TYPE, "Audio", PW_KEY_MEDIA_CATEGORY, "Capture", PW_KEY_MEDIA_ROLE, "Communication",
                                  PW_KEY_MEDIA_NAME, "Tutorux recording", PW_KEY_NODE_NAME, "tutorux.capture", nullptr);
            if (!properties)
                return std::unexpected(core::error("audio_pipewire_properties_failed", "Creating PipeWire stream properties failed."));
            const std::string target = pipeWireTarget(deviceId);
            if (target.empty()) {
                pw_properties_free(properties);
                return std::unexpected(core::error("audio_pipewire_device_invalid", "The PipeWire device ID has no target."));
            }
            int propertyResult = pw_properties_set(properties, PW_KEY_TARGET_OBJECT, target.c_str());
            if (propertyResult >= 0 && source == DeviceKind::playback)
                propertyResult = pw_properties_set(properties, PW_KEY_STREAM_CAPTURE_SINK, "true");
            if (propertyResult < 0) {
                pw_properties_free(properties);
                return std::unexpected(
                    pipeWireError("audio_pipewire_properties_failed", "Setting the PipeWire capture target", propertyResult));
            }

            stream_.stream =
                pw_stream_new_simple(pw_main_loop_get_loop(loop_), "Tutorux Audio Capture", properties, &streamEvents(), &stream_);
            if (!stream_.stream)
                return std::unexpected(core::error("audio_pipewire_stream_failed", "Creating the PipeWire capture stream failed."));

            std::array<std::byte, 1024> podStorage{};
            spa_pod_builder builder = SPA_POD_BUILDER_INIT(podStorage.data(), podStorage.size());
            spa_audio_info_raw requestedFormat{};
            requestedFormat.format = SPA_AUDIO_FORMAT_S16_LE;
            const spa_pod* parameters[] = {
                spa_format_audio_raw_build(&builder, SPA_PARAM_EnumFormat, &requestedFormat),
            };
            if (!parameters[0])
                return std::unexpected(core::error("audio_pipewire_format_failed", "Building the PipeWire audio format request failed."));

            auto flags = static_cast<pw_stream_flags>(PW_STREAM_FLAG_AUTOCONNECT | PW_STREAM_FLAG_MAP_BUFFERS);
            if (inactive)
                flags = static_cast<pw_stream_flags>(flags | PW_STREAM_FLAG_INACTIVE);
            const int result = pw_stream_connect(stream_.stream, PW_DIRECTION_INPUT, PW_ID_ANY, flags, parameters, 1);
            if (result < 0)
                return std::unexpected(pipeWireError("audio_pipewire_connect_failed", "Connecting the PipeWire capture stream", result));

            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
            while (std::chrono::steady_clock::now() < deadline) {
                if (auto status = iterate(100); !status)
                    return status;
                const bool connected = inactive ? stream_.state == PW_STREAM_STATE_PAUSED || stream_.state == PW_STREAM_STATE_STREAMING
                                                : stream_.state == PW_STREAM_STATE_STREAMING;
                if (connected && stream_.formatReady)
                    return {};
            }
            return std::unexpected(core::error("audio_pipewire_timeout", "Timed out while opening the PipeWire audio stream."));
        }

        core::Status activate(bool active) {
            const int result = pw_stream_set_active(stream_.stream, active);
            if (result < 0)
                return std::unexpected(pipeWireError("audio_pipewire_state_failed", "Changing PipeWire stream activity", result));
            const auto expected = active ? PW_STREAM_STATE_STREAMING : PW_STREAM_STATE_PAUSED;
            const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
            while (stream_.state != expected && std::chrono::steady_clock::now() < deadline) {
                if (auto status = iterate(100); !status)
                    return status;
            }
            if (stream_.state != expected)
                return std::unexpected(core::error("audio_pipewire_timeout", active ? "PipeWire did not start the capture stream."
                                                                                    : "PipeWire did not pause the capture stream."));
            return {};
        }

        core::Status iterate(int timeoutMilliseconds = 50) {
            const int result = pw_main_loop_iterate(loop_, timeoutMilliseconds, true);
            if (result < 0)
                return std::unexpected(pipeWireError("audio_pipewire_loop_failed", "Running the PipeWire event loop", result));
            if (!stream_.errorMessage.empty())
                return std::unexpected(core::error("audio_pipewire_stream_failed", stream_.errorMessage));
            if (stream_.ringOverflow.load(std::memory_order_acquire))
                return std::unexpected(
                    core::error("audio_pipewire_overrun", "PipeWire capture exceeded the bounded PCM buffer; recording stopped."));
            return {};
        }

        bool formatReady() const {
            return stream_.formatReady;
        }
        std::uint32_t sampleRateHz() const {
            return stream_.sampleRateHz;
        }
        std::uint16_t channelCount() const {
            return stream_.channelCount;
        }

        std::size_t read(std::span<std::byte> output) {
            const auto read = stream_.readIndex.load(std::memory_order_relaxed);
            const auto write = stream_.writeIndex.load(std::memory_order_acquire);
            const std::size_t available = static_cast<std::size_t>(write - read);
            const std::size_t bytes = std::min(output.size(), available);
            const std::size_t ringOffset = static_cast<std::size_t>(read % kRingCapacity);
            const std::size_t firstPart = std::min(bytes, kRingCapacity - ringOffset);
            std::memcpy(output.data(), stream_.ring.get() + ringOffset, firstPart);
            if (bytes > firstPart)
                std::memcpy(output.data() + firstPart, stream_.ring.get(), bytes - firstPart);
            stream_.readIndex.store(read + bytes, std::memory_order_release);
            return bytes;
        }

        std::size_t available() const {
            return static_cast<std::size_t>(stream_.writeIndex.load(std::memory_order_acquire) -
                                            stream_.readIndex.load(std::memory_order_relaxed));
        }

      private:
        pw_main_loop* loop_{};
        StreamState stream_;
        std::optional<core::Error> failure_;
    };

    core::Status updateRecordingSession(archive::Archive& archive, archive::Record& session, std::string state, std::uint64_t chunks,
                                        std::uint64_t samples, std::uint64_t bytes, std::string error = {}) {
        session.fields["recording_state"] = std::move(state);
        session.fields["recording_audio_chunks"] = std::to_string(chunks);
        session.fields["recording_samples"] = std::to_string(samples);
        session.fields["recording_bytes"] = std::to_string(bytes);
        session.fields["recording_error"] = std::move(error);
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        return archive.put(session);
    }

    core::Status appendCapturedChunk(archive::Archive& archive, archive::Record& session, const archive::Uuid& sessionId,
                                     const archive::Uuid& trackId, std::uint64_t sequence, std::uint64_t firstSample,
                                     std::uint64_t frameCount, std::uint64_t storedSamples, std::uint64_t storedBytes,
                                     std::uint32_t sampleRateHz, std::uint16_t channelCount, archive::Bytes payload) {
        archive::Record chunk;
        chunk.type = archive::RecordType::AudioChunk;
        chunk.id = archive::randomUuid();
        chunk.fields = {
            {"session_id", archive::uuidToString(sessionId)},
            {"track_id", archive::uuidToString(trackId)},
            {"sequence_number", std::to_string(sequence)},
            {"first_sample_index", std::to_string(firstSample)},
            {"sample_count", std::to_string(frameCount)},
            {"gap_before_samples", "0"},
            {"timeline_start_us", std::to_string(samplesToMicroseconds(firstSample, sampleRateHz))},
            {"timeline_end_us", std::to_string(samplesToMicroseconds(firstSample + frameCount, sampleRateHz))},
            {"sample_format", "pcm_s16le"},
            {"sample_rate_hz", std::to_string(sampleRateHz)},
            {"channel_count", std::to_string(channelCount)},
            {"channel_mask", "0"},
            {"codec", "none"},
            {"source", domain::getField(session, "recording_source")},
            {"contains_device_discontinuity", "false"},
            {"payload_checksum", std::to_string(archive::crc32(payload))}
        };
        chunk.blob = std::move(payload);
        const std::uint64_t payloadBytes = chunk.blob.size();
        if (payloadBytes > std::numeric_limits<std::uint64_t>::max() - storedBytes ||
            frameCount > std::numeric_limits<std::uint64_t>::max() - storedSamples ||
            frameCount > std::numeric_limits<std::uint64_t>::max() - firstSample) {
            return std::unexpected(core::error("audio_capture_counter_invalid", "Recording counters overflowed."));
        }
        session.fields["recording_audio_chunks"] = std::to_string(sequence + 1);
        session.fields["recording_samples"] = std::to_string(storedSamples + frameCount);
        session.fields["recording_timeline_samples"] = std::to_string(firstSample + frameCount);
        session.fields["recording_bytes"] = std::to_string(storedBytes + payloadBytes);
        session.fields["recording_state"] = "recording";
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        std::vector<archive::Record> transaction;
        transaction.reserve(2);
        transaction.push_back(std::move(chunk));
        transaction.push_back(session);
        return archive.putMany(std::move(transaction));
    }

    core::Result<CaptureDeviceProbe> makeProbe(PipeWireCapture& stream, std::string deviceId) {
        return CaptureDeviceProbe{std::move(deviceId), "pcm_s16le", stream.sampleRateHz(), stream.channelCount()};
    }

} // namespace

core::Result<std::vector<DeviceInfo>> enumeratePipeWireDevices() {
    return enumeratePipeWireNodes();
}

core::Result<CaptureDeviceProbe> probePipeWireCaptureDevice(DeviceKind source, std::string deviceId) {
    if ((source == DeviceKind::microphone || source == DeviceKind::playback || source == DeviceKind::application) &&
        !isPipeWireDevice(deviceId)) {
        return std::unexpected(core::error("audio_pipewire_device_invalid", "The selected device is not a PipeWire endpoint."));
    }
    PipeWireCapture stream;
    if (auto status = stream.connect(source, deviceId, false); !status)
        return std::unexpected(status.error());
    return makeProbe(stream, std::move(deviceId));
}

core::Result<CapturePreflightSummary> preflightPipeWireCaptureDevice(CapturePreflightOptions options) {
    if (auto status = detail::validatePreflightOptions(options); !status)
        return std::unexpected(status.error());
    if (!isPipeWireDevice(options.deviceId))
        return std::unexpected(core::error("audio_pipewire_device_invalid", "Select a PipeWire microphone before checking input."));

    PipeWireCapture stream;
    if (auto status = stream.connect(DeviceKind::microphone, options.deviceId, false); !status)
        return std::unexpected(status.error());
    if (auto status = stream.activate(true); !status)
        return std::unexpected(status.error());

    CaptureDeviceProbe device{options.deviceId, "pcm_s16le", stream.sampleRateHz(), stream.channelCount()};
    detail::LevelAccumulator levels;
    std::vector<std::byte> buffer(kMaximumPendingBytes);
    const auto startedAt = std::chrono::steady_clock::now();
    auto lastNotification = startedAt;
    std::uint64_t framesMeasured = 0;
    const auto deadline = startedAt + options.duration;
    while (std::chrono::steady_clock::now() < deadline) {
        if (auto status = stream.iterate(50); !status)
            return std::unexpected(status.error());
        const std::size_t bytes = stream.read(buffer);
        const std::size_t bytesPerFrame = static_cast<std::size_t>(device.channelCount) * sizeof(std::int16_t);
        const std::size_t alignedBytes = bytes - bytes % bytesPerFrame;
        for (std::size_t offset = 0; offset < alignedBytes; offset += sizeof(std::int16_t)) {
            std::int16_t sample{};
            std::memcpy(&sample, buffer.data() + offset, sizeof(sample));
            levels.add(static_cast<double>(sample) / 32'768.0);
        }
        const std::uint64_t frames = alignedBytes / bytesPerFrame;
        if (frames > std::numeric_limits<std::uint64_t>::max() - framesMeasured)
            return std::unexpected(core::error("audio_preflight_counter_invalid", "PipeWire microphone check counter overflowed."));
        framesMeasured += frames;

        const auto now = std::chrono::steady_clock::now();
        if (now - lastNotification >= options.levelInterval) {
            auto level = detail::makeCaptureInputLevel(levels.takeWindow(), device.channelCount,
                                                       std::chrono::duration_cast<std::chrono::milliseconds>(now - startedAt));
            level.framesMeasured = framesMeasured;
            if (auto status = detail::notifyPreflightLevel(options, level); !status)
                return std::unexpected(status.error());
            lastNotification = now;
        }
    }
    const auto finishedAt = std::chrono::steady_clock::now();
    auto finalLevel = detail::makeCaptureInputLevel(levels.takeWindow(), device.channelCount,
                                                    std::chrono::duration_cast<std::chrono::milliseconds>(finishedAt - startedAt));
    finalLevel.framesMeasured = framesMeasured;
    if (finalLevel.framesInInterval != 0) {
        if (auto status = detail::notifyPreflightLevel(options, finalLevel); !status)
            return std::unexpected(status.error());
    }
    if (framesMeasured == 0)
        return std::unexpected(core::error("audio_preflight_no_samples", "The PipeWire microphone produced no samples during the check."));
    return detail::makeCapturePreflightSummary(std::move(device), levels.total(),
                                               std::chrono::duration_cast<std::chrono::milliseconds>(finishedAt - startedAt));
}

core::Result<CaptureSummary> capturePipeWire(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
    if (!isPipeWireDevice(options.deviceId))
        return std::unexpected(core::error("audio_pipewire_device_invalid", "Select a PipeWire device before starting capture."));
    if (options.maximumDuration && options.maximumDuration->count() <= 0)
        return std::unexpected(core::error("audio_capture_duration_invalid", "Maximum capture duration must be positive."));

    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult))
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    archive::Record session = std::move(**sessionResult);
    const std::string existingState = domain::getField(session, "recording_state");
    if (existingState == "initializing" || existingState == "recording" || existingState == "paused" || existingState == "finalizing")
        return std::unexpected(core::error("audio_capture_session_busy", "Session already has an active recording."));
    bool hasAudio = false;
    if (auto status = archive.forEachAudioChunk(sessionId, options.trackId,
                                                [&](archive::Record&&) {
                                                    hasAudio = true;
                                                    return false;
                                                });
        !status) {
        return std::unexpected(status.error());
    }
    if (hasAudio)
        return std::unexpected(
            core::error("audio_capture_audio_exists", "Session already contains audio. Create a new session or explicitly merge audio."));

    CaptureSummary summary;
    summary.trackId = options.trackId.value_or(archive::randomUuid());
    summary.deviceId = options.deviceId;
    summary.sampleFormat = "pcm_s16le";
    summary.sampleRateHz = kPreferredSampleRateHz;
    summary.channelCount = 2;
    session.fields["recording_track_id"] = archive::uuidToString(summary.trackId);
    const std::string sourceName = options.source == DeviceKind::microphone ? "microphone"
                                   : options.source == DeviceKind::playback ? "system-audio-loopback"
                                                                            : "application-audio";
    session.fields["recording_source"] = sourceName;
    session.fields["recording_source_backend"] = "pipewire";
    session.fields["recording_durability"] = options.durability == DurabilityPolicy::maximum        ? "maximum"
                                             : options.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                    : "default";
    session.fields["recording_device_id"] = options.deviceId;
    session.fields["recording_consent"] = "explicit";
    session.fields["recording_consent_at_us"] = std::to_string(nowUnixMicroseconds());
    session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
    session.fields["recording_consent_sources"] = sourceName;
    session.fields["recording_consent_policy_version"] = "1";
    session.fields["recording_sample_format"] = "pcm_s16le";
    session.fields["recording_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
    session.fields["recording_channel_count"] = std::to_string(summary.channelCount);
    session.fields["recording_channel_mask"] = "0";
    const std::uint64_t recordingStartedAtUs = nowUnixMicroseconds();
    session.fields["recording_started_at_us"] = std::to_string(recordingStartedAtUs);
    session.fields["recording_audio_chunks"] = "0";
    session.fields["recording_samples"] = "0";
    session.fields["recording_timeline_samples"] = "0";
    session.fields["recording_bytes"] = "0";
    session.fields["recording_discontinuities"] = "0";
    if (auto status = updateRecordingSession(archive, session, "initializing", 0, 0, 0); !status)
        return std::unexpected(status.error());
    if (options.stateChanged)
        options.stateChanged("initializing", "Preparing the selected PipeWire input.");

    PipeWireCapture stream;
    if (auto status = stream.connect(options.source, options.deviceId, true); !status) {
        updateRecordingSession(archive, session, "failed", 0, 0, 0, status.error().message);
        return std::unexpected(status.error());
    }
    summary.sampleRateHz = stream.sampleRateHz();
    summary.channelCount = stream.channelCount();
    session.fields["recording_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
    session.fields["recording_channel_count"] = std::to_string(summary.channelCount);
    if (options.waitForSynchronizedStart && !options.waitForSynchronizedStart()) {
        const auto error =
            core::error("audio_synchronized_start_cancelled", "A synchronized capture peer failed before both tracks started.");
        updateRecordingSession(archive, session, "failed", 0, 0, 0, error.message);
        return std::unexpected(error);
    }
    if (auto status = stream.activate(true); !status) {
        updateRecordingSession(archive, session, "failed", 0, 0, 0, status.error().message);
        return std::unexpected(status.error());
    }
    if (auto status = updateRecordingSession(archive, session, "recording", 0, 0, 0); !status)
        return std::unexpected(status.error());
    if (options.stateChanged)
        options.stateChanged("recording", "PipeWire capture is active.");

    const std::uint64_t intervalMilliseconds = options.durability == DurabilityPolicy::maximum        ? 100U
                                               : options.durability == DurabilityPolicy::reducedWrite ? 2'000U
                                                                                                      : 500U;
    const std::uint64_t bytesPerFrame = static_cast<std::uint64_t>(summary.channelCount) * sizeof(std::int16_t);
    const std::uint64_t framesPerChunk =
        std::max<std::uint64_t>(1, static_cast<std::uint64_t>(summary.sampleRateHz) * intervalMilliseconds / 1'000U);
    const std::uint64_t safeFramesPerChunk = std::max<std::uint64_t>(1, std::min(framesPerChunk, kMaximumPendingBytes / bytesPerFrame));
    archive::Bytes pending;
    pending.reserve(static_cast<std::size_t>(safeFramesPerChunk * bytesPerFrame));
    archive::Bytes ringBytes(kMaximumPendingBytes);
    std::uint64_t sequence = 0;
    std::uint64_t storedSamples = 0;
    std::uint64_t storedBytes = 0;
    std::uint64_t timelineEndSample = 0;
    bool paused = false;
    auto startedAt = std::chrono::steady_clock::now();
    auto pausedAt = std::chrono::steady_clock::time_point{};
    auto totalPause = std::chrono::steady_clock::duration::zero();
    std::optional<core::Error> streamFailure;

    const auto writePending = [&]() -> core::Status {
        if (pending.empty())
            return {};
        if (pending.size() % bytesPerFrame != 0 || sequence == std::numeric_limits<std::uint64_t>::max())
            return std::unexpected(core::error("audio_capture_chunk_invalid", "PipeWire produced an incomplete audio frame."));
        const std::uint64_t frames = pending.size() / bytesPerFrame;
        archive::Bytes payload = std::move(pending);
        pending.clear();
        pending.reserve(static_cast<std::size_t>(safeFramesPerChunk * bytesPerFrame));
        archive::Bytes observerSamples;
        if (options.pcmChunk && !summary.pcmObserverFailure)
            observerSamples = payload;
        if (auto status = appendCapturedChunk(archive, session, sessionId, summary.trackId, sequence, timelineEndSample, frames,
                                              storedSamples, storedBytes, summary.sampleRateHz, summary.channelCount, std::move(payload));
            !status)
            return status;
        if (!observerSamples.empty())
            detail::notifyPcmChunk(options, summary, recordingStartedAtUs, timelineEndSample, frames, observerSamples);
        ++sequence;
        storedSamples += frames;
        timelineEndSample += frames;
        storedBytes += frames * bytesPerFrame;
        summary.chunkCount = sequence;
        summary.sampleCount = storedSamples;
        summary.timelineSampleCount = timelineEndSample;
        summary.byteCount = storedBytes;
        summary.durationUs = samplesToMicroseconds(timelineEndSample, summary.sampleRateHz);
        if (options.progress)
            options.progress(summary);
        return {};
    };

    const auto drainStream = [&]() -> core::Status {
        const std::size_t targetBytes = static_cast<std::size_t>(safeFramesPerChunk * bytesPerFrame);
        while (stream.available() != 0) {
            if (pending.size() == targetBytes) {
                if (auto status = writePending(); !status)
                    return status;
            }
            const std::size_t capacity = targetBytes - pending.size();
            const std::size_t amount = std::min({stream.available(), ringBytes.size(), capacity});
            const std::size_t read = stream.read(std::span(ringBytes).first(amount));
            if (read == 0)
                break;
            pending.insert(pending.end(), ringBytes.begin(), ringBytes.begin() + static_cast<std::ptrdiff_t>(read));
            if (pending.size() == targetBytes) {
                if (auto status = writePending(); !status)
                    return status;
            }
        }
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
            if (auto status = stream.activate(false); !status) {
                streamFailure = status.error();
                break;
            }
            if (auto status = updateRecordingSession(archive, session, "paused", sequence, storedSamples, storedBytes); !status) {
                streamFailure = status.error();
                break;
            }
            paused = true;
            pausedAt = now;
            if (options.stateChanged)
                options.stateChanged("paused", "PipeWire capture is paused.");
        }
        if (paused) {
            if (options.stopRequested && options.stopRequested())
                break;
            if (options.pauseRequested && !options.pauseRequested()) {
                if (auto status = stream.activate(true); !status) {
                    streamFailure = status.error();
                    break;
                }
                const auto resumedAt = std::chrono::steady_clock::now();
                totalPause += resumedAt - pausedAt;
                paused = false;
                if (auto status = updateRecordingSession(archive, session, "recording", sequence, storedSamples, storedBytes); !status) {
                    streamFailure = status.error();
                    break;
                }
                if (options.stateChanged)
                    options.stateChanged("recording", "PipeWire capture resumed.");
            } else {
                if (auto status = stream.iterate(50); !status) {
                    streamFailure = status.error();
                    break;
                }
                continue;
            }
        }
        if (options.maximumDuration && now - startedAt - totalPause >= *options.maximumDuration)
            break;
        if (auto status = stream.iterate(50); !status) {
            streamFailure = status.error();
            break;
        }
        if (auto status = drainStream(); !status) {
            streamFailure = status.error();
            break;
        }
    }
    if (!streamFailure) {
        if (auto status = drainStream(); !status)
            streamFailure = status.error();
        if (!streamFailure) {
            if (auto status = writePending(); !status)
                streamFailure = status.error();
        }
    }
    if (streamFailure) {
        const std::string state = sequence == 0 ? "failed" : "interrupted";
        if (auto status = updateRecordingSession(archive, session, state, sequence, storedSamples, storedBytes, streamFailure->message);
            !status) {
            return std::unexpected(core::error(
                streamFailure->code, streamFailure->message + " Unable to persist the capture failure state: " + status.error().message));
        }
        if (options.stateChanged)
            options.stateChanged(state, streamFailure->message);
        return std::unexpected(*streamFailure);
    }

    session.fields["recording_stopped_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = updateRecordingSession(archive, session, "completed", sequence, storedSamples, storedBytes); !status)
        return std::unexpected(status.error());
    summary.completed = true;
    summary.state = "completed";
    if (options.stateChanged)
        options.stateChanged("completed", "Recording is durably saved.");
    return summary;
}

#else

core::Result<std::vector<DeviceInfo>> enumeratePipeWireDevices() {
    return std::vector<DeviceInfo>{};
}

core::Result<CaptureDeviceProbe> probePipeWireCaptureDevice(DeviceKind, std::string) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the PipeWire backend."));
}

core::Result<CapturePreflightSummary> preflightPipeWireCaptureDevice(CapturePreflightOptions) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the PipeWire backend."));
}

core::Result<CaptureSummary> capturePipeWire(archive::Archive&, const archive::Uuid&, CaptureOptions) {
    return std::unexpected(core::error("audio_backend_unavailable", "This build does not include the PipeWire backend."));
}

#endif

} // namespace tutorux::audio

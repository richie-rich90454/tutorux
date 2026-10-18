#include "playback_platform.hpp"

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <audioclient.h>
#include <ksmedia.h>
#include <mmdeviceapi.h>
#endif

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <string>
#include <vector>

namespace tutorux::audio::detail {

#ifdef _WIN32
namespace {

    constexpr std::size_t framesPerBuffer = 4'096;
    constexpr DWORD playbackWaitMilliseconds = 100;
    constexpr GUID pcmSubFormat{
        0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}
    };
    constexpr DWORD speakerMasks[] = {
        0,
        SPEAKER_FRONT_CENTER,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT |
            SPEAKER_BACK_RIGHT,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY |
            SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_BACK_LEFT |
            SPEAKER_BACK_RIGHT | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT,
        SPEAKER_FRONT_LEFT | SPEAKER_FRONT_RIGHT | SPEAKER_FRONT_CENTER | SPEAKER_LOW_FREQUENCY |
            SPEAKER_BACK_LEFT | SPEAKER_BACK_RIGHT | SPEAKER_SIDE_LEFT | SPEAKER_SIDE_RIGHT,
    };

    core::Error wasapiError(std::string_view operation, HRESULT result) {
        return core::error("audio_playback_device_failed",
                           std::string(operation) + " failed (HRESULT " +
                               std::to_string(static_cast<unsigned long>(result)) + ").");
    }

    template <typename Interface> class ComOwner final {
      public:
        ComOwner() = default;
        ComOwner(const ComOwner&) = delete;
        ComOwner& operator=(const ComOwner&) = delete;
        ~ComOwner() {
            if (value_)
                value_->Release();
        }

        Interface** put() noexcept {
            if (value_) {
                value_->Release();
                value_ = nullptr;
            }
            return &value_;
        }

        Interface* operator->() const noexcept {
            return value_;
        }

      private:
        Interface* value_{};
    };

    class ComApartment final {
      public:
        ComApartment()
            : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
        ComApartment(const ComApartment&) = delete;
        ComApartment& operator=(const ComApartment&) = delete;
        ~ComApartment() {
            if (result_ == S_OK || result_ == S_FALSE)
                CoUninitialize();
        }

        HRESULT result() const noexcept {
            return result_;
        }

      private:
        HRESULT result_{};
    };

    class EventHandle final {
      public:
        EventHandle()
            : handle_(CreateEventW(nullptr, FALSE, FALSE, nullptr)) {}
        EventHandle(const EventHandle&) = delete;
        EventHandle& operator=(const EventHandle&) = delete;
        ~EventHandle() {
            if (handle_)
                CloseHandle(handle_);
        }

        HANDLE get() const noexcept {
            return handle_;
        }

      private:
        HANDLE handle_{};
    };

} // namespace

core::Result<PcmPlaybackResult> playPcmSource(PcmPlaybackSource source) {
    if (!source.readFrames || source.sampleRateHz < 8'000 || source.sampleRateHz > 384'000 ||
        source.channelCount == 0 || source.channelCount > 8) {
        return std::unexpected(core::error(
            "audio_playback_format_invalid",
            "Playback requires 16-bit PCM with a supported sample rate and channel count."));
    }

    const std::uint32_t bytesPerFrame = static_cast<std::uint32_t>(source.channelCount) * 2U;
    const std::uint64_t bytesPerSecond =
        static_cast<std::uint64_t>(source.sampleRateHz) * bytesPerFrame;
    if (bytesPerSecond > std::numeric_limits<DWORD>::max()) {
        return std::unexpected(
            core::error("audio_playback_format_invalid",
                        "The requested playback format exceeds Windows limits."));
    }

    ComApartment apartment;
    if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
        return std::unexpected(
            wasapiError("Initializing the Windows audio apartment", apartment.result()));
    }

    ComOwner<IMMDeviceEnumerator> enumerator;
    HRESULT result =
        CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                         __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(enumerator.put()));
    if (FAILED(result))
        return std::unexpected(wasapiError("Creating the Windows audio device enumerator", result));

    ComOwner<IMMDevice> device;
    result = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, device.put());
    if (FAILED(result))
        return std::unexpected(wasapiError("Finding the default playback endpoint", result));

    ComOwner<IAudioClient> client;
    result = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(client.put()));
    if (FAILED(result))
        return std::unexpected(wasapiError("Opening the Windows playback endpoint", result));

    WAVEFORMATEXTENSIBLE format{};
    format.Format.wFormatTag = WAVE_FORMAT_EXTENSIBLE;
    format.Format.nChannels = source.channelCount;
    format.Format.nSamplesPerSec = source.sampleRateHz;
    format.Format.nAvgBytesPerSec = static_cast<DWORD>(bytesPerSecond);
    format.Format.nBlockAlign = static_cast<WORD>(bytesPerFrame);
    format.Format.wBitsPerSample = 16;
    format.Format.cbSize = static_cast<WORD>(sizeof(WAVEFORMATEXTENSIBLE) - sizeof(WAVEFORMATEX));
    format.Samples.wValidBitsPerSample = 16;
    format.dwChannelMask = speakerMasks[source.channelCount];
    format.SubFormat = pcmSubFormat;

    EventHandle audioEvent;
    if (!audioEvent.get()) {
        return std::unexpected(
            wasapiError("Creating the Windows playback event", HRESULT_FROM_WIN32(GetLastError())));
    }
    constexpr REFERENCE_TIME bufferDuration = 20'000'000;
    constexpr DWORD streamFlags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK |
                                  AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                                  AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
    result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, bufferDuration, 0,
                                &format.Format, nullptr);
    if (FAILED(result))
        return std::unexpected(wasapiError("Initializing Windows shared-mode playback", result));
    result = client->SetEventHandle(audioEvent.get());
    if (FAILED(result))
        return std::unexpected(wasapiError("Connecting the Windows playback event", result));

    UINT32 endpointBufferFrames = 0;
    result = client->GetBufferSize(&endpointBufferFrames);
    if (FAILED(result))
        return std::unexpected(wasapiError("Reading the Windows playback buffer size", result));
    if (endpointBufferFrames == 0)
        return std::unexpected(core::error("audio_playback_buffer_invalid",
                                           "The Windows playback endpoint has an empty buffer."));
    ComOwner<IAudioRenderClient> renderClient;
    result = client->GetService(__uuidof(IAudioRenderClient),
                                reinterpret_cast<void**>(renderClient.put()));
    if (FAILED(result))
        return std::unexpected(wasapiError("Opening the Windows render service", result));
    result = client->Start();
    if (FAILED(result))
        return std::unexpected(wasapiError("Starting Windows shared-mode playback", result));

    std::vector<std::int16_t> samples(framesPerBuffer * source.channelCount);
    PcmPlaybackResult playback;
    while (true) {
        if (source.stopRequested && source.stopRequested())
            break;
        const DWORD waitResult = WaitForSingleObject(audioEvent.get(), playbackWaitMilliseconds);
        if (waitResult == WAIT_TIMEOUT)
            continue;
        if (waitResult != WAIT_OBJECT_0) {
            result = HRESULT_FROM_WIN32(GetLastError());
            static_cast<void>(client->Stop());
            return std::unexpected(wasapiError("Waiting for the Windows playback event", result));
        }

        UINT32 paddingFrames = 0;
        result = client->GetCurrentPadding(&paddingFrames);
        if (FAILED(result)) {
            static_cast<void>(client->Stop());
            return std::unexpected(wasapiError("Reading Windows playback buffer padding", result));
        }
        if (paddingFrames >= endpointBufferFrames)
            continue;
        const std::size_t availableFrames = endpointBufferFrames - paddingFrames;
        const std::size_t requestedFrames = std::min(framesPerBuffer, availableFrames);
        auto frameCount = source.readFrames(
            std::span<std::int16_t>(samples.data(), requestedFrames * source.channelCount));
        if (!frameCount) {
            static_cast<void>(client->Stop());
            return std::unexpected(frameCount.error());
        }
        if (*frameCount == 0) {
            playback.reachedEnd = true;
            break;
        }

        BYTE* endpointData = nullptr;
        result = renderClient->GetBuffer(static_cast<UINT32>(*frameCount), &endpointData);
        if (FAILED(result)) {
            static_cast<void>(client->Stop());
            return std::unexpected(wasapiError("Reserving a Windows playback buffer", result));
        }
        const std::size_t byteCount = *frameCount * bytesPerFrame;
        std::memcpy(endpointData, samples.data(), byteCount);
        result = renderClient->ReleaseBuffer(static_cast<UINT32>(*frameCount), 0);
        if (FAILED(result)) {
            static_cast<void>(client->Stop());
            return std::unexpected(wasapiError("Submitting a Windows playback buffer", result));
        }

        playback.playedFrames += *frameCount;
        if (source.progress)
            source.progress(playback.playedFrames);
    }

    if (playback.reachedEnd) {
        while (true) {
            if (source.stopRequested && source.stopRequested())
                break;
            const DWORD waitResult =
                WaitForSingleObject(audioEvent.get(), playbackWaitMilliseconds);
            if (waitResult == WAIT_TIMEOUT)
                continue;
            if (waitResult != WAIT_OBJECT_0) {
                result = HRESULT_FROM_WIN32(GetLastError());
                static_cast<void>(client->Stop());
                return std::unexpected(
                    wasapiError("Waiting for Windows playback to drain", result));
            }
            UINT32 paddingFrames = 0;
            result = client->GetCurrentPadding(&paddingFrames);
            if (FAILED(result)) {
                static_cast<void>(client->Stop());
                return std::unexpected(
                    wasapiError("Reading Windows playback drain status", result));
            }
            if (paddingFrames == 0)
                break;
        }
    }

    result = client->Stop();
    if (FAILED(result))
        return std::unexpected(wasapiError("Stopping Windows shared-mode playback", result));
    return playback;
}

#endif

} // namespace tutorux::audio::detail

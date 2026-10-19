#include "tutorux/audio/capture.hpp"

#include "tutorux/domain/entities.hpp"
#include "capture_observer.hpp"
#include "preflight_metrics.hpp"

#if defined(__linux__)
#include "tutorux/audio/alsa_backend.hpp"
#include "tutorux/audio/pipewire_backend.hpp"
#elif defined(__APPLE__)
#include "tutorux/audio/coreaudio_backend.hpp"
#include "tutorux/audio/screencapturekit_backend.hpp"
#endif

#include <algorithm>
#include <charconv>
#include <chrono>
#include <cstring>
#include <limits>
#include <new>
#include <mutex>
#include <optional>
#include <string_view>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#include <atomic>
#include <propvarutil.h>
#define TUTORUX_HAS_WASAPI_PROCESS_LOOPBACK 1
#endif
#endif

namespace tutorux::audio {
namespace {

    std::uint64_t samplesToMicroseconds(std::uint64_t samples, std::uint32_t sampleRateHz) {
        const std::uint64_t seconds = samples / sampleRateHz;
        const std::uint64_t remainder = samples % sampleRateHz;
        return seconds * 1'000'000ULL + (remainder * 1'000'000ULL) / sampleRateHz;
    }

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(
            std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::system_clock::now().time_since_epoch()).count());
    }

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

#ifdef _WIN32
    constexpr std::string_view kWasapiProcessDevicePrefix = "wasapi-process:";

    core::Result<DWORD> parseWasapiProcessId(std::string_view deviceId) {
        if (!deviceId.starts_with(kWasapiProcessDevicePrefix)) {
            return std::unexpected(
                core::error("audio_device_id_invalid", "Windows application audio device IDs must use the WASAPI process prefix."));
        }
        const std::string_view encodedId = deviceId.substr(kWasapiProcessDevicePrefix.size());
        std::uint32_t processId = 0;
        const auto [end, error] = std::from_chars(encodedId.data(), encodedId.data() + encodedId.size(), processId);
        if (error != std::errc{} || end != encodedId.data() + encodedId.size() || processId == 0) {
            return std::unexpected(core::error("audio_device_id_invalid", "The selected WASAPI application process ID is invalid."));
        }
        return static_cast<DWORD>(processId);
    }

#if defined(TUTORUX_HAS_WASAPI_PROCESS_LOOPBACK)
    core::Status validateWasapiProcess(DWORD processId) {
        HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
        if (!process) {
            return std::unexpected(
                core::error("audio_application_not_running", "The selected application process is no longer available to WASAPI."));
        }
        CloseHandle(process);

        DWORD currentSession = 0;
        DWORD targetSession = 0;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), &currentSession) || !ProcessIdToSessionId(processId, &targetSession)) {
            return std::unexpected(
                core::error("audio_application_session_unavailable", "Windows could not determine the selected application's session."));
        }
        if (targetSession != currentSession) {
            return std::unexpected(core::error("audio_application_session_mismatch",
                                               "WASAPI application capture is limited to applications in the current Windows session."));
        }
        return {};
    }

    class ProcessLoopbackActivation final : public IActivateAudioInterfaceCompletionHandler {
      public:
        ProcessLoopbackActivation()
            : event_(CreateEventW(nullptr, TRUE, FALSE, nullptr)) {}

        ProcessLoopbackActivation(const ProcessLoopbackActivation&) = delete;
        ProcessLoopbackActivation& operator=(const ProcessLoopbackActivation&) = delete;

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID interfaceId, void** object) override {
            if (!object)
                return E_POINTER;
            *object = nullptr;
            if (IsEqualIID(interfaceId, IID_IUnknown) || IsEqualIID(interfaceId, __uuidof(IActivateAudioInterfaceCompletionHandler))) {
                *object = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
                AddRef();
                return S_OK;
            }
            return E_NOINTERFACE;
        }

        ULONG STDMETHODCALLTYPE AddRef() override {
            return references_.fetch_add(1, std::memory_order_relaxed) + 1;
        }

        ULONG STDMETHODCALLTYPE Release() override {
            const ULONG remaining = references_.fetch_sub(1, std::memory_order_acq_rel) - 1;
            if (remaining == 0)
                delete this;
            return remaining;
        }

        HRESULT STDMETHODCALLTYPE OnActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
            HRESULT activationResult = E_FAIL;
            IUnknown* activatedInterface = nullptr;
            const HRESULT result = operation->GetActivateResult(&activationResult, &activatedInterface);
            if (FAILED(result)) {
                activationResult = result;
            } else if (SUCCEEDED(activationResult)) {
                IAudioClient* audioClient = nullptr;
                activationResult = activatedInterface->QueryInterface(IID_IAudioClient, reinterpret_cast<void**>(&audioClient));
                if (SUCCEEDED(activationResult)) {
                    std::lock_guard lock(mutex_);
                    audioClient_ = audioClient;
                }
            }
            if (activatedInterface)
                activatedInterface->Release();
            {
                std::lock_guard lock(mutex_);
                activationResult_ = activationResult;
            }
            if (event_)
                SetEvent(event_);
            Release();
            return S_OK;
        }

        HANDLE event() const {
            return event_;
        }

        HRESULT activationResult() const {
            std::lock_guard lock(mutex_);
            return activationResult_;
        }

        IAudioClient* takeAudioClient() {
            std::lock_guard lock(mutex_);
            IAudioClient* result = audioClient_;
            audioClient_ = nullptr;
            return result;
        }

      private:
        ~ProcessLoopbackActivation() {
            if (audioClient_)
                audioClient_->Release();
            if (event_)
                CloseHandle(event_);
        }

        std::atomic<ULONG> references_{1};
        HANDLE event_{};
        mutable std::mutex mutex_;
        HRESULT activationResult_{E_PENDING};
        IAudioClient* audioClient_{};
    };

    using ActivateAudioInterfaceAsyncFunction = HRESULT(WINAPI*)(LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*,
                                                                 IActivateAudioInterfaceAsyncOperation**);

    ActivateAudioInterfaceAsyncFunction wasapiProcessLoopbackActivator() {
        static HMODULE module = [] {
            HMODULE loaded = GetModuleHandleW(L"Mmdevapi.dll");
            return loaded ? loaded : LoadLibraryW(L"Mmdevapi.dll");
        }();
        if (!module)
            return nullptr;
        return reinterpret_cast<ActivateAudioInterfaceAsyncFunction>(GetProcAddress(module, "ActivateAudioInterfaceAsync"));
    }

    core::Status activateWasapiProcessLoopback(DWORD processId, IAudioClient** audioClient) {
        if (auto status = validateWasapiProcess(processId); !status)
            return status;
        auto activate = wasapiProcessLoopbackActivator();
        if (!activate) {
            return std::unexpected(core::error("audio_application_capture_unsupported",
                                               "This Windows build does not expose the WASAPI process-loopback activation API."));
        }

        auto* completion = new (std::nothrow) ProcessLoopbackActivation();
        if (!completion)
            return std::unexpected(core::error("audio_activation_allocate_failed", "Allocating WASAPI activation state failed."));
        if (!completion->event()) {
            completion->Release();
            return std::unexpected(
                captureError("audio_event_create_failed", HRESULT_FROM_WIN32(GetLastError()), "Creating the WASAPI activation event"));
        }

        AUDIOCLIENT_ACTIVATION_PARAMS parameters{};
        parameters.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
        parameters.ProcessLoopbackParams.TargetProcessId = processId;
        parameters.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
        PROPVARIANT activation{};
        activation.vt = VT_BLOB;
        activation.blob.cbSize = sizeof(parameters);
        activation.blob.pBlobData = reinterpret_cast<BYTE*>(&parameters);

        IActivateAudioInterfaceAsyncOperation* operation = nullptr;
        completion->AddRef(); // Keep callback state alive if activation completes after a timeout.
        HRESULT result = activate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, IID_IAudioClient, &activation, completion, &operation);
        if (FAILED(result)) {
            if (operation)
                operation->Release();
            completion->Release();
            completion->Release();
            return std::unexpected(
                captureError("audio_application_activation_failed", result, "Starting WASAPI process-loopback activation"));
        }

        const DWORD waitResult = WaitForSingleObject(completion->event(), 15'000);
        if (waitResult != WAIT_OBJECT_0) {
            const HRESULT waitError = waitResult == WAIT_FAILED ? HRESULT_FROM_WIN32(GetLastError()) : HRESULT_FROM_WIN32(WAIT_TIMEOUT);
            if (operation)
                operation->Release();
            completion->Release();
            return std::unexpected(
                captureError("audio_application_activation_timeout", waitError, "Waiting for WASAPI process-loopback activation"));
        }
        result = completion->activationResult();
        if (SUCCEEDED(result)) {
            IAudioClient* activatedClient = completion->takeAudioClient();
            if (!activatedClient) {
                result = E_POINTER;
            } else {
                *audioClient = activatedClient;
            }
        }
        if (operation)
            operation->Release();
        completion->Release();
        if (FAILED(result)) {
            return std::unexpected(
                captureError("audio_application_activation_failed", result, "Activating the WASAPI process-loopback stream"));
        }
        return {};
    }
#else
    core::Status activateWasapiProcessLoopback(DWORD, IAudioClient**) {
        return std::unexpected(core::error("audio_application_capture_unsupported",
                                           "This build uses a Windows SDK without WASAPI process-loopback activation APIs."));
    }
#endif

    constexpr GUID kPcmSubFormat{
        0x00000001, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}
    };
    constexpr GUID kFloatSubFormat{
        0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}
    };

    template <typename Interface> class ComOwner final {
      public:
        ComOwner() = default;
        ComOwner(const ComOwner&) = delete;
        ComOwner& operator=(const ComOwner&) = delete;
        ~ComOwner() {
            if (value_)
                value_->Release();
        }
        Interface* get() const {
            return value_;
        }
        Interface** put() {
            if (value_) {
                value_->Release();
                value_ = nullptr;
            }
            return &value_;
        }
        Interface* operator->() const {
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
        HRESULT result() const {
            return result_;
        }

      private:
        HRESULT result_{};
    };

    class EventHandle final {
      public:
        explicit EventHandle(HANDLE handle)
            : handle_(handle) {}
        EventHandle(const EventHandle&) = delete;
        EventHandle& operator=(const EventHandle&) = delete;
        ~EventHandle() {
            if (handle_)
                CloseHandle(handle_);
        }
        HANDLE get() const {
            return handle_;
        }

      private:
        HANDLE handle_{};
    };

    class WaveFormatOwner final {
      public:
        WaveFormatOwner() = default;
        WaveFormatOwner(const WaveFormatOwner&) = delete;
        WaveFormatOwner& operator=(const WaveFormatOwner&) = delete;
        ~WaveFormatOwner() {
            if (value_)
                CoTaskMemFree(value_);
        }
        WAVEFORMATEX** put() {
            return &value_;
        }
        WAVEFORMATEX* get() const {
            return value_;
        }

      private:
        WAVEFORMATEX* value_{};
    };

    core::Error captureError(std::string code, HRESULT result, std::string_view operation) {
        return core::error(std::move(code),
                           std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(result)) + ").");
    }

    core::Result<std::wstring> toWide(std::string_view value) {
        if (value.empty())
            return std::wstring{};
        const int required = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
        if (required <= 0) {
            return std::unexpected(captureError("audio_device_id_invalid", HRESULT_FROM_WIN32(GetLastError()),
                                                "Converting the selected audio device identifier"));
        }
        std::wstring converted(static_cast<std::size_t>(required), L'\0');
        const int written =
            MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), converted.data(), required);
        if (written != required) {
            return std::unexpected(captureError("audio_device_id_invalid", HRESULT_FROM_WIN32(GetLastError()),
                                                "Converting the selected audio device identifier"));
        }
        return converted;
    }

    core::Result<std::string> toUtf8(const wchar_t* value) {
        if (!value)
            return std::string{};
        const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
        if (required <= 0) {
            return std::unexpected(captureError("audio_device_id_invalid", HRESULT_FROM_WIN32(GetLastError()),
                                                "Converting the active audio device identifier"));
        }
        std::string converted(static_cast<std::size_t>(required), '\0');
        const int written = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, converted.data(), required, nullptr, nullptr);
        if (written != required) {
            return std::unexpected(captureError("audio_device_id_invalid", HRESULT_FROM_WIN32(GetLastError()),
                                                "Converting the active audio device identifier"));
        }
        converted.pop_back();
        return converted;
    }

    core::Result<std::uint32_t> channelMask(WAVEFORMATEX* format, std::uint16_t& sampleFormatTag) {
        sampleFormatTag = format->wFormatTag;
        if (format->wFormatTag != WAVE_FORMAT_EXTENSIBLE)
            return std::uint32_t{};
        if (format->cbSize < 22)
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI returned a truncated extensible format."));
        const auto* extended = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        if (extended->Samples.wValidBitsPerSample != format->wBitsPerSample) {
            return std::unexpected(
                core::error("audio_format_unsupported", "WASAPI endpoint uses valid sample bits smaller than its sample container."));
        }
        if (IsEqualGUID(extended->SubFormat, kPcmSubFormat))
            sampleFormatTag = WAVE_FORMAT_PCM;
        else if (IsEqualGUID(extended->SubFormat, kFloatSubFormat))
            sampleFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        else
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI endpoint uses a compressed sample format."));
        return extended->dwChannelMask;
    }

    core::Result<std::string> sampleFormatName(std::uint16_t formatTag, std::uint16_t bitsPerSample) {
        if (formatTag == WAVE_FORMAT_IEEE_FLOAT && bitsPerSample == 32)
            return std::string("pcm_f32le");
        if (formatTag != WAVE_FORMAT_PCM)
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI endpoint format is not PCM audio."));
        switch (bitsPerSample) {
            case 8:
                return std::string("pcm_u8");
            case 16:
                return std::string("pcm_s16le");
            case 24:
                return std::string("pcm_s24le");
            case 32:
                return std::string("pcm_s32le");
            default:
                return std::unexpected(core::error("audio_format_unsupported", "WASAPI endpoint sample depth is unsupported."));
        }
    }

    core::Result<CaptureDeviceProbe> probeWasapiProcessLoopback(std::string deviceId) {
        auto processId = parseWasapiProcessId(deviceId);
        if (!processId)
            return std::unexpected(processId.error());
        ComApartment apartment;
        if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
            return std::unexpected(
                captureError("audio_com_initialization_failed", apartment.result(), "Initializing Windows audio capture"));
        }

        ComOwner<IAudioClient> client;
        if (auto status = activateWasapiProcessLoopback(*processId, client.put()); !status)
            return std::unexpected(status.error());
        WAVEFORMATEX processFormat{};
        processFormat.wFormatTag = WAVE_FORMAT_PCM;
        processFormat.nChannels = 2;
        processFormat.nSamplesPerSec = 48'000;
        processFormat.wBitsPerSample = 16;
        processFormat.nBlockAlign = 4;
        processFormat.nAvgBytesPerSec = 192'000;
        WAVEFORMATEX* format = &processFormat;
        std::uint16_t formatTag = format->wFormatTag;
        if (auto mask = channelMask(format, formatTag); !mask)
            return std::unexpected(mask.error());
        auto sampleFormat = sampleFormatName(formatTag, format->wBitsPerSample);
        if (!sampleFormat)
            return std::unexpected(sampleFormat.error());
        const std::uint32_t expectedBlockAlign = static_cast<std::uint32_t>(format->nChannels) * (format->wBitsPerSample / 8U);
        if (format->nChannels == 0 || format->nChannels > 8 || format->nSamplesPerSec < 8'000 || format->nSamplesPerSec > 384'000 ||
            expectedBlockAlign != format->nBlockAlign || format->nBlockAlign == 0) {
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI process-loopback channel or rate is unsupported."));
        }

        IAudioClient* audioClient = client.get();
        // SDK-less activation stubs never hand over a client; keep the null check visible.
        if (!audioClient) {
            return std::unexpected(
                core::error("audio_stream_unavailable",
                            "WASAPI process-loopback activation did not provide an audio client."));
        }
        const HRESULT result = audioClient->Initialize(
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, 10'000'000, 0, format, nullptr);
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_stream_initialize_failed", result, "Probing the process-loopback audio stream"));
        }
        return CaptureDeviceProbe{"wasapi-process:" + std::to_string(*processId), std::move(*sampleFormat), format->nSamplesPerSec,
                                  format->nChannels};
    }

    core::Result<CaptureDeviceProbe> probeWasapi(DeviceKind source, std::string deviceId) {
        if (source == DeviceKind::application)
            return probeWasapiProcessLoopback(std::move(deviceId));
        ComApartment apartment;
        if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
            return std::unexpected(
                captureError("audio_com_initialization_failed", apartment.result(), "Initializing Windows audio capture"));
        }
        const EDataFlow flow = source == DeviceKind::microphone ? eCapture : eRender;
        ComOwner<IMMDeviceEnumerator> enumerator;
        HRESULT result = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator,
                                          reinterpret_cast<void**>(enumerator.put()));
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_enumeration_failed", result, "Creating the Windows audio device enumerator"));
        }
        ComOwner<IMMDevice> device;
        if (deviceId.empty()) {
            result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put());
        } else {
            auto identifier = toWide(deviceId);
            if (!identifier)
                return std::unexpected(identifier.error());
            result = enumerator->GetDevice(identifier->c_str(), device.put());
        }
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_open_failed", result, "Opening the selected audio endpoint"));
        }
        ComOwner<IMMEndpoint> endpoint;
        result = device->QueryInterface(IID_IMMEndpoint, reinterpret_cast<void**>(endpoint.put()));
        EDataFlow actualFlow{};
        if (SUCCEEDED(result))
            result = endpoint->GetDataFlow(&actualFlow);
        if (FAILED(result) || actualFlow != flow) {
            return std::unexpected(captureError("audio_device_flow_mismatch", FAILED(result) ? result : E_INVALIDARG,
                                                "Validating the selected audio endpoint type"));
        }
        LPWSTR wideDeviceId = nullptr;
        result = device->GetId(&wideDeviceId);
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_id_failed", result, "Reading the selected endpoint identifier"));
        }
        auto activeDeviceId = toUtf8(wideDeviceId);
        CoTaskMemFree(wideDeviceId);
        if (!activeDeviceId)
            return std::unexpected(activeDeviceId.error());

        ComOwner<IAudioClient> client;
        result = device->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.put()));
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_client_activation_failed", result, "Activating the audio endpoint"));
        }
        WaveFormatOwner mixFormat;
        result = client->GetMixFormat(mixFormat.put());
        if (FAILED(result) || !mixFormat.get()) {
            return std::unexpected(captureError("audio_format_query_failed", result, "Reading the endpoint audio format"));
        }
        WAVEFORMATEX* format = mixFormat.get();
        std::uint16_t formatTag = format->wFormatTag;
        if (auto mask = channelMask(format, formatTag); !mask)
            return std::unexpected(mask.error());
        auto sampleFormat = sampleFormatName(formatTag, format->wBitsPerSample);
        if (!sampleFormat)
            return std::unexpected(sampleFormat.error());
        const std::uint32_t expectedBlockAlign = static_cast<std::uint32_t>(format->nChannels) * (format->wBitsPerSample / 8U);
        if (format->nChannels == 0 || format->nChannels > 8 || format->nSamplesPerSec < 8'000 || format->nSamplesPerSec > 384'000 ||
            expectedBlockAlign != format->nBlockAlign || format->nBlockAlign == 0) {
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI endpoint channel or rate is unsupported."));
        }

        const DWORD streamFlags = source == DeviceKind::playback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, 10'000'000, 0, format, nullptr);
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_stream_initialize_failed", result, "Probing the audio capture stream"));
        }
        return CaptureDeviceProbe{std::move(*activeDeviceId), std::move(*sampleFormat), format->nSamplesPerSec, format->nChannels};
    }

    double normalizedSample(const BYTE* sample, std::uint16_t formatTag, std::uint16_t bitsPerSample) noexcept {
        if (formatTag == WAVE_FORMAT_IEEE_FLOAT) {
            float value{};
            std::memcpy(&value, sample, sizeof(value));
            return std::isfinite(value) ? std::clamp(static_cast<double>(value), -1.0, 1.0) : 0.0;
        }
        switch (bitsPerSample) {
            case 8:
                return (static_cast<double>(*sample) - 128.0) / 128.0;
            case 16: {
                std::int16_t value{};
                std::memcpy(&value, sample, sizeof(value));
                return static_cast<double>(value) / 32'768.0;
            }
            case 24: {
                std::int32_t value = static_cast<std::int32_t>(sample[0]) | (static_cast<std::int32_t>(sample[1]) << 8) |
                                     (static_cast<std::int32_t>(sample[2]) << 16);
                if ((value & 0x0080'0000) != 0)
                    value -= 0x0100'0000;
                return static_cast<double>(value) / 8'388'608.0;
            }
            case 32: {
                std::int32_t value{};
                std::memcpy(&value, sample, sizeof(value));
                return static_cast<double>(value) / 2'147'483'648.0;
            }
            default:
                return 0.0;
        }
    }

    class WasapiRunGuard final {
      public:
        WasapiRunGuard() = default;
        WasapiRunGuard(const WasapiRunGuard&) = delete;
        WasapiRunGuard& operator=(const WasapiRunGuard&) = delete;
        ~WasapiRunGuard() {
            if (client_)
                client_->Stop();
        }

        void arm(IAudioClient* client) noexcept {
            client_ = client;
        }

        HRESULT stop() noexcept {
            if (!client_)
                return S_OK;
            const HRESULT result = client_->Stop();
            if (SUCCEEDED(result))
                client_ = nullptr;
            return result;
        }

      private:
        IAudioClient* client_{};
    };

    core::Result<CapturePreflightSummary> preflightWasapi(CapturePreflightOptions options) {
        if (auto status = detail::validatePreflightOptions(options); !status)
            return std::unexpected(status.error());

        ComApartment apartment;
        if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
            return std::unexpected(
                captureError("audio_com_initialization_failed", apartment.result(), "Initializing Windows microphone access"));
        }
        ComOwner<IMMDeviceEnumerator> enumerator;
        HRESULT result = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator,
                                          reinterpret_cast<void**>(enumerator.put()));
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_enumeration_failed", result, "Creating the Windows audio device enumerator"));
        }

        ComOwner<IMMDevice> device;
        if (options.deviceId.empty()) {
            result = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, device.put());
        } else {
            auto identifier = toWide(options.deviceId);
            if (!identifier)
                return std::unexpected(identifier.error());
            result = enumerator->GetDevice(identifier->c_str(), device.put());
        }
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_open_failed", result, "Opening the selected microphone"));
        }

        ComOwner<IMMEndpoint> endpoint;
        result = device->QueryInterface(IID_IMMEndpoint, reinterpret_cast<void**>(endpoint.put()));
        EDataFlow actualFlow{};
        if (SUCCEEDED(result))
            result = endpoint->GetDataFlow(&actualFlow);
        if (FAILED(result) || actualFlow != eCapture) {
            return std::unexpected(
                captureError("audio_device_flow_mismatch", FAILED(result) ? result : E_INVALIDARG, "Validating the selected microphone"));
        }

        LPWSTR wideDeviceId = nullptr;
        result = device->GetId(&wideDeviceId);
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_device_id_failed", result, "Reading the selected microphone identifier"));
        }
        auto activeDeviceId = toUtf8(wideDeviceId);
        CoTaskMemFree(wideDeviceId);
        if (!activeDeviceId)
            return std::unexpected(activeDeviceId.error());

        ComOwner<IAudioClient> client;
        result = device->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.put()));
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_client_activation_failed", result, "Activating the selected microphone"));
        }
        WaveFormatOwner mixFormat;
        result = client->GetMixFormat(mixFormat.put());
        if (FAILED(result) || !mixFormat.get()) {
            return std::unexpected(captureError("audio_format_query_failed", result, "Reading the microphone audio format"));
        }
        WAVEFORMATEX* format = mixFormat.get();
        std::uint16_t formatTag = format->wFormatTag;
        auto mask = channelMask(format, formatTag);
        if (!mask)
            return std::unexpected(mask.error());
        auto sampleFormat = sampleFormatName(formatTag, format->wBitsPerSample);
        if (!sampleFormat)
            return std::unexpected(sampleFormat.error());
        const std::uint32_t expectedBlockAlign = static_cast<std::uint32_t>(format->nChannels) * (format->wBitsPerSample / 8U);
        if (format->nChannels == 0 || format->nChannels > 8 || format->nSamplesPerSec < 8'000 || format->nSamplesPerSec > 384'000 ||
            expectedBlockAlign != format->nBlockAlign || format->nBlockAlign == 0) {
            return std::unexpected(core::error("audio_format_unsupported", "Microphone channel or sample rate is unsupported."));
        }

        constexpr DWORD kEventFlags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, kEventFlags, 20'000'000, 0, format, nullptr);
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_stream_initialize_failed", result, "Initializing the microphone check stream"));
        }
        EventHandle audioEvent(CreateEventW(nullptr, FALSE, FALSE, nullptr));
        if (!audioEvent.get()) {
            return std::unexpected(
                captureError("audio_event_create_failed", HRESULT_FROM_WIN32(GetLastError()), "Creating the microphone check event"));
        }
        result = client->SetEventHandle(audioEvent.get());
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_event_setup_failed", result, "Attaching the microphone check event"));
        }
        ComOwner<IAudioCaptureClient> captureClient;
        result = client->GetService(IID_IAudioCaptureClient, reinterpret_cast<void**>(captureClient.put()));
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_capture_service_failed", result, "Opening the microphone sample stream"));
        }
        result = client->Start();
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_preflight_start_failed", result, "Starting the microphone access check"));
        }
        WasapiRunGuard runGuard;
        runGuard.arm(client.get());

        const auto startedAt = std::chrono::steady_clock::now();
        auto lastNotification = startedAt;
        const auto deadline = startedAt + options.duration;
        detail::LevelAccumulator levels;
        std::uint64_t framesMeasured = 0;
        const std::size_t bytesPerSample = format->wBitsPerSample / 8U;
        const std::size_t bytesPerFrame = format->nBlockAlign;

        while (std::chrono::steady_clock::now() < deadline) {
            const auto remaining = deadline - std::chrono::steady_clock::now();
            const auto waitMilliseconds =
                std::clamp<std::int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(remaining).count(), 1, 100);
            const DWORD waitResult = WaitForSingleObject(audioEvent.get(), static_cast<DWORD>(waitMilliseconds));
            if (waitResult == WAIT_FAILED) {
                return std::unexpected(
                    captureError("audio_event_wait_failed", HRESULT_FROM_WIN32(GetLastError()), "Waiting for microphone input"));
            }
            if (waitResult != WAIT_OBJECT_0 && waitResult != WAIT_TIMEOUT) {
                return std::unexpected(core::error("audio_event_wait_failed", "The microphone check received an invalid event result."));
            }

            UINT32 packetFrames = 0;
            while (SUCCEEDED(result = captureClient->GetNextPacketSize(&packetFrames)) && packetFrames != 0) {
                BYTE* packet = nullptr;
                UINT32 frameCount = 0;
                DWORD packetFlags = 0;
                result = captureClient->GetBuffer(&packet, &frameCount, &packetFlags, nullptr, nullptr);
                if (FAILED(result))
                    break;
                bool packetValid = frameCount != 0;
                const std::uint64_t packetBytes = static_cast<std::uint64_t>(frameCount) * bytesPerFrame;
                if (packetBytes > std::numeric_limits<std::size_t>::max() || packetBytes % bytesPerFrame != 0 ||
                    ((packetFlags & AUDCLNT_BUFFERFLAGS_SILENT) == 0 && !packet && packetBytes != 0)) {
                    packetValid = false;
                }
                if (packetValid && frameCount > std::numeric_limits<std::uint64_t>::max() - framesMeasured) {
                    packetValid = false;
                }
                if (packetValid) {
                    const std::size_t sampleCount = static_cast<std::size_t>(frameCount) * format->nChannels;
                    for (std::size_t index = 0; index < sampleCount; ++index) {
                        const double value = (packetFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0
                                                 ? 0.0
                                                 : normalizedSample(packet + index * bytesPerSample, formatTag, format->wBitsPerSample);
                        levels.add(value);
                    }
                    framesMeasured += frameCount;
                }
                const HRESULT releaseResult = captureClient->ReleaseBuffer(frameCount);
                if (!packetValid) {
                    result = E_INVALIDARG;
                    break;
                }
                if (FAILED(releaseResult)) {
                    result = releaseResult;
                    break;
                }
            }
            if (FAILED(result)) {
                return std::unexpected(captureError("audio_preflight_read_failed", result, "Reading microphone samples"));
            }

            const auto now = std::chrono::steady_clock::now();
            if (now - lastNotification >= options.levelInterval) {
                const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - startedAt);
                auto level = detail::makeCaptureInputLevel(levels.takeWindow(), format->nChannels, elapsed);
                level.framesMeasured = framesMeasured;
                if (auto status = detail::notifyPreflightLevel(options, level); !status)
                    return std::unexpected(status.error());
                lastNotification = now;
            }
        }

        result = runGuard.stop();
        if (FAILED(result)) {
            return std::unexpected(captureError("audio_preflight_stop_failed", result, "Stopping the microphone access check"));
        }
        const auto finishedAt = std::chrono::steady_clock::now();
        const auto finalWindow = levels.takeWindow();
        if (framesMeasured == 0) {
            return std::unexpected(
                core::error("audio_preflight_no_samples", "The selected microphone opened, but it produced no samples during the check."));
        }
        if (finalWindow.sampleValueCount != 0) {
            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(finishedAt - startedAt);
            auto level = detail::makeCaptureInputLevel(finalWindow, format->nChannels, elapsed);
            level.framesMeasured = framesMeasured;
            if (auto status = detail::notifyPreflightLevel(options, level); !status)
                return std::unexpected(status.error());
        }

        CaptureDeviceProbe selectedDevice{std::move(*activeDeviceId), std::move(*sampleFormat), format->nSamplesPerSec, format->nChannels};
        return detail::makeCapturePreflightSummary(std::move(selectedDevice), levels.total(),
                                                   std::chrono::duration_cast<std::chrono::milliseconds>(finishedAt - startedAt));
    }

    core::Status appendCapturedChunk(archive::Archive& archive, archive::Record& session, const archive::Uuid& sessionId,
                                     const archive::Uuid& trackId, std::uint64_t sequence, std::uint64_t firstSample,
                                     std::uint64_t frameCount, std::uint64_t totalStoredSamples, std::uint64_t gapBeforeSamples,
                                     std::uint32_t sampleRateHz, std::uint16_t channelCount, std::uint32_t channelMaskValue,
                                     const std::string& sampleFormat, bool containsDiscontinuity, archive::Bytes payload) {
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
            {"timeline_end_us", std::to_string(samplesToMicroseconds(firstSample + frameCount, sampleRateHz))},
            {"sample_format", sampleFormat},
            {"sample_rate_hz", std::to_string(sampleRateHz)},
            {"channel_count", std::to_string(channelCount)},
            {"channel_mask", std::to_string(channelMaskValue)},
            {"codec", "none"},
            {"source", domain::getField(session, "recording_source")},
            {"contains_device_discontinuity", containsDiscontinuity ? "true" : "false"},
            {"payload_checksum", std::to_string(archive::crc32(payload))}
        };
        chunk.blob = std::move(payload);

        session.fields["recording_audio_chunks"] = std::to_string(sequence + 1);
        session.fields["recording_samples"] = std::to_string(totalStoredSamples);
        session.fields["recording_timeline_samples"] = std::to_string(firstSample + frameCount);
        session.fields["recording_bytes"] = domain::getField(session, "recording_bytes", "0");
        std::uint64_t currentBytes = 0;
        const std::string previousBytes = session.fields["recording_bytes"];
        const auto [end, error] = std::from_chars(previousBytes.data(), previousBytes.data() + previousBytes.size(), currentBytes);
        if (error != std::errc{} || end != previousBytes.data() + previousBytes.size() ||
            currentBytes > std::numeric_limits<std::uint64_t>::max() - chunk.blob.size()) {
            return std::unexpected(core::error("audio_capture_counter_invalid", "Recording byte counter overflowed."));
        }
        session.fields["recording_bytes"] = std::to_string(currentBytes + chunk.blob.size());
        session.fields["recording_state"] = "recording";
        session.fields["updated_at_us"] = std::to_string(nowUnixMicroseconds());
        std::vector<archive::Record> transaction;
        transaction.reserve(2);
        transaction.push_back(std::move(chunk));
        transaction.push_back(session);
        return archive.putMany(std::move(transaction));
    }

    core::Result<CaptureSummary> captureWasapi(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
        ComApartment apartment;
        if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
            return std::unexpected(
                captureError("audio_com_initialization_failed", apartment.result(), "Initializing Windows audio capture"));
        }

        const bool capturesApplication = options.source == DeviceKind::application;
        std::string activeDeviceId;
        ComOwner<IAudioClient> client;
        WaveFormatOwner mixFormat;
        WAVEFORMATEX applicationFormat{};
        WAVEFORMATEX* format = nullptr;
        HRESULT result = S_OK;
        if (capturesApplication) {
            auto processId = parseWasapiProcessId(options.deviceId);
            if (!processId)
                return std::unexpected(processId.error());
            if (auto status = activateWasapiProcessLoopback(*processId, client.put()); !status)
                return std::unexpected(status.error());
            activeDeviceId = "wasapi-process:" + std::to_string(*processId);
            applicationFormat.wFormatTag = WAVE_FORMAT_PCM;
            applicationFormat.nChannels = 2;
            applicationFormat.nSamplesPerSec = 48'000;
            applicationFormat.wBitsPerSample = 16;
            applicationFormat.nBlockAlign = 4;
            applicationFormat.nAvgBytesPerSec = 192'000;
            format = &applicationFormat;
        } else {
            const EDataFlow flow = options.source == DeviceKind::microphone ? eCapture : eRender;
            ComOwner<IMMDeviceEnumerator> enumerator;
            result = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator,
                                      reinterpret_cast<void**>(enumerator.put()));
            if (FAILED(result)) {
                return std::unexpected(
                    captureError("audio_device_enumeration_failed", result, "Creating the Windows audio device enumerator"));
            }

            ComOwner<IMMDevice> device;
            if (options.deviceId.empty()) {
                result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put());
            } else {
                auto identifier = toWide(options.deviceId);
                if (!identifier)
                    return std::unexpected(identifier.error());
                result = enumerator->GetDevice(identifier->c_str(), device.put());
            }
            if (FAILED(result)) {
                return std::unexpected(captureError("audio_device_open_failed", result, "Opening the selected audio endpoint"));
            }
            ComOwner<IMMEndpoint> endpoint;
            result = device->QueryInterface(IID_IMMEndpoint, reinterpret_cast<void**>(endpoint.put()));
            EDataFlow actualFlow{};
            if (SUCCEEDED(result))
                result = endpoint->GetDataFlow(&actualFlow);
            if (FAILED(result) || actualFlow != flow) {
                return std::unexpected(captureError("audio_device_flow_mismatch", FAILED(result) ? result : E_INVALIDARG,
                                                    "Validating the selected audio endpoint type"));
            }
            LPWSTR wideDeviceId = nullptr;
            result = device->GetId(&wideDeviceId);
            if (FAILED(result)) {
                return std::unexpected(captureError("audio_device_id_failed", result, "Reading the selected endpoint identifier"));
            }
            auto convertedDeviceId = toUtf8(wideDeviceId);
            CoTaskMemFree(wideDeviceId);
            if (!convertedDeviceId)
                return std::unexpected(convertedDeviceId.error());
            activeDeviceId = std::move(*convertedDeviceId);

            result = device->Activate(IID_IAudioClient, CLSCTX_ALL, nullptr, reinterpret_cast<void**>(client.put()));
            if (FAILED(result)) {
                return std::unexpected(captureError("audio_client_activation_failed", result, "Activating the audio endpoint"));
            }
            result = client->GetMixFormat(mixFormat.put());
            if (FAILED(result) || !mixFormat.get()) {
                return std::unexpected(captureError("audio_format_query_failed", result, "Reading the endpoint audio format"));
            }
            format = mixFormat.get();
        }
        std::uint16_t formatTag = format->wFormatTag;
        auto mask = channelMask(format, formatTag);
        if (!mask)
            return std::unexpected(mask.error());
        auto sampleFormat = sampleFormatName(formatTag, format->wBitsPerSample);
        if (!sampleFormat)
            return std::unexpected(sampleFormat.error());
        const std::uint32_t expectedBlockAlign = static_cast<std::uint32_t>(format->nChannels) * (format->wBitsPerSample / 8U);
        if (format->nChannels == 0 || format->nChannels > 8 || format->nSamplesPerSec < 8'000 || format->nSamplesPerSec > 384'000 ||
            expectedBlockAlign != format->nBlockAlign || format->nBlockAlign == 0) {
            return std::unexpected(core::error("audio_format_unsupported", "WASAPI endpoint channel or rate is unsupported."));
        }

        auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
        if (!sessionResult)
            return std::unexpected(sessionResult.error());
        if (!*sessionResult || domain::isDeleted(**sessionResult)) {
            return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
        }
        archive::Record session = std::move(**sessionResult);
        const std::string currentState = domain::getField(session, "recording_state");
        if (currentState == "initializing" || currentState == "recording" || currentState == "paused" || currentState == "finalizing") {
            return std::unexpected(core::error("audio_capture_session_busy", "Session already has an active recording."));
        }
        bool sessionAlreadyHasAudio = false;
        if (auto status = archive.forEachAudioChunk(sessionId, options.trackId,
                                                    [&](archive::Record&& chunk) {
                                                        if (domain::getField(chunk, "session_id") == archive::uuidToString(sessionId)) {
                                                            sessionAlreadyHasAudio = true;
                                                            return false;
                                                        }
                                                        return true;
                                                    });
            !status) {
            return std::unexpected(status.error());
        }
        if (sessionAlreadyHasAudio) {
            return std::unexpected(core::error("audio_capture_audio_exists", "Session already contains audio. Create a new "
                                                                             "session or explicitly merge audio."));
        }

        CaptureSummary summary;
        summary.trackId = options.trackId.value_or(archive::randomUuid());
        summary.deviceId = activeDeviceId;
        summary.sampleFormat = *sampleFormat;
        summary.sampleRateHz = format->nSamplesPerSec;
        summary.channelCount = format->nChannels;
        summary.channelMask = *mask;
        const std::string sourceName = options.source == DeviceKind::microphone ? "microphone"
                                       : capturesApplication                    ? "application-audio"
                                                                                : "system-audio-loopback";
        session.fields["recording_track_id"] = archive::uuidToString(summary.trackId);
        session.fields["recording_source"] = sourceName;
        session.fields["recording_source_backend"] = capturesApplication ? "wasapi-process-loopback" : "wasapi";
        session.fields["recording_durability"] = options.durability == DurabilityPolicy::maximum        ? "maximum"
                                                 : options.durability == DurabilityPolicy::reducedWrite ? "reduced-write"
                                                                                                        : "default";
        session.fields["recording_device_id"] = activeDeviceId;
        if (capturesApplication) {
            auto processId = parseWasapiProcessId(activeDeviceId);
            if (!processId)
                return std::unexpected(processId.error());
            session.fields["recording_application_process_id"] = std::to_string(*processId);
        }
        session.fields["recording_consent"] = "explicit";
        session.fields["recording_consent_at_us"] = std::to_string(nowUnixMicroseconds());
        session.fields["recording_consent_confirmed_by"] = options.consentConfirmedBy;
        session.fields["recording_consent_sources"] = sourceName;
        session.fields["recording_consent_policy_version"] = "1";
        session.fields["recording_sample_format"] = *sampleFormat;
        session.fields["recording_sample_rate_hz"] = std::to_string(summary.sampleRateHz);
        session.fields["recording_channel_count"] = std::to_string(summary.channelCount);
        session.fields["recording_channel_mask"] = std::to_string(*mask);
        const std::uint64_t recordingStartedAtUs = nowUnixMicroseconds();
        session.fields["recording_started_at_us"] = std::to_string(recordingStartedAtUs);
        session.fields["recording_audio_chunks"] = "0";
        session.fields["recording_samples"] = "0";
        session.fields["recording_timeline_samples"] = "0";
        session.fields["recording_bytes"] = "0";
        session.fields["recording_discontinuities"] = "0";
        if (auto status = updateRecordingSession(archive, session, "initializing", 0, 0, 0); !status) {
            return std::unexpected(status.error());
        }
        if (options.stateChanged)
            options.stateChanged("initializing", "Preparing the selected audio endpoint.");
        const auto markCaptureFailed = [&](std::string message) -> core::Status {
            return updateRecordingSession(archive, session, "failed", 0, 0, 0, std::move(message));
        };

        constexpr DWORD kEventFlags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK;
        const DWORD streamFlags = capturesApplication ? kEventFlags | AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                                  : options.source == DeviceKind::playback ? kEventFlags | AUDCLNT_STREAMFLAGS_LOOPBACK
                                                                           : kEventFlags;
        result = client->Initialize(AUDCLNT_SHAREMODE_SHARED, streamFlags, 20'000'000, 0, format, nullptr);
        if (FAILED(result)) {
            if (auto status = markCaptureFailed("Unable to initialize the endpoint stream."); !status) {
                return std::unexpected(status.error());
            }
            return std::unexpected(captureError("audio_stream_initialize_failed", result, "Initializing the audio capture stream"));
        }
        EventHandle audioEvent(CreateEventW(nullptr, FALSE, FALSE, nullptr));
        if (!audioEvent.get()) {
            const HRESULT eventError = HRESULT_FROM_WIN32(GetLastError());
            if (auto status = markCaptureFailed("Unable to create the capture event."); !status) {
                return std::unexpected(status.error());
            }
            return std::unexpected(captureError("audio_event_create_failed", eventError, "Creating the audio capture event"));
        }
        result = client->SetEventHandle(audioEvent.get());
        if (FAILED(result)) {
            if (auto status = markCaptureFailed("Unable to attach the capture event."); !status) {
                return std::unexpected(status.error());
            }
            return std::unexpected(captureError("audio_event_setup_failed", result, "Attaching the audio capture event"));
        }
        ComOwner<IAudioCaptureClient> captureClient;
        result = client->GetService(IID_IAudioCaptureClient, reinterpret_cast<void**>(captureClient.put()));
        if (FAILED(result)) {
            if (auto status = markCaptureFailed("Unable to access captured audio packets."); !status) {
                return std::unexpected(status.error());
            }
            return std::unexpected(captureError("audio_capture_service_failed", result, "Opening the audio capture stream"));
        }
        if (options.waitForSynchronizedStart && !options.waitForSynchronizedStart()) {
            if (auto status = markCaptureFailed("A synchronized capture peer failed before both tracks started."); !status) {
                return std::unexpected(status.error());
            }
            return std::unexpected(
                core::error("audio_synchronized_start_cancelled", "A synchronized capture peer failed before both tracks started."));
        }
        result = client->Start();
        if (FAILED(result)) {
            if (auto status = markCaptureFailed("The audio endpoint did not start."); !status)
                return std::unexpected(status.error());
            return std::unexpected(captureError("audio_capture_start_failed", result, "Starting audio capture"));
        }
        if (auto status = updateRecordingSession(archive, session, "recording", 0, 0, 0); !status) {
            client->Stop();
            return std::unexpected(status.error());
        }
        if (options.stateChanged)
            options.stateChanged("recording", "Audio capture is active.");

        const std::uint64_t blockAlign = format->nBlockAlign;
        const std::uint64_t intervalMilliseconds = options.durability == DurabilityPolicy::maximum        ? 100U
                                                   : options.durability == DurabilityPolicy::reducedWrite ? 2'000U
                                                                                                          : 500U;
        const std::uint64_t targetIntervalBytes =
            static_cast<std::uint64_t>(format->nSamplesPerSec) * blockAlign * intervalMilliseconds / 1'000U;
        const std::uint64_t targetChunkBytes = std::max<std::uint64_t>(blockAlign, std::min<std::uint64_t>(1'048'576, targetIntervalBytes));
        const std::uint64_t alignedChunkBytes = targetChunkBytes - (targetChunkBytes % blockAlign);
        archive::Bytes pending;
        pending.reserve(static_cast<std::size_t>(alignedChunkBytes));
        std::uint64_t sequence = 0;
        std::uint64_t totalStoredSamples = 0;
        std::uint64_t timelineEndSample = 0;
        std::uint64_t pendingFirstSample = 0;
        std::uint64_t storedBytes = 0;
        std::uint64_t discontinuities = 0;
        std::optional<std::uint64_t> devicePositionOrigin;
        std::uint64_t devicePositionSampleOffset = 0;
        bool devicePositionValid = true;
        bool pendingHasDiscontinuity = false;
        const auto startedAt = std::chrono::steady_clock::now();
        auto pausedAt = std::chrono::steady_clock::time_point{};
        auto accumulatedPause = std::chrono::steady_clock::duration::zero();
        bool paused = false;
        core::Error streamFailure{};
        bool failed = false;

        const auto writePending = [&](std::size_t bytesToWrite) -> core::Status {
            if (bytesToWrite == 0 || bytesToWrite > pending.size() || bytesToWrite % blockAlign != 0) {
                return std::unexpected(core::error("audio_capture_chunk_invalid", "Captured audio chunk alignment is invalid."));
            }
            archive::Bytes payload(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(bytesToWrite));
            const std::uint64_t frameCount = bytesToWrite / blockAlign;
            if (pendingFirstSample < timelineEndSample || frameCount > std::numeric_limits<std::uint64_t>::max() - totalStoredSamples ||
                frameCount > std::numeric_limits<std::uint64_t>::max() - pendingFirstSample ||
                bytesToWrite > std::numeric_limits<std::uint64_t>::max() - storedBytes ||
                sequence == std::numeric_limits<std::uint64_t>::max()) {
                return std::unexpected(core::error("audio_capture_counter_invalid", "Recording timeline or storage counter overflowed."));
            }
            const std::uint64_t gapBeforeSamples = pendingFirstSample - timelineEndSample;
            auto status = appendCapturedChunk(archive, session, sessionId, summary.trackId, sequence, pendingFirstSample, frameCount,
                                              totalStoredSamples + frameCount, gapBeforeSamples, summary.sampleRateHz, summary.channelCount,
                                              *mask, *sampleFormat, pendingHasDiscontinuity, std::move(payload));
            if (!status)
                return status;
            if (options.pcmChunk && !summary.pcmObserverFailure) {
                const archive::Bytes observerSamples(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(bytesToWrite));
                detail::notifyPcmChunk(options, summary, recordingStartedAtUs, pendingFirstSample, frameCount, observerSamples);
            }
            ++sequence;
            totalStoredSamples += frameCount;
            timelineEndSample = pendingFirstSample + frameCount;
            pendingFirstSample = timelineEndSample;
            storedBytes += bytesToWrite;
            summary.chunkCount = sequence;
            summary.sampleCount = totalStoredSamples;
            summary.timelineSampleCount = timelineEndSample;
            summary.byteCount = storedBytes;
            summary.durationUs = samplesToMicroseconds(timelineEndSample, summary.sampleRateHz);
            pending.erase(pending.begin(), pending.begin() + static_cast<std::ptrdiff_t>(bytesToWrite));
            pendingHasDiscontinuity = false;
            if (options.progress)
                options.progress(summary);
            return {};
        };

        while (true) {
            if (options.stopRequested && options.stopRequested())
                break;
            const auto now = std::chrono::steady_clock::now();
            if (options.pauseRequested && options.pauseRequested() && !paused) {
                if (!pending.empty()) {
                    if (auto status = writePending(pending.size()); !status) {
                        streamFailure = status.error();
                        failed = true;
                        break;
                    }
                }
                result = client->Stop();
                if (FAILED(result)) {
                    streamFailure = captureError("audio_capture_pause_failed", result, "Pausing audio capture");
                    failed = true;
                    break;
                }
                if (auto status =
                        updateRecordingSession(archive, session, "paused", summary.chunkCount, summary.sampleCount, summary.byteCount);
                    !status) {
                    streamFailure = status.error();
                    failed = true;
                    break;
                }
                paused = true;
                pausedAt = now;
                if (options.stateChanged)
                    options.stateChanged("paused", "Audio capture is paused.");
            }
            if (paused) {
                if (options.stopRequested && options.stopRequested())
                    break;
                if (options.pauseRequested && !options.pauseRequested()) {
                    result = client->Start();
                    if (FAILED(result)) {
                        streamFailure = captureError("audio_capture_resume_failed", result, "Resuming audio capture");
                        failed = true;
                        break;
                    }
                    const auto resumedAt = std::chrono::steady_clock::now();
                    accumulatedPause += resumedAt - pausedAt;
                    paused = false;
                    devicePositionOrigin.reset();
                    devicePositionSampleOffset = timelineEndSample;
                    devicePositionValid = true;
                    if (auto status = updateRecordingSession(archive, session, "recording", summary.chunkCount, summary.sampleCount,
                                                             summary.byteCount);
                        !status) {
                        streamFailure = status.error();
                        failed = true;
                        break;
                    }
                    if (options.stateChanged)
                        options.stateChanged("recording", "Audio capture resumed.");
                } else {
                    std::this_thread::sleep_for(std::chrono::milliseconds(50));
                    continue;
                }
            }
            if (options.maximumDuration && now - startedAt - accumulatedPause >= *options.maximumDuration) {
                break;
            }
            const DWORD waitResult = WaitForSingleObject(audioEvent.get(), 250);
            if (waitResult == WAIT_FAILED) {
                streamFailure =
                    captureError("audio_event_wait_failed", HRESULT_FROM_WIN32(GetLastError()), "Waiting for audio capture packets");
                failed = true;
                break;
            }
            if (waitResult == WAIT_TIMEOUT)
                continue;

            UINT32 packetFrames = 0;
            while (SUCCEEDED(result = captureClient->GetNextPacketSize(&packetFrames)) && packetFrames != 0) {
                BYTE* packet = nullptr;
                UINT32 frameCount = 0;
                DWORD packetFlags = 0;
                UINT64 devicePosition = 0;
                UINT64 qpcPosition = 0;
                result = captureClient->GetBuffer(&packet, &frameCount, &packetFlags, &devicePosition, &qpcPosition);
                if (FAILED(result))
                    break;
                static_cast<void>(qpcPosition);
                const std::uint64_t packetBytes = static_cast<std::uint64_t>(frameCount) * blockAlign;
                archive::Bytes packetData;
                if (packetBytes > std::numeric_limits<std::size_t>::max()) {
                    result = E_OUTOFMEMORY;
                } else if ((packetFlags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
                    packetData.resize(static_cast<std::size_t>(packetBytes), std::byte{});
                } else if (packet && packetBytes != 0) {
                    const auto* begin = reinterpret_cast<const std::byte*>(packet);
                    packetData.insert(packetData.end(), begin, begin + static_cast<std::ptrdiff_t>(packetBytes));
                } else if (packetBytes != 0) {
                    result = E_POINTER;
                }
                const HRESULT releaseResult = captureClient->ReleaseBuffer(frameCount);
                if (FAILED(result) || FAILED(releaseResult)) {
                    if (SUCCEEDED(result))
                        result = releaseResult;
                    break;
                }
                const bool deviceDiscontinuity = (packetFlags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) != 0;
                const bool timestampError = (packetFlags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) != 0;
                std::uint64_t expectedPacketStart = timelineEndSample;
                if (!pending.empty()) {
                    const std::uint64_t pendingFrames = pending.size() / blockAlign;
                    if (pendingFrames > std::numeric_limits<std::uint64_t>::max() - pendingFirstSample) {
                        result = E_BOUNDS;
                        break;
                    }
                    expectedPacketStart = pendingFirstSample + pendingFrames;
                }

                bool inferredDiscontinuity = timestampError;
                std::uint64_t packetFirstSample = expectedPacketStart;
                if (!timestampError) {
                    if (!devicePositionOrigin) {
                        devicePositionOrigin = devicePosition;
                        packetFirstSample = devicePositionSampleOffset;
                    } else if (devicePositionValid && devicePosition >= *devicePositionOrigin) {
                        const std::uint64_t relativePosition = devicePosition - *devicePositionOrigin;
                        if (relativePosition <= std::numeric_limits<std::uint64_t>::max() - devicePositionSampleOffset) {
                            packetFirstSample = devicePositionSampleOffset + relativePosition;
                        } else {
                            devicePositionValid = false;
                            inferredDiscontinuity = true;
                        }
                    } else {
                        devicePositionValid = false;
                        inferredDiscontinuity = true;
                    }
                }
                if (packetFirstSample < expectedPacketStart) {
                    packetFirstSample = expectedPacketStart;
                    inferredDiscontinuity = true;
                }
                const bool timelineGap = packetFirstSample > expectedPacketStart;
                const bool packetBoundary = deviceDiscontinuity || inferredDiscontinuity || timelineGap;
                if (!pending.empty() && packetBoundary) {
                    if (auto status = writePending(pending.size()); !status) {
                        streamFailure = status.error();
                        failed = true;
                        break;
                    }
                    expectedPacketStart = timelineEndSample;
                    if (packetFirstSample < expectedPacketStart) {
                        packetFirstSample = expectedPacketStart;
                        inferredDiscontinuity = true;
                    }
                }
                if (deviceDiscontinuity || inferredDiscontinuity || timelineGap) {
                    if (discontinuities == std::numeric_limits<std::uint64_t>::max()) {
                        result = E_BOUNDS;
                        break;
                    }
                    ++discontinuities;
                    session.fields["recording_discontinuities"] = std::to_string(discontinuities);
                    pendingHasDiscontinuity = pendingHasDiscontinuity || packetBoundary;
                }
                if (packetBytes != 0) {
                    if (pending.empty())
                        pendingFirstSample = packetFirstSample;
                    if (packetData.size() > std::numeric_limits<std::size_t>::max() - pending.size()) {
                        result = E_OUTOFMEMORY;
                        break;
                    }
                    pending.insert(pending.end(), packetData.begin(), packetData.end());
                    pendingHasDiscontinuity = pendingHasDiscontinuity || packetBoundary;
                }
                while (pending.size() >= alignedChunkBytes) {
                    if (auto status = writePending(static_cast<std::size_t>(alignedChunkBytes)); !status) {
                        streamFailure = status.error();
                        failed = true;
                        break;
                    }
                }
                if (failed || FAILED(result))
                    break;
            }
            if (failed)
                break;
            if (FAILED(result)) {
                streamFailure = captureError("audio_packet_read_failed", result, "Reading captured audio packets");
                failed = true;
                break;
            }
        }

        const HRESULT stopResult = client->Stop();
        if (FAILED(stopResult) && !failed) {
            streamFailure = captureError("audio_capture_stop_failed", stopResult, "Stopping audio capture");
            failed = true;
        }
        if (!failed && !pending.empty()) {
            const auto bytesToWrite = pending.size() - (pending.size() % blockAlign);
            if (auto status = writePending(bytesToWrite); !status) {
                streamFailure = status.error();
                failed = true;
            }
        }
        summary.durationUs = samplesToMicroseconds(timelineEndSample, summary.sampleRateHz);
        if (failed) {
            const std::string finalState = summary.chunkCount == 0 ? "failed" : "interrupted";
            auto status = updateRecordingSession(archive, session, finalState, summary.chunkCount, summary.sampleCount, summary.byteCount,
                                                 streamFailure.message);
            if (!status)
                return std::unexpected(core::error(
                    streamFailure.code, streamFailure.message + " Unable to persist the capture failure state: " + status.error().message));
            if (options.stateChanged)
                options.stateChanged(finalState, streamFailure.message);
            return std::unexpected(streamFailure);
        }
        session.fields["recording_stopped_at_us"] = std::to_string(nowUnixMicroseconds());
        if (auto status = updateRecordingSession(archive, session, "completed", summary.chunkCount, summary.sampleCount, summary.byteCount);
            !status) {
            return std::unexpected(status.error());
        }
        summary.completed = true;
        summary.state = "completed";
        if (options.stateChanged)
            options.stateChanged("completed", "Recording is durably saved.");
        return summary;
    }
#endif

} // namespace

core::Result<CaptureDeviceProbe> probeCaptureDevice(DeviceKind source, std::string deviceId) {
#ifdef _WIN32
    return probeWasapi(source, std::move(deviceId));
#elif defined(__linux__)
    if (isPipeWireDevice(deviceId))
        return probePipeWireCaptureDevice(source, std::move(deviceId));
    if (source == DeviceKind::application) {
        return std::unexpected(core::error("audio_application_capture_unsupported",
                                           "This Linux build uses ALSA capture and does not expose PipeWire application streams."));
    }
    if (source == DeviceKind::playback && deviceId.empty()) {
        return std::unexpected(core::error("audio_monitor_required", "Select an ALSA monitor PCM explicitly for system-audio capture."));
    }
    return probeAlsaCaptureDevice(std::move(deviceId));
#elif defined(__APPLE__)
    if (source == DeviceKind::application)
        return probeScreenCaptureKitApplication(std::move(deviceId));
    if (source == DeviceKind::playback && (deviceId.empty() || deviceId == "default" || deviceId == "screen-capture-kit")) {
        return probeScreenCaptureKitDevice(std::move(deviceId));
    }
    return probeCoreAudioCaptureDevice(std::move(deviceId));
#else
    static_cast<void>(source);
    static_cast<void>(deviceId);
    return std::unexpected(core::error("audio_backend_unavailable", "Native device probing is not implemented for this platform."));
#endif
}

core::Result<CapturePreflightSummary> preflightCaptureInput(CapturePreflightOptions options) {
    if (auto status = detail::validatePreflightOptions(options); !status)
        return std::unexpected(status.error());
#ifdef _WIN32
    return preflightWasapi(std::move(options));
#elif defined(__linux__)
    if (isPipeWireDevice(options.deviceId))
        return preflightPipeWireCaptureDevice(std::move(options));
    return preflightAlsaCaptureDevice(std::move(options));
#elif defined(__APPLE__)
    return preflightCoreAudioCaptureDevice(std::move(options));
#else
    static_cast<void>(options);
    return std::unexpected(core::error("audio_backend_unavailable", "Native microphone checks are not implemented for this platform."));
#endif
}

core::Result<CaptureSummary> recoverNativeCapture(archive::Archive& archive, const archive::Uuid& sessionId,
                                                  std::optional<archive::Uuid> requestedTrackId) {
    auto sessionResult = archive.get(archive::RecordType::Session, sessionId);
    if (!sessionResult)
        return std::unexpected(sessionResult.error());
    if (!*sessionResult || domain::isDeleted(**sessionResult)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    }

    archive::Record session = std::move(**sessionResult);
    auto trackIdResult = requestedTrackId ? core::Result<archive::Uuid>(*requestedTrackId)
                                          : archive::uuidFromString(domain::getField(session, "recording_track_id"));
    if (!trackIdResult) {
        return std::unexpected(core::error("audio_recording_not_found", "Session does not contain a native recording."));
    }
    const archive::Uuid trackId = *trackIdResult;
    std::optional<archive::Record> trackMetadata;
    if (requestedTrackId) {
        auto storedTrack = archive.get(archive::RecordType::AssetMetadata, trackId);
        if (!storedTrack)
            return std::unexpected(storedTrack.error());
        if (!*storedTrack || domain::getField(**storedTrack, "record_role") != "audio-track" ||
            domain::getField(**storedTrack, "session_id") != archive::uuidToString(sessionId)) {
            return std::unexpected(
                core::error("audio_track_metadata_missing", "The selected recording track has no matching recovery metadata."));
        }
        trackMetadata = std::move(**storedTrack);
    }
    const archive::Record& formatRecord = trackMetadata ? *trackMetadata : session;
    std::uint64_t sampleRate = 0;
    std::uint64_t channelCount = 0;
    std::uint64_t channelMaskValue = 0;
    const auto parseNumber = [](std::string_view value, std::uint64_t& parsed) -> bool {
        const auto [end, error] = std::from_chars(value.data(), value.data() + value.size(), parsed);
        return error == std::errc{} && end == value.data() + value.size();
    };
    if (!parseNumber(domain::getField(formatRecord, trackMetadata ? "sample_rate_hz" : "recording_sample_rate_hz"), sampleRate) ||
        !parseNumber(domain::getField(formatRecord, trackMetadata ? "channel_count" : "recording_channel_count"), channelCount) ||
        !parseNumber(domain::getField(formatRecord, trackMetadata ? "channel_mask" : "recording_channel_mask"), channelMaskValue) ||
        sampleRate < 8'000 || sampleRate > 384'000 || channelCount == 0 || channelCount > 8 ||
        channelMaskValue > std::numeric_limits<std::uint32_t>::max()) {
        return std::unexpected(core::error("audio_recovery_metadata_invalid", "Recording format metadata is invalid."));
    }

    const std::string sampleFormat = domain::getField(formatRecord, trackMetadata ? "sample_format" : "recording_sample_format");
    std::uint64_t bytesPerSample = 0;
    if (sampleFormat == "pcm_u8")
        bytesPerSample = 1;
    else if (sampleFormat == "pcm_s16le")
        bytesPerSample = 2;
    else if (sampleFormat == "pcm_s24le")
        bytesPerSample = 3;
    else if (sampleFormat == "pcm_s32le" || sampleFormat == "pcm_f32le")
        bytesPerSample = 4;
    if (bytesPerSample == 0) {
        return std::unexpected(core::error("audio_recovery_metadata_invalid", "Recording sample format is unsupported."));
    }

    CaptureSummary summary;
    summary.trackId = trackId;
    summary.deviceId = domain::getField(formatRecord, trackMetadata ? "device_id" : "recording_device_id");
    summary.sampleFormat = sampleFormat;
    summary.sampleRateHz = static_cast<std::uint32_t>(sampleRate);
    summary.channelCount = static_cast<std::uint16_t>(channelCount);
    summary.channelMask = static_cast<std::uint32_t>(channelMaskValue);
    const std::uint64_t blockAlign = bytesPerSample * channelCount;
    const std::uint64_t maximumTimelineSample = (std::numeric_limits<std::uint64_t>::max() / 1'000'000ULL) * sampleRate +
                                                ((std::numeric_limits<std::uint64_t>::max() % 1'000'000ULL) * sampleRate) / 1'000'000ULL;
    std::uint64_t timelineEndSample = 0;
    std::uint64_t discontinuities = 0;
    std::string failureReason;
    auto chunkStatus = archive.forEachAudioChunk(sessionId, trackId, [&](archive::Record&& chunk) {
        std::uint64_t sequence = 0;
        std::uint64_t firstSample = 0;
        std::uint64_t frameCount = 0;
        std::uint64_t gapBefore = 0;
        std::uint64_t startUs = 0;
        std::uint64_t endUs = 0;
        std::uint64_t checksum = 0;
        const std::string gapField = domain::getField(chunk, "gap_before_samples", "0");
        const std::string discontinuityField = domain::getField(chunk, "contains_device_discontinuity", "false");
        const bool fieldsValid = parseNumber(domain::getField(chunk, "sequence_number"), sequence) &&
                                 parseNumber(domain::getField(chunk, "first_sample_index"), firstSample) &&
                                 parseNumber(domain::getField(chunk, "sample_count"), frameCount) && parseNumber(gapField, gapBefore) &&
                                 parseNumber(domain::getField(chunk, "timeline_start_us"), startUs) &&
                                 parseNumber(domain::getField(chunk, "timeline_end_us"), endUs) &&
                                 parseNumber(domain::getField(chunk, "payload_checksum"), checksum);
        const bool timelineValid = firstSample >= timelineEndSample && firstSample - timelineEndSample == gapBefore &&
                                   firstSample <= std::numeric_limits<std::uint64_t>::max() - frameCount &&
                                   frameCount <= std::numeric_limits<std::uint64_t>::max() / blockAlign &&
                                   firstSample + frameCount <= maximumTimelineSample;
        const bool formatValid = domain::getField(chunk, "sample_format") == sampleFormat && domain::getField(chunk, "codec") == "none" &&
                                 domain::getField(chunk, "sample_rate_hz") == std::to_string(sampleRate) &&
                                 domain::getField(chunk, "channel_count") == std::to_string(channelCount) &&
                                 domain::getField(chunk, "channel_mask") == std::to_string(channelMaskValue);
        const bool payloadValid = checksum <= std::numeric_limits<std::uint32_t>::max() &&
                                  frameCount <= std::numeric_limits<std::uint64_t>::max() / blockAlign &&
                                  frameCount * blockAlign == chunk.blob.size() && archive::crc32(chunk.blob) == checksum;
        const bool timestampsValid = startUs == samplesToMicroseconds(firstSample, summary.sampleRateHz) &&
                                     endUs == samplesToMicroseconds(firstSample + frameCount, summary.sampleRateHz);
        if (!fieldsValid || sequence != summary.chunkCount || frameCount == 0 || !timelineValid || !formatValid || !payloadValid ||
            !timestampsValid || summary.sampleCount > std::numeric_limits<std::uint64_t>::max() - frameCount ||
            summary.byteCount > std::numeric_limits<std::uint64_t>::max() - chunk.blob.size()) {
            failureReason = "A committed native audio chunk is missing, malformed, or corrupt.";
            return false;
        }
        summary.sampleCount += frameCount;
        summary.byteCount += chunk.blob.size();
        ++summary.chunkCount;
        timelineEndSample = firstSample + frameCount;
        if (discontinuityField == "true" || gapBefore != 0)
            ++discontinuities;
        return true;
    });
    if (!chunkStatus)
        return std::unexpected(chunkStatus.error());

    const std::string previousState =
        domain::getField(trackMetadata ? *trackMetadata : session, trackMetadata ? "state" : "recording_state");
    const std::string countField = trackMetadata ? "chunk_count" : "recording_audio_chunks";
    if (const auto recordedCount = formatRecord.fields.find(countField); recordedCount != formatRecord.fields.end()) {
        std::uint64_t expectedChunkCount = 0;
        if (!parseNumber(recordedCount->second, expectedChunkCount) && failureReason.empty()) {
            failureReason = "Saved native audio chunk count is invalid.";
        } else if (expectedChunkCount != summary.chunkCount && failureReason.empty() && (!trackMetadata || previousState == "completed")) {
            failureReason = "The saved recording count does not match its committed chunks.";
        }
    }
    summary.durationUs = samplesToMicroseconds(timelineEndSample, summary.sampleRateHz);
    summary.timelineSampleCount = timelineEndSample;
    summary.completed = failureReason.empty() && previousState == "completed";
    summary.state = summary.completed ? "completed" : summary.chunkCount == 0 ? "failed" : "interrupted";
    session.fields["recording_timeline_samples"] = std::to_string(timelineEndSample);
    session.fields["recording_discontinuities"] = std::to_string(discontinuities);
    session.fields["recording_recovered_at_us"] = std::to_string(nowUnixMicroseconds());
    if (!summary.completed && failureReason.empty()) {
        failureReason = summary.chunkCount == 0 ? "No committed native audio chunk was available for recovery."
                                                : "Committed audio was verified; the capture did not reach "
                                                  "completion.";
    }
    auto status =
        updateRecordingSession(archive, session, summary.state, summary.chunkCount, summary.sampleCount, summary.byteCount, failureReason);
    if (!status)
        return std::unexpected(status.error());
    if (trackMetadata) {
        trackMetadata->fields["state"] = summary.state;
        trackMetadata->fields["chunk_count"] = std::to_string(summary.chunkCount);
        trackMetadata->fields["sample_count"] = std::to_string(summary.sampleCount);
        trackMetadata->fields["timeline_sample_count"] = std::to_string(timelineEndSample);
        trackMetadata->fields["byte_count"] = std::to_string(summary.byteCount);
        trackMetadata->fields["duration_us"] = std::to_string(summary.durationUs);
        trackMetadata->fields["recovery_error"] = failureReason;
        trackMetadata->fields["recovered_at_us"] = std::to_string(nowUnixMicroseconds());
        if (auto trackStatus = archive.put(std::move(*trackMetadata)); !trackStatus)
            return std::unexpected(trackStatus.error());
    }
    return summary;
}

core::Result<MultiTrackCaptureSummary> recoverNativeCaptureTracks(archive::Archive& archive, const archive::Uuid& sessionId) {
    auto storedSession = archive.get(archive::RecordType::Session, sessionId);
    if (!storedSession)
        return std::unexpected(storedSession.error());
    if (!*storedSession || domain::isDeleted(**storedSession)) {
        return std::unexpected(core::error("session_not_found", "Session was not found in the archive."));
    }

    const archive::Record session = **storedSession;
    std::vector<archive::Uuid> trackIds;
    const std::string encodedTrackIds = domain::getField(session, "recording_track_ids");
    for (std::size_t start = 0; start < encodedTrackIds.size();) {
        const std::size_t separator = encodedTrackIds.find(',', start);
        const std::size_t end = separator == std::string::npos ? encodedTrackIds.size() : separator;
        const std::string_view value(encodedTrackIds.data() + start, end - start);
        auto trackId = archive::uuidFromString(value);
        if (!trackId) {
            return std::unexpected(core::error("audio_track_metadata_invalid", "Session contains an invalid recording track ID."));
        }
        if (std::find(trackIds.begin(), trackIds.end(), *trackId) == trackIds.end())
            trackIds.push_back(*trackId);
        if (separator == std::string::npos)
            break;
        start = separator + 1;
    }
    if (trackIds.empty()) {
        auto legacyTrackId = archive::uuidFromString(domain::getField(session, "recording_track_id"));
        if (legacyTrackId)
            trackIds.push_back(*legacyTrackId);
    }
    if (trackIds.empty()) {
        auto tracks = archive.list(archive::RecordType::AssetMetadata);
        if (!tracks)
            return std::unexpected(tracks.error());
        for (const auto& track : *tracks) {
            if (domain::isDeleted(track) || domain::getField(track, "record_role") != "audio-track" ||
                domain::getField(track, "session_id") != archive::uuidToString(sessionId)) {
                continue;
            }
            trackIds.push_back(track.id);
        }
    }
    if (trackIds.empty()) {
        return std::unexpected(core::error("audio_recording_not_found", "Session does not contain recoverable audio tracks."));
    }

    MultiTrackCaptureSummary combined;
    combined.completed = true;
    combined.tracks.reserve(trackIds.size());
    std::string errorSummary;
    const auto addSaturated = [](std::uint64_t left, std::uint64_t right) {
        return right > std::numeric_limits<std::uint64_t>::max() - left ? std::numeric_limits<std::uint64_t>::max() : left + right;
    };
    for (const auto& trackId : trackIds) {
        CaptureTrackOutcome outcome;
        auto metadata = archive.get(archive::RecordType::AssetMetadata, trackId);
        if (!metadata)
            return std::unexpected(metadata.error());
        const bool hasTrackMetadata = *metadata && domain::getField(**metadata, "record_role") == "audio-track";
        if (hasTrackMetadata) {
            const std::string storedSource = domain::getField(**metadata, "source");
            outcome.source = storedSource == "application-audio" ? DeviceKind::application
                             : storedSource == "microphone"      ? DeviceKind::microphone
                                                                 : DeviceKind::playback;
        }
        auto recovered = hasTrackMetadata ? recoverNativeCapture(archive, sessionId, trackId) : recoverNativeCapture(archive, sessionId);
        if (recovered) {
            outcome.summary = std::move(*recovered);
            combined.durationUs = std::max(combined.durationUs, outcome.summary->durationUs);
            combined.chunkCount = addSaturated(combined.chunkCount, outcome.summary->chunkCount);
            combined.sampleCount = addSaturated(combined.sampleCount, outcome.summary->sampleCount);
            combined.byteCount = addSaturated(combined.byteCount, outcome.summary->byteCount);
            combined.completed = combined.completed && outcome.summary->completed;
        } else {
            outcome.failure = recovered.error();
            combined.completed = false;
            if (!errorSummary.empty())
                errorSummary.push_back('\n');
            const std::string sourceName = outcome.source == DeviceKind::microphone    ? "microphone"
                                           : outcome.source == DeviceKind::application ? "application-audio"
                                                                                       : "system-audio";
            errorSummary += sourceName + ": " + recovered.error().message;
        }
        combined.tracks.push_back(std::move(outcome));
    }

    auto latestSession = archive.get(archive::RecordType::Session, sessionId);
    if (!latestSession)
        return std::unexpected(latestSession.error());
    if (!*latestSession)
        return std::unexpected(core::error("session_not_found", "Session disappeared during audio recovery."));
    archive::Record finalSession = std::move(**latestSession);
    finalSession.fields["recording_track_count"] = std::to_string(trackIds.size());
    finalSession.fields["recording_audio_chunks"] = std::to_string(combined.chunkCount);
    finalSession.fields["recording_samples"] = std::to_string(combined.sampleCount);
    finalSession.fields["recording_bytes"] = std::to_string(combined.byteCount);
    finalSession.fields["recording_duration_us"] = std::to_string(combined.durationUs);
    finalSession.fields["recording_state"] = combined.completed ? "completed" : combined.chunkCount > 0 ? "partial" : "failed";
    finalSession.fields["recording_error"] = std::move(errorSummary);
    finalSession.fields["recording_recovered_at_us"] = std::to_string(nowUnixMicroseconds());
    if (auto status = archive.put(std::move(finalSession)); !status)
        return std::unexpected(status.error());
    return combined;
}

core::Result<CaptureSummary> captureNative(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options) {
#ifdef _WIN32
    if (options.maximumDuration && options.maximumDuration->count() <= 0) {
        return std::unexpected(core::error("audio_capture_duration_invalid", "Maximum capture duration must be positive."));
    }
    return captureWasapi(archive, sessionId, std::move(options));
#elif defined(__linux__)
    if (isPipeWireDevice(options.deviceId))
        return capturePipeWire(archive, sessionId, std::move(options));
    if (options.source == DeviceKind::application) {
        return std::unexpected(core::error("audio_application_capture_unsupported",
                                           "This Linux build uses ALSA capture and does not expose PipeWire application streams."));
    }
    return captureAlsa(archive, sessionId, std::move(options));
#elif defined(__APPLE__)
    if (options.source == DeviceKind::application)
        return captureScreenCaptureKit(archive, sessionId, std::move(options));
    if (options.source == DeviceKind::playback &&
        (options.deviceId.empty() || options.deviceId == "default" || options.deviceId == "screen-capture-kit")) {
        return captureScreenCaptureKit(archive, sessionId, std::move(options));
    }
    return captureCoreAudio(archive, sessionId, std::move(options));
#else
    static_cast<void>(archive);
    static_cast<void>(sessionId);
    static_cast<void>(options);
    return std::unexpected(core::error("audio_backend_unavailable", "Native recording is not implemented for this platform."));
#endif
}

} // namespace tutorux::audio

#include "tutorux/audio/devices.hpp"

#if defined(__linux__)
#include "tutorux/audio/pipewire_backend.hpp"
#endif

#include <algorithm>
#include <cctype>
#include <iterator>
#include <string_view>
#include <system_error>
#include <vector>

#if defined(__linux__) && defined(TUTORUX_HAS_ALSA)
#include <alsa/asoundlib.h>

#include <cstdlib>
#endif

#if defined(__APPLE__)
#include "tutorux/audio/screencapturekit_backend.hpp"

#include <CoreAudio/CoreAudio.h>
#include <CoreFoundation/CoreFoundation.h>

#include <cstddef>
#include <cstring>
#endif

#ifdef _WIN32
// clang-format off
#include <initguid.h>
#include <Windows.h>
#include <TlHelp32.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
// clang-format on

#if __has_include(<audioclientactivationparams.h>)
#include <audioclientactivationparams.h>
#define TUTORUX_HAS_WASAPI_PROCESS_LOOPBACK 1
#endif

#include <unordered_set>
#endif

#if defined(__linux__) && defined(TUTORUX_HAS_ALSA)
core::Result<std::string> alsaHintValue(const void* hint, const char* key) {
    char* value = snd_device_name_get_hint(hint, key);
    if (!value)
        return std::string{};
    std::string result(value);
    std::free(value);
    return result;
}

core::Result<std::vector<DeviceInfo>> enumerateAlsaCaptureDevices() {
    void** hints = nullptr;
    const int result = snd_device_name_hint(-1, "pcm", &hints);
    if (result < 0) {
        return std::unexpected(
            core::error("audio_device_enumeration_failed", "Enumerating ALSA PCM devices: " + std::string(snd_strerror(result))));
    }

    std::vector<DeviceInfo> devices;
    if (!hints)
        return devices;
    for (void** hint = hints; *hint != nullptr; ++hint) {
        auto id = alsaHintValue(*hint, "NAME");
        auto description = alsaHintValue(*hint, "DESC");
        auto ioType = alsaHintValue(*hint, "IOID");
        if (!id || !description || !ioType) {
            snd_device_name_free_hint(hints);
            return std::unexpected(!id ? id.error() : !description ? description.error() : ioType.error());
        }
        if (id->empty())
            continue;

        const std::string normalizedId = [&] {
            std::string value = *id;
            std::ranges::transform(value, value.begin(), [](unsigned char character) {
                return static_cast<char>(std::tolower(character));
            });
            return value;
        }();
        std::string normalizedDescription = *description;
        std::ranges::transform(normalizedDescription, normalizedDescription.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        const bool isMonitor =
            normalizedId.find("monitor") != std::string::npos || normalizedDescription.find("monitor") != std::string::npos;
        if (!ioType->empty() && *ioType != "Input" && !isMonitor)
            continue;

        std::string name = description->empty() ? *id : *description;
        const bool isDefault = *id == "default";
        const auto duplicate = std::find_if(devices.begin(), devices.end(), [&](const DeviceInfo& device) {
            return device.id == *id;
        });
        if (duplicate == devices.end())
            devices.push_back({std::move(*id), std::move(name), isMonitor ? DeviceKind::playback : DeviceKind::microphone, isDefault});
    }
    snd_device_name_free_hint(hints);
    if (std::none_of(devices.begin(), devices.end(), [](const DeviceInfo& device) {
            return device.id == "default";
        })) {
        devices.insert(devices.begin(), {"default", "Default ALSA input", DeviceKind::microphone, true});
    }
    return devices;
}
#endif

#if defined(__APPLE__)
core::Result<std::string> coreAudioDeviceName(AudioDeviceID deviceId) {
    AudioObjectPropertyAddress address{
        kAudioObjectPropertyName,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    CFStringRef name = nullptr;
    UInt32 size = sizeof(name);
    const OSStatus status = AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &size, &name);
    if (status != noErr || !name) {
        return std::unexpected(
            core::error("audio_device_name_failed", "Reading a CoreAudio device name failed (OSStatus " + std::to_string(status) + ")."));
    }
    std::string converted(static_cast<std::size_t>(CFStringGetMaximumSizeForEncoding(CFStringGetLength(name), kCFStringEncodingUTF8)) + 1,
                          '\0');
    const bool success = CFStringGetCString(name, converted.data(), static_cast<CFIndex>(converted.size()), kCFStringEncodingUTF8);
    CFRelease(name);
    if (!success) {
        return std::unexpected(core::error("audio_device_name_invalid", "Converting a CoreAudio device name failed."));
    }
    converted.resize(std::strlen(converted.c_str()));
    return converted;
}

core::Result<bool> coreAudioDeviceHasInput(AudioDeviceID deviceId) {
    AudioObjectPropertyAddress address{
        kAudioDevicePropertyStreamConfiguration,
        kAudioDevicePropertyScopeInput,
        kAudioObjectPropertyElementMain,
    };
    UInt32 byteCount = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(deviceId, &address, 0, nullptr, &byteCount);
    if (status != noErr) {
        return std::unexpected(core::error("audio_device_query_failed",
                                           "Querying CoreAudio input channels failed (OSStatus " + std::to_string(status) + ")."));
    }
    std::vector<std::byte> storage(byteCount);
    auto* buffers = reinterpret_cast<AudioBufferList*>(storage.data());
    status = AudioObjectGetPropertyData(deviceId, &address, 0, nullptr, &byteCount, buffers);
    if (status != noErr) {
        return std::unexpected(
            core::error("audio_device_query_failed", "Reading CoreAudio input channels failed (OSStatus " + std::to_string(status) + ")."));
    }
    for (UInt32 index = 0; index < buffers->mNumberBuffers; ++index) {
        if (buffers->mBuffers[index].mNumberChannels != 0)
            return true;
    }
    return false;
}

core::Result<std::vector<DeviceInfo>> enumerateCoreAudioInputDevices() {
    AudioObjectPropertyAddress address{
        kAudioHardwarePropertyDevices,
        kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyElementMain,
    };
    UInt32 byteCount = 0;
    OSStatus status = AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &address, 0, nullptr, &byteCount);
    if (status != noErr) {
        return std::unexpected(
            core::error("audio_device_enumeration_failed", "Counting CoreAudio devices failed (OSStatus " + std::to_string(status) + ")."));
    }
    std::vector<AudioDeviceID> deviceIds(byteCount / sizeof(AudioDeviceID));
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &byteCount, deviceIds.data());
    if (status != noErr) {
        return std::unexpected(
            core::error("audio_device_enumeration_failed", "Reading CoreAudio devices failed (OSStatus " + std::to_string(status) + ")."));
    }

    address.mSelector = kAudioHardwarePropertyDefaultInputDevice;
    AudioDeviceID defaultId = kAudioObjectUnknown;
    UInt32 defaultSize = sizeof(defaultId);
    status = AudioObjectGetPropertyData(kAudioObjectSystemObject, &address, 0, nullptr, &defaultSize, &defaultId);
    if (status != noErr) {
        return std::unexpected(core::error("audio_default_device_failed",
                                           "Reading the default CoreAudio input failed (OSStatus " + std::to_string(status) + ")."));
    }

    std::vector<DeviceInfo> devices;
    for (const AudioDeviceID deviceId : deviceIds) {
        auto hasInput = coreAudioDeviceHasInput(deviceId);
        if (!hasInput)
            return std::unexpected(hasInput.error());
        if (!*hasInput)
            continue;
        auto name = coreAudioDeviceName(deviceId);
        if (!name)
            return std::unexpected(name.error());
        devices.push_back({std::to_string(deviceId), std::move(*name), DeviceKind::microphone, deviceId == defaultId});
    }
    return devices;
}
#endif

namespace tutorux::audio {
namespace {

#ifdef _WIN32
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
        explicit operator bool() const {
            return value_ != nullptr;
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

    core::Error windowsAudioError(std::string code, HRESULT result, std::string_view operation) {
        return core::error(std::move(code),
                           std::string(operation) + " failed (HRESULT " + std::to_string(static_cast<unsigned long>(result)) + ").");
    }

    core::Result<std::string> toUtf8(const wchar_t* value) {
        if (!value)
            return std::string{};
        const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, nullptr, 0, nullptr, nullptr);
        if (required <= 0) {
            return std::unexpected(
                windowsAudioError("audio_device_name_invalid", HRESULT_FROM_WIN32(GetLastError()), "Converting an audio device name"));
        }
        std::string converted(static_cast<std::size_t>(required), '\0');
        const int written = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1, converted.data(), required, nullptr, nullptr);
        if (written != required) {
            return std::unexpected(
                windowsAudioError("audio_device_name_invalid", HRESULT_FROM_WIN32(GetLastError()), "Converting an audio device name"));
        }
        converted.pop_back();
        return converted;
    }

    core::Result<std::string> defaultDeviceId(IMMDeviceEnumerator* enumerator, EDataFlow flow) {
        ComOwner<IMMDevice> device;
        const HRESULT result = enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put());
        if (result == E_NOTFOUND)
            return std::string{};
        if (FAILED(result))
            return std::unexpected(windowsAudioError("audio_default_device_failed", result, "Reading the default audio endpoint"));
        LPWSTR identifier = nullptr;
        const HRESULT idResult = device->GetId(&identifier);
        if (FAILED(idResult))
            return std::unexpected(windowsAudioError("audio_device_id_failed", idResult, "Reading the audio endpoint identifier"));
        auto converted = toUtf8(identifier);
        CoTaskMemFree(identifier);
        return converted;
    }

    core::Result<std::string> deviceName(IMMDevice* device) {
        ComOwner<IPropertyStore> properties;
        HRESULT result = device->OpenPropertyStore(STGM_READ, properties.put());
        if (FAILED(result))
            return std::unexpected(windowsAudioError("audio_device_properties_failed", result, "Opening audio endpoint properties"));

        PROPVARIANT value;
        PropVariantInit(&value);
        result = properties->GetValue(PKEY_Device_FriendlyName, &value);
        if (FAILED(result)) {
            PropVariantClear(&value);
            return std::unexpected(windowsAudioError("audio_device_name_failed", result, "Reading the audio endpoint name"));
        }
        PWSTR name = nullptr;
        result = PropVariantToStringAlloc(value, &name);
        PropVariantClear(&value);
        if (FAILED(result)) {
            return std::unexpected(windowsAudioError("audio_device_name_failed", result, "Converting the audio endpoint name"));
        }
        auto converted = toUtf8(name);
        CoTaskMemFree(name);
        return converted;
    }

    core::Status appendDevices(IMMDeviceEnumerator* enumerator, EDataFlow flow, DeviceKind kind, std::string_view defaultId,
                               std::vector<DeviceInfo>& devices) {
        ComOwner<IMMDeviceCollection> collection;
        HRESULT result = enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, collection.put());
        if (FAILED(result))
            return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result, "Enumerating audio endpoints"));
        UINT deviceCount = 0;
        result = collection->GetCount(&deviceCount);
        if (FAILED(result))
            return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result, "Counting audio endpoints"));
        devices.reserve(devices.size() + deviceCount);
        for (UINT index = 0; index < deviceCount; ++index) {
            ComOwner<IMMDevice> device;
            result = collection->Item(index, device.put());
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result, "Reading an audio endpoint"));
            LPWSTR wideIdentifier = nullptr;
            result = device->GetId(&wideIdentifier);
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_device_id_failed", result, "Reading the audio endpoint identifier"));
            auto identifier = toUtf8(wideIdentifier);
            CoTaskMemFree(wideIdentifier);
            if (!identifier)
                return std::unexpected(identifier.error());
            auto name = deviceName(device.get());
            if (!name)
                return std::unexpected(name.error());
            const bool isDefault = *identifier == defaultId;
            devices.push_back({std::move(*identifier), std::move(*name), kind, isDefault});
        }
        return {};
    }

#if defined(TUTORUX_HAS_WASAPI_PROCESS_LOOPBACK)
    BOOL CALLBACK collectVisibleApplicationProcesses(HWND window, LPARAM context) {
        if (!IsWindowVisible(window) || GetWindowTextLengthW(window) == 0)
            return TRUE;

        DWORD processId = 0;
        if (GetWindowThreadProcessId(window, &processId) != 0 && processId != 0 && processId != GetCurrentProcessId()) {
            reinterpret_cast<std::unordered_set<DWORD>*>(context)->insert(processId);
        }
        return TRUE;
    }

    core::Result<std::vector<DeviceInfo>> enumerateWindowsApplicationAudioSources() {
        std::unordered_set<DWORD> visibleProcesses;
        if (!EnumWindows(collectVisibleApplicationProcesses, reinterpret_cast<LPARAM>(&visibleProcesses))) {
            return std::unexpected(windowsAudioError("audio_application_enumeration_failed", HRESULT_FROM_WIN32(GetLastError()),
                                                     "Enumerating visible application windows"));
        }
        if (visibleProcesses.empty())
            return std::vector<DeviceInfo>{};

        const HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == INVALID_HANDLE_VALUE) {
            return std::unexpected(windowsAudioError("audio_application_enumeration_failed", HRESULT_FROM_WIN32(GetLastError()),
                                                     "Reading the current process list"));
        }
        const auto closeSnapshot = [&] {
            CloseHandle(snapshot);
        };

        DWORD currentSession = 0;
        if (!ProcessIdToSessionId(GetCurrentProcessId(), &currentSession)) {
            const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
            closeSnapshot();
            return std::unexpected(windowsAudioError("audio_application_enumeration_failed", error, "Reading the current Windows session"));
        }

        std::vector<DeviceInfo> applications;
        PROCESSENTRY32W process{};
        process.dwSize = sizeof(process);
        if (Process32FirstW(snapshot, &process)) {
            do {
                if (!visibleProcesses.contains(process.th32ProcessID))
                    continue;
                DWORD processSession = 0;
                if (!ProcessIdToSessionId(process.th32ProcessID, &processSession) || processSession != currentSession) {
                    continue;
                }

                auto executable = toUtf8(process.szExeFile);
                if (!executable) {
                    closeSnapshot();
                    return std::unexpected(executable.error());
                }
                std::string name = std::move(*executable);
                if (name.size() > 4 && name.substr(name.size() - 4) == ".exe")
                    name.resize(name.size() - 4);
                applications.push_back({
                    "wasapi-process:" + std::to_string(process.th32ProcessID),
                    name + " (process " + std::to_string(process.th32ProcessID) + ")",
                    DeviceKind::application,
                    false,
                });
            } while (Process32NextW(snapshot, &process));
        } else if (GetLastError() != ERROR_NO_MORE_FILES) {
            const HRESULT error = HRESULT_FROM_WIN32(GetLastError());
            closeSnapshot();
            return std::unexpected(windowsAudioError("audio_application_enumeration_failed", error, "Reading the current process list"));
        }
        closeSnapshot();
        std::sort(applications.begin(), applications.end(), [](const DeviceInfo& left, const DeviceInfo& right) {
            return left.name < right.name;
        });
        return applications;
    }
#endif
#endif

} // namespace

core::Result<std::vector<DeviceInfo>> enumerateDevices() {
#ifdef _WIN32
    ComApartment apartment;
    if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
        return std::unexpected(
            windowsAudioError("audio_com_initialization_failed", apartment.result(), "Initializing Windows audio access"));
    }

    ComOwner<IMMDeviceEnumerator> enumerator;
    const HRESULT result = CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator,
                                            reinterpret_cast<void**>(enumerator.put()));
    if (FAILED(result))
        return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result, "Creating the audio device enumerator"));

    auto defaultInput = defaultDeviceId(enumerator.get(), eCapture);
    if (!defaultInput)
        return std::unexpected(defaultInput.error());
    auto defaultOutput = defaultDeviceId(enumerator.get(), eRender);
    if (!defaultOutput)
        return std::unexpected(defaultOutput.error());

    std::vector<DeviceInfo> devices;
    if (auto status = appendDevices(enumerator.get(), eCapture, DeviceKind::microphone, *defaultInput, devices); !status) {
        return std::unexpected(status.error());
    }
    if (auto status = appendDevices(enumerator.get(), eRender, DeviceKind::playback, *defaultOutput, devices); !status) {
        return std::unexpected(status.error());
    }
#if defined(TUTORUX_HAS_WASAPI_PROCESS_LOOPBACK)
    auto applicationSources = enumerateWindowsApplicationAudioSources();
    if (!applicationSources)
        return std::unexpected(applicationSources.error());
    devices.insert(devices.end(), std::make_move_iterator(applicationSources->begin()), std::make_move_iterator(applicationSources->end()));
#endif
    return devices;
#elif defined(__linux__) && defined(TUTORUX_HAS_ALSA)
    auto alsaDevices = enumerateAlsaCaptureDevices();
    auto pipeWireDevices = enumeratePipeWireDevices();
    if (!alsaDevices) {
        if (!pipeWireDevices || pipeWireDevices->empty())
            return std::unexpected(alsaDevices.error());
        return std::move(*pipeWireDevices);
    }
    if (pipeWireDevices) {
        for (auto& device : *pipeWireDevices) {
            if (std::none_of(alsaDevices->begin(), alsaDevices->end(), [&](const DeviceInfo& existing) {
                    return existing.id == device.id;
                })) {
                alsaDevices->push_back(std::move(device));
            }
        }
    }
    return std::move(*alsaDevices);
#elif defined(__APPLE__)
    auto devices = enumerateCoreAudioInputDevices();
    if (!devices)
        return std::unexpected(devices.error());
    if (probeScreenCaptureKitDevice("screen-capture-kit")) {
        devices->push_back({"screen-capture-kit", "System audio (ScreenCaptureKit)", DeviceKind::playback, false});
    }
    auto applications = enumerateScreenCaptureKitApplications();
    if (applications) {
        devices->insert(devices->end(), std::make_move_iterator(applications->begin()), std::make_move_iterator(applications->end()));
    }
    return devices;
#else
    return std::unexpected(
        core::error("audio_backend_unavailable", "Native device enumeration is not implemented for this platform build."));
#endif
}

} // namespace tutorux::audio

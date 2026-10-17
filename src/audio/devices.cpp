#include "tutorux/audio/devices.hpp"

#include <string_view>
#include <system_error>
#include <vector>

#ifdef _WIN32
// clang-format off
#include <initguid.h>
#include <Windows.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mmdeviceapi.h>
#include <propvarutil.h>
// clang-format on
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
            ComApartment() : result_(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) {}
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

        core::Error windowsAudioError(std::string code, HRESULT result,
                                      std::string_view operation) {
            return core::error(std::move(code),
                               std::string(operation) + " failed (HRESULT " +
                                   std::to_string(static_cast<unsigned long>(result)) + ").");
        }

        core::Result<std::string> toUtf8(const wchar_t* value) {
            if (!value)
                return std::string{};
            const int required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                                                     nullptr, 0, nullptr, nullptr);
            if (required <= 0) {
                return std::unexpected(windowsAudioError("audio_device_name_invalid",
                                                         HRESULT_FROM_WIN32(GetLastError()),
                                                         "Converting an audio device name"));
            }
            std::string converted(static_cast<std::size_t>(required), '\0');
            const int written = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value, -1,
                                                    converted.data(), required, nullptr, nullptr);
            if (written != required) {
                return std::unexpected(windowsAudioError("audio_device_name_invalid",
                                                         HRESULT_FROM_WIN32(GetLastError()),
                                                         "Converting an audio device name"));
            }
            converted.pop_back();
            return converted;
        }

        core::Result<std::string> defaultDeviceId(IMMDeviceEnumerator* enumerator, EDataFlow flow) {
            ComOwner<IMMDevice> device;
            const HRESULT result =
                enumerator->GetDefaultAudioEndpoint(flow, eConsole, device.put());
            if (result == E_NOTFOUND)
                return std::string{};
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_default_device_failed", result,
                                                         "Reading the default audio endpoint"));
            LPWSTR identifier = nullptr;
            const HRESULT idResult = device->GetId(&identifier);
            if (FAILED(idResult))
                return std::unexpected(windowsAudioError("audio_device_id_failed", idResult,
                                                         "Reading the audio endpoint identifier"));
            auto converted = toUtf8(identifier);
            CoTaskMemFree(identifier);
            return converted;
        }

        core::Result<std::string> deviceName(IMMDevice* device) {
            ComOwner<IPropertyStore> properties;
            HRESULT result = device->OpenPropertyStore(STGM_READ, properties.put());
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_device_properties_failed", result,
                                                         "Opening audio endpoint properties"));

            PROPVARIANT value;
            PropVariantInit(&value);
            result = properties->GetValue(PKEY_Device_FriendlyName, &value);
            if (FAILED(result)) {
                PropVariantClear(&value);
                return std::unexpected(windowsAudioError("audio_device_name_failed", result,
                                                         "Reading the audio endpoint name"));
            }
            PWSTR name = nullptr;
            result = PropVariantToStringAlloc(value, &name);
            PropVariantClear(&value);
            if (FAILED(result)) {
                return std::unexpected(windowsAudioError("audio_device_name_failed", result,
                                                         "Converting the audio endpoint name"));
            }
            auto converted = toUtf8(name);
            CoTaskMemFree(name);
            return converted;
        }

        core::Status appendDevices(IMMDeviceEnumerator* enumerator, EDataFlow flow, DeviceKind kind,
                                   std::string_view defaultId, std::vector<DeviceInfo>& devices) {
            ComOwner<IMMDeviceCollection> collection;
            HRESULT result =
                enumerator->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, collection.put());
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result,
                                                         "Enumerating audio endpoints"));
            UINT deviceCount = 0;
            result = collection->GetCount(&deviceCount);
            if (FAILED(result))
                return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result,
                                                         "Counting audio endpoints"));
            devices.reserve(devices.size() + deviceCount);
            for (UINT index = 0; index < deviceCount; ++index) {
                ComOwner<IMMDevice> device;
                result = collection->Item(index, device.put());
                if (FAILED(result))
                    return std::unexpected(windowsAudioError("audio_device_enumeration_failed",
                                                             result, "Reading an audio endpoint"));
                LPWSTR wideIdentifier = nullptr;
                result = device->GetId(&wideIdentifier);
                if (FAILED(result))
                    return std::unexpected(windowsAudioError(
                        "audio_device_id_failed", result, "Reading the audio endpoint identifier"));
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
#endif

    } // namespace

    core::Result<std::vector<DeviceInfo>> enumerateDevices() {
#ifdef _WIN32
        ComApartment apartment;
        if (FAILED(apartment.result()) && apartment.result() != RPC_E_CHANGED_MODE) {
            return std::unexpected(windowsAudioError("audio_com_initialization_failed",
                                                     apartment.result(),
                                                     "Initializing Windows audio access"));
        }

        ComOwner<IMMDeviceEnumerator> enumerator;
        const HRESULT result =
            CoCreateInstance(CLSID_MMDeviceEnumerator, nullptr, CLSCTX_ALL, IID_IMMDeviceEnumerator,
                             reinterpret_cast<void**>(enumerator.put()));
        if (FAILED(result))
            return std::unexpected(windowsAudioError("audio_device_enumeration_failed", result,
                                                     "Creating the audio device enumerator"));

        auto defaultInput = defaultDeviceId(enumerator.get(), eCapture);
        if (!defaultInput)
            return std::unexpected(defaultInput.error());
        auto defaultOutput = defaultDeviceId(enumerator.get(), eRender);
        if (!defaultOutput)
            return std::unexpected(defaultOutput.error());

        std::vector<DeviceInfo> devices;
        if (auto status = appendDevices(enumerator.get(), eCapture, DeviceKind::microphone,
                                        *defaultInput, devices);
            !status) {
            return std::unexpected(status.error());
        }
        if (auto status = appendDevices(enumerator.get(), eRender, DeviceKind::playback,
                                        *defaultOutput, devices);
            !status) {
            return std::unexpected(status.error());
        }
        return devices;
#else
        return std::unexpected(
            core::error("audio_backend_unavailable",
                        "Native device enumeration is not implemented for this platform build."));
#endif
    }

} // namespace tutorux::audio

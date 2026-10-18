#pragma once

#include "tutorux/audio/capture.hpp"

#include <string_view>

namespace tutorux::audio {

inline constexpr std::string_view kPipeWireDevicePrefix = "pipewire:";

bool isPipeWireDevice(std::string_view deviceId) noexcept;
core::Result<std::vector<DeviceInfo>> enumeratePipeWireDevices();
core::Result<CaptureDeviceProbe> probePipeWireCaptureDevice(DeviceKind source, std::string deviceId);
core::Result<CapturePreflightSummary> preflightPipeWireCaptureDevice(CapturePreflightOptions options);
core::Result<CaptureSummary> capturePipeWire(archive::Archive& archive, const archive::Uuid& sessionId,
                                             CaptureOptions options);

} // namespace tutorux::audio

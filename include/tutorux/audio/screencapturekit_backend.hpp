#pragma once

#include "tutorux/audio/capture.hpp"

#include <vector>

namespace tutorux::audio {

core::Result<CaptureDeviceProbe> probeScreenCaptureKitDevice(std::string deviceId);
core::Result<std::vector<DeviceInfo>> enumerateScreenCaptureKitApplications();
core::Result<CaptureDeviceProbe> probeScreenCaptureKitApplication(std::string deviceId);
core::Result<CaptureSummary> captureScreenCaptureKit(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options);

} // namespace tutorux::audio

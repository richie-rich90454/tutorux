#pragma once

#include "tutorux/audio/capture.hpp"

namespace tutorux::audio {

core::Result<CaptureDeviceProbe> probeScreenCaptureKitDevice(std::string deviceId);
core::Result<CaptureSummary> captureScreenCaptureKit(archive::Archive& archive,
                                                     const archive::Uuid& sessionId,
                                                     CaptureOptions options);

} // namespace tutorux::audio

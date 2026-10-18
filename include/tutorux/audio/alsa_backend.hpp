#pragma once

#include "tutorux/audio/capture.hpp"

namespace tutorux::audio {

core::Result<CaptureDeviceProbe> probeAlsaCaptureDevice(std::string deviceId);
core::Result<CaptureSummary>
captureAlsa(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options);

} // namespace tutorux::audio

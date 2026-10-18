#pragma once

#include "tutorux/audio/capture.hpp"

namespace tutorux::audio {

core::Result<CaptureDeviceProbe> probeCoreAudioCaptureDevice(std::string deviceId);
core::Result<CapturePreflightSummary>
preflightCoreAudioCaptureDevice(CapturePreflightOptions options);
core::Result<CaptureSummary>
captureCoreAudio(archive::Archive& archive, const archive::Uuid& sessionId, CaptureOptions options);

} // namespace tutorux::audio

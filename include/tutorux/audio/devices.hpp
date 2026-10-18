#pragma once

#include "tutorux/core/result.hpp"

#include <string>
#include <vector>

namespace tutorux::audio {

enum class DeviceKind {
    microphone,
    playback,
    application
};

struct DeviceInfo final {
    std::string id;
    std::string name;
    DeviceKind kind{DeviceKind::microphone};
    bool isDefault{};
};

core::Result<std::vector<DeviceInfo>> enumerateDevices();

} // namespace tutorux::audio

#pragma once

#include "tutorux/core/result.hpp"

#include <atomic>
#include <filesystem>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::audio {

struct RecordingControlCallbacks final {
    std::function<bool()> stopRequested;
    std::function<bool()> pauseRequested;
    std::function<void(std::string state, std::string message)> stateChanged;
};

struct RecordingControlResponse final {
    std::string state;
    std::string message;
};

using RecordingWorker = std::function<core::Status(const RecordingControlCallbacks&)>;

core::Result<std::string> recordingControlEndpoint(const std::filesystem::path& archivePath,
                                                   std::string_view sessionId);
core::Result<RecordingControlResponse> sendRecordingControl(std::string_view endpoint,
                                                            std::string_view command);
core::Status launchRecordingWorker(std::string_view endpoint,
                                   const std::vector<std::string>& arguments);
int runRecordingWorker(std::string endpoint, RecordingWorker worker);

} // namespace tutorux::audio

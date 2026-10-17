#pragma once

#include "tutorux/core/result.hpp"

#include <cstdint>
#include <filesystem>
#include <functional>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::command {

    struct CommandResult final {
        bool json{};
        std::string output;
        int exitCode{};
    };

    struct ProgressEvent final {
        std::string phase;
        std::string message;
        std::uint64_t completed{};
        std::uint64_t total{};
    };

    using ProgressCallback = std::function<void(const ProgressEvent&)>;

    struct DispatchControl final {
        std::function<bool()> stopRequested;
        std::function<bool()> pauseRequested;
        std::function<void(std::string state, std::string message)> stateChanged;
        std::string_view archivePassphrase;
        std::string_view newArchivePassphrase;
    };

    core::Result<CommandResult> dispatch(const std::vector<std::string>& arguments,
                                         ProgressCallback progress = {},
                                         DispatchControl control = {});
    std::string helpText();
    std::string versionText();

} // namespace tutorux::command

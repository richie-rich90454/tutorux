#include "tutorux/audio/recording_control.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/command/json.hpp"

#ifdef TUTORUX_WITH_GUI
#include "tutorux/gui/desktop.hpp"
#endif

#include <algorithm>
#include <csignal>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#elif defined(__APPLE__)
#include <mach-o/dyld.h>
#endif

namespace {

volatile std::sig_atomic_t cliStopRequested = 0;

void requestCliStop(int) {
    cliStopRequested = 1;
}

std::filesystem::path executableDirectory(const char* executableArgument) {
#ifdef _WIN32
    std::vector<wchar_t> buffer(32'768);
    const DWORD length =
        GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length > 0 && length < buffer.size())
        return std::filesystem::path(std::wstring(buffer.data(), length)).parent_path();
#elif defined(__APPLE__)
    std::uint32_t requiredSize = 0;
    static_cast<void>(_NSGetExecutablePath(nullptr, &requiredSize));
    if (requiredSize > 0) {
        std::vector<char> buffer(requiredSize);
        if (_NSGetExecutablePath(buffer.data(), &requiredSize) == 0)
            return std::filesystem::absolute(buffer.data()).parent_path();
    }
#elif defined(__linux__)
    std::error_code errorCode;
    const auto executable = std::filesystem::read_symlink("/proc/self/exe", errorCode);
    if (!errorCode)
        return executable.parent_path();
#endif
    std::error_code errorCode;
    const auto executable = std::filesystem::absolute(executableArgument, errorCode);
    return errorCode ? std::filesystem::current_path() : executable.parent_path();
}

} // namespace

int main(int argumentCount, char* argumentValues[]) {
    if (argumentCount >= 3 && std::string_view(argumentValues[1]) == "--record-worker") {
        std::vector<std::string> workerArguments;
        workerArguments.reserve(static_cast<std::size_t>(argumentCount - 3));
        for (int index = 3; index < argumentCount; ++index)
            workerArguments.emplace_back(argumentValues[index]);
        return tutorux::audio::runRecordingWorker(
            argumentValues[2],
            [&](const tutorux::audio::RecordingControlCallbacks& callbacks)
                -> tutorux::core::Status {
                tutorux::command::DispatchControl control{
                    callbacks.stopRequested, callbacks.pauseRequested, callbacks.stateChanged};
                auto commandResult =
                    tutorux::command::dispatch(workerArguments, {}, std::move(control));
                if (!commandResult)
                    return std::unexpected(commandResult.error());
                if (commandResult->exitCode != 0) {
                    return std::unexpected(
                        tutorux::core::error("recording_worker_failed", commandResult->output));
                }
                return tutorux::core::Status{};
            });
    }
    std::vector<std::string> arguments;
    arguments.reserve(static_cast<std::size_t>(argumentCount > 0 ? argumentCount - 1 : 0));
    bool jsonOutput = false;
    for (int index = 1; index < argumentCount; ++index) {
        arguments.emplace_back(argumentValues[index]);
        if (arguments.back() == "--json")
            jsonOutput = true;
    }
#ifdef TUTORUX_WITH_GUI
    bool hasExplicitCommand = false;
    bool guiCommand = false;
    std::optional<std::filesystem::path> archivePath;
    std::optional<std::filesystem::path> directoryPath;
    for (std::size_t index = 0; index < arguments.size(); ++index) {
        const std::string& argument = arguments[index];
        if (argument == "--archive" && index + 1 < arguments.size()) {
            archivePath = arguments[++index];
            continue;
        }
        if (argument == "--directory" && index + 1 < arguments.size()) {
            directoryPath = arguments[++index];
            continue;
        }
        constexpr std::string_view archivePrefix = "--archive=";
        if (argument.starts_with(archivePrefix)) {
            archivePath = argument.substr(archivePrefix.size());
            continue;
        }
        constexpr std::string_view directoryPrefix = "--directory=";
        if (argument.starts_with(directoryPrefix)) {
            directoryPath = argument.substr(directoryPrefix.size());
            continue;
        }
        if (argument == "--json" || argument == "--quiet" || argument == "--verbose" ||
            argument == "--no-color")
            continue;
        if (argument == "gui") {
            guiCommand = true;
            continue;
        }
        hasExplicitCommand = true;
    }
    const bool guiRequested = argumentCount == 1 || guiCommand || !hasExplicitCommand;
    if (guiRequested) {
        if (!directoryPath) {
            directoryPath = guiCommand ? std::filesystem::current_path()
                                       : executableDirectory(argumentValues[0]);
        }
        if (archivePath && archivePath->is_relative())
            archivePath = std::filesystem::absolute(*directoryPath / *archivePath);
#ifdef _WIN32
        static_cast<void>(FreeConsole());
#endif
        return tutorux::gui::launchDesktop(std::move(archivePath), std::move(directoryPath));
    }
#endif
    try {
        bool emittedProgress = false;
        cliStopRequested = 0;
        static_cast<void>(std::signal(SIGINT, requestCliStop));
        tutorux::command::DispatchControl control;
        control.stopRequested = [] {
            return cliStopRequested != 0;
        };
        auto commandResult = tutorux::command::dispatch(
            arguments,
            [&](const tutorux::command::ProgressEvent& event) {
                emittedProgress = true;
                if (jsonOutput) {
                    std::cout << tutorux::command::toJson({
                                     {"event",     "progress"                     },
                                     {"phase",     event.phase                    },
                                     {"message",   event.message                  },
                                     {"completed", std::to_string(event.completed)},
                                     {"total",     std::to_string(event.total)    }
                    })
                              << '\n';
                } else if (event.phase == "ai-generation-text") {
                    std::cerr << event.message << std::flush;
                } else {
                    std::cerr << '\r' << event.message << "   " << std::flush;
                }
            },
            std::move(control));
        if (emittedProgress && !jsonOutput)
            std::cerr << '\n';
        if (!commandResult) {
            if (jsonOutput) {
                std::cout << "{\"error\":{\"code\":\""
                          << tutorux::command::jsonEscape(commandResult.error().code)
                          << "\",\"message\":\""
                          << tutorux::command::jsonEscape(commandResult.error().message)
                          << "\"}}\n";
            } else {
                std::cerr << "tutorux: " << commandResult.error().message << "\n";
            }
            return 2;
        }
        std::cout << commandResult->output;
        if (!commandResult->output.empty() && commandResult->output.back() != '\n')
            std::cout << '\n';
        return commandResult->exitCode;
    } catch (const std::exception& exception) {
        if (jsonOutput) {
            std::cout << "{\"error\":{\"code\":\"unexpected_error\",\"message\":\""
                      << tutorux::command::jsonEscape(exception.what()) << "\"}}\n";
        } else {
            std::cerr << "tutorux: unexpected error: " << exception.what() << "\n";
        }
        return 2;
    } catch (...) {
        if (jsonOutput) {
            std::cout
                << "{\"error\":{\"code\":\"unexpected_error\",\"message\":\"Unknown failure.\"}}\n";
        } else {
            std::cerr << "tutorux: unknown failure.\n";
        }
        return 2;
    }
}

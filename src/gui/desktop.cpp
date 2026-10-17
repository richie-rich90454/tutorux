#include "tutorux/gui/desktop.hpp"

#include "app-window.h"
#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <exception>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <vector>

#include <sodium.h>

namespace tutorux::gui {
    namespace {

        using tutorux::archive::Archive;
        using tutorux::archive::ArchiveInfo;
        using tutorux::command::CommandResult;
        using tutorux::core::Result;

        slint::SharedString toSharedString(std::string_view text) {
            return slint::SharedString(text);
        }

        std::string archiveChoices(const std::vector<ArchiveInfo>& archives) {
            if (archives.empty())
                return "No .tux archives were found in this folder. Create one to begin.";
            std::ostringstream output;
            output << "Archives in this folder\n\n";
            for (const auto& archive : archives) {
                output << (archive.healthStatus == "healthy" ? "●  " : "!  ") << archive.displayName
                       << "\n    " << archive.path.string();
                if (archive.healthStatus != "healthy")
                    output << "\n    Status: " << archive.healthStatus;
                output << "\n\n";
            }
            return output.str();
        }

        std::shared_ptr<slint::VectorModel<slint::SharedString>>
        archivePathChoices(const std::vector<ArchiveInfo>& archives) {
            std::vector<slint::SharedString> paths;
            paths.reserve(archives.size());
            for (const auto& archive : archives)
                paths.emplace_back(archive.path.string());
            return std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(paths));
        }

        std::string commandOutput(Result<CommandResult> command) {
            if (!command)
                return command.error().message;
            return command->output.empty() ? "Completed." : command->output;
        }

        std::vector<std::string> archiveCommand(const std::filesystem::path& path,
                                                std::initializer_list<std::string> command) {
            std::vector<std::string> arguments{"--archive", path.string()};
            arguments.insert(arguments.end(), command.begin(), command.end());
            return arguments;
        }

        void eraseSecret(std::string& secret) {
            if (!secret.empty())
                sodium_memzero(secret.data(), secret.size());
            secret.clear();
        }

        Result<CommandResult> dispatchWithSecrets(const std::vector<std::string>& arguments,
                                                  std::string_view passphrase = {},
                                                  std::string_view newPassphrase = {},
                                                  tutorux::command::ProgressCallback progress = {},
                                                  std::function<bool()> stopRequested = {}) {
            tutorux::command::DispatchControl control;
            control.archivePassphrase = passphrase;
            control.newArchivePassphrase = newPassphrase;
            control.stopRequested = std::move(stopRequested);
            return command::dispatch(arguments, std::move(progress), std::move(control));
        }

        Result<std::vector<std::string>> parseCommandLine(std::string_view input) {
            std::vector<std::string> arguments;
            std::string token;
            char quote = 0;
            bool escaped = false;
            bool tokenStarted = false;

            const auto finishToken = [&]() {
                if (!tokenStarted)
                    return;
                arguments.push_back(std::move(token));
                token.clear();
                tokenStarted = false;
            };

            for (const char character : input) {
                if (escaped) {
                    token.push_back(character);
                    escaped = false;
                    continue;
                }
                if (quote != 0) {
                    if (character == '\\' && quote == '"') {
                        escaped = true;
                    } else if (character == quote) {
                        quote = 0;
                    } else {
                        token.push_back(character);
                    }
                    tokenStarted = true;
                    continue;
                }
                if (character == '"' || character == '\'') {
                    quote = character;
                    tokenStarted = true;
                } else if (std::isspace(static_cast<unsigned char>(character)) != 0) {
                    finishToken();
                } else {
                    token.push_back(character);
                    tokenStarted = true;
                }
            }

            if (escaped)
                token.push_back('\\');
            if (quote != 0) {
                return std::unexpected(
                    tutorux::core::error("command_quote_unclosed",
                                         "Close the quoted command argument before running it."));
            }
            finishToken();
            if (!arguments.empty() && arguments.front() == "tutorux")
                arguments.erase(arguments.begin());
            if (arguments.empty()) {
                return std::unexpected(
                    tutorux::core::error("command_empty", "Enter a Tutorux command to run."));
            }
            for (const auto& argument : arguments) {
                if (argument == "--archive" || argument.starts_with("--archive=") ||
                    argument == "--directory" || argument.starts_with("--directory=")) {
                    return std::unexpected(tutorux::core::error(
                        "command_workspace_override",
                        "The command console always uses the selected archive and directory."));
                }
            }
            return arguments;
        }

        std::string commandResultText(const Result<CommandResult>& command) {
            if (!command)
                return command.error().message;
            if (command->exitCode != 0)
                return command->output.empty() ? "Command failed." : command->output;
            if (command->output.empty())
                return "Completed.";
            constexpr std::size_t maximumDisplayedBytes = 256U * 1024U;
            if (command->output.size() > maximumDisplayedBytes) {
                return "Command completed, but its " + std::to_string(command->output.size()) +
                       "-byte result is too large to display here. Use the CLI to save or inspect "
                       "the full output.";
            }
            return command->output;
        }

        void refreshWorkspace(MainWindow& window, const std::filesystem::path& path,
                              std::string_view passphrase = {}) {
            window.set_archive_path(toSharedString(path.string()));
            auto info = Archive::discover(path.parent_path());
            window.set_archive_list(
                toSharedString(info ? archiveChoices(*info) : info.error().message));
            window.set_archive_paths(archivePathChoices(info ? *info : std::vector<ArchiveInfo>{}));
            auto students =
                dispatchWithSecrets(archiveCommand(path, {"student", "list"}), passphrase);
            auto sessions =
                dispatchWithSecrets(archiveCommand(path, {"session", "list"}), passphrase);
            window.set_students_text(toSharedString(commandOutput(std::move(students))));
            window.set_sessions_text(toSharedString(commandOutput(std::move(sessions))));
            window.set_selected_archive(toSharedString(path.filename().string()));
        }

        std::optional<std::filesystem::path>
        initialArchive(const std::optional<std::filesystem::path>& requested,
                       const std::filesystem::path& directory) {
            if (requested)
                return requested;
            auto archives = Archive::discover(directory);
            if (!archives)
                return std::nullopt;
            std::vector<std::filesystem::path> healthy;
            for (const auto& archive : *archives) {
                if (archive.healthStatus == "healthy")
                    healthy.push_back(archive.path);
            }
            if (archives->size() == 1 && healthy.size() == 1)
                return healthy.front();
            return std::nullopt;
        }

    } // namespace

    int launchDesktop(std::optional<std::filesystem::path> archivePath,
                      std::optional<std::filesystem::path> directoryPath) {
        auto window = MainWindow::create();
        auto directory = directoryPath ? std::filesystem::absolute(*directoryPath)
                                       : std::filesystem::current_path();
        if (archivePath && archivePath->is_relative())
            archivePath = directory / *archivePath;
        auto archives = Archive::discover(directory);
        std::string startupMessage = "Your tutoring data stays in the selected .tux archive.";
        if (!archivePath && archives && archives->empty())
            startupMessage = "No archive was found. Choose a name and create a workspace to begin.";
        window->set_archive_list(
            toSharedString(archives ? archiveChoices(*archives) : archives.error().message));
        window->set_archive_paths(
            archivePathChoices(archives ? *archives : std::vector<ArchiveInfo>{}));
        window->set_archive_path(toSharedString(archivePath ? archivePath->string() : ""));
        window->set_archive_name(toSharedString("Tutorux.tux"));
        window->set_students_text(toSharedString("Choose an archive to view students."));
        window->set_sessions_text(toSharedString("Choose an archive to view sessions."));
        window->set_selected_archive(toSharedString("No archive selected"));
        window->set_status_message(toSharedString(startupMessage));
        std::string activePassphrase;

        auto selected = initialArchive(archivePath, directory);
        if (selected) {
            auto info = tutorux::archive::inspectArchive(*selected);
            if (info) {
                directory = info->path.parent_path();
                if (info->healthStatus == "locked") {
                    window->set_archive_path(toSharedString(info->path.string()));
                    window->set_selected_archive(toSharedString(info->path.filename().string()));
                    window->set_students_text(toSharedString(
                        "This archive is encrypted. Enter its passphrase to unlock it."));
                    window->set_sessions_text(
                        toSharedString("Unlock the archive to view sessions."));
                    window->set_status_message(toSharedString("Archive is locked."));
                } else {
                    refreshWorkspace(*window, info->path);
                }
            } else {
                window->set_status_message(toSharedString(info.error().message));
            }
        }

        window->on_open_archive([&](slint::SharedString requestedPath,
                                    slint::SharedString requestedPassphrase) {
            std::filesystem::path path(requestedPath.data());
            if (path.is_relative())
                path = directory / path;
            std::string passphrase(requestedPassphrase.data(), requestedPassphrase.size());
            auto info = tutorux::archive::inspectArchive(path, passphrase);
            if (!info) {
                eraseSecret(passphrase);
                window->set_status_message(toSharedString(info.error().message));
                return;
            }
            if (info->healthStatus == "locked") {
                eraseSecret(passphrase);
                window->set_status_message(
                    toSharedString("Enter the archive passphrase before opening this workspace."));
                return;
            }
            directory = info->path.parent_path();
            eraseSecret(activePassphrase);
            auto opened = Archive::open(info->path, false, passphrase);
            if (!opened) {
                eraseSecret(passphrase);
                window->set_status_message(toSharedString(opened.error().message));
                return;
            }
            if (opened->encrypted())
                activePassphrase = std::move(passphrase);
            eraseSecret(passphrase);
            window->set_archive_passphrase(toSharedString(""));
            refreshWorkspace(*window, info->path, activePassphrase);
            window->set_status_message(
                toSharedString("Archive opened. Changes save directly to this file."));
        });

        window->on_forget_passphrase([&]() {
            eraseSecret(activePassphrase);
            window->set_archive_passphrase(toSharedString(""));
            const std::filesystem::path path(window->get_archive_path().data());
            auto info = tutorux::archive::inspectArchive(path);
            if (info && info->healthStatus == "locked") {
                window->set_students_text(toSharedString("Unlock the archive to view students."));
                window->set_sessions_text(toSharedString("Unlock the archive to view sessions."));
                window->set_status_message(
                    toSharedString("Passphrase cleared. Archive is locked."));
            } else {
                window->set_status_message(toSharedString("Passphrase cleared from memory."));
            }
        });

        window->on_create_archive([&](slint::SharedString requestedName,
                                      slint::SharedString requestedPassphrase) {
            std::string name(requestedName.data());
            if (name.empty())
                name = "Tutorux.tux";
            std::filesystem::path path(name);
            std::string extension = path.extension().string();
            std::transform(
                extension.begin(), extension.end(), extension.begin(),
                [](unsigned char character) { return static_cast<char>(std::tolower(character)); });
            if (extension != ".tux")
                path += ".tux";
            if (path.is_relative())
                path = directory / path;
            auto created = command::dispatch(
                {"archive", "init", path.string(), "--name", path.stem().string()});
            if (!created) {
                window->set_status_message(toSharedString(created.error().message));
                return;
            }
            std::string newPassphrase(requestedPassphrase.data(), requestedPassphrase.size());
            if (!newPassphrase.empty()) {
                auto encrypted =
                    dispatchWithSecrets({"archive", "encrypt", path.string()}, {}, newPassphrase);
                if (!encrypted || encrypted->exitCode != 0) {
                    eraseSecret(newPassphrase);
                    window->set_status_message(toSharedString(commandOutput(std::move(encrypted))));
                    return;
                }
                eraseSecret(activePassphrase);
                activePassphrase = std::move(newPassphrase);
            }
            eraseSecret(newPassphrase);
            window->set_new_archive_passphrase(toSharedString(""));
            refreshWorkspace(*window, path, activePassphrase);
            window->set_status_message(toSharedString("Archive created and selected."));
        });

        window->on_create_student([&](slint::SharedString requestedName) {
            if (requestedName.empty()) {
                window->set_status_message(toSharedString("Enter a student name first."));
                return;
            }
            const std::filesystem::path path(window->get_archive_path().data());
            if (path.empty()) {
                window->set_status_message(
                    toSharedString("Choose an archive before adding a student."));
                return;
            }
            auto created =
                dispatchWithSecrets(archiveCommand(path, {"student", "create", "--name",
                                                          std::string(requestedName.data())}),
                                    activePassphrase);
            window->set_status_message(toSharedString(commandOutput(std::move(created))));
            refreshWorkspace(*window, path, activePassphrase);
        });

        window->on_create_session([&](slint::SharedString subject, slint::SharedString title) {
            const std::filesystem::path path(window->get_archive_path().data());
            if (path.empty()) {
                window->set_status_message(
                    toSharedString("Choose an archive before adding a session."));
                return;
            }
            if (title.empty()) {
                window->set_status_message(toSharedString("Enter a session title first."));
                return;
            }
            auto created = dispatchWithSecrets(
                archiveCommand(path, {"session", "create", "--subject", std::string(subject.data()),
                                      "--title", std::string(title.data())}),
                activePassphrase);
            window->set_status_message(toSharedString(commandOutput(std::move(created))));
            refreshWorkspace(*window, path, activePassphrase);
        });

        const auto commandBusy = std::make_shared<std::atomic_bool>(false);
        const auto commandStopRequested = std::make_shared<std::atomic_bool>(false);
        const auto commandThreads = std::make_shared<std::vector<std::thread>>();
        const auto commandThreadsMutex = std::make_shared<std::mutex>();
        const slint::ComponentWeakHandle<MainWindow> weakWindow(window);
        window->on_cancel_command([weakWindow, commandBusy, commandStopRequested] {
            if (!commandBusy->load())
                return;
            commandStopRequested->store(true);
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)
                    ->set_status_message(
                        toSharedString("Cancellation requested. Saving any received response."));
            }
        });
        window->on_run_command([weakWindow, commandBusy, commandStopRequested, commandThreads,
                                commandThreadsMutex,
                                &activePassphrase](slint::SharedString requestedCommand,
                                                   slint::SharedString requestedNewPassphrase) {
            const auto selectedPath = [&]() -> std::filesystem::path {
                const auto strongWindow = weakWindow.lock();
                if (!strongWindow)
                    return {};
                return std::filesystem::path((*strongWindow)->get_archive_path().data());
            }();
            if (selectedPath.empty()) {
                if (auto strongWindow = weakWindow.lock()) {
                    (*strongWindow)
                        ->set_command_output(
                            toSharedString("Choose an archive before running a command."));
                }
                return;
            }

            auto parsed = parseCommandLine(
                std::string_view(requestedCommand.data(), requestedCommand.size()));
            if (!parsed) {
                if (auto strongWindow = weakWindow.lock()) {
                    (*strongWindow)->set_command_output(toSharedString(parsed.error().message));
                }
                return;
            }

            bool expected = false;
            if (!commandBusy->compare_exchange_strong(expected, true)) {
                if (auto strongWindow = weakWindow.lock()) {
                    (*strongWindow)
                        ->set_command_output(
                            toSharedString("Wait for the current command to finish."));
                }
                return;
            }
            commandStopRequested->store(false);
            if (auto strongWindow = weakWindow.lock())
                (*strongWindow)->set_command_running(true);

            auto commandStart = parsed->begin();
            while (commandStart != parsed->end() &&
                   (*commandStart == "--json" || *commandStart == "--quiet" ||
                    *commandStart == "--verbose" || *commandStart == "--no-color")) {
                ++commandStart;
            }
            const bool foregroundRecording =
                parsed->end() - commandStart >= 2 && *commandStart == "record" &&
                *(commandStart + 1) == "start" &&
                std::find(parsed->begin(), parsed->end(), "--detach") == parsed->end();
            if (foregroundRecording) {
                commandBusy->store(false);
                if (auto strongWindow = weakWindow.lock()) {
                    (*strongWindow)->set_command_running(false);
                    (*strongWindow)
                        ->set_command_output(
                            toSharedString("Run foreground recording from the CLI, or add --detach "
                                           "so the recording "
                                           "worker remains controllable outside this window."));
                }
                return;
            }

            std::vector<std::string> arguments{"--archive", selectedPath.string(), "--directory",
                                               selectedPath.parent_path().string()};
            arguments.insert(arguments.end(), std::make_move_iterator(parsed->begin()),
                             std::make_move_iterator(parsed->end()));
            if (auto strongWindow = weakWindow.lock()) {
                (*strongWindow)->set_command_output(toSharedString("Running command…"));
                (*strongWindow)
                    ->set_status_message(
                        toSharedString("Running command against the selected archive."));
            }

            std::string commandPassphrase = activePassphrase;
            std::string newPassphrase(requestedNewPassphrase.data(), requestedNewPassphrase.size());
            bool changesPassphrase =
                parsed->size() >= 2 && parsed->front() == "archive" &&
                ((*parsed)[1] == "encrypt" || (*parsed)[1] == "change-passphrase");
            if (changesPassphrase && parsed->size() > 2) {
                std::filesystem::path commandArchive((*parsed)[2]);
                if (commandArchive.is_relative())
                    commandArchive = selectedPath.parent_path() / commandArchive;
                std::error_code pathError;
                const auto normalizedCommandArchive =
                    std::filesystem::absolute(commandArchive, pathError).lexically_normal();
                changesPassphrase =
                    !pathError && normalizedCommandArchive == selectedPath.lexically_normal();
            }
            if (auto strongWindow = weakWindow.lock())
                (*strongWindow)->set_new_archive_passphrase(toSharedString(""));

            std::thread worker([weakWindow, commandBusy, commandStopRequested, selectedPath,
                                &activePassphrase, changesPassphrase,
                                commandPassphrase = std::move(commandPassphrase),
                                newPassphrase = std::move(newPassphrase),
                                arguments = std::move(arguments)]() mutable {
                std::string output;
                int exitCode = 2;
                try {
                    auto command = dispatchWithSecrets(
                        arguments, commandPassphrase, newPassphrase,
                        [weakWindow, liveOutputTruncated = std::make_shared<std::atomic_bool>(
                                         false)](const tutorux::command::ProgressEvent& event) {
                            if (event.phase != "ai-generation-text")
                                return;
                            if (liveOutputTruncated->load())
                                return;
                            std::string delta = event.message;
                            static_cast<void>(slint::invoke_from_event_loop([weakWindow,
                                                                             liveOutputTruncated,
                                                                             delta = std::move(
                                                                                 delta)]() mutable {
                                auto strongWindow = weakWindow.lock();
                                if (!strongWindow)
                                    return;
                                const auto displayed = (*strongWindow)->get_command_output();
                                std::string current(displayed.data(), displayed.size());
                                if (current == "Running command…")
                                    current.clear();
                                constexpr std::size_t maximumStreamDisplayBytes = 256U * 1024U;
                                if (current.size() + delta.size() > maximumStreamDisplayBytes) {
                                    liveOutputTruncated->store(true);
                                    (*strongWindow)
                                        ->set_command_output(toSharedString(
                                            "Streaming response exceeded the 256 KiB live display "
                                            "limit. The complete response will be retained in the "
                                            "archive.\n"));
                                    return;
                                }
                                current += delta;
                                (*strongWindow)->set_command_output(toSharedString(current));
                                (*strongWindow)
                                    ->set_status_message(toSharedString("Receiving AI response…"));
                            }));
                        },
                        [commandStopRequested] { return commandStopRequested->load(); });
                    output = commandResultText(command);
                    if (command)
                        exitCode = command->exitCode;
                } catch (const std::exception& exception) {
                    output = std::string("Command failed: ") + exception.what();
                } catch (...) {
                    output = "Command failed with an unknown error.";
                }

                std::string refreshPassphrase =
                    exitCode == 0 && changesPassphrase ? newPassphrase : commandPassphrase;
                eraseSecret(commandPassphrase);
                eraseSecret(newPassphrase);

                commandBusy->store(false);
                static_cast<void>(slint::invoke_from_event_loop(
                    [weakWindow, selectedPath, exitCode, changesPassphrase, &activePassphrase,
                     refreshPassphrase = std::move(refreshPassphrase),
                     output = std::move(output)]() mutable {
                        auto strongWindow = weakWindow.lock();
                        if (!strongWindow) {
                            eraseSecret(refreshPassphrase);
                            return;
                        }
                        (*strongWindow)->set_command_output(toSharedString(output));
                        (*strongWindow)->set_command_running(false);
                        (*strongWindow)
                            ->set_status_message(toSharedString(exitCode == 0 ? "Command completed."
                                                                              : "Command failed."));
                        if (exitCode == 0 &&
                            std::filesystem::path((*strongWindow)->get_archive_path().data()) ==
                                selectedPath) {
                            if (changesPassphrase) {
                                eraseSecret(activePassphrase);
                                activePassphrase = refreshPassphrase;
                            }
                            refreshWorkspace(**strongWindow, selectedPath, refreshPassphrase);
                        }
                        eraseSecret(refreshPassphrase);
                    }));
            });
            {
                const std::scoped_lock lock(*commandThreadsMutex);
                commandThreads->push_back(std::move(worker));
            }
        });

        window->run();
        for (auto& commandThread : *commandThreads) {
            if (commandThread.joinable())
                commandThread.join();
        }
        return 0;
    }

} // namespace tutorux::gui

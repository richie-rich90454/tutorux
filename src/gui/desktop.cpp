#include "tutorux/gui/desktop.hpp"

#include "app-window.h"
#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/document/editor.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <cctype>
#include <exception>
#include <iterator>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <set>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <sodium.h>

namespace tutorux::gui {
namespace {

    using tutorux::archive::Archive;
    using tutorux::archive::ArchiveInfo;
    using tutorux::command::CommandResult;
    using tutorux::core::Result;

    struct ActiveGuideEditor final {
        std::string guideId;
        std::size_t sectionIndex{};
        std::size_t blockIndex{};
        std::uint64_t expectedRevision{};
        tutorux::document::PieceTable text;
    };

    struct GuideBlockSelection final {
        std::string guideId;
        std::size_t sectionIndex{};
        std::size_t blockIndex{};
    };

    struct ActiveTranscriptEditor final {
        std::string sessionId;
        std::string segmentId;
        std::uint64_t expectedRevision{};
    };

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

    std::string commandLineFromArguments(const std::vector<std::string>& arguments) {
        std::string commandLine;
        for (const auto& argument : arguments) {
            if (!commandLine.empty())
                commandLine.push_back(' ');
            commandLine.push_back('"');
            for (const char character : argument) {
                if (character == '\\' || character == '"')
                    commandLine.push_back('\\');
                commandLine.push_back(character);
            }
            commandLine.push_back('"');
        }
        return commandLine;
    }

    std::string commandResultText(const Result<CommandResult>& command) {
        if (!command)
            return command.error().message;
        if (command->exitCode != 0)
            return command->output.empty() ? "Command failed." : command->output;
        if (command->output.empty())
            return "Completed.";
        constexpr std::string_view aiPreviewPrefix =
            "Outbound AI request preview (no network request was sent)";
        constexpr std::size_t maximumAiPreviewBytes = 17U * 1024U * 1024U;
        if (command->output.starts_with(aiPreviewPrefix) &&
            command->output.size() <= maximumAiPreviewBytes) {
            return command->output;
        }
        constexpr std::size_t maximumDisplayedBytes = 256U * 1024U;
        if (command->output.size() > maximumDisplayedBytes) {
            return "Command completed, but its " + std::to_string(command->output.size()) +
                   "-byte result is too large to display here. Use the CLI to save or inspect "
                   "the full output.";
        }
        return command->output;
    }

    std::string selectionId(const slint::SharedString& selection) {
        constexpr std::string_view separator = " · ";
        const std::string value(selection.data(), selection.size());
        const auto position = value.rfind(separator);
        if (position == std::string::npos)
            return {};
        const std::string id = value.substr(position + separator.size());
        return tutorux::archive::uuidFromString(id) ? id : std::string{};
    }

    std::string formatTimestampField(const tutorux::archive::Record& record,
                                     std::string_view field) {
        const auto value = record.fields.find(field);
        if (value == record.fields.end())
            return "00:00:00";
        std::int64_t timestamp = 0;
        const auto [end, error] = std::from_chars(value->second.data(),
                                                  value->second.data() + value->second.size(),
                                                  timestamp);
        if (error != std::errc{} || end != value->second.data() + value->second.size() ||
            timestamp < 0) {
            return "Unknown time";
        }
        return tutorux::domain::formatTimestampUs(timestamp);
    }

    std::array<std::string, 7> markerShortcuts(Archive& archive) {
        std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
        auto settings = archive.list(tutorux::archive::RecordType::Settings);
        if (!settings)
            return shortcuts;
        const auto record =
            std::find_if(settings->begin(), settings->end(), [](const auto& setting) {
                const auto key = setting.fields.find("key");
                return key != setting.fields.end() &&
                       key->second == "annotation.quick_marker_shortcuts";
            });
        if (record == settings->end())
            return shortcuts;
        const auto saved = record->fields.find("value");
        if (saved == record->fields.end())
            return shortcuts;
        std::array<std::string, 7> parsed;
        std::size_t start = 0;
        for (std::size_t index = 0; index < parsed.size(); ++index) {
            const auto comma = saved->second.find(',', start);
            const auto end = comma == std::string::npos ? saved->second.size() : comma;
            parsed[index] = saved->second.substr(start, end - start);
            if (parsed[index].size() != 1 ||
                static_cast<unsigned char>(parsed[index].front()) < 0x21U ||
                static_cast<unsigned char>(parsed[index].front()) > 0x7eU ||
                (index + 1 < parsed.size() && comma == std::string::npos) ||
                (index + 1 == parsed.size() && comma != std::string::npos)) {
                return shortcuts;
            }
            start = end + (comma == std::string::npos ? 0U : 1U);
        }
        std::set<char> unique;
        for (auto& shortcut : parsed) {
            char key = shortcut.front();
            if (std::isalpha(static_cast<unsigned char>(key))) {
                key = static_cast<char>(std::tolower(static_cast<unsigned char>(key)));
                shortcut.front() = key;
            }
            if (!unique.insert(key).second)
                return shortcuts;
        }
        return parsed;
    }

    std::optional<GuideBlockSelection> guideBlockIndexes(const slint::SharedString& selection) {
        const std::string value(selection.data(), selection.size());
        constexpr std::string_view labelSeparator = " · ";
        const auto labelPosition = value.find(labelSeparator);
        const std::string_view label(value.data(),
                                     labelPosition == std::string::npos ? value.size()
                                                                        : labelPosition);
        const auto identitySeparator = label.find('|');
        if (identitySeparator == std::string_view::npos)
            return std::nullopt;
        const std::string guideId(label.substr(0, identitySeparator));
        if (!tutorux::archive::uuidFromString(guideId))
            return std::nullopt;
        const std::string_view indexes = label.substr(identitySeparator + 1);
        const auto colon = indexes.find(':');
        if (colon == std::string_view::npos)
            return std::nullopt;
        std::size_t sectionIndex = 0;
        std::size_t blockIndex = 0;
        const auto [sectionEnd, sectionError] =
            std::from_chars(indexes.data(), indexes.data() + colon, sectionIndex);
        const auto [blockEnd, blockError] = std::from_chars(indexes.data() + colon + 1,
                                                            indexes.data() + indexes.size(),
                                                            blockIndex);
        if (sectionError != std::errc{} || sectionEnd != indexes.data() + colon ||
            blockError != std::errc{} || blockEnd != indexes.data() + indexes.size()) {
            return std::nullopt;
        }
        return GuideBlockSelection{guideId, sectionIndex, blockIndex};
    }

    std::string
    populateGuideBlockOptions(MainWindow& window, Archive& archive, std::string_view guideIdText) {
        auto guideId = tutorux::archive::uuidFromString(guideIdText);
        if (!guideId)
            return guideId.error().message;
        auto record = archive.get(tutorux::archive::RecordType::Guide, *guideId);
        if (!record)
            return record.error().message;
        if (!*record)
            return "Guide was not found in the active archive.";
        auto guide = tutorux::domain::guideFromRecord(**record);
        if (!guide)
            return guide.error().message;

        std::vector<slint::SharedString> choices;
        const std::string canonicalId = tutorux::archive::uuidToString(guide->id);
        for (std::size_t sectionIndex = 0; sectionIndex < guide->sections.size(); ++sectionIndex) {
            const auto& section = guide->sections[sectionIndex];
            for (std::size_t blockIndex = 0; blockIndex < section.blocks.size(); ++blockIndex) {
                const auto& block = section.blocks[blockIndex];
                const auto label = tutorux::domain::guideBlockLabel(block.kind);
                const std::string blockLabel = label.empty() ? block.kind : std::string(label);
                choices.emplace_back(canonicalId + "|" + std::to_string(sectionIndex) + ":" +
                                     std::to_string(blockIndex) + " · " + section.heading + " — " +
                                     blockLabel);
            }
        }
        window.set_guide_block_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(choices)));
        const auto options = window.get_guide_block_options();
        window.set_selected_guide_block(options->row_count() == 0
                                            ? toSharedString("")
                                            : options->row_data(0).value_or(toSharedString("")));
        return {};
    }

    void refreshWorkspace(MainWindow& window,
                          const std::filesystem::path& path,
                          std::string_view passphrase = {}) {
        window.set_archive_path(toSharedString(path.string()));
        auto info = Archive::discover(path.parent_path());
        window.set_archive_list(
            toSharedString(info ? archiveChoices(*info) : info.error().message));
        window.set_archive_paths(archivePathChoices(info ? *info : std::vector<ArchiveInfo>{}));
        bool writableOnDisk = false;
        if (info) {
            const auto selectedPath = path.lexically_normal();
            const auto selectedInfo =
                std::find_if(info->begin(), info->end(), [&](const ArchiveInfo& archive) {
                    return archive.path.lexically_normal() == selectedPath;
                });
            writableOnDisk = selectedInfo != info->end() && selectedInfo->writable;
        }
        auto students = dispatchWithSecrets(archiveCommand(path, {"student", "list"}), passphrase);
        auto sessions = dispatchWithSecrets(archiveCommand(path, {"session", "list"}), passphrase);
        window.set_students_text(toSharedString(commandOutput(std::move(students))));
        window.set_sessions_text(toSharedString(commandOutput(std::move(sessions))));
        window.set_selected_archive(toSharedString(path.filename().string()));

        std::vector<slint::SharedString> studentChoices{"Anonymous session"};
        std::vector<slint::SharedString> sessionChoices;
        std::vector<slint::SharedString> guideChoices;
        std::vector<slint::SharedString> guideBlockChoices;
        auto opened = Archive::open(path, false, passphrase);
        if (opened) {
            auto records = opened->list(tutorux::archive::RecordType::Student);
            if (records) {
                studentChoices.reserve(records->size() + 1);
                for (const auto& student : *records) {
                    const auto name = student.fields.find("display_name");
                    const std::string displayName =
                        name == student.fields.end() ? "Unnamed student" : name->second;
                    studentChoices.emplace_back(displayName + " · " +
                                                tutorux::archive::uuidToString(student.id));
                }
            }
            auto sessions = opened->list(tutorux::archive::RecordType::Session);
            if (sessions) {
                sessionChoices.reserve(sessions->size());
                for (const auto& session : *sessions) {
                    const auto title = session.fields.find("title");
                    const auto subject = session.fields.find("subject");
                    const std::string displayTitle =
                        title == session.fields.end() ? "Untitled session" : title->second;
                    const std::string displaySubject =
                        subject == session.fields.end() ? "Session" : subject->second;
                    sessionChoices.emplace_back(displaySubject + " · " + displayTitle + " · " +
                                                tutorux::archive::uuidToString(session.id));
                }
            }
            auto guides = opened->list(tutorux::archive::RecordType::Guide);
            if (guides) {
                guideChoices.reserve(guides->size());
                for (const auto& guide : *guides) {
                    const auto title = guide.fields.find("title");
                    const std::string displayTitle =
                        title == guide.fields.end() ? "Untitled guide" : title->second;
                    guideChoices.emplace_back(displayTitle + " · " +
                                              tutorux::archive::uuidToString(guide.id));
                    auto parsedGuide = tutorux::domain::guideFromRecord(guide);
                    if (!parsedGuide)
                        continue;
                    for (std::size_t sectionIndex = 0; sectionIndex < parsedGuide->sections.size();
                         ++sectionIndex) {
                        const auto& section = parsedGuide->sections[sectionIndex];
                        for (std::size_t blockIndex = 0; blockIndex < section.blocks.size();
                             ++blockIndex) {
                            const auto& block = section.blocks[blockIndex];
                            const auto kind = tutorux::domain::guideBlockLabel(block.kind);
                            const std::string blockLabel =
                                kind.empty() ? block.kind : std::string(kind);
                            guideBlockChoices.emplace_back(
                                tutorux::archive::uuidToString(guide.id) + "|" +
                                std::to_string(sectionIndex) + ":" + std::to_string(blockIndex) +
                                " · " + section.heading + " — " + blockLabel);
                        }
                    }
                }
            }
        }
        window.set_student_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(studentChoices)));
        window.set_selected_student(toSharedString("Anonymous session"));
        window.set_session_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(sessionChoices)));
        const auto selectedSessions = window.get_session_options();
        window.set_selected_session(
            selectedSessions->row_count() == 0
                ? toSharedString("")
                : selectedSessions->row_data(0).value_or(toSharedString("")));
        window.set_guide_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(guideChoices)));
        const auto selectedGuides = window.get_guide_options();
        window.set_selected_guide(selectedGuides->row_count() == 0
                                      ? toSharedString("")
                                      : selectedGuides->row_data(0).value_or(toSharedString("")));
        window.set_guide_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>(
            std::move(guideBlockChoices)));
        const auto selectedBlocks = window.get_guide_block_options();
        window.set_selected_guide_block(
            selectedBlocks->row_count() == 0
                ? toSharedString("")
                : selectedBlocks->row_data(0).value_or(toSharedString("")));
        std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
        if (opened)
            shortcuts = markerShortcuts(*opened);
        window.set_shortcut_concept(toSharedString(shortcuts[0]));
        window.set_shortcut_mistake(toSharedString(shortcuts[1]));
        window.set_shortcut_correction(toSharedString(shortcuts[2]));
        window.set_shortcut_instruction(toSharedString(shortcuts[3]));
        window.set_shortcut_example(toSharedString(shortcuts[4]));
        window.set_shortcut_follow_up(toSharedString(shortcuts[5]));
        window.set_shortcut_note(toSharedString(shortcuts[6]));
        const bool encrypted = opened && opened->encrypted();
        window.set_archive_status(
            toSharedString(std::string(writableOnDisk ? "Read/Write" : "Read-only") +
                           (encrypted ? " · Encrypted" : " · Unencrypted")));
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
    auto directory =
        directoryPath ? std::filesystem::absolute(*directoryPath) : std::filesystem::current_path();
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
    window->set_archive_status(toSharedString("No archive selected"));
    window->set_students_text(toSharedString("Choose an archive to view students."));
    window->set_sessions_text(toSharedString("Choose an archive to view sessions."));
    window->set_transcript_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_transcript(toSharedString(""));
    window->set_transcript_edit_text(toSharedString(""));
    window->set_transcript_provenance(toSharedString("Choose a session and load a segment."));
    window->set_session_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_session(toSharedString(""));
    window->set_guide_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_guide(toSharedString(""));
    window->set_guide_block_options(std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_guide_block(toSharedString(""));
    window->set_guide_edit_text(toSharedString(""));
    window->set_guide_provenance(toSharedString("Load a guide block to edit its text."));
    window->set_guide_output(toSharedString("Choose an archive to view study guides."));
    window->set_student_options(std::make_shared<slint::VectorModel<slint::SharedString>>(
        std::vector<slint::SharedString>{toSharedString("Anonymous session")}));
    window->set_selected_student(toSharedString("Anonymous session"));
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
                window->set_archive_status(toSharedString("Locked · Encrypted"));
                window->set_students_text(toSharedString(
                    "This archive is encrypted. Enter its passphrase to unlock it."));
                window->set_sessions_text(toSharedString("Unlock the archive to view sessions."));
                window->set_status_message(toSharedString("Archive is locked."));
            } else {
                refreshWorkspace(*window, info->path);
            }
        } else {
            window->set_status_message(toSharedString(info.error().message));
        }
    }

    window->on_open_archive(
        [&](slint::SharedString requestedPath, slint::SharedString requestedPassphrase) {
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
            window->set_archive_status(toSharedString("Locked · Encrypted"));
            window->set_students_text(toSharedString("Unlock the archive to view students."));
            window->set_sessions_text(toSharedString("Unlock the archive to view sessions."));
            window->set_status_message(toSharedString("Passphrase cleared. Archive is locked."));
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
        std::transform(extension.begin(),
                       extension.end(),
                       extension.begin(),
                       [](unsigned char character) {
                           return static_cast<char>(std::tolower(character));
                       });
        if (extension != ".tux")
            path += ".tux";
        if (path.is_relative())
            path = directory / path;
        auto created =
            command::dispatch({"archive", "init", path.string(), "--name", path.stem().string()});
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

    window->on_create_student([&](slint::SharedString requestedName,
                                  slint::SharedString requestedGrade,
                                  slint::SharedString requestedSubjects,
                                  slint::SharedString requestedObjectives,
                                  slint::SharedString requestedDifficulties,
                                  slint::SharedString requestedNotes) {
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
        auto arguments =
            archiveCommand(path,
                           {"student", "create", "--name", std::string(requestedName.data())});
        const auto appendOption = [&](std::string_view name, const slint::SharedString& value) {
            if (value.empty())
                return;
            arguments.emplace_back("--" + std::string(name));
            arguments.emplace_back(value.data(), value.size());
        };
        appendOption("grade", requestedGrade);
        appendOption("subjects", requestedSubjects);
        appendOption("objectives", requestedObjectives);
        appendOption("difficulties", requestedDifficulties);
        appendOption("notes", requestedNotes);
        auto created = dispatchWithSecrets(arguments, activePassphrase);
        window->set_status_message(toSharedString(commandOutput(std::move(created))));
        refreshWorkspace(*window, path, activePassphrase);
        window->set_student_name(toSharedString(""));
        window->set_student_grade(toSharedString(""));
        window->set_student_subjects(toSharedString(""));
        window->set_student_objectives(toSharedString(""));
        window->set_student_difficulties(toSharedString(""));
        window->set_student_notes(toSharedString(""));
    });

    window->on_create_session([&](slint::SharedString selectedStudent,
                                  slint::SharedString subject,
                                  slint::SharedString title,
                                  slint::SharedString objectives) {
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
        std::string studentId = "anonymous";
        const std::string selected(selectedStudent.data(), selectedStudent.size());
        if (!selected.empty() && selected != "Anonymous session") {
            constexpr std::string_view separator = " · ";
            const auto separatorPosition = selected.rfind(separator);
            if (separatorPosition == std::string::npos) {
                window->set_status_message(toSharedString(
                    "Select a student from this archive before creating the session."));
                return;
            }
            studentId = selected.substr(separatorPosition + separator.size());
            if (!tutorux::archive::uuidFromString(studentId)) {
                window->set_status_message(
                    toSharedString("The selected student entry is invalid. Refresh the archive."));
                return;
            }
        }
        auto arguments = archiveCommand(path,
                                        {"session",
                                         "create",
                                         "--student-id",
                                         studentId,
                                         "--subject",
                                         std::string(subject.data()),
                                         "--title",
                                         std::string(title.data())});
        if (!objectives.empty()) {
            arguments.emplace_back("--objectives");
            arguments.emplace_back(objectives.data(), objectives.size());
        }
        auto created = dispatchWithSecrets(arguments, activePassphrase);
        window->set_status_message(toSharedString(commandOutput(std::move(created))));
        refreshWorkspace(*window, path, activePassphrase);
        window->set_session_subject(toSharedString(""));
        window->set_session_title(toSharedString(""));
        window->set_session_objectives(toSharedString(""));
    });

    window->on_open_session([&](slint::SharedString selectedSession) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path, {"session", "show", id}), activePassphrase);
        window->set_command_output(toSharedString(commandOutput(std::move(command))));
    });

    const auto activeTranscriptEditor = std::make_shared<std::optional<ActiveTranscriptEditor>>();
    window->on_review_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path, {"transcript", "list", "--session", id}),
                                activePassphrase);
        window->set_command_output(toSharedString(commandOutput(std::move(command))));
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto records = archive->list(tutorux::archive::RecordType::TranscriptSegment);
        if (!records) {
            window->set_transcript_provenance(toSharedString(records.error().message));
            return;
        }
        std::vector<slint::SharedString> choices;
        for (const auto& segment : *records) {
            const auto session = segment.fields.find("session_id");
            if (session == segment.fields.end() || session->second != id)
                continue;
            const auto speaker = segment.fields.find("speaker_label");
            const std::string speakerName =
                speaker == segment.fields.end() || speaker->second.empty() ? "Unknown speaker"
                                                                           : speaker->second;
            choices.emplace_back(formatTimestampField(segment, "start_time_us") + "–" +
                                 formatTimestampField(segment, "end_time_us") + " · " +
                                 speakerName + " · " + tutorux::archive::uuidToString(segment.id));
        }
        window->set_transcript_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(std::move(choices)));
        const auto selectedSegments = window->get_transcript_options();
        window->set_selected_transcript(
            selectedSegments->row_count() == 0
                ? toSharedString("")
                : selectedSegments->row_data(0).value_or(toSharedString("")));
        window->set_transcript_provenance(
            selectedSegments->row_count() == 0
                ? toSharedString("No transcript segments are stored for this session.")
                : toSharedString("Select a segment, load it, then save a human correction."));
        activeTranscriptEditor->reset();
    });

    window->on_load_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession,
                                                           slint::SharedString selectedSegment) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string sessionId = selectionId(selectedSession);
        const std::string segmentId = selectionId(selectedSegment);
        const auto uuid = tutorux::archive::uuidFromString(segmentId);
        if (path.empty() || sessionId.empty() || !uuid) {
            window->set_transcript_provenance(
                toSharedString("Select a transcript segment from the active session."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto record = archive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
        if (!record || !*record) {
            window->set_transcript_provenance(toSharedString(
                record ? "Transcript segment was not found." : record.error().message));
            return;
        }
        const auto& fields = (**record).fields;
        const auto savedSession = fields.find("session_id");
        if (savedSession == fields.end() || savedSession->second != sessionId) {
            window->set_transcript_provenance(
                toSharedString("The selected transcript segment belongs to another session."));
            return;
        }
        const auto text = fields.find("text");
        const auto speaker = fields.find("speaker_label");
        const auto verification = fields.find("verification_state");
        window->set_transcript_edit_text(toSharedString(text == fields.end() ? "" : text->second));
        std::ostringstream provenance;
        provenance << "Segment " << segmentId << " · "
                   << (speaker == fields.end() || speaker->second.empty() ? "Unknown speaker"
                                                                          : speaker->second)
                   << " · " << (verification == fields.end() ? "provisional" : verification->second)
                   << " · " << formatTimestampField(**record, "start_time_us") << "–"
                   << formatTimestampField(**record, "end_time_us");
        window->set_transcript_provenance(toSharedString(provenance.str()));
        *activeTranscriptEditor = ActiveTranscriptEditor{sessionId, segmentId, (**record).revision};
    });

    window->on_save_transcript([&, activeTranscriptEditor](slint::SharedString selectedSession,
                                                           slint::SharedString selectedSegment,
                                                           slint::SharedString editedText) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string sessionId = selectionId(selectedSession);
        const std::string segmentId = selectionId(selectedSegment);
        const auto uuid = tutorux::archive::uuidFromString(segmentId);
        if (path.empty() || sessionId.empty() || !uuid || !*activeTranscriptEditor ||
            (*activeTranscriptEditor)->sessionId != sessionId ||
            (*activeTranscriptEditor)->segmentId != segmentId) {
            window->set_transcript_provenance(
                toSharedString("Load the selected transcript segment before saving."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_transcript_provenance(toSharedString(archive.error().message));
            return;
        }
        auto current = archive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
        if (!current || !*current) {
            window->set_transcript_provenance(toSharedString(
                current ? "Transcript segment was not found." : current.error().message));
            return;
        }
        if ((**current).revision != (*activeTranscriptEditor)->expectedRevision) {
            window->set_transcript_provenance(toSharedString(
                "This transcript segment changed after it was loaded. Reload it before saving."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path,
                                               {"transcript",
                                                "correct",
                                                segmentId,
                                                "--text",
                                                std::string(editedText.data(), editedText.size())}),
                                activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
        if (output == "Transcript segment corrected.\n") {
            auto latestArchive = Archive::open(path, false, activePassphrase);
            if (latestArchive) {
                auto latest =
                    latestArchive->get(tutorux::archive::RecordType::TranscriptSegment, *uuid);
                if (latest && *latest)
                    (*activeTranscriptEditor)->expectedRevision = (**latest).revision;
            }
            window->set_transcript_provenance(
                toSharedString("Saved as a new human-corrected archive revision."));
        }
    });

    window->on_quick_marker([&](slint::SharedString selectedSession,
                                slint::SharedString type,
                                slint::SharedString timestamp,
                                slint::SharedString note) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path,
                                               {"annotation",
                                                "add",
                                                "--session",
                                                id,
                                                "--type",
                                                std::string(type.data(), type.size()),
                                                "--at",
                                                std::string(timestamp.data(), timestamp.size()),
                                                "--text",
                                                std::string(note.data(), note.size())}),
                                activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
    });

    window->on_recording_command([&](slint::SharedString selectedSession,
                                     slint::SharedString action,
                                     slint::SharedString source) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        const std::string commandAction(action.data(), action.size());
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        std::vector<std::string> arguments{"record", commandAction, "--session", id};
        if (commandAction == "start") {
            const std::string requestedSource(source.data(), source.size());
            arguments.insert(arguments.end(),
                             {"--source",
                              requestedSource,
                              "--consent",
                              "--confirmed-by",
                              "Tutorux desktop",
                              "--detach"});
            const std::string microphoneDevice(window->get_recording_microphone_device().data(),
                                               window->get_recording_microphone_device().size());
            const std::string playbackDevice(window->get_recording_playback_device().data(),
                                             window->get_recording_playback_device().size());
            if ((requestedSource == "microphone" || requestedSource == "both") &&
                !microphoneDevice.empty()) {
                arguments.insert(arguments.end(), {"--microphone", microphoneDevice});
            }
            if ((requestedSource == "system-audio" || requestedSource == "both") &&
                !playbackDevice.empty()) {
                arguments.insert(arguments.end(), {"--playback", playbackDevice});
            }
        } else if (commandAction != "pause" && commandAction != "resume" &&
                   commandAction != "stop" && commandAction != "status") {
            window->set_command_output(toSharedString("Unsupported recording action."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
    });

    window->on_guide_command([&](slint::SharedString selectedGuide,
                                 slint::SharedString action,
                                 slint::SharedString format,
                                 slint::SharedString outputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedGuide);
        const std::string commandAction(action.data(), action.size());
        if (path.empty() || id.empty()) {
            window->set_guide_output(toSharedString("Select a guide from this archive."));
            return;
        }
        auto openedArchive = Archive::open(path, false, activePassphrase);
        if (!openedArchive) {
            window->set_guide_output(toSharedString(openedArchive.error().message));
            return;
        }
        const std::string blockStatus = populateGuideBlockOptions(*window, *openedArchive, id);
        if (!blockStatus.empty()) {
            window->set_guide_output(toSharedString(blockStatus));
            return;
        }
        std::vector<std::string> arguments{"guide", commandAction, id};
        if (commandAction == "export") {
            if (outputPath.empty()) {
                window->set_guide_output(
                    toSharedString("Choose an output file before exporting the guide."));
                return;
            }
            arguments.insert(arguments.end(),
                             {"--format",
                              std::string(format.data(), format.size()),
                              "--output",
                              std::string(outputPath.data(), outputPath.size())});
        } else if (commandAction != "show" && commandAction != "validate" &&
                   commandAction != "approve") {
            window->set_guide_output(toSharedString("Unsupported guide action."));
            return;
        }
        auto command =
            dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_guide_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
    });

    window->on_asset_command([&](slint::SharedString selectedSession,
                                 slint::SharedString action,
                                 slint::SharedString inputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedSession);
        const std::string commandAction(action.data(), action.size());
        if (path.empty() || id.empty()) {
            window->set_command_output(toSharedString("Select a session from this archive."));
            return;
        }
        std::vector<std::string> arguments{"asset", commandAction};
        if (commandAction == "add") {
            if (inputPath.empty()) {
                window->set_command_output(toSharedString("Choose a file path to import."));
                return;
            }
            arguments.emplace_back(inputPath.data(), inputPath.size());
        } else if (commandAction != "list") {
            window->set_command_output(toSharedString("Unsupported material action."));
            return;
        }
        arguments.insert(arguments.end(), {"--session", id});
        auto command =
            dispatchWithSecrets(archiveCommand(path, std::move(arguments)), activePassphrase);
        const std::string output = commandOutput(std::move(command));
        window->set_command_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
    });

    window->on_ai_command([&](slint::SharedString provider,
                              slint::SharedString action,
                              slint::SharedString selectedSession,
                              slint::SharedString outputPath) {
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_command_output(toSharedString("Choose an archive first."));
            return;
        }
        const std::string commandAction(action.data(), action.size());
        const std::string providerId(provider.data(), provider.size());
        const std::string modelId(window->get_ai_model_id().data(),
                                  window->get_ai_model_id().size());
        const std::string endpoint(window->get_ai_endpoint().data(),
                                   window->get_ai_endpoint().size());
        std::vector<std::string> arguments{"ai"};
        if (commandAction == "providers") {
            arguments.emplace_back("providers");
        } else if (commandAction == "models") {
            if (providerId.empty()) {
                window->set_command_output(toSharedString("Enter a provider ID first."));
                return;
            }
            arguments.insert(arguments.end(), {"models", "--provider", providerId, "--refresh"});
        } else if (commandAction == "configure") {
            if (providerId.empty()) {
                window->set_command_output(toSharedString("Enter a provider ID first."));
                return;
            }
            arguments.insert(arguments.end(), {"configure", "--provider", providerId});
            if (!endpoint.empty())
                arguments.insert(arguments.end(), {"--endpoint", endpoint});
            if (!modelId.empty())
                arguments.insert(arguments.end(), {"--model", modelId});
        } else if (commandAction == "select-embedded") {
            const std::string modelPath(window->get_ai_model_path().data(),
                                        window->get_ai_model_path().size());
            if (providerId != "llama.cpp-embedded" || modelId.empty() || modelPath.empty()) {
                window->set_command_output(toSharedString(
                    "Enter provider llama.cpp-embedded, a model ID, and an explicit GGUF path."));
                return;
            }
            arguments = {"model",
                         "select",
                         "--provider",
                         providerId,
                         "--model",
                         modelId,
                         "--path",
                         modelPath};
        } else if (commandAction == "package" || commandAction == "zip-package") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty()) {
                window->set_command_output(
                    toSharedString("Select a session before preparing its package."));
                return;
            }
            arguments.insert(arguments.end(),
                             {"package",
                              "--session",
                              sessionId,
                              "--mode",
                              "manual",
                              "--format",
                              commandAction == "zip-package" ? "zip" : "markdown"});
            if (commandAction == "zip-package")
                arguments.emplace_back("--confirm-sensitive");
            if (!outputPath.empty()) {
                arguments.emplace_back("--output");
                arguments.emplace_back(outputPath.data(), outputPath.size());
            }
        } else if (commandAction == "local-package") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty()) {
                window->set_command_output(
                    toSharedString("Select a session before preparing a local package."));
                return;
            }
            arguments.insert(
                arguments.end(),
                {"package", "--session", sessionId, "--mode", "local", "--format", "json"});
            if (!outputPath.empty()) {
                arguments.emplace_back("--output");
                arguments.emplace_back(outputPath.data(), outputPath.size());
            }
        } else if (commandAction == "generate" || commandAction == "confirm-send") {
            const std::string jobId(window->get_ai_package_job_id().data(),
                                    window->get_ai_package_job_id().size());
            if (providerId.empty() || !tutorux::archive::uuidFromString(jobId)) {
                window->set_command_output(toSharedString(
                    "Enter a provider ID and the package job ID returned by package creation."));
                return;
            }
            arguments.insert(arguments.end(),
                             {"generate", "--job", jobId, "--provider", providerId});
            if (!modelId.empty())
                arguments.insert(arguments.end(), {"--model", modelId});
            if (providerId != "ollama" && providerId != "lm-studio" &&
                providerId != "llama.cpp-server" && providerId != "llama.cpp-embedded") {
                const std::string environment(window->get_ai_api_key_environment().data(),
                                              window->get_ai_api_key_environment().size());
                if (!environment.empty())
                    arguments.insert(arguments.end(), {"--api-key-env", environment});
            }
            if (commandAction == "confirm-send") {
                const std::string confirmationHash(window->get_ai_confirmation_hash().data(),
                                                   window->get_ai_confirmation_hash().size());
                if (confirmationHash.empty()) {
                    window->set_command_output(toSharedString(
                        "Review the outbound preview and enter its package SHA-256 first."));
                    return;
                }
                arguments.insert(arguments.end(),
                                 {"--confirm-outbound", "--confirm-hash", confirmationHash});
            }
        } else if (commandAction == "import") {
            const std::string sessionId = selectionId(selectedSession);
            if (sessionId.empty() || outputPath.empty()) {
                window->set_command_output(toSharedString(
                    "Select a session and enter the structured external response file path."));
                return;
            }
            arguments = {"ai",
                         "import",
                         "--session",
                         sessionId,
                         "--input",
                         std::string(outputPath.data(), outputPath.size())};
        } else {
            window->set_command_output(toSharedString("Unsupported AI workspace action."));
            return;
        }
        const std::string requestedCommand = commandLineFromArguments(arguments);
        window->set_command_input(toSharedString(requestedCommand));
        window->invoke_run_command(toSharedString(requestedCommand), toSharedString(""));
    });

    window->on_save_marker_shortcuts([&](slint::SharedString concept,
                                         slint::SharedString mistake,
                                         slint::SharedString correction,
                                         slint::SharedString instruction,
                                         slint::SharedString example,
                                         slint::SharedString followUp,
                                         slint::SharedString note) {
        const std::filesystem::path path(window->get_archive_path().data());
        if (path.empty()) {
            window->set_status_message(toSharedString("Choose an archive first."));
            return;
        }
        std::array<std::string, 7> shortcuts{std::string(concept.data(), concept.size()),
                                             std::string(mistake.data(), mistake.size()),
                                             std::string(correction.data(), correction.size()),
                                             std::string(instruction.data(), instruction.size()),
                                             std::string(example.data(), example.size()),
                                             std::string(followUp.data(), followUp.size()),
                                             std::string(note.data(), note.size())};
        std::set<char> unique;
        for (auto& shortcut : shortcuts) {
            if (shortcut.size() != 1 || shortcut.front() == ',' ||
                static_cast<unsigned char>(shortcut.front()) < 0x21U ||
                static_cast<unsigned char>(shortcut.front()) > 0x7eU) {
                window->set_status_message(toSharedString(
                    "Each shortcut must be one printable ASCII character other than comma."));
                return;
            }
            char key = shortcut.front();
            if (std::isalpha(static_cast<unsigned char>(key))) {
                key = static_cast<char>(std::tolower(static_cast<unsigned char>(key)));
                shortcut.front() = key;
            }
            if (!unique.insert(key).second) {
                window->set_status_message(
                    toSharedString("Quick marker shortcuts must be unique."));
                return;
            }
        }
        std::string serialized;
        for (const auto& shortcut : shortcuts) {
            if (!serialized.empty())
                serialized.push_back(',');
            serialized += shortcut;
        }
        auto command = dispatchWithSecrets(
            archiveCommand(path,
                           {"settings", "set", "annotation.quick_marker_shortcuts", serialized}),
            activePassphrase);
        const bool saved = command && command->exitCode == 0;
        const std::string output = commandOutput(std::move(command));
        if (saved) {
            window->set_shortcut_concept(toSharedString(shortcuts[0]));
            window->set_shortcut_mistake(toSharedString(shortcuts[1]));
            window->set_shortcut_correction(toSharedString(shortcuts[2]));
            window->set_shortcut_instruction(toSharedString(shortcuts[3]));
            window->set_shortcut_example(toSharedString(shortcuts[4]));
            window->set_shortcut_follow_up(toSharedString(shortcuts[5]));
            window->set_shortcut_note(toSharedString(shortcuts[6]));
        }
        window->set_status_message(toSharedString(output));
        window->set_command_output(toSharedString(output));
    });

    const auto activeGuideEditor = std::make_shared<std::optional<ActiveGuideEditor>>();
    window->on_load_guide_block([&, activeGuideEditor](slint::SharedString selectedGuide,
                                                       slint::SharedString selectedBlock) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedGuide);
        const auto indexes = guideBlockIndexes(selectedBlock);
        const auto guideId = tutorux::archive::uuidFromString(id);
        if (path.empty() || !guideId || !indexes || indexes->guideId != id) {
            window->set_guide_provenance(
                toSharedString("Select a block that belongs to the currently selected guide."));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_guide_provenance(toSharedString(archive.error().message));
            return;
        }
        auto record = archive->get(tutorux::archive::RecordType::Guide, *guideId);
        if (!record || !*record) {
            window->set_guide_provenance(toSharedString(
                record ? "Guide was not found in the active archive." : record.error().message));
            return;
        }
        auto guide = tutorux::domain::guideFromRecord(**record);
        if (!guide || indexes->sectionIndex >= guide->sections.size() ||
            indexes->blockIndex >= guide->sections[indexes->sectionIndex].blocks.size()) {
            window->set_guide_provenance(toSharedString(
                guide ? "Selected block is outside the guide." : guide.error().message));
            return;
        }
        auto& block = guide->sections[indexes->sectionIndex].blocks[indexes->blockIndex];
        auto buffer = tutorux::document::PieceTable::create(block.text);
        if (!buffer) {
            window->set_guide_provenance(toSharedString(buffer.error().message));
            return;
        }
        *activeGuideEditor = ActiveGuideEditor{id,
                                               indexes->sectionIndex,
                                               indexes->blockIndex,
                                               (**record).revision,
                                               std::move(*buffer)};
        window->set_guide_edit_text(toSharedString(block.text));
        std::ostringstream provenance;
        provenance << guide->sections[indexes->sectionIndex].heading << " · " << block.kind;
        if (block.stale)
            provenance << " · source changed; review this content before saving";
        if (!block.sourceIds.empty()) {
            provenance << " · sources: ";
            for (std::size_t sourceIndex = 0; sourceIndex < block.sourceIds.size(); ++sourceIndex) {
                if (sourceIndex != 0)
                    provenance << ", ";
                provenance << block.sourceIds[sourceIndex];
            }
        } else {
            provenance << " · no source references";
        }
        window->set_guide_provenance(toSharedString(provenance.str()));
        window->set_guide_output(
            toSharedString("Block loaded from the selected archive revision."));
    });

    window->on_save_guide_block([&, activeGuideEditor](slint::SharedString selectedGuide,
                                                       slint::SharedString selectedBlock,
                                                       slint::SharedString editedText) {
        const std::filesystem::path path(window->get_archive_path().data());
        const std::string id = selectionId(selectedGuide);
        const auto indexes = guideBlockIndexes(selectedBlock);
        if (path.empty() || !indexes || indexes->guideId != id || !*activeGuideEditor ||
            (*activeGuideEditor)->guideId != id ||
            (*activeGuideEditor)->sectionIndex != indexes->sectionIndex ||
            (*activeGuideEditor)->blockIndex != indexes->blockIndex) {
            window->set_guide_output(
                toSharedString("Load the selected guide block before saving its edits."));
            return;
        }
        auto guideId = tutorux::archive::uuidFromString(id);
        if (!guideId) {
            window->set_guide_output(toSharedString(guideId.error().message));
            return;
        }
        auto archive = Archive::open(path, false, activePassphrase);
        if (!archive) {
            window->set_guide_output(toSharedString(archive.error().message));
            return;
        }
        auto current = archive->get(tutorux::archive::RecordType::Guide, *guideId);
        if (!current || !*current) {
            window->set_guide_output(toSharedString(
                current ? "Guide was not found in the active archive." : current.error().message));
            return;
        }
        if ((**current).revision != (*activeGuideEditor)->expectedRevision) {
            window->set_guide_output(toSharedString(
                "This guide changed after the block was loaded. Reload it before saving."));
            return;
        }

        const std::string replacement(editedText.data(), editedText.size());
        auto& buffer = (*activeGuideEditor)->text;
        tutorux::document::DocumentEditTransaction transaction;
        transaction.documentId = id;
        transaction.expectedRevision = (*activeGuideEditor)->expectedRevision;
        transaction.operations.push_back({0, replacement, buffer.text()});
        transaction.selectionAfter = {replacement.size(), replacement.size()};
        transaction.origin = "desktop-guide-editor";
        auto applied = buffer.apply(transaction);
        if (!applied) {
            window->set_guide_output(toSharedString(applied.error().message));
            return;
        }

        auto arguments = archiveCommand(path,
                                        {"guide",
                                         "edit",
                                         id,
                                         "--section-index",
                                         std::to_string(indexes->sectionIndex),
                                         "--block-index",
                                         std::to_string(indexes->blockIndex),
                                         "--text",
                                         buffer.text()});
        auto saved = dispatchWithSecrets(arguments, activePassphrase);
        const std::string output = commandOutput(std::move(saved));
        window->set_guide_output(toSharedString(output));
        window->set_status_message(toSharedString(output));
        if (output.starts_with("Updated") || output.starts_with("Guide")) {
            auto latestArchive = Archive::open(path, false, activePassphrase);
            if (latestArchive) {
                auto latest = latestArchive->get(tutorux::archive::RecordType::Guide, *guideId);
                if (latest && *latest)
                    (*activeGuideEditor)->expectedRevision = (**latest).revision;
            }
            window->set_guide_edit_text(toSharedString(buffer.text()));
            window->set_guide_provenance(toSharedString(
                "Saved as a new archive revision. Source references were retained."));
        }
        const std::string guideSelection(selectedGuide.data(), selectedGuide.size());
        const std::string blockSelection(selectedBlock.data(), selectedBlock.size());
        refreshWorkspace(*window, path, activePassphrase);
        window->set_selected_guide(toSharedString(guideSelection));
        auto latestArchive = Archive::open(path, false, activePassphrase);
        if (latestArchive) {
            const std::string blockStatus = populateGuideBlockOptions(*window, *latestArchive, id);
            if (!blockStatus.empty())
                window->set_guide_provenance(toSharedString(blockStatus));
        }
        window->set_selected_guide_block(toSharedString(blockSelection));
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
    window->on_run_command([weakWindow,
                            commandBusy,
                            commandStopRequested,
                            commandThreads,
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

        auto parsed =
            parseCommandLine(std::string_view(requestedCommand.data(), requestedCommand.size()));
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
                    ->set_command_output(toSharedString("Wait for the current command to finish."));
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

        std::vector<std::string> arguments{"--archive",
                                           selectedPath.string(),
                                           "--directory",
                                           selectedPath.parent_path().string()};
        arguments.insert(arguments.end(),
                         std::make_move_iterator(parsed->begin()),
                         std::make_move_iterator(parsed->end()));
        if (auto strongWindow = weakWindow.lock()) {
            (*strongWindow)->set_command_output(toSharedString("Running command…"));
            (*strongWindow)
                ->set_status_message(
                    toSharedString("Running command against the selected archive."));
        }

        std::string commandPassphrase = activePassphrase;
        std::string newPassphrase(requestedNewPassphrase.data(), requestedNewPassphrase.size());
        bool changesPassphrase = parsed->size() >= 2 && parsed->front() == "archive" &&
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

        std::thread worker([weakWindow,
                            commandBusy,
                            commandStopRequested,
                            selectedPath,
                            &activePassphrase,
                            changesPassphrase,
                            commandPassphrase = std::move(commandPassphrase),
                            newPassphrase = std::move(newPassphrase),
                            arguments = std::move(arguments)]() mutable {
            std::string output;
            int exitCode = 2;
            try {
                auto command = dispatchWithSecrets(
                    arguments,
                    commandPassphrase,
                    newPassphrase,
                    [weakWindow, liveOutputTruncated = std::make_shared<std::atomic_bool>(false)](
                        const tutorux::command::ProgressEvent& event) {
                        if (event.phase != "ai-generation-text")
                            return;
                        if (liveOutputTruncated->load())
                            return;
                        std::string delta = event.message;
                        static_cast<void>(slint::invoke_from_event_loop(
                            [weakWindow, liveOutputTruncated, delta = std::move(delta)]() mutable {
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
                    [commandStopRequested] {
                        return commandStopRequested->load();
                    });
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
            static_cast<void>(
                slint::invoke_from_event_loop([weakWindow,
                                               selectedPath,
                                               exitCode,
                                               changesPassphrase,
                                               &activePassphrase,
                                               refreshPassphrase = std::move(refreshPassphrase),
                                               output = std::move(output)]() mutable {
                    auto strongWindow = weakWindow.lock();
                    if (!strongWindow) {
                        eraseSecret(refreshPassphrase);
                        return;
                    }
                    constexpr std::string_view packageJobMarker = "as job ";
                    const std::size_t packageJobPosition = output.find(packageJobMarker);
                    if (packageJobPosition != std::string::npos) {
                        const std::size_t idStart = packageJobPosition + packageJobMarker.size();
                        if (idStart <= output.size() && output.size() - idStart >= 36) {
                            const std::string_view candidate(output.data() + idStart, 36);
                            if (tutorux::archive::uuidFromString(candidate))
                                (*strongWindow)->set_ai_package_job_id(toSharedString(candidate));
                        }
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

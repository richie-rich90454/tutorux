#pragma once

#include <filesystem>
#include <optional>

namespace tutorux::gui {

    int launchDesktop(std::optional<std::filesystem::path> archivePath,
                      std::optional<std::filesystem::path> directoryPath);

} // namespace tutorux::gui

#pragma once

#include "tutorux/archive/archive.hpp"

#include <filesystem>
#include <optional>

namespace tutorux::command {

    core::Status exportSessionPackage(const archive::Archive& source,
                                      const archive::Uuid& sessionId,
                                      const std::filesystem::path& destination,
                                      bool replaceExisting);

    core::Result<archive::Uuid>
    importSessionPackage(archive::Archive& destination, const std::filesystem::path& source,
                         std::optional<archive::Uuid> studentId = std::nullopt);

} // namespace tutorux::command

#pragma once

#include "tutorux/archive/format.hpp"
#include "tutorux/core/result.hpp"

#include <filesystem>
#include <string>
#include <string_view>
#include <vector>

namespace tutorux::application {

struct TrashItem final {
    archive::RecordType type{archive::RecordType::Settings};
    std::string typeLabel;
    std::string id;
    std::string title;
    std::string detail;
    std::string deletedAtUs;
    std::string sessionId;
    bool restoresGroup{};
};

struct TrashSnapshot final {
    std::string errorMessage;
    std::uint64_t generation{};
    std::vector<TrashItem> items;
};

class TrashService final {
  public:
    [[nodiscard]] TrashSnapshot snapshot(const std::filesystem::path& archivePath,
                                         std::string_view passphrase) const;

    // Restoring a session restores its dependent records and reinstates journal
    // relations removed by the group-delete operation.
    [[nodiscard]] core::Status restore(const std::filesystem::path& archivePath,
                                       std::string_view passphrase,
                                       archive::RecordType type,
                                       std::string_view id) const;

    // Permanently purges soft-deleted records only after confirming that no
    // active record still references one of them.
    [[nodiscard]] core::Status purge(const std::filesystem::path& archivePath,
                                     std::string_view passphrase) const;
};

} // namespace tutorux::application

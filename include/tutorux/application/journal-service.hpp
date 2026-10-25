#pragma once

#include "tutorux/core/result.hpp"
#include "tutorux/domain/journal.hpp"

#include <cstdint>
#include <filesystem>
#include <string>
#include <string_view>

namespace tutorux::application {

struct NoteBlockUpdateRequest final {
    std::string documentId;
    std::string blockId;
    std::string kind;
    std::string text;
};

struct NoteBlockUpdateResult final {
    domain::JournalNotesDocument document;
    std::uint64_t revision{};
};

class JournalService final {
  public:
    [[nodiscard]] core::Result<NoteBlockUpdateResult> updateNoteBlock(
        const std::filesystem::path& archivePath, std::string_view passphrase,
        const NoteBlockUpdateRequest& request) const;
};

} // namespace tutorux::application

#pragma once

#include "tutorux/archive/archive.hpp"

#include <array>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace tutorux::application {

struct StudentSummary final {
    std::string id;
    std::string name;
    std::string grade;
    std::string subjects;
};

struct SessionSummary final {
    std::string id;
    std::string title;
    std::string subject;
    std::string studentId;
    std::string studentName;
    std::string entryId;
    std::string startedAtUs;
    std::string audioDurationUs;
    std::string notesDocumentId;
    std::string sessionState;
    std::string recordingState;
};

struct JournalEntrySummary final {
    std::string id;
    std::string title;
    std::string date;
    std::string createdAtUs;
    std::size_t sessionCount{};
};

struct JournalNameSummary final {
    std::string id;
    std::string name;
    std::string description;
};

struct TemplateSummary final {
    std::string id;
    std::string name;
};

struct GuideSummary final {
    std::string id;
    std::string title;
    std::string sessionId;
    std::string entryId;
    std::string approvalState;
};

struct GuideBlockRef final {
    std::string guideId;
    std::string heading;
    std::string kind;
    std::string label;
    std::size_t sectionIndex{};
    std::size_t blockIndex{};
};

struct MarkerSummary final {
    std::string id;
    std::string label;
    std::int64_t startSeconds{};
};

struct NotesBlock final {
    std::string id;
    std::string kind;
    std::string text;
};

struct NotesDocument final {
    bool available{};
    std::string id;
    std::vector<NotesBlock> blocks;
};

struct SessionDetail final {
    bool available{};
    std::string id;
    std::string title;
    std::string subject;
    std::string studentId;
    std::string studentName;
    std::string startedAtUs;
    std::string sessionState;
    std::string recordingState;
    std::int64_t audioDurationUs{};
    std::string notesDocumentId;
    NotesDocument notes;
    std::vector<MarkerSummary> markers;
};

struct OverviewRequest final {
    std::filesystem::path path;
    std::string passphrase;
    std::string journalSort{"Newest first"};
    std::string selectedEntryId;
    std::string selectedSessionId;
    std::string selectedGuideId;
    std::string selectedGuideBlockKey;
};

struct WorkspaceOverview final {
    std::string errorMessage;
    std::string archiveListText;
    std::vector<std::string> archivePaths;
    std::optional<tutorux::archive::ArchiveInfo> specialArchive;
    bool specialArchiveIsMetadataOnly{};
    bool specialArchiveIsLocked{};
    bool writableOnDisk{};
    bool encrypted{};
    std::string themeMode{"light"};
    std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
    std::uint64_t generation{};
    std::string selectedEntryId;
    std::string selectedSessionId;
    std::string selectedGuideId;
    std::string selectedGuideBlockKey;
    std::vector<StudentSummary> students;
    std::vector<SessionSummary> sessions;
    std::vector<JournalEntrySummary> entries;
    std::vector<JournalNameSummary> collections;
    std::vector<JournalNameSummary> tags;
    std::vector<TemplateSummary> templates;
    std::vector<GuideSummary> guides;
    std::vector<GuideBlockRef> guideBlocks;
    SessionDetail selectedSession;
};

class WorkspaceService final {
  public:
    // Opens the archive exactly once and reads the overview from the archive
    // indexes. No command dispatcher, no JSON output parsing, no second open.
    [[nodiscard]] WorkspaceOverview snapshotOverview(const OverviewRequest& request) const;
};

} // namespace tutorux::application

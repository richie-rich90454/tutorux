#include "tutorux/application/workspace-service.hpp"

#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"
#include "tutorux/domain/journal.hpp"

#include <algorithm>
#include <cctype>
#include <charconv>
#include <map>
#include <set>
#include <sstream>
#include <unordered_map>

namespace tutorux::application {
namespace {

    using tutorux::archive::Archive;
    using tutorux::archive::ArchiveInfo;
    using tutorux::archive::Record;
    using tutorux::archive::RecordType;

    std::string field(const Record& record, std::string_view name) {
        return tutorux::domain::getField(record, name);
    }

    std::string archiveChoices(const std::vector<ArchiveInfo>& archives) {
        if (archives.empty())
            return "No .tux archives were found in this folder. Create one to begin.";
        std::ostringstream output;
        output << "Archives in this folder\n\n";
        for (const auto& archive : archives) {
            output << (archive.healthStatus == "healthy" ? "  " : "!  ") << archive.displayName
                   << "\n    " << archive.path.string();
            if (archive.healthStatus != "healthy")
                output << "\n    Status: " << archive.healthStatus;
            output << "\n\n";
        }
        return output.str();
    }

    std::array<std::string, 7> markerShortcuts(const Archive& archive) {
        std::array<std::string, 7> shortcuts{"1", "2", "3", "4", "5", "6", "m"};
        auto settings = archive.list(RecordType::Settings);
        if (!settings)
            return shortcuts;
        const auto record =
            std::find_if(settings->begin(), settings->end(), [](const auto& setting) {
                return field(setting, "key") == "annotation.quick_marker_shortcuts";
            });
        if (record == settings->end())
            return shortcuts;
        const std::string saved = field(*record, "value");
        std::array<std::string, 7> parsed;
        std::size_t start = 0;
        for (std::size_t index = 0; index < parsed.size(); ++index) {
            const auto comma = saved.find(',', start);
            const auto end = comma == std::string::npos ? saved.size() : comma;
            parsed[index] = saved.substr(start, end - start);
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

    std::string readThemeMode(const Archive& archive) {
        auto settings = archive.list(RecordType::Settings);
        if (!settings)
            return {};
        const auto record = std::find_if(settings->begin(), settings->end(), [](const auto& setting) {
            return field(setting, "key") == "ui.theme";
        });
        if (record == settings->end())
            return {};
        const std::string value = field(*record, "value");
        return value == "light" || value == "dark" ? value : std::string{};
    }

    std::string sessionDateText(const std::string& value) {
        std::int64_t timestampUs = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), timestampUs);
        if (errorCode != std::errc{} || end != value.data() + value.size() || timestampUs < 0)
            return value;
        return tutorux::domain::formatTimestampUs(timestampUs);
    }

    std::int64_t timestampValue(std::string_view value) {
        std::int64_t timestamp = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), timestamp);
        return errorCode == std::errc{} && end == value.data() + value.size() ? timestamp : 0;
    }

} // namespace

WorkspaceOverview WorkspaceService::snapshotOverview(const OverviewRequest& request) const {
    WorkspaceOverview overview;
    const auto discovered = Archive::discover(request.path.parent_path());
    overview.archiveListText =
        discovered ? archiveChoices(*discovered) : discovered.error().message;
    if (discovered) {
        overview.archivePaths.reserve(discovered->size());
        for (const auto& archive : *discovered)
            overview.archivePaths.push_back(archive.path.string());

        const auto selectedPath = request.path.lexically_normal();
        const auto selected = std::find_if(discovered->begin(), discovered->end(),
                                           [&](const ArchiveInfo& archive) {
                                               return archive.path.lexically_normal() == selectedPath;
                                           });
        if (selected != discovered->end() &&
            (selected->metadataOnly ||
             (selected->healthStatus == "locked" && request.passphrase.empty()))) {
            overview.specialArchive = *selected;
            overview.specialArchiveIsMetadataOnly = selected->metadataOnly;
            overview.specialArchiveIsLocked = selected->healthStatus == "locked";
            return overview;
        }
        overview.writableOnDisk = selected != discovered->end() && selected->writable;
    }

    auto opened = Archive::open(request.path, false, request.passphrase);
    if (!opened) {
        overview.errorMessage = opened.error().message;
        return overview;
    }
    overview.generation = opened->commitInfo().generation;
    overview.encrypted = opened->encrypted();
    const std::string theme = readThemeMode(*opened);
    if (!theme.empty())
        overview.themeMode = theme;
    overview.shortcuts = markerShortcuts(*opened);

    std::unordered_map<std::string, std::string> studentNames;
    if (auto students = opened->list(RecordType::Student)) {
        overview.students.reserve(students->size());
        for (const auto& student : *students) {
            if (tutorux::domain::isDeleted(student))
                continue;
            StudentSummary summary;
            summary.id = tutorux::archive::uuidToString(student.id);
            summary.name = field(student, "display_name");
            if (summary.name.empty())
                summary.name = "Unnamed student";
            summary.grade = field(student, "grade");
            summary.subjects = field(student, "subjects");
            studentNames[summary.id] = summary.name;
            overview.students.push_back(std::move(summary));
        }
    }
    std::stable_sort(overview.students.begin(), overview.students.end(),
                     [](const StudentSummary& left, const StudentSummary& right) {
                         return left.name < right.name;
                     });

    std::unordered_map<std::string, std::size_t> sessionsByEntry;
    if (auto sessions = opened->list(RecordType::Session)) {
        overview.sessions.reserve(sessions->size());
        for (const auto& session : *sessions) {
            if (tutorux::domain::isDeleted(session))
                continue;
            SessionSummary summary;
            summary.id = tutorux::archive::uuidToString(session.id);
            summary.title = field(session, "title");
            if (summary.title.empty())
                summary.title = "Untitled session";
            summary.subject = field(session, "subject");
            summary.studentId = field(session, "student_id");
            const auto student = studentNames.find(summary.studentId);
            if (student != studentNames.end())
                summary.studentName = student->second;
            summary.entryId = field(session, "entry_id");
            summary.startedAtUs = field(session, "started_at_us");
            summary.audioDurationUs = field(session, "audio_duration_us");
            summary.notesDocumentId = field(session, "notes_document_id");
            summary.sessionState = field(session, "session_state");
            summary.recordingState = field(session, "recording_state");
            if (!summary.entryId.empty()) {
                ++sessionsByEntry[summary.entryId];
            }
            overview.sessions.push_back(std::move(summary));
        }
    }
    std::stable_sort(overview.sessions.begin(), overview.sessions.end(),
                     [](const SessionSummary& left, const SessionSummary& right) {
                         return timestampValue(left.startedAtUs) > timestampValue(right.startedAtUs);
                     });

    if (auto settings = opened->list(RecordType::Settings)) {
        for (const auto& record : *settings) {
            const std::string role = field(record, "record_role");
            if (role == "journal-entry") {
                auto entry = tutorux::domain::journalEntryFromRecord(record);
                if (!entry)
                    continue;
                JournalEntrySummary summary;
                summary.id = tutorux::archive::uuidToString(record.id);
                summary.title = entry->title;
                summary.date = entry->date;
                summary.createdAtUs = field(record, "created_at_us");
                summary.sessionCount = sessionsByEntry[summary.id];
                overview.entries.push_back(std::move(summary));
            } else if (role == "journal-collection") {
                JournalNameSummary summary;
                summary.id = tutorux::archive::uuidToString(record.id);
                summary.name = field(record, "name");
                summary.description = field(record, "description");
                if (!summary.name.empty())
                    overview.collections.push_back(std::move(summary));
            } else if (role == "journal-tag") {
                JournalNameSummary summary;
                summary.id = tutorux::archive::uuidToString(record.id);
                summary.name = field(record, "name");
                if (!summary.name.empty())
                    overview.tags.push_back(std::move(summary));
            } else if (role == "guide-template") {
                TemplateSummary summary;
                summary.id = tutorux::archive::uuidToString(record.id);
                summary.name = field(record, "name");
                if (!summary.name.empty())
                    overview.templates.push_back(std::move(summary));
            }
        }
    }
    std::stable_sort(overview.entries.begin(), overview.entries.end(),
                     [&](const JournalEntrySummary& left, const JournalEntrySummary& right) {
                         if (request.journalSort == "Title") {
                             if (left.title != right.title)
                                 return left.title < right.title;
                         } else {
                             const std::string leftSort =
                                 request.journalSort == "Oldest first" ? left.date : left.date;
                             const std::string rightSort =
                                 request.journalSort == "Oldest first" ? right.date : right.date;
                             if (leftSort != rightSort)
                                 return request.journalSort == "Oldest first" ? leftSort < rightSort
                                                                             : leftSort > rightSort;
                         }
                         return left.createdAtUs > right.createdAtUs;
                     });

    if (auto guides = opened->list(RecordType::Guide)) {
        overview.guides.reserve(guides->size());
        for (const auto& record : *guides) {
            if (tutorux::domain::isDeleted(record))
                continue;
            GuideSummary summary;
            summary.id = tutorux::archive::uuidToString(record.id);
            if (auto parsed = tutorux::domain::guideFromRecord(record)) {
                summary.title = parsed->title;
                summary.sessionId = parsed->sessionId;
                summary.entryId = parsed->entryId;
                summary.approvalState = parsed->approvalState;
                for (std::size_t sectionIndex = 0; sectionIndex < parsed->sections.size();
                     ++sectionIndex) {
                    const auto& section = parsed->sections[sectionIndex];
                    for (std::size_t blockIndex = 0; blockIndex < section.blocks.size();
                         ++blockIndex) {
                        const auto& block = section.blocks[blockIndex];
                        const auto kindLabel = tutorux::domain::guideBlockLabel(block.kind);
                        GuideBlockRef blockRef;
                        blockRef.guideId = summary.id;
                        blockRef.heading = section.heading;
                        blockRef.kind = block.kind;
                        blockRef.label = section.heading + " · " +
                                         std::string(kindLabel.empty() ? block.kind : kindLabel);
                        blockRef.sectionIndex = sectionIndex;
                        blockRef.blockIndex = blockIndex;
                        overview.guideBlocks.push_back(std::move(blockRef));
                    }
                }
            } else {
                summary.title = field(record, "title");
            }
            if (summary.title.empty())
                summary.title = "Untitled guide";
            overview.guides.push_back(std::move(summary));
        }
    }

    const auto entryStillPresent =
        std::find_if(overview.entries.begin(), overview.entries.end(),
                     [&](const JournalEntrySummary& entry) {
                         return entry.id == request.selectedEntryId;
                     });
    if (entryStillPresent != overview.entries.end())
        overview.selectedEntryId = entryStillPresent->id;
    else if (!overview.entries.empty())
        overview.selectedEntryId = overview.entries.front().id;

    const auto sessionStillPresent =
        std::find_if(overview.sessions.begin(), overview.sessions.end(),
                     [&](const SessionSummary& session) {
                         return session.id == request.selectedSessionId;
                     });
    if (sessionStillPresent != overview.sessions.end())
        overview.selectedSessionId = sessionStillPresent->id;
    else if (!overview.sessions.empty())
        overview.selectedSessionId = overview.sessions.front().id;

    const auto guideStillPresent =
        std::find_if(overview.guides.begin(), overview.guides.end(),
                     [&](const GuideSummary& guide) {
                         return guide.id == request.selectedGuideId;
                     });
    if (guideStillPresent != overview.guides.end())
        overview.selectedGuideId = guideStillPresent->id;
    else if (!overview.guides.empty())
        overview.selectedGuideId = overview.guides.front().id;

    const auto blockStillPresent =
        std::find_if(overview.guideBlocks.begin(), overview.guideBlocks.end(),
                     [&](const GuideBlockRef& block) {
                         return block.guideId == overview.selectedGuideId &&
                                (block.guideId + "|" + std::to_string(block.sectionIndex) + ":" +
                                 std::to_string(block.blockIndex)) == request.selectedGuideBlockKey;
                     });
    if (blockStillPresent != overview.guideBlocks.end())
        overview.selectedGuideBlockKey = blockStillPresent->guideId + "|" +
                                         std::to_string(blockStillPresent->sectionIndex) + ":" +
                                         std::to_string(blockStillPresent->blockIndex);
    else {
        const auto firstBlock = std::find_if(overview.guideBlocks.begin(), overview.guideBlocks.end(),
                                             [&](const GuideBlockRef& block) {
                                                 return block.guideId == overview.selectedGuideId;
                                             });
        if (firstBlock != overview.guideBlocks.end())
            overview.selectedGuideBlockKey = firstBlock->guideId + "|" +
                                             std::to_string(firstBlock->sectionIndex) + ":" +
                                             std::to_string(firstBlock->blockIndex);
    }

    const auto detail = std::find_if(overview.sessions.begin(), overview.sessions.end(),
                                     [&](const SessionSummary& session) {
                                         return session.id == overview.selectedSessionId;
                                     });
    if (detail != overview.sessions.end()) {
        overview.selectedSession.available = true;
        overview.selectedSession.id = detail->id;
        overview.selectedSession.title = detail->title;
        overview.selectedSession.subject = detail->subject;
        overview.selectedSession.studentId = detail->studentId;
        overview.selectedSession.studentName = detail->studentName;
        overview.selectedSession.startedAtUs = sessionDateText(detail->startedAtUs);
        overview.selectedSession.sessionState = detail->sessionState;
        overview.selectedSession.recordingState =
            detail->recordingState.empty() ? "not-started" : detail->recordingState;
        overview.selectedSession.audioDurationUs = timestampValue(detail->audioDurationUs);

        if (auto annotations = opened->list(RecordType::Annotation)) {
            for (const auto& annotation : *annotations) {
                if (tutorux::domain::isDeleted(annotation) ||
                    field(annotation, "session_id") != detail->id)
                    continue;
                MarkerSummary marker;
                marker.id = tutorux::archive::uuidToString(annotation.id);
                const auto startUs = timestampValue(field(annotation, "start_time_us"));
                marker.startSeconds = startUs / 1'000'000;
                marker.label = field(annotation, "title");
                if (marker.label.empty())
                    marker.label = field(annotation, "content");
                if (marker.label.empty())
                    marker.label = field(annotation, "type");
                overview.selectedSession.markers.push_back(std::move(marker));
            }
            std::stable_sort(overview.selectedSession.markers.begin(),
                             overview.selectedSession.markers.end(),
                             [](const MarkerSummary& left, const MarkerSummary& right) {
                                 return left.startSeconds < right.startSeconds;
                             });
        }

        overview.selectedSession.notesDocumentId = detail->notesDocumentId;
        if (!detail->notesDocumentId.empty()) {
            const auto documentId = tutorux::archive::uuidFromString(detail->notesDocumentId);
            if (documentId) {
                auto document = opened->get(RecordType::Settings, *documentId);
                if (document && *document && !tutorux::domain::isDeleted(**document) &&
                    field(**document, "record_role") == "journal-notes") {
                    auto parsed = tutorux::domain::journalNotesDocumentFromRecord(**document);
                    if (parsed) {
                        overview.selectedSession.notes.available = true;
                        overview.selectedSession.notes.id = detail->notesDocumentId;
                        overview.selectedSession.notes.blocks.reserve(parsed->blocks.size());
                        for (const auto& block : parsed->blocks)
                            overview.selectedSession.notes.blocks.push_back(
                                {block.id, block.kind, block.text});
                    }
                }
            }
        }
    }
    return overview;
}

} // namespace tutorux::application

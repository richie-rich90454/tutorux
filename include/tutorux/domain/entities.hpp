#pragma once

#include "tutorux/archive/archive.hpp"

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

namespace tutorux::domain {

using tutorux::archive::Record;
using tutorux::archive::RecordType;
using tutorux::archive::Uuid;

struct Student final {
    Uuid id{};
    std::string name;
    std::string grade;
    std::string subjects;
    std::string objectives;
    std::string difficulties;
    std::string tutorNotes;
};

struct Session final {
    Uuid id{};
    std::string studentId;
    std::string entryId;
    std::string notesDocumentId;
    std::string subject;
    std::string title;
    std::string objectives;
    std::string sessionType{"notes-only"};
    std::string sessionState{"active"};
    std::int64_t startedAtUs{};
    std::int64_t endedAtUs{};
    std::int64_t reviewedAtUs{};
    std::int64_t createdAtUs{};
    std::string recordingState{"not-started"};
    std::string processingState{"not-processed"};
    bool archived{};
};

struct Annotation final {
    Uuid id{};
    std::string sessionId;
    std::int64_t startTimeUs{};
    std::int64_t endTimeUs{};
    std::string type{"general-note"};
    std::string priority{"normal"};
    std::string title;
    std::string content;
};

Record toRecord(const Student& student);
Record toRecord(const Session& session);
Record toRecord(const Annotation& annotation);
tutorux::core::Result<Session> sessionFromRecord(const Record& record);
std::string formatTimestampUs(std::int64_t timestampUs);
tutorux::core::Result<std::int64_t> parseTimestamp(std::string_view value);
bool isValidSessionType(std::string_view value) noexcept;
bool isValidSessionState(std::string_view value) noexcept;
bool isValidAnnotationType(std::string_view value);
bool isValidPriority(std::string_view value);
std::string getField(const Record& record, std::string_view key, std::string_view fallback = {});
bool isDeleted(const Record& record);
Uuid idFromRecord(const Record& record);

} // namespace tutorux::domain

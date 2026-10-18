#include "tutorux/domain/entities.hpp"

#include <array>
#include <charconv>
#include <chrono>
#include <limits>
#include <algorithm>

namespace tutorux::domain {
namespace {

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
    }

    std::uint64_t timestampOrNow(std::int64_t timestamp) {
        return timestamp > 0 ? static_cast<std::uint64_t>(timestamp) : nowUnixMicroseconds();
    }

    std::string booleanString(bool value) {
        return value ? "true" : "false";
    }

} // namespace

Record toRecord(const Student& student) {
    Record record;
    record.type = RecordType::Student;
    record.id = student.id;
    record.fields = {
        {"display_name",        student.name                         },
        {"grade",               student.grade                        },
        {"subjects",            student.subjects                     },
        {"learning_objectives", student.objectives                   },
        {"known_difficulties",  student.difficulties                 },
        {"tutor_notes",         student.tutorNotes                   },
        {"created_at_us",       std::to_string(nowUnixMicroseconds())},
        {"updated_at_us",       std::to_string(nowUnixMicroseconds())}
    };
    return record;
}

Record toRecord(const Session& session) {
    const std::uint64_t now = nowUnixMicroseconds();
    Record record;
    record.type = RecordType::Session;
    record.id = session.id;
    record.fields = {
        {"student_id",          session.studentId                                  },
        {"entry_id",            session.entryId                                    },
        {"notes_document_id",   session.notesDocumentId                            },
        {"subject",             session.subject                                    },
        {"title",               session.title                                      },
        {"learning_objectives", session.objectives                                 },
        {"session_type",        session.sessionType                                },
        {"session_state",       session.sessionState                               },
        {"started_at_us",       std::to_string(timestampOrNow(session.startedAtUs))},
        {"ended_at_us",         std::to_string(session.endedAtUs)                  },
        {"reviewed_at_us",      std::to_string(session.reviewedAtUs)               },
        {"recording_state",     session.recordingState                             },
        {"processing_state",    session.processingState                            },
        {"archived",            booleanString(session.archived)                    },
        {"created_at_us",       std::to_string(timestampOrNow(session.createdAtUs))},
        {"updated_at_us",       std::to_string(now)                                }
    };
    return record;
}

Record toRecord(const Annotation& annotation) {
    Record record;
    record.type = RecordType::Annotation;
    record.id = annotation.id;
    record.fields = {
        {"session_id",    annotation.sessionId                  },
        {"start_time_us", std::to_string(annotation.startTimeUs)},
        {"end_time_us",   std::to_string(annotation.endTimeUs)  },
        {"type",          annotation.type                       },
        {"priority",      annotation.priority                   },
        {"title",         annotation.title                      },
        {"content",       annotation.content                    },
        {"origin",        "tutor-authored"                      },
        {"created_at_us", std::to_string(nowUnixMicroseconds()) },
        {"updated_at_us", std::to_string(nowUnixMicroseconds()) }
    };
    return record;
}

tutorux::core::Result<Session> sessionFromRecord(const Record& record) {
    if (record.type != RecordType::Session) {
        return std::unexpected(
            tutorux::core::error("session_record_invalid", "Record is not a session."));
    }
    Session session;
    session.id = record.id;
    session.studentId = getField(record, "student_id", "anonymous");
    session.entryId = getField(record, "entry_id");
    session.notesDocumentId = getField(record, "notes_document_id");
    session.subject = getField(record, "subject");
    session.title = getField(record, "title", "Untitled session");
    session.objectives = getField(record, "learning_objectives");
    session.recordingState = getField(record, "recording_state", "not-started");
    session.processingState = getField(record, "processing_state", "not-processed");
    session.sessionType =
        getField(record, "session_type",
                 session.recordingState == "not-started" ? "notes-only" : "record-audio");
    session.sessionState = getField(record, "session_state", "active");
    session.archived = getField(record, "archived") == "true";
    const auto parseTimestampField = [&](std::string_view key) -> std::int64_t {
        const auto value = getField(record, key);
        std::int64_t timestamp = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), timestamp);
        return errorCode == std::errc{} && end == value.data() + value.size() && timestamp >= 0
                   ? timestamp
                   : 0;
    };
    session.startedAtUs = parseTimestampField("started_at_us");
    session.endedAtUs = parseTimestampField("ended_at_us");
    session.reviewedAtUs = parseTimestampField("reviewed_at_us");
    session.createdAtUs = parseTimestampField("created_at_us");
    if (!isValidSessionType(session.sessionType) || !isValidSessionState(session.sessionState)) {
        return std::unexpected(tutorux::core::error("session_record_invalid",
                                                    "Session type or lifecycle state is invalid."));
    }
    return session;
}

bool isValidSessionType(std::string_view value) noexcept {
    static constexpr std::array types{"notes-only", "record-audio", "import-recording"};
    return std::find(types.begin(), types.end(), value) != types.end();
}

bool isValidSessionState(std::string_view value) noexcept {
    static constexpr std::array states{"created", "active", "completed", "reviewed"};
    return std::find(states.begin(), states.end(), value) != states.end();
}

std::string formatTimestampUs(std::int64_t timestampUs) {
    if (timestampUs < 0)
        timestampUs = 0;
    const std::uint64_t totalMilliseconds = static_cast<std::uint64_t>(timestampUs) / 1000U;
    const std::uint64_t totalSeconds = totalMilliseconds / 1000U;
    const std::uint64_t hours = totalSeconds / 3600U;
    const std::uint64_t minutes = (totalSeconds / 60U) % 60U;
    const std::uint64_t seconds = totalSeconds % 60U;
    const std::uint64_t milliseconds = totalMilliseconds % 1000U;
    auto twoDigits = [](std::uint64_t value) {
        return value < 10 ? "0" + std::to_string(value) : std::to_string(value);
    };
    std::string timestamp = twoDigits(hours) + ":" + twoDigits(minutes) + ":" + twoDigits(seconds);
    if (milliseconds != 0) {
        std::string fractional = std::to_string(milliseconds + 1000).substr(1);
        while (!fractional.empty() && fractional.back() == '0')
            fractional.pop_back();
        timestamp += "." + fractional;
    }
    return timestamp;
}

tutorux::core::Result<std::int64_t> parseTimestamp(std::string_view value) {
    if (value.empty()) {
        return std::unexpected(tutorux::core::error("timestamp_invalid", "Timestamp is required."));
    }
    const auto firstColon = value.find(':');
    const auto secondColon = firstColon == std::string_view::npos ? std::string_view::npos
                                                                  : value.find(':', firstColon + 1);
    if (firstColon == std::string_view::npos) {
        std::uint64_t seconds = 0;
        const auto [end, errorCode] =
            std::from_chars(value.data(), value.data() + value.size(), seconds);
        if (errorCode == std::errc{} && end == value.data() + value.size() &&
            seconds <=
                static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max() / 1'000'000)) {
            return static_cast<std::int64_t>(seconds * 1'000'000U);
        }
        return std::unexpected(tutorux::core::error("timestamp_invalid", "Use HH:MM:SS[.ffffff]."));
    }
    if (secondColon == std::string_view::npos ||
        value.find(':', secondColon + 1) != std::string_view::npos) {
        return std::unexpected(tutorux::core::error("timestamp_invalid", "Use HH:MM:SS[.ffffff]."));
    }
    const auto dot = value.find('.', secondColon + 1);
    const std::size_t secondsEnd = dot == std::string_view::npos ? value.size() : dot;
    std::array<std::uint64_t, 3> parts{};
    const std::array<std::pair<std::size_t, std::size_t>, 3> ranges{
        {{0, firstColon}, {firstColon + 1, secondColon}, {secondColon + 1, secondsEnd}}
    };
    for (std::size_t index = 0; index < ranges.size(); ++index) {
        const auto [start, end] = ranges[index];
        if (start == end) {
            return std::unexpected(
                tutorux::core::error("timestamp_invalid", "Use HH:MM:SS[.ffffff]."));
        }
        const auto [parsedEnd, errorCode] =
            std::from_chars(value.data() + start, value.data() + end, parts[index]);
        if (errorCode != std::errc{} || parsedEnd != value.data() + end) {
            return std::unexpected(
                tutorux::core::error("timestamp_invalid", "Use HH:MM:SS[.ffffff]."));
        }
    }
    if (parts[1] > 59 || parts[2] > 59) {
        return std::unexpected(
            tutorux::core::error("timestamp_invalid", "Minutes and seconds must be below 60."));
    }
    std::uint64_t microseconds = 0;
    if (parts[0] >
        static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max() / 3'600'000'000LL)) {
        return std::unexpected(
            tutorux::core::error("timestamp_invalid", "Timestamp exceeds the supported range."));
    }
    microseconds = parts[0] * 3'600'000'000ULL + parts[1] * 60'000'000ULL + parts[2] * 1'000'000ULL;
    if (dot != std::string_view::npos) {
        if (value.size() - dot - 1 == 0 || value.size() - dot - 1 > 6) {
            return std::unexpected(tutorux::core::error(
                "timestamp_invalid", "Fractional seconds must contain one to six digits."));
        }
        std::uint64_t fractional = 0;
        const auto digits = value.substr(dot + 1);
        const auto [fractionEnd, fractionError] =
            std::from_chars(digits.data(), digits.data() + digits.size(), fractional);
        if (fractionError != std::errc{} || fractionEnd != digits.data() + digits.size()) {
            return std::unexpected(
                tutorux::core::error("timestamp_invalid", "Fractional seconds are invalid."));
        }
        for (std::size_t index = digits.size(); index < 6; ++index)
            fractional *= 10U;
        microseconds += fractional;
    }
    if (microseconds > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
        return std::unexpected(
            tutorux::core::error("timestamp_invalid", "Timestamp exceeds the supported range."));
    }
    return static_cast<std::int64_t>(microseconds);
}

bool isValidAnnotationType(std::string_view value) {
    static constexpr std::array types{"general-note",         "important-concept",
                                      "student-mistake",      "tutor-correction",
                                      "explicit-instruction", "worked-example",
                                      "follow-up-priority",   "student-question",
                                      "learning-outcome",     "custom"};
    return std::find(types.begin(), types.end(), value) != types.end();
}

bool isValidPriority(std::string_view value) {
    static constexpr std::array priorities{"low", "normal", "high", "critical"};
    return std::find(priorities.begin(), priorities.end(), value) != priorities.end();
}

std::string getField(const Record& record, std::string_view key, std::string_view fallback) {
    const auto found = record.fields.find(key);
    return found == record.fields.end() ? std::string(fallback) : found->second;
}

bool isDeleted(const Record& record) {
    const auto found = record.fields.find("_deleted");
    return found != record.fields.end() && found->second == "true";
}

Uuid idFromRecord(const Record& record) {
    return record.id;
}

} // namespace tutorux::domain

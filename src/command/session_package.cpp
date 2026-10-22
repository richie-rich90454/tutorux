#include "tutorux/command/session_package.hpp"

#include "tutorux/domain/entities.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <iterator>
#include <limits>
#include <map>
#include <set>
#include <string_view>
#include <system_error>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#endif

namespace tutorux::command {
namespace {

    using archive::Archive;
    using archive::Record;
    using archive::RecordType;
    using archive::Uuid;

    bool isInternalAssetMetadata(const Record& record) {
        if (record.type != RecordType::AssetMetadata)
            return false;
        const std::string role = domain::getField(record, "record_role");
        return role == "audio-track" || role == "waveform-pyramid" ||
               role == "sparse-timestamp-seek-index" || role == "asset-blob-manifest" ||
               role == "asset-blob-chunk";
    }

    class TemporaryFile final {
      public:
        explicit TemporaryFile(std::filesystem::path path)
            : path_(std::move(path)) {}
        TemporaryFile(const TemporaryFile&) = delete;
        TemporaryFile& operator=(const TemporaryFile&) = delete;
        ~TemporaryFile() {
            if (keep_)
                return;
            std::error_code ignored;
            std::filesystem::remove(path_, ignored);
        }
        const std::filesystem::path& path() const {
            return path_;
        }
        void keep() {
            keep_ = true;
        }

      private:
        std::filesystem::path path_;
        bool keep_{};
    };

    std::uint64_t nowUnixMicroseconds() {
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                                              std::chrono::system_clock::now().time_since_epoch())
                                              .count());
    }

    core::Result<Record> requiredRecord(const Archive& archive,
                                        RecordType type,
                                        const Uuid& id,
                                        std::string_view label) {
        auto record = archive.get(type, id);
        if (!record)
            return std::unexpected(record.error());
        if (!*record || domain::isDeleted(**record)) {
            return std::unexpected(
                core::error("session_package_record_missing",
                            std::string(label) + " is missing from the selected archive."));
        }
        return std::move(**record);
    }

    void addRecord(std::vector<Record>& records, std::set<std::string>& keys, Record record) {
        const std::string key = std::to_string(static_cast<std::uint16_t>(record.type)) + ":" +
                                archive::uuidToString(record.id);
        if (keys.insert(key).second)
            records.push_back(std::move(record));
    }

    core::Result<std::vector<Record>> recordVersions(const Archive& source, const Record& latest) {
        if (latest.revision > std::numeric_limits<std::size_t>::max()) {
            return std::unexpected(
                core::error("session_package_history_too_large",
                            "A record's revision history exceeds this platform's index range."));
        }
        std::vector<Record> history;
        for (std::size_t revision = 0; revision < static_cast<std::size_t>(latest.revision);
             ++revision) {
            auto record = source.getRevision(latest.type, latest.id, revision);
            if (!record)
                return std::unexpected(record.error());
            if (!*record)
                break;
            history.push_back(std::move(**record));
        }
        if (history.empty())
            history.push_back(latest);
        else
            std::reverse(history.begin(), history.end());
        return history;
    }

    core::Result<std::vector<Record>> includeRecordHistory(const Archive& source,
                                                           std::vector<Record> current) {
        std::vector<Record> complete;
        for (const Record& latest : current) {
            auto history = recordVersions(source, latest);
            if (!history)
                return std::unexpected(history.error());
            complete.insert(complete.end(),
                            std::make_move_iterator(history->begin()),
                            std::make_move_iterator(history->end()));
        }
        return complete;
    }

    core::Status validateSessionRecords(const std::vector<Record>& records,
                                        std::string_view sessionId) {
        std::map<RecordType, std::set<std::string>> recordIds;
        for (const Record& record : records)
            recordIds[record.type].insert(archive::uuidToString(record.id));

        const auto hasReference = [&](RecordType type, std::string_view id) {
            const auto found = recordIds.find(type);
            return found != recordIds.end() && found->second.contains(std::string(id));
        };
        const auto validateList =
            [&](std::string_view value, RecordType type, std::string_view label) -> core::Status {
            std::size_t start = 0;
            while (start < value.size()) {
                const auto end = value.find(',', start);
                const auto itemEnd = end == std::string_view::npos ? value.size() : end;
                const std::string_view id = value.substr(start, itemEnd - start);
                if (!id.empty() && !hasReference(type, id)) {
                    return std::unexpected(
                        core::error("session_package_reference_invalid",
                                    "A session package " + std::string(label) +
                                        " points to a record that is not included."));
                }
                if (end == std::string_view::npos)
                    break;
                start = end + 1;
            }
            return {};
        };

        for (const Record& record : records) {
            const std::string relatedSession = domain::getField(record, "session_id");
            if (!relatedSession.empty() && record.type != RecordType::AssetMetadata &&
                relatedSession != sessionId) {
                return std::unexpected(
                    core::error("session_package_foreign_record",
                                "Package contains a record associated with another session."));
            }
            if (record.type == RecordType::AssetMetadata && !isInternalAssetMetadata(record) &&
                !hasReference(RecordType::AssetBlob, domain::getField(record, "blob_id"))) {
                return std::unexpected(
                    core::error("session_package_asset_invalid",
                                "A session asset revision references a missing content blob."));
            }
            if (record.type == RecordType::AssetBlob &&
                domain::getField(record, "record_role") == "asset-blob-manifest") {
                const std::string chunkIds = domain::getField(record, "chunk_ids");
                std::size_t start = 0;
                while (start < chunkIds.size()) {
                    const std::size_t end = chunkIds.find(',', start);
                    const std::size_t itemEnd = end == std::string::npos ? chunkIds.size() : end;
                    const std::string_view chunkId(chunkIds.data() + start, itemEnd - start);
                    if (chunkId.empty() || !hasReference(RecordType::AssetBlob, chunkId)) {
                        return std::unexpected(
                            core::error("session_package_asset_invalid",
                                        "An asset manifest references a missing content chunk."));
                    }
                    if (end == std::string::npos)
                        break;
                    start = end + 1;
                }
            }
            if (record.type == RecordType::Annotation ||
                record.type == RecordType::TranscriptSegment) {
                if (auto status = validateList(domain::getField(record, "linked_asset_ids"),
                                               RecordType::AssetMetadata,
                                               "asset link");
                    !status) {
                    return status;
                }
            }
            if (record.type == RecordType::EvidenceNode) {
                const std::string annotationId = domain::getField(record, "source_annotation_id");
                if (!annotationId.empty() && !hasReference(RecordType::Annotation, annotationId)) {
                    return std::unexpected(
                        core::error("session_package_reference_invalid",
                                    "Evidence refers to an annotation that is not included."));
                }
                if (auto status = validateList(domain::getField(record, "source_segment_ids"),
                                               RecordType::TranscriptSegment,
                                               "transcript source");
                    !status) {
                    return status;
                }
                if (auto status = validateList(domain::getField(record, "source_asset_ids"),
                                               RecordType::AssetMetadata,
                                               "evidence asset source");
                    !status) {
                    return status;
                }
            }
            if (record.type == RecordType::EvidenceEdge &&
                (!hasReference(RecordType::EvidenceNode, domain::getField(record, "from_id")) ||
                 !hasReference(RecordType::EvidenceNode, domain::getField(record, "to_id")))) {
                return std::unexpected(
                    core::error("session_package_reference_invalid",
                                "An evidence relationship points to a missing evidence node."));
            }
        }
        return {};
    }

    core::Result<std::vector<Record>> collectSessionRecords(const Archive& source,
                                                            const Uuid& sessionId) {
        auto session = requiredRecord(source, RecordType::Session, sessionId, "Session");
        if (!session)
            return std::unexpected(session.error());

        const std::string sessionEntryId = domain::getField(*session, "entry_id");
        const std::string sessionDocumentId = domain::getField(*session, "notes_document_id");

        std::vector<Record> records;
        std::set<std::string> recordKeys;
        std::set<std::string> evidenceIds;
        std::set<std::string> assetIds;
        addRecord(records, recordKeys, std::move(*session));

        constexpr std::array relatedTypes{RecordType::AudioChunk,
                                          RecordType::TranscriptSegment,
                                          RecordType::Annotation,
                                          RecordType::AssetMetadata,
                                          RecordType::EvidenceNode,
                                          RecordType::Guide,
                                          RecordType::AiJob};
        for (const RecordType type : relatedTypes) {
            auto listed = source.list(type, true);
            if (!listed)
                return std::unexpected(listed.error());
            for (Record& record : *listed) {
                if (domain::getField(record, "session_id") != archive::uuidToString(sessionId)) {
                    continue;
                }
                if (type == RecordType::EvidenceNode)
                    evidenceIds.insert(archive::uuidToString(record.id));
                if (type == RecordType::AssetMetadata && !isInternalAssetMetadata(record))
                    assetIds.insert(archive::uuidToString(record.id));
                for (const std::string_view field : {"linked_asset_ids", "source_asset_ids"}) {
                    const auto found = record.fields.find(field);
                    if (found == record.fields.end())
                        continue;
                    std::size_t start = 0;
                    while (start < found->second.size()) {
                        const auto end = found->second.find(',', start);
                        const auto itemEnd = end == std::string::npos ? found->second.size() : end;
                        if (itemEnd > start)
                            assetIds.insert(found->second.substr(start, itemEnd - start));
                        if (end == std::string::npos)
                            break;
                        start = end + 1;
                    }
                }
                addRecord(records, recordKeys, std::move(record));
            }
        }

        auto edges = source.list(RecordType::EvidenceEdge, true);
        if (!edges)
            return std::unexpected(edges.error());
        for (Record& edge : *edges) {
            const bool belongsToSession =
                domain::getField(edge, "session_id") == archive::uuidToString(sessionId);
            const bool connectsSessionEvidence =
                evidenceIds.contains(domain::getField(edge, "from_id")) &&
                evidenceIds.contains(domain::getField(edge, "to_id"));
            if (belongsToSession || connectsSessionEvidence)
                addRecord(records, recordKeys, std::move(edge));
        }

        for (const Record& current : records) {
            auto history = recordVersions(source, current);
            if (!history)
                return std::unexpected(history.error());
            for (const Record& version : *history) {
                for (const std::string_view field : {"linked_asset_ids", "source_asset_ids"}) {
                    const auto found = version.fields.find(field);
                    if (found == version.fields.end())
                        continue;
                    std::size_t start = 0;
                    while (start < found->second.size()) {
                        const auto end = found->second.find(',', start);
                        const auto itemEnd = end == std::string::npos ? found->second.size() : end;
                        if (itemEnd > start)
                            assetIds.insert(found->second.substr(start, itemEnd - start));
                        if (end == std::string::npos)
                            break;
                        start = end + 1;
                    }
                }
            }
        }

        auto assets = source.list(RecordType::AssetMetadata, true);
        if (!assets)
            return std::unexpected(assets.error());
        std::set<std::string> resolvedAssetIds;
        std::set<std::string> blobIds;
        for (Record& asset : *assets) {
            if (!assetIds.contains(archive::uuidToString(asset.id)))
                continue;
            auto history = recordVersions(source, asset);
            if (!history)
                return std::unexpected(history.error());
            for (const Record& version : *history) {
                auto parsedBlobId = archive::uuidFromString(domain::getField(version, "blob_id"));
                if (!parsedBlobId) {
                    return std::unexpected(core::error(
                        "session_package_asset_invalid",
                        "A session asset revision has an invalid content-blob reference."));
                }
                blobIds.insert(archive::uuidToString(*parsedBlobId));
            }
            resolvedAssetIds.insert(archive::uuidToString(asset.id));
            addRecord(records, recordKeys, std::move(asset));
        }
        std::vector<std::string> pendingBlobIds(blobIds.begin(), blobIds.end());
        std::set<std::string> resolvedBlobIds;
        for (std::size_t index = 0; index < pendingBlobIds.size(); ++index) {
            const std::string& blobId = pendingBlobIds[index];
            if (!resolvedBlobIds.insert(blobId).second)
                continue;
            auto parsedBlobId = archive::uuidFromString(blobId);
            if (!parsedBlobId)
                return std::unexpected(core::error("session_package_asset_invalid",
                                                   "An asset blob identifier is invalid."));
            auto blob =
                requiredRecord(source, RecordType::AssetBlob, *parsedBlobId, "Asset content blob");
            if (!blob)
                return std::unexpected(blob.error());
            if (domain::getField(*blob, "record_role") == "asset-blob-manifest") {
                auto history = recordVersions(source, *blob);
                if (!history)
                    return std::unexpected(history.error());
                for (const Record& version : *history) {
                    const std::string chunkIds = domain::getField(version, "chunk_ids");
                    std::size_t start = 0;
                    while (start < chunkIds.size()) {
                        const std::size_t end = chunkIds.find(',', start);
                        const std::size_t itemEnd =
                            end == std::string::npos ? chunkIds.size() : end;
                        if (itemEnd == start)
                            return std::unexpected(core::error(
                                "session_package_asset_invalid",
                                "An asset manifest contains an empty chunk identifier."));
                        pendingBlobIds.emplace_back(chunkIds.substr(start, itemEnd - start));
                        if (end == std::string::npos)
                            break;
                        start = end + 1;
                    }
                }
            }
            addRecord(records, recordKeys, std::move(*blob));
        }
        if (resolvedAssetIds != assetIds) {
            return std::unexpected(
                core::error("session_package_asset_missing",
                            "A session reference points to asset metadata that is not available."));
        }

        const auto includeSettings = [&](std::string_view id,
                                         std::string_view label) -> core::Status {
            if (id.empty())
                return {};
            const auto uuid = archive::uuidFromString(id);
            if (!uuid) {
                return std::unexpected(
                    core::error("session_package_reference_invalid",
                                std::string(label) + " has an invalid identifier."));
            }
            auto record = source.get(RecordType::Settings, *uuid);
            if (!record)
                return std::unexpected(record.error());
            if (!*record || domain::isDeleted(**record)) {
                return std::unexpected(
                    core::error("session_package_reference_invalid",
                                std::string(label) + " is missing from the selected archive."));
            }
            addRecord(records, recordKeys, std::move(**record));
            return {};
        };

        if (auto status = includeSettings(sessionEntryId, "Session journal entry"); !status)
            return std::unexpected(status.error());
        if (auto status = includeSettings(sessionDocumentId, "Session notes document"); !status)
            return std::unexpected(status.error());
        for (const Record& record : records) {
            if (record.type != RecordType::Guide)
                continue;
            if (auto status =
                    includeSettings(domain::getField(record, "entry_id"), "Guide journal entry");
                !status) {
                return std::unexpected(status.error());
            }
        }
        std::vector<std::string> entryDocuments;
        for (const Record& record : records) {
            if (record.type == RecordType::Settings &&
                domain::getField(record, "record_role") == "journal-entry") {
                entryDocuments.push_back(domain::getField(record, "notes_document_id"));
            }
        }
        for (const std::string& documentId : entryDocuments) {
            if (auto status = includeSettings(documentId, "Journal notes document"); !status)
                return std::unexpected(status.error());
        }

        std::vector<Record> complete = std::move(records);
        if (auto status = validateSessionRecords(complete, archive::uuidToString(sessionId));
            !status) {
            return std::unexpected(status.error());
        }
        for (Record& record : complete) {
            record.revision = 0;
            record.previousOffset = 0;
            if (record.type == RecordType::Session)
                record.fields["student_id"] = "anonymous";
        }
        return complete;
    }

    std::string trim(std::string_view value) {
        const auto first = value.find_first_not_of(" \t\r\n");
        if (first == std::string_view::npos)
            return {};
        const auto last = value.find_last_not_of(" \t\r\n");
        return std::string(value.substr(first, last - first + 1));
    }

    void remapReference(std::string& value, const std::map<std::string, std::string>& ids) {
        const std::string normalized = trim(value);
        if (const auto found = ids.find(normalized); found != ids.end()) {
            value = found->second;
            return;
        }

        std::string remapped;
        std::size_t start = 0;
        bool changed = false;
        bool first = true;
        while (start <= value.size()) {
            const auto end = value.find(',', start);
            const auto itemEnd = end == std::string::npos ? value.size() : end;
            const std::string item = trim(std::string_view(value).substr(start, itemEnd - start));
            const auto found = ids.find(item);
            std::string replacement;
            if (found != ids.end()) {
                changed = true;
                replacement = found->second;
            } else {
                replacement = std::string(std::string_view(value).substr(start, itemEnd - start));
            }
            if (!replacement.empty()) {
                if (!first)
                    remapped.push_back(',');
                remapped += replacement;
                first = false;
            }
            if (end == std::string::npos)
                break;
            start = end + 1;
        }
        if (changed)
            value = std::move(remapped);
    }

    core::Result<std::vector<Record>> readPackageRecords(const Archive& package) {
        auto manifest = package.get(RecordType::Settings, package.header().id);
        if (!manifest)
            return std::unexpected(manifest.error());
        if (!*manifest ||
            domain::getField(**manifest, "record_role") != "tutorux-session-package" ||
            domain::getField(**manifest, "package_version") != "1") {
            return std::unexpected(
                core::error("session_package_format_invalid",
                            "Input archive is not a Tutorux session transfer package."));
        }

        std::vector<Record> records;
        std::size_t sessionCount = 0;
        std::size_t currentSessionCount = 0;
        auto students = package.list(RecordType::Student, true);
        if (!students)
            return std::unexpected(students.error());
        auto settings = package.list(RecordType::Settings, true);
        if (!settings)
            return std::unexpected(settings.error());
        if (!students->empty()) {
            return std::unexpected(
                core::error("session_package_records_invalid",
                            "Session packages cannot contain student profiles."));
        }
        constexpr std::array supportedTypes{RecordType::Session,
                                            RecordType::AudioChunk,
                                            RecordType::TranscriptSegment,
                                            RecordType::Annotation,
                                            RecordType::AssetMetadata,
                                            RecordType::AssetBlob,
                                            RecordType::EvidenceNode,
                                            RecordType::EvidenceEdge,
                                            RecordType::Guide,
                                            RecordType::AiJob};
        for (Record& record : *settings) {
            if (record.id == package.header().id)
                continue;
            const std::string role = domain::getField(record, "record_role");
            if (role != "journal-entry" && role != "journal-notes") {
                return std::unexpected(
                    core::error("session_package_records_invalid",
                                "Session packages cannot contain unrelated settings."));
            }
            records.push_back(std::move(record));
        }
        for (const RecordType type : supportedTypes) {
            auto listed = package.list(type, true);
            if (!listed)
                return std::unexpected(listed.error());
            if (type == RecordType::Session) {
                currentSessionCount = listed->size();
                sessionCount = static_cast<std::size_t>(
                    std::count_if(listed->begin(), listed->end(), [](const Record& record) {
                        return !domain::isDeleted(record);
                    }));
            }
            for (Record& record : *listed)
                records.push_back(std::move(record));
        }
        if (sessionCount != 1 || currentSessionCount != 1) {
            return std::unexpected(
                core::error("session_package_session_count_invalid",
                            "A session transfer package must contain exactly one active session."));
        }
        const auto session = std::find_if(records.begin(), records.end(), [](const Record& item) {
            return item.type == RecordType::Session && !domain::isDeleted(item);
        });
        if (session == records.end())
            return std::unexpected(core::error("session_package_session_missing",
                                               "The package session record is missing."));
        const std::string sessionId = archive::uuidToString(session->id);
        for (const Record& record : records) {
            const std::string relatedSession = domain::getField(record, "session_id");
            if (!relatedSession.empty() && record.type != RecordType::AssetMetadata &&
                relatedSession != sessionId) {
                return std::unexpected(
                    core::error("session_package_foreign_record",
                                "Package contains a record associated with another session."));
            }
        }
        auto complete = includeRecordHistory(package, std::move(records));
        if (!complete)
            return std::unexpected(complete.error());
        if (auto status = validateSessionRecords(*complete, sessionId); !status)
            return std::unexpected(status.error());
        return complete;
    }

    core::Status publishArchive(const std::filesystem::path& temporary,
                                const std::filesystem::path& destination,
                                bool replaceExisting) {
        std::error_code errorCode;
        const bool exists = std::filesystem::exists(destination, errorCode);
        if (errorCode)
            return std::unexpected(
                core::error("session_package_publish_failed", errorCode.message()));
        if (exists && !replaceExisting) {
            return std::unexpected(
                core::error("session_package_output_exists",
                            "Output already exists; pass --force to replace the existing file."));
        }
#ifdef _WIN32
        const DWORD flags =
            MOVEFILE_WRITE_THROUGH | (replaceExisting ? MOVEFILE_REPLACE_EXISTING : 0U);
        if (!MoveFileExW(temporary.c_str(), destination.c_str(), flags)) {
            return std::unexpected(
                core::error("session_package_publish_failed",
                            "Unable to publish the session package (Windows error " +
                                std::to_string(GetLastError()) + ")."));
        }
#else
        std::filesystem::rename(temporary, destination, errorCode);
        if (errorCode)
            return std::unexpected(
                core::error("session_package_publish_failed", errorCode.message()));
#endif
        return {};
    }

} // namespace

core::Status exportSessionPackage(const Archive& source,
                                  const Uuid& sessionId,
                                  const std::filesystem::path& destination,
                                  bool replaceExisting) {
    if (destination.extension() != ".tux") {
        return std::unexpected(
            core::error("session_package_extension_invalid",
                        "Session transfer packages use the portable .tux archive format."));
    }
    std::error_code errorCode;
    if (std::filesystem::equivalent(source.path(), destination, errorCode) && !errorCode) {
        return std::unexpected(core::error("session_package_path_conflict",
                                           "A session package cannot replace the source archive."));
    }
    const auto parent =
        destination.has_parent_path() ? destination.parent_path() : std::filesystem::current_path();
    if (!std::filesystem::is_directory(parent, errorCode) || errorCode) {
        return std::unexpected(core::error("session_package_directory_invalid",
                                           "The output directory must already exist."));
    }

    auto sourceSession = source.get(RecordType::Session, sessionId);
    if (!sourceSession)
        return std::unexpected(sourceSession.error());
    if (!*sourceSession || domain::isDeleted(**sourceSession)) {
        return std::unexpected(
            core::error("session_package_session_missing",
                        "The selected session is missing from the source archive."));
    }
    const std::string sourceStudentId = domain::getField(**sourceSession, "student_id");

    auto records = collectSessionRecords(source, sessionId);
    if (!records)
        return std::unexpected(records.error());
    TemporaryFile temporary(parent /
                            (destination.stem().string() + "." +
                             archive::uuidToString(archive::randomUuid()) + ".partial.tux"));
    {
        auto package = Archive::create(temporary.path(),
                                       "Tutorux session transfer",
                                       "Portable transfer package for session " +
                                           archive::uuidToString(sessionId));
        if (!package)
            return std::unexpected(package.error());
        auto manifest = package->get(RecordType::Settings, package->header().id);
        if (!manifest)
            return std::unexpected(manifest.error());
        if (!*manifest)
            return std::unexpected(core::error("session_package_manifest_missing",
                                               "The new package archive is missing its manifest."));
        (*manifest)->fields["record_role"] = "tutorux-session-package";
        (*manifest)->fields["package_version"] = "1";
        (*manifest)->fields["source_session_id"] = archive::uuidToString(sessionId);
        if (!sourceStudentId.empty() && sourceStudentId != "anonymous")
            (*manifest)->fields["source_student_id"] = sourceStudentId;
        if (auto status = package->put(std::move(**manifest)); !status)
            return status;
        if (auto status = package->putMany(std::move(*records)); !status)
            return status;
        auto verification = package->verify(true);
        if (!verification)
            return std::unexpected(verification.error());
        if (!verification->valid) {
            std::string message =
                "The generated session package failed integrity verification.";
            if (!verification->issues.empty())
                message += " " + verification->issues.front();
            return std::unexpected(
                core::error("session_package_verify_failed", std::move(message)));
        }
    }

    if (auto status = publishArchive(temporary.path(), destination, replaceExisting); !status)
        return status;
    temporary.keep();
    return {};
}

core::Result<Uuid> importSessionPackage(Archive& destination,
                                        const std::filesystem::path& source,
                                        std::optional<Uuid> studentId) {
    auto package = Archive::open(source, false);
    if (!package)
        return std::unexpected(package.error());
    auto verification = package->verify(true);
    if (!verification)
        return std::unexpected(verification.error());
    if (!verification->valid) {
        return std::unexpected(
            core::error("session_package_verify_failed",
                        "The input session package failed integrity verification."));
    }
    auto records = readPackageRecords(*package);
    if (!records)
        return std::unexpected(records.error());

    auto sessionRecord = records->end();
    for (auto record = records->begin(); record != records->end(); ++record) {
        if (record->type == RecordType::Session &&
            (sessionRecord == records->end() || record->revision > sessionRecord->revision)) {
            sessionRecord = record;
        }
    }
    if (sessionRecord == records->end()) {
        return std::unexpected(core::error("session_package_session_missing",
                                           "The session package has no session record."));
    }
    const Uuid sourceSessionId = sessionRecord->id;
    const std::uint64_t latestSessionRevision = sessionRecord->revision;
    auto manifest = package->get(RecordType::Settings, package->header().id);
    if (!manifest || !*manifest ||
        domain::getField(**manifest, "source_session_id") !=
            archive::uuidToString(sourceSessionId)) {
        return std::unexpected(
            core::error("session_package_manifest_invalid",
                        "The package manifest does not match its contained session."));
    }

    std::optional<std::string> mappedStudent;
    if (studentId) {
        auto student = destination.get(RecordType::Student, *studentId);
        if (!student)
            return std::unexpected(student.error());
        if (!*student || domain::isDeleted(**student)) {
            return std::unexpected(core::error("session_package_student_missing",
                                               "The selected destination student does not exist."));
        }
        mappedStudent = archive::uuidToString(*studentId);
    } else {
        std::string sourceStudent = domain::getField(*sessionRecord, "student_id");
        auto packageManifest = package->get(RecordType::Settings, package->header().id);
        if (!packageManifest)
            return std::unexpected(packageManifest.error());
        if (*packageManifest) {
            const std::string recordedStudent =
                domain::getField(**packageManifest, "source_student_id");
            if (!recordedStudent.empty())
                sourceStudent = recordedStudent;
        }
        auto parsedStudent = archive::uuidFromString(sourceStudent);
        if (parsedStudent) {
            auto existing = destination.get(RecordType::Student, *parsedStudent);
            if (!existing)
                return std::unexpected(existing.error());
            if (*existing && !domain::isDeleted(**existing))
                mappedStudent = sourceStudent;
        }
    }

    std::set<std::string> sourceStudentIds;
    for (const Record& record : *records) {
        if (record.type != RecordType::Session)
            continue;
        const auto historicalStudentId = domain::getField(record, "student_id");
        if (!historicalStudentId.empty() && historicalStudentId != "anonymous")
            sourceStudentIds.insert(historicalStudentId);
    }

    std::map<std::string, std::string> idMap;
    std::map<std::string, RecordType> idTypes;
    for (const Record& record : *records) {
        const std::string recordId = archive::uuidToString(record.id);
        const auto [typePosition, typeInserted] = idTypes.emplace(recordId, record.type);
        if (!typeInserted && typePosition->second != record.type) {
            return std::unexpected(
                core::error("session_package_duplicate_id",
                            "The package reuses a record UUID across different record types."));
        }
        if (typeInserted)
            idMap.emplace(recordId, archive::uuidToString(archive::randomUuid()));
    }
    std::set<std::string> generatedIds;
    for (const auto& [oldId, newId] : idMap) {
        static_cast<void>(oldId);
        if (!generatedIds.insert(newId).second) {
            return std::unexpected(
                core::error("session_package_id_collision",
                            "Unable to assign unique identifiers to imported records."));
        }
    }
    for (const std::string& historicalStudentId : sourceStudentIds) {
        if (idMap.contains(historicalStudentId)) {
            return std::unexpected(
                core::error("session_package_duplicate_id",
                            "A source student UUID conflicts with a session package record UUID."));
        }
        if (mappedStudent && generatedIds.contains(*mappedStudent)) {
            return std::unexpected(core::error(
                "session_package_id_collision",
                "The destination student UUID conflicts with an imported record UUID."));
        }
        idMap.emplace(historicalStudentId, mappedStudent.value_or(""));
    }

    for (Record& record : *records) {
        const std::string oldId = archive::uuidToString(record.id);
        const bool isLatestSession =
            record.type == RecordType::Session && record.revision == latestSessionRevision;
        record.id = *archive::uuidFromString(idMap.at(oldId));
        record.revision = 0;
        record.previousOffset = 0;
        for (auto& [field, value] : record.fields) {
            if (field == "session_id" && record.type == RecordType::AssetMetadata) {
                value = idMap.at(archive::uuidToString(sourceSessionId));
            } else if (field == "student_id" && record.type == RecordType::Session) {
                value = mappedStudent.value_or("anonymous");
            } else if (field == "student_id" && sourceStudentIds.contains(value)) {
                value = mappedStudent.value_or("anonymous");
            } else if (field.ends_with("_id") || field.ends_with("_ids")) {
                remapReference(value, idMap);
            }
            if (field == "session_id" && value == archive::uuidToString(sourceSessionId))
                value = idMap.at(archive::uuidToString(sourceSessionId));
        }
        if (record.type == RecordType::Session) {
            if (isLatestSession) {
                record.fields["imported_at_us"] = std::to_string(nowUnixMicroseconds());
                record.fields.erase("_deleted");
            }
        }
    }
    const Uuid importedSessionId =
        *archive::uuidFromString(idMap.at(archive::uuidToString(sourceSessionId)));
    if (auto status = destination.putMany(std::move(*records)); !status)
        return std::unexpected(status.error());
    return importedSessionId;
}

} // namespace tutorux::command

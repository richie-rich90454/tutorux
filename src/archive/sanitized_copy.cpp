#include "tutorux/archive/sanitized_copy.hpp"

#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/guide.hpp"
#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <cerrno>
#include <cctype>
#include <cstring>
#include <map>
#include <optional>
#include <set>
#include <string_view>

#ifdef _WIN32
#include <Windows.h>
#else
#include <fcntl.h>
#include <unistd.h>
#endif

namespace tutorux::archive {
namespace {

    using core::Result;
    using core::Status;
    using RecordSet = std::set<Uuid>;
    using RecordMap = std::map<RecordType, std::vector<Record>>;

    constexpr std::array kCopyTypes{
        RecordType::Student,       RecordType::Session,   RecordType::AudioChunk,   RecordType::TranscriptSegment, RecordType::Annotation,
        RecordType::AssetMetadata, RecordType::AssetBlob, RecordType::EvidenceNode, RecordType::EvidenceEdge,      RecordType::Guide,
        RecordType::Settings,      RecordType::AiJob,     RecordType::WaveformIndex};

    std::string lower(std::string_view value) {
        std::string result(value);
        std::transform(result.begin(), result.end(), result.begin(), [](unsigned char character) {
            return static_cast<char>(std::tolower(character));
        });
        return result;
    }

    std::vector<std::string> splitIds(std::string_view value) {
        std::vector<std::string> result;
        std::size_t start = 0;
        while (start < value.size()) {
            const std::size_t comma = value.find(',', start);
            const std::size_t end = comma == std::string_view::npos ? value.size() : comma;
            if (end > start)
                result.emplace_back(value.substr(start, end - start));
            if (comma == std::string_view::npos)
                break;
            start = comma + 1U;
        }
        return result;
    }

    std::string joinIds(const std::vector<std::string>& values) {
        std::string result;
        for (const auto& value : values) {
            if (!result.empty())
                result.push_back(',');
            result += value;
        }
        return result;
    }

    bool contains(const RecordSet& values, std::string_view id) {
        auto parsed = uuidFromString(id);
        return parsed && values.contains(*parsed);
    }

    bool privateAnnotation(const Record& record) {
        for (const auto& [field, rawValue] : record.fields) {
            const std::string fieldName = lower(field);
            if (fieldName.find("private") == std::string::npos && fieldName.find("privacy") == std::string::npos &&
                fieldName.find("visibility") == std::string::npos)
                continue;
            const std::string value = lower(rawValue);
            if (value == "true" || value == "yes" || value == "1" || value == "private" || value == "restricted")
                return true;
        }
        return false;
    }

    bool recordingAsset(const Record& record) {
        const std::string role = lower(domain::getField(record, "record_role"));
        const std::string mime = lower(domain::getField(record, "mime_type"));
        return role.find("audio") != std::string::npos || role.find("waveform") != std::string::npos ||
               role.find("seek-index") != std::string::npos || !domain::getField(record, "capture_source").empty() ||
               mime.starts_with("audio/");
    }

    bool isCredential(const Record& record) {
        return isCredentialSettingsRecord(record);
    }

    bool sensitiveField(std::string_view name) {
        std::string normalized;
        normalized.reserve(name.size());
        for (const unsigned char character : name) {
            if (character >= 'A' && character <= 'Z')
                normalized.push_back(static_cast<char>(character - 'A' + 'a'));
            else if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9'))
                normalized.push_back(static_cast<char>(character));
        }
        constexpr std::array<std::string_view, 12> markers{"password",   "passwd",  "passphrase",    "secret",
                                                           "credential", "apikey",  "authorization", "privatekey",
                                                           "accesskey",  "authkey", "bearertoken",   "refreshtoken"};
        if (std::any_of(markers.begin(), markers.end(), [&](std::string_view marker) {
                return normalized.find(marker) != std::string::npos;
            }))
            return true;
        if (normalized.find("token") == std::string::npos)
            return false;
        constexpr std::array<std::string_view, 8> nonSecretTokenSettings{"tokenbudget", "tokensbudget", "tokencount", "tokenscount",
                                                                         "tokenlimit",  "tokenslimit",  "tokenusage", "tokensusage"};
        return std::none_of(nonSecretTokenSettings.begin(), nonSecretTokenSettings.end(), [&](std::string_view suffix) {
            return normalized.ends_with(suffix);
        });
    }

    bool selectedBy(const Uuid& id, const std::set<Uuid>& include, const std::set<Uuid>& exclude) {
        return (include.empty() || include.contains(id)) && !exclude.contains(id);
    }

    bool recordingsRequested(const SanitizedCopyOptions& options) {
        return options.includeRecordings || !options.includeRecordingTracks.empty() || !options.excludeRecordingTracks.empty();
    }

    std::string selectionFingerprint(const Archive& source, const SanitizedCopyOptions& options) {
        std::string canonical = "archive=" + uuidToString(source.header().id) + ";recordings=" + std::to_string(options.includeRecordings) +
                                ";private=" + std::to_string(options.includePrivateAnnotations) +
                                ";generation=" + std::to_string(options.includeGenerationLogs) +
                                ";credentials=" + std::to_string(options.includeCredentials);
        const auto appendIds = [&](std::string_view name, const RecordSet& ids) {
            canonical += ";";
            canonical += name;
            canonical += "=";
            for (const auto& id : ids) {
                canonical += uuidToString(id);
                canonical += ",";
            }
        };
        appendIds("include-students", options.includeStudents);
        appendIds("exclude-students", options.excludeStudents);
        appendIds("include-sessions", options.includeSessions);
        appendIds("exclude-sessions", options.excludeSessions);
        appendIds("include-recording-tracks", options.includeRecordingTracks);
        appendIds("exclude-recording-tracks", options.excludeRecordingTracks);
        return domain::hexHash(std::as_bytes(std::span(canonical.data(), canonical.size())));
    }

    Status readMetadata(const Archive& source, RecordMap& records) {
        for (const RecordType type : kCopyTypes) {
            if (type == RecordType::AudioChunk || type == RecordType::AssetBlob)
                continue;
            if (auto status = source.forEach(type,
                                             [&](Record&& record) {
                                                 record.blob = Bytes{};
                                                 records[type].push_back(std::move(record));
                                                 return true;
                                             });
                !status)
                return status;
        }
        return {};
    }

    struct CopyPlan final {
        RecordMap metadata;
        std::map<RecordType, RecordSet> keep;
        std::map<Uuid, RecordSet> sourceRecordingTracksBySession;
        std::map<Uuid, RecordSet> recordingTracksBySession;
        std::map<Uuid, std::uint64_t> recordingChunksBySession;
        SanitizedCopySummary summary;
    };

    RecordSet& keep(CopyPlan& plan, RecordType type) {
        return plan.keep[type];
    }

    const RecordSet& kept(const CopyPlan& plan, RecordType type) {
        static const RecordSet empty;
        const auto found = plan.keep.find(type);
        return found == plan.keep.end() ? empty : found->second;
    }

    bool sessionIsKept(const CopyPlan& plan, const Record& record) {
        const std::string session = domain::getField(record, "session_id");
        if (session.empty())
            return true;
        return contains(kept(plan, RecordType::Session), session);
    }

    bool hasKeptSession(const CopyPlan& plan, const Record& record) {
        const std::string session = domain::getField(record, "session_id");
        return !session.empty() && contains(kept(plan, RecordType::Session), session);
    }

    Result<CopyPlan> makePlan(const Archive& source, const SanitizedCopyOptions& options) {
        CopyPlan plan;
        plan.summary.sourceGeneration = source.commitInfo().generation;
        plan.summary.selectionFingerprint = selectionFingerprint(source, options);
        if (auto status = readMetadata(source, plan.metadata); !status)
            return std::unexpected(status.error());

        RecordSet availableStudents;
        RecordSet availableSessions;
        for (const auto& record : plan.metadata[RecordType::Student])
            if (!domain::isDeleted(record))
                availableStudents.insert(record.id);
        for (const auto& record : plan.metadata[RecordType::Session])
            if (!domain::isDeleted(record))
                availableSessions.insert(record.id);
        for (const auto& id : options.includeStudents) {
            if (!availableStudents.contains(id))
                return std::unexpected(
                    core::error("sanitized_copy_student_missing", "A selected student does not exist in the source archive."));
        }
        for (const auto& id : options.includeSessions) {
            if (!availableSessions.contains(id))
                return std::unexpected(
                    core::error("sanitized_copy_session_missing", "A selected session does not exist in the source archive."));
        }
        for (const auto& id : options.excludeStudents) {
            if (!availableStudents.contains(id))
                return std::unexpected(
                    core::error("sanitized_copy_student_missing", "An excluded student does not exist in the source archive."));
        }
        for (const auto& id : options.excludeSessions) {
            if (!availableSessions.contains(id))
                return std::unexpected(
                    core::error("sanitized_copy_session_missing", "An excluded session does not exist in the source archive."));
        }

        for (const auto& record : plan.metadata[RecordType::Student]) {
            if (!domain::isDeleted(record) && selectedBy(record.id, options.includeStudents, options.excludeStudents))
                keep(plan, RecordType::Student).insert(record.id);
        }
        for (const auto& record : plan.metadata[RecordType::Session]) {
            if (domain::isDeleted(record) || !selectedBy(record.id, options.includeSessions, options.excludeSessions))
                continue;
            const std::string student = domain::getField(record, "student_id");
            auto studentId = uuidFromString(student);
            if (studentId && availableStudents.contains(*studentId) && !kept(plan, RecordType::Student).contains(*studentId))
                continue;
            if (!options.includeStudents.empty() && (!studentId || !kept(plan, RecordType::Student).contains(*studentId)))
                continue;
            keep(plan, RecordType::Session).insert(record.id);
        }

        const bool scoped = !options.includeStudents.empty() || !options.excludeStudents.empty() || !options.includeSessions.empty() ||
                            !options.excludeSessions.empty();

        RecordSet availableRecordingTracks;
        if (recordingsRequested(options)) {
            std::optional<core::Error> invalidChunk;
            auto status = source.forEach(RecordType::AudioChunk, [&](Record&& record) {
                if (domain::isDeleted(record))
                    return true;
                const auto track = uuidFromString(domain::getField(record, "track_id"));
                const auto session = uuidFromString(domain::getField(record, "session_id"));
                if (!track || !session) {
                    invalidChunk =
                        core::error("sanitized_copy_audio_chunk_invalid", "A recording chunk has an invalid session or track reference.");
                    return false;
                }
                if (!sessionIsKept(plan, record))
                    return true;
                availableRecordingTracks.insert(*track);
                plan.sourceRecordingTracksBySession[*session].insert(*track);
                if (selectedBy(*track, options.includeRecordingTracks, options.excludeRecordingTracks)) {
                    keep(plan, RecordType::AudioChunk).insert(record.id);
                    ++plan.recordingChunksBySession[*session];
                    plan.recordingTracksBySession[*session].insert(*track);
                }
                return true;
            });
            if (!status)
                return std::unexpected(status.error());
            if (invalidChunk)
                return std::unexpected(*invalidChunk);
            for (const auto& id : options.includeRecordingTracks) {
                if (!availableRecordingTracks.contains(id))
                    return std::unexpected(core::error("sanitized_copy_recording_track_missing",
                                                       "A selected recording track does not exist in the source archive."));
            }
            for (const auto& id : options.excludeRecordingTracks) {
                if (!availableRecordingTracks.contains(id))
                    return std::unexpected(core::error("sanitized_copy_recording_track_missing",
                                                       "An excluded recording track does not exist in the source archive."));
            }
        }

        for (const auto& record : plan.metadata[RecordType::Annotation]) {
            if (!domain::isDeleted(record) && sessionIsKept(plan, record) && (!scoped || hasKeptSession(plan, record)) &&
                (options.includePrivateAnnotations || !privateAnnotation(record)))
                keep(plan, RecordType::Annotation).insert(record.id);
        }
        for (const auto& record : plan.metadata[RecordType::TranscriptSegment]) {
            if (!domain::isDeleted(record) && sessionIsKept(plan, record) && (!scoped || hasKeptSession(plan, record)))
                keep(plan, RecordType::TranscriptSegment).insert(record.id);
        }

        RecordSet requestedAssets;
        for (const auto type : {RecordType::Annotation, RecordType::TranscriptSegment}) {
            for (const auto& record : plan.metadata[type]) {
                if (!kept(plan, type).contains(record.id))
                    continue;
                for (const auto& id : splitIds(domain::getField(record, "linked_asset_ids"))) {
                    auto parsed = uuidFromString(id);
                    if (parsed)
                        requestedAssets.insert(*parsed);
                }
            }
        }
        for (const auto& record : plan.metadata[RecordType::Settings]) {
            if (domain::isDeleted(record) || lower(domain::getField(record, "record_role")) != "journal-entry")
                continue;
            const auto sessions = splitIds(domain::getField(record, "session_ids"));
            const bool inScope = !scoped || (!sessions.empty() && std::any_of(sessions.begin(), sessions.end(), [&](const auto& id) {
                return contains(kept(plan, RecordType::Session), id);
            }));
            if (!inScope)
                continue;
            keep(plan, RecordType::Settings).insert(record.id);
            for (const auto& id : splitIds(domain::getField(record, "attachment_ids"))) {
                auto parsed = uuidFromString(id);
                if (parsed)
                    requestedAssets.insert(*parsed);
            }
        }
        RecordSet retainedNotes;
        for (const auto& record : plan.metadata[RecordType::Session]) {
            if (!kept(plan, RecordType::Session).contains(record.id))
                continue;
            auto notes = uuidFromString(domain::getField(record, "notes_document_id"));
            if (notes)
                retainedNotes.insert(*notes);
        }
        for (const auto& record : plan.metadata[RecordType::Settings]) {
            if (!kept(plan, RecordType::Settings).contains(record.id) || lower(domain::getField(record, "record_role")) != "journal-entry")
                continue;
            auto notes = uuidFromString(domain::getField(record, "notes_document_id"));
            if (notes)
                retainedNotes.insert(*notes);
        }
        for (const auto& record : plan.metadata[RecordType::Guide]) {
            if (domain::isDeleted(record))
                continue;
            auto guide = domain::guideFromRecord(record);
            if (!guide)
                continue;
            const std::string entryId = domain::getField(record, "entry_id");
            if (scoped && (guide->sessionId.empty() && (entryId.empty() || !contains(kept(plan, RecordType::Settings), entryId))))
                continue;
            if (!guide->sessionId.empty() && !contains(kept(plan, RecordType::Session), guide->sessionId))
                continue;
            for (const auto& section : guide->sections) {
                for (const auto& block : section.blocks) {
                    if (block.kind == "image") {
                        auto image = domain::parseGuideImageReference(block.text);
                        if (image) {
                            auto parsed = uuidFromString(image->assetId);
                            if (parsed)
                                requestedAssets.insert(*parsed);
                        }
                    }
                }
            }
        }
        for (const auto& record : plan.metadata[RecordType::AssetMetadata]) {
            if (domain::isDeleted(record) || !sessionIsKept(plan, record))
                continue;
            if (recordingAsset(record)) {
                if (!recordingsRequested(options))
                    continue;
                if (lower(domain::getField(record, "record_role")) == "audio-track") {
                    const auto session = uuidFromString(domain::getField(record, "session_id"));
                    const auto track = uuidFromString(domain::getField(record, "track_id"));
                    const auto tracks = session ? plan.recordingTracksBySession.find(*session) : plan.recordingTracksBySession.end();
                    if (!session || !track || tracks == plan.recordingTracksBySession.end() || !tracks->second.contains(*track))
                        continue;
                } else {
                    const auto trackText = domain::getField(record, "track_id");
                    const auto session = uuidFromString(domain::getField(record, "session_id"));
                    const auto track = uuidFromString(trackText);
                    if (session && track) {
                        const auto tracks = plan.recordingTracksBySession.find(*session);
                        if (tracks == plan.recordingTracksBySession.end() || !tracks->second.contains(*track))
                            continue;
                    }
                }
            }
            const std::string student = domain::getField(record, "student_id");
            auto studentId = uuidFromString(student);
            if (studentId && availableStudents.contains(*studentId) && !kept(plan, RecordType::Student).contains(*studentId))
                continue;
            const bool associatedStudent = studentId && kept(plan, RecordType::Student).contains(*studentId);
            if (scoped && domain::getField(record, "session_id").empty() && !associatedStudent && !requestedAssets.contains(record.id))
                continue;
            keep(plan, RecordType::AssetMetadata).insert(record.id);
        }

        RecordSet availableAssetIds = kept(plan, RecordType::AssetMetadata);
        for (const auto& record : plan.metadata[RecordType::EvidenceNode]) {
            if (domain::isDeleted(record) || !sessionIsKept(plan, record))
                continue;
            auto studentId = uuidFromString(domain::getField(record, "student_id"));
            if (studentId && availableStudents.contains(*studentId) && !kept(plan, RecordType::Student).contains(*studentId))
                continue;
            if (scoped && domain::getField(record, "session_id").empty()) {
                if (!studentId || !kept(plan, RecordType::Student).contains(*studentId))
                    continue;
            }
            const std::string sourceAnnotation = domain::getField(record, "source_annotation_id");
            if (!sourceAnnotation.empty() && !contains(kept(plan, RecordType::Annotation), sourceAnnotation))
                continue;
            bool refsValid = true;
            for (const auto& id : splitIds(domain::getField(record, "source_segment_ids")))
                refsValid = refsValid && contains(kept(plan, RecordType::TranscriptSegment), id);
            for (const auto& id : splitIds(domain::getField(record, "source_asset_ids")))
                refsValid = refsValid && contains(availableAssetIds, id);
            if (refsValid)
                keep(plan, RecordType::EvidenceNode).insert(record.id);
        }
        for (const auto& record : plan.metadata[RecordType::EvidenceEdge]) {
            if (!domain::isDeleted(record) && sessionIsKept(plan, record) && (!scoped || hasKeptSession(plan, record)) &&
                contains(kept(plan, RecordType::EvidenceNode), domain::getField(record, "from_id")) &&
                contains(kept(plan, RecordType::EvidenceNode), domain::getField(record, "to_id")))
                keep(plan, RecordType::EvidenceEdge).insert(record.id);
        }

        for (const auto& record : plan.metadata[RecordType::Guide]) {
            if (domain::isDeleted(record) || !sessionIsKept(plan, record))
                continue;
            auto guide = domain::guideFromRecord(record);
            if (!guide)
                continue;
            const std::string entryId = domain::getField(record, "entry_id");
            if (scoped && guide->sessionId.empty() && (entryId.empty() || !contains(kept(plan, RecordType::Settings), entryId)))
                continue;
            bool refsValid = true;
            for (const auto& section : guide->sections) {
                for (const auto& block : section.blocks) {
                    for (const auto& id : block.sourceIds) {
                        const bool found = contains(kept(plan, RecordType::EvidenceNode), id) ||
                                           contains(kept(plan, RecordType::Annotation), id) ||
                                           contains(kept(plan, RecordType::TranscriptSegment), id) || contains(availableAssetIds, id);
                        refsValid = refsValid && found;
                    }
                    auto inlineSources = domain::guideInlineSourceIds(block.text);
                    if (!inlineSources)
                        refsValid = false;
                    else {
                        for (const auto& id : *inlineSources) {
                            const bool found = contains(kept(plan, RecordType::EvidenceNode), id) ||
                                               contains(kept(plan, RecordType::Annotation), id) ||
                                               contains(kept(plan, RecordType::TranscriptSegment), id) || contains(availableAssetIds, id);
                            refsValid = refsValid && found;
                        }
                    }
                    if (block.kind == "image") {
                        auto image = domain::parseGuideImageReference(block.text);
                        refsValid = refsValid && image && contains(availableAssetIds, image->assetId);
                    }
                }
            }
            if (!guide->sessionId.empty())
                refsValid = refsValid && contains(kept(plan, RecordType::Session), guide->sessionId);
            if (refsValid)
                keep(plan, RecordType::Guide).insert(record.id);
        }

        for (const auto& record : plan.metadata[RecordType::Settings]) {
            if (domain::isDeleted(record))
                continue;
            const std::string role = lower(domain::getField(record, "record_role"));
            if (role == "archive-manifest" || record.id == source.header().id)
                continue;
            if (isCredential(record) && !options.includeCredentials)
                continue;
            if (hasSensitiveCredentialMaterial(record) && !isCredential(record)) {
                if (options.includeCredentials) {
                    return std::unexpected(core::error("sanitized_copy_plaintext_credential",
                                                       "A credential-looking value is not stored as an encrypted credential and "
                                                       "cannot be copied. "
                                                       "Move it into an encrypted credential record first."));
                }
                continue;
            }
            if (role == "journal-entry") {
                const auto sessions = splitIds(domain::getField(record, "session_ids"));
                if ((!options.includeSessions.empty() || !options.excludeSessions.empty() || !options.includeStudents.empty() ||
                     !options.excludeStudents.empty()) &&
                    sessions.empty())
                    continue;
                if (!sessions.empty() && std::none_of(sessions.begin(), sessions.end(), [&](const auto& id) {
                        return contains(kept(plan, RecordType::Session), id);
                    }))
                    continue;
            }
            if (role == "journal-notes") {
                const std::string session = domain::getField(record, "session_id");
                if (!session.empty() && !contains(kept(plan, RecordType::Session), session))
                    continue;
                if (scoped && !retainedNotes.contains(record.id))
                    continue;
            }
            keep(plan, RecordType::Settings).insert(record.id);
        }
        for (const auto& record : plan.metadata[RecordType::AiJob]) {
            if (!domain::isDeleted(record) && sessionIsKept(plan, record) && (!scoped || hasKeptSession(plan, record)) &&
                options.includeGenerationLogs)
                keep(plan, RecordType::AiJob).insert(record.id);
        }
        for (const auto& record : plan.metadata[RecordType::WaveformIndex]) {
            if (domain::isDeleted(record) || !recordingsRequested(options) || !sessionIsKept(plan, record) ||
                (scoped && !hasKeptSession(plan, record)))
                continue;
            const auto session = uuidFromString(domain::getField(record, "session_id"));
            const auto track = uuidFromString(domain::getField(record, "track_id"));
            if (!session || !track)
                continue;
            const auto tracks = plan.recordingTracksBySession.find(*session);
            if (tracks != plan.recordingTracksBySession.end() && tracks->second.contains(*track))
                keep(plan, RecordType::WaveformIndex).insert(record.id);
        }

        RecordSet referencedBlobs;
        for (const auto& record : plan.metadata[RecordType::AssetMetadata]) {
            if (!kept(plan, RecordType::AssetMetadata).contains(record.id))
                continue;
            const std::string blobText = domain::getField(record, "blob_id");
            if (blobText.empty())
                continue;
            auto blobId = uuidFromString(blobText);
            if (!blobId)
                return std::unexpected(
                    core::error("sanitized_copy_asset_blob_id_invalid", "A selected asset has an invalid blob reference."));
            referencedBlobs.insert(*blobId);
        }
        RecordSet referencedChunks;
        std::map<Uuid, Uuid> chunkOwners;
        for (const auto& blobId : referencedBlobs) {
            auto blob = source.get(RecordType::AssetBlob, blobId);
            if (!blob)
                return std::unexpected(blob.error());
            if (!*blob || domain::isDeleted(**blob))
                return std::unexpected(
                    core::error("sanitized_copy_asset_blob_missing", "A selected asset refers to a missing blob record."));
            const std::string role = domain::getField(**blob, "record_role");
            if (role == "asset-blob-chunk")
                return std::unexpected(
                    core::error("sanitized_copy_asset_blob_invalid", "An asset points directly to a chunk instead of a blob manifest."));
            if (role == "asset-blob-manifest") {
                for (const auto& id : splitIds(domain::getField(**blob, "chunk_ids"))) {
                    auto chunk = uuidFromString(id);
                    if (!chunk)
                        return std::unexpected(core::error("sanitized_copy_asset_manifest_invalid",
                                                           "A selected asset manifest contains an invalid chunk reference."));
                    referencedChunks.insert(*chunk);
                    const auto [owner, inserted] = chunkOwners.emplace(*chunk, blobId);
                    if (!inserted && owner->second != blobId)
                        return std::unexpected(
                            core::error("sanitized_copy_asset_chunk_shared", "A chunk is assigned to multiple asset manifests."));
                }
            }
            (**blob).blob = Bytes{};
        }
        for (const auto& chunkId : referencedChunks) {
            auto chunk = source.get(RecordType::AssetBlob, chunkId);
            if (!chunk)
                return std::unexpected(chunk.error());
            if (!*chunk || domain::isDeleted(**chunk))
                return std::unexpected(
                    core::error("sanitized_copy_asset_chunk_missing", "A selected asset manifest refers to a missing chunk record."));
            if (domain::getField(**chunk, "record_role") != "asset-blob-chunk" ||
                domain::getField(**chunk, "manifest_id") != uuidToString(chunkOwners.at(chunkId)))
                return std::unexpected(
                    core::error("sanitized_copy_asset_chunk_invalid", "An asset chunk does not match its selected manifest."));
            (**chunk).blob = Bytes{};
        }
        keep(plan, RecordType::AssetBlob) = referencedBlobs;
        keep(plan, RecordType::AssetBlob).insert(referencedChunks.begin(), referencedChunks.end());
        plan.summary.students = kept(plan, RecordType::Student).size();
        plan.summary.sessions = kept(plan, RecordType::Session).size();
        plan.summary.annotations = kept(plan, RecordType::Annotation).size();
        plan.summary.assets = kept(plan, RecordType::AssetMetadata).size();
        plan.summary.evidenceItems = kept(plan, RecordType::EvidenceNode).size();
        plan.summary.guides = kept(plan, RecordType::Guide).size();
        plan.summary.recordings = kept(plan, RecordType::AudioChunk).size();
        for (const auto& [session, tracks] : plan.recordingTracksBySession) {
            (void)session;
            plan.summary.recordingTracks += tracks.size();
        }
        plan.summary.generationLogs = kept(plan, RecordType::AiJob).size();
        plan.summary.credentials = 0;
        if (options.includeCredentials)
            plan.summary.credentials = std::count_if(
                plan.metadata[RecordType::Settings].begin(), plan.metadata[RecordType::Settings].end(), [&](const Record& record) {
                    return kept(plan, RecordType::Settings).contains(record.id) && isCredential(record);
                });
        return plan;
    }

    void pruneListField(Record& record, std::string_view field, const RecordSet& valid) {
        const auto ids = splitIds(domain::getField(record, field));
        std::vector<std::string> retained;
        for (const auto& id : ids)
            if (contains(valid, id))
                retained.push_back(id);
        if (record.fields.contains(field))
            record.fields[std::string(field)] = joinIds(retained);
    }

    void sanitizeRecord(Record& record, const CopyPlan& plan, const SanitizedCopyOptions& options, const Uuid& sourceManifestId) {
        record.revision = 1;
        record.previousOffset = 0;
        if (record.type == RecordType::Settings && record.id == sourceManifestId)
            return;
        if (record.type == RecordType::Session) {
            const auto tracks = plan.recordingTracksBySession.find(record.id);
            if (tracks == plan.recordingTracksBySession.end() || tracks->second.empty()) {
                record.fields["session_type"] = "notes-only";
                record.fields["recording_state"] = "not-started";
                for (auto field = record.fields.begin(); field != record.fields.end();) {
                    if (field->first.starts_with("recording_") || field->first.starts_with("audio_import_"))
                        field = record.fields.erase(field);
                    else
                        ++field;
                }
            } else {
                pruneListField(record, "recording_track_ids", tracks->second);
                const std::string primaryTrack = domain::getField(record, "recording_track_id");
                if (!primaryTrack.empty() && !contains(tracks->second, primaryTrack))
                    record.fields["recording_track_id"].clear();
                const std::string importedTrack = domain::getField(record, "audio_import_track_id");
                if (!importedTrack.empty() && !contains(tracks->second, importedTrack)) {
                    for (auto field = record.fields.begin(); field != record.fields.end();) {
                        if (field->first.starts_with("audio_import_"))
                            field = record.fields.erase(field);
                        else
                            ++field;
                    }
                }
                record.fields["recording_track_count"] = std::to_string(tracks->second.size());
                record.fields["recording_audio_chunks"] = std::to_string(plan.recordingChunksBySession.at(record.id));
                const auto sourceTracks = plan.sourceRecordingTracksBySession.find(record.id);
                if (sourceTracks != plan.sourceRecordingTracksBySession.end() && sourceTracks->second.size() > tracks->second.size()) {
                    for (const std::string_view field :
                         {"recording_source", "recording_device_id", "recording_durability", "recording_sample_format",
                          "recording_sample_rate_hz", "recording_channel_count", "recording_channel_mask", "recording_samples",
                          "recording_timeline_samples", "recording_bytes", "recording_discontinuities", "recording_duration_us"})
                        record.fields.erase(std::string(field));
                }
            }
        }
        if (record.type == RecordType::Session) {
            const std::string student = domain::getField(record, "student_id");
            auto studentId = uuidFromString(student);
            if (studentId && !contains(kept(plan, RecordType::Student), student))
                record.fields["student_id"] = "anonymous";
            for (const std::string_view field : {"entry_id", "notes_document_id"}) {
                const std::string id = domain::getField(record, field);
                if (!id.empty() && !contains(kept(plan, RecordType::Settings), id))
                    record.fields[std::string(field)].clear();
            }
        }
        if (record.type == RecordType::TranscriptSegment)
            pruneListField(record, "linked_asset_ids", kept(plan, RecordType::AssetMetadata));
        if (record.type == RecordType::Annotation) {
            pruneListField(record, "linked_asset_ids", kept(plan, RecordType::AssetMetadata));
            pruneListField(record, "linked_evidence_ids", kept(plan, RecordType::EvidenceNode));
        }
        if (record.type == RecordType::EvidenceNode) {
            pruneListField(record, "source_segment_ids", kept(plan, RecordType::TranscriptSegment));
            pruneListField(record, "source_asset_ids", kept(plan, RecordType::AssetMetadata));
        }
        if (record.type == RecordType::Settings) {
            const std::string role = lower(domain::getField(record, "record_role"));
            if (role == "journal-entry") {
                pruneListField(record, "session_ids", kept(plan, RecordType::Session));
                pruneListField(record, "study_guide_ids", kept(plan, RecordType::Guide));
                pruneListField(record, "attachment_ids", kept(plan, RecordType::AssetMetadata));
                const std::string notesId = domain::getField(record, "notes_document_id");
                if (!notesId.empty() && !contains(kept(plan, RecordType::Settings), notesId))
                    record.fields["notes_document_id"].clear();
            }
            if (!options.includeCredentials) {
                for (auto field = record.fields.begin(); field != record.fields.end();) {
                    if (sensitiveField(field->first))
                        field = record.fields.erase(field);
                    else
                        ++field;
                }
            }
        }
        if (record.type == RecordType::Guide) {
            record.fields.erase("source_index_history");
            record.fields.erase("stale_source_id");
            record.fields.erase("stale_source_ids");
            const std::string entry = domain::getField(record, "entry_id");
            if (!entry.empty() && !contains(kept(plan, RecordType::Settings), entry))
                record.fields["entry_id"].clear();
        }
    }

    Status publishNoReplace(const std::filesystem::path& temporary, const std::filesystem::path& destination) {
#ifdef _WIN32
        if (!MoveFileExW(temporary.c_str(), destination.c_str(), MOVEFILE_WRITE_THROUGH)) {
            const DWORD error = GetLastError();
            if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
                return std::unexpected(core::error("sanitized_copy_output_exists", "Output already exists."));
            return std::unexpected(core::error("sanitized_copy_publish_failed",
                                               "Unable to publish the sanitized archive (Windows error " + std::to_string(error) + ")."));
        }
#else
        std::error_code error;
        std::filesystem::create_hard_link(temporary, destination, error);
        if (error) {
            if (error == std::errc::file_exists)
                return std::unexpected(core::error("sanitized_copy_output_exists", "Output already exists."));
            return std::unexpected(core::error("sanitized_copy_publish_failed", error.message()));
        }
        const bool removedTemporary = std::filesystem::remove(temporary, error);
        if (error || !removedTemporary) {
            return std::unexpected(core::error("sanitized_copy_cleanup_failed",
                                               "Sanitized archive was published, but its staging file could not be removed."));
        }
        const auto parent = destination.parent_path().empty() ? std::filesystem::path(".") : destination.parent_path();
        int directoryFlags = O_RDONLY;
#ifdef O_CLOEXEC
        directoryFlags |= O_CLOEXEC;
#endif
#ifdef O_DIRECTORY
        directoryFlags |= O_DIRECTORY;
#endif
        const int directoryHandle = ::open(parent.c_str(), directoryFlags);
        if (directoryHandle < 0) {
            return std::unexpected(core::error("sanitized_copy_durability_uncertain",
                                               "Sanitized archive was published, but its directory could not be opened for "
                                               "synchronization."));
        }
        if (::fsync(directoryHandle) != 0) {
            const int flushError = errno;
            ::close(directoryHandle);
            return std::unexpected(core::error("sanitized_copy_durability_uncertain",
                                               "Sanitized archive was published, but its directory could not be synchronized: " +
                                                   std::string(std::strerror(flushError))));
        }
        ::close(directoryHandle);
#endif
        return {};
    }

} // namespace

Result<SanitizedCopySummary> previewSanitizedCopy(const Archive& source, const SanitizedCopyOptions& options) {
    auto plan = makePlan(source, options);
    if (!plan)
        return std::unexpected(plan.error());
    return plan->summary;
}

Status createSanitizedCopy(const Archive& source, const SanitizedCopyOptions& options, const SanitizedCopySummary& expected,
                           const std::filesystem::path& destination, std::string_view destinationPassphrase) {
    if (destination.extension() != ".tux")
        return std::unexpected(core::error("sanitized_copy_extension_invalid", "Sanitized archives must use the .tux extension."));
    std::error_code error;
    if (std::filesystem::equivalent(source.path(), destination, error) && !error)
        return std::unexpected(core::error("sanitized_copy_path_conflict", "A sanitized copy cannot replace its source archive."));
    error.clear();
    const auto parent = destination.has_parent_path() ? destination.parent_path() : std::filesystem::current_path();
    if (!std::filesystem::is_directory(parent, error) || error)
        return std::unexpected(core::error("sanitized_copy_directory_invalid", "The output directory must already exist."));
    if (source.commitInfo().generation != expected.sourceGeneration)
        return std::unexpected(
            core::error("sanitized_copy_source_changed", "The source archive changed after preview; review a new preview."));

    auto plan = makePlan(source, options);
    if (!plan)
        return std::unexpected(plan.error());
    if (plan->summary.sourceGeneration != expected.sourceGeneration)
        return std::unexpected(
            core::error("sanitized_copy_source_changed", "The source archive changed after preview; review a new preview."));
    if (plan->summary.selectionFingerprint != expected.selectionFingerprint)
        return std::unexpected(
            core::error("sanitized_copy_selection_changed", "The selection differs from the reviewed preview; review it again."));

    if ((source.encrypted() || options.includeCredentials) && destinationPassphrase.empty())
        return std::unexpected(core::error("sanitized_copy_encryption_required", "An encrypted output is required to preserve source "
                                                                                 "protection or include credentials."));

    auto temporary = parent / ("." + destination.stem().string() + "-" + uuidToString(randomUuid()) + ".partial.tux");
    struct TemporaryCleanup final {
        std::filesystem::path path;
        ~TemporaryCleanup() {
            std::error_code ignored;
            std::filesystem::remove(path, ignored);
        }
    } cleanup{temporary};
    const Uuid sourceManifestId = source.header().id;
    {
        auto output = Archive::create(temporary, "Sanitized copy of " + source.path().stem().string(),
                                      "Created from an explicitly reviewed privacy selection.");
        if (!output)
            return std::unexpected(output.error());
        if (!destinationPassphrase.empty()) {
            if (auto status = output->enableEncryption(destinationPassphrase); !status)
                return status;
        }

        constexpr std::size_t batchLimit = 32;
        constexpr std::size_t batchByteLimit = 16U * 1024U * 1024U;
        std::vector<Record> batch;
        batch.reserve(batchLimit);
        std::size_t batchBytes = 0;
        Status writeStatus;
        const auto flush = [&]() -> Status {
            if (batch.empty())
                return {};
            auto status = output->putMany(std::move(batch));
            batch.clear();
            batch.reserve(batchLimit);
            batchBytes = 0;
            return status;
        };
        const auto appendSelected = [&](Record&& record, const RecordSet& selected) {
            if (!selected.contains(record.id) || domain::isDeleted(record))
                return true;
            sanitizeRecord(record, *plan, options, sourceManifestId);
            batchBytes += record.blob.size();
            batch.push_back(std::move(record));
            if (batch.size() >= batchLimit || batchBytes >= batchByteLimit) {
                writeStatus = flush();
                if (!writeStatus)
                    return false;
            }
            return true;
        };
        for (const RecordType type : kCopyTypes) {
            const auto& selected = kept(*plan, type);
            if (selected.empty())
                continue;
            if (type == RecordType::AssetBlob) {
                for (const auto& id : selected) {
                    auto record = source.get(type, id);
                    if (!record)
                        return std::unexpected(record.error());
                    if (!*record)
                        return std::unexpected(
                            core::error("sanitized_copy_asset_record_missing", "A selected asset blob disappeared after preview."));
                    if (!appendSelected(std::move(**record), selected))
                        break;
                }
            } else {
                auto status = source.forEach(type, [&](Record&& record) {
                    return appendSelected(std::move(record), selected);
                });
                if (!status)
                    return status;
            }
            if (!writeStatus)
                return writeStatus;
            if (auto flushStatus = flush(); !flushStatus)
                return flushStatus;
        }
        auto verification = output->verify(true);
        if (!verification)
            return std::unexpected(verification.error());
        if (!verification->valid)
            return std::unexpected(
                core::error("sanitized_copy_verification_failed", "The generated archive did not pass full verification."));
    }
    if (auto status = publishNoReplace(temporary, destination); !status)
        return status;
    return {};
}

} // namespace tutorux::archive

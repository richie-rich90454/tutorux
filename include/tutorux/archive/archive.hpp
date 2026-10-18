#pragma once

#include "tutorux/archive/crypto.hpp"
#include "tutorux/archive/file.hpp"
#include "tutorux/archive/format.hpp"

#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace tutorux::archive {

struct ArchiveInfo final {
    std::filesystem::path path;
    std::string displayName;
    std::string description;
    Uuid id{};
    std::uint64_t generation{};
    std::uint64_t fileSize{};
    std::uint64_t studentCount{};
    std::uint64_t sessionCount{};
    std::uint64_t createdAtUs{};
    std::uint64_t trailingBytes{};
    std::uint16_t formatMajor{};
    std::uint16_t formatMinor{};
    // Filesystem write access, independent of archive locks and format compatibility.
    bool writable{};
    bool recoveryNeeded{};
    bool metadataOnly{};
    std::string healthStatus{"healthy"};
};

struct VerificationReport final {
    bool valid{};
    std::uint64_t generation{};
    std::uint64_t recordsChecked{};
    std::uint64_t indexPagesChecked{};
    std::vector<std::string> issues;
};

struct RecoveryReport final {
    std::uint64_t committedGeneration{};
    std::uint64_t candidateGeneration{};
    std::uint64_t recoverableGeneration{};
    std::uint64_t trailingBytes{};
    bool archiveHeaderValid{true};
    bool recoveryAssessmentComplete{true};
    bool headerRepairCandidate{};
    bool headerRepairAvailable{};
    std::uint64_t headerRepairGeneration{};
    bool hasUnpublishedCommit{};
    bool encrypted{};
    bool requiresPassphrase{};
    bool recoverable{};
    std::vector<std::string> issues;
};

bool isCredentialSettingsRecord(const Record& record);
bool isSensitiveCredentialFieldName(std::string_view fieldName);
bool hasSensitiveCredentialMaterial(const Record& record);

class Archive final {
  public:
    Archive(const Archive&) = delete;
    Archive& operator=(const Archive&) = delete;
    Archive(Archive&&) noexcept = default;
    Archive& operator=(Archive&&) noexcept = default;

    static core::Result<Archive> create(const std::filesystem::path& path, std::string_view displayName, std::string_view description = {});
    static core::Result<Archive> open(const std::filesystem::path& path, bool writable = false, std::string_view passphrase = {},
                                      bool allowLocked = false);
    static core::Result<std::vector<ArchiveInfo>> discover(const std::filesystem::path& directory);

    ArchiveHeader header() const {
        std::lock_guard lock(*mutex_);
        return header_;
    }
    CommitInfo commitInfo() const {
        std::lock_guard lock(*mutex_);
        return commit_;
    }
    std::filesystem::path path() const {
        std::lock_guard lock(*mutex_);
        return file_.path();
    }
    bool writable() const {
        std::lock_guard lock(*mutex_);
        return file_.writable();
    }
    bool encrypted() const {
        std::lock_guard lock(*mutex_);
        return encryptionEnabled_;
    }
    bool locked() const {
        std::lock_guard lock(*mutex_);
        return encryptionEnabled_ && !dataKey_;
    }

    core::Result<std::optional<Record>> get(RecordType type, const Uuid& id) const;
    core::Result<std::optional<Record>> getRevision(RecordType type, const Uuid& id, std::size_t revisionIndex) const;
    core::Result<std::optional<Record>> getByIndexKey(std::string_view key) const;
    core::Status forEachIndexPrefix(std::string_view indexPrefix, const std::function<bool(Record&&)>& visitor,
                                    bool includeDeleted = false) const;
    core::Status forEach(RecordType type, const std::function<bool(Record&&)>& visitor, bool includeDeleted = false) const;
    core::Status forEachAudioChunk(const Uuid& sessionId, const std::optional<Uuid>& trackId, const std::function<bool(Record&&)>& visitor,
                                   bool includeDeleted = false) const;
    core::Result<std::vector<Record>> list(RecordType type, bool includeDeleted = false) const;
    core::Status put(Record record);
    core::Status putMany(std::vector<Record> records);
    core::Result<VerificationReport> verify(bool full) const;
    static core::Result<RecoveryReport> inspectRecovery(const std::filesystem::path& path, std::string_view passphrase = {});
    static core::Status recoverUnpublishedCommit(const std::filesystem::path& path, std::string_view passphrase = {});
    static core::Status discardUncommittedTail(const std::filesystem::path& path);
    core::Status backup(const std::filesystem::path& destination) const;
    static core::Status repairCopy(const std::filesystem::path& source, const std::filesystem::path& destination,
                                   std::string_view passphrase = {});
    core::Status compact();
    core::Status enableEncryption(std::string_view passphrase);
    core::Status changePassphrase(std::string_view passphrase);

  private:
    struct IndexPage;
    Archive(ArchiveFile file, ArchiveHeader header, CommitInfo commit)
        : file_(std::move(file))
        , header_(header)
        , commit_(commit) {}

    static core::Result<Archive> openWithRecoveredHeader(const std::filesystem::path& path, std::string_view passphrase);

    core::Result<std::optional<std::uint64_t>> findOffset(std::string_view key) const;
    core::Result<RecordLocation> appendRecord(const Record& record);
    core::Result<Record> readRecordAt(std::uint64_t offset) const;
    core::Result<Bytes> readRecordPayloadAt(std::uint64_t offset, std::optional<RecordType> expected = {}) const;
    core::Result<std::uint64_t> writeIndexPage(const IndexPage& page);
    core::Result<IndexPage> readIndexPage(std::uint64_t offset) const;
    struct InsertResult final {
        std::uint64_t leftOffset{};
        std::optional<std::pair<std::string, std::uint64_t>> split;
    };
    core::Result<InsertResult> insertIndex(std::uint64_t pageOffset, std::string_view key, std::uint64_t valueOffset);
    core::Result<std::uint64_t> indexRecord(std::string_view key, std::uint64_t valueOffset);
    core::Status publishCommit(std::uint64_t rootOffset, const Uuid& transactionId, std::uint64_t recordCount);
    core::Result<std::vector<std::pair<std::string, std::uint64_t>>> allIndexEntries() const;
    core::Status verifyIndexAuthentication() const;
    core::Status verifyCommitAuthentication(const CommitInfo& commit) const;
    core::Status verifyCommitChain(bool full) const;
    core::Status rewrite(bool encrypted, std::optional<EncryptionEnvelope> envelope, const SecretKey* key);
    core::Result<Record> encryptionMetadata() const;
    core::Status writeEncryptionMetadata(const EncryptionEnvelope& envelope);
    core::Status putManyInternal(std::vector<Record> records, bool invalidateGuides);
    core::Status initializeEncryption(std::string_view passphrase, bool allowLocked);

    ArchiveFile file_;
    ArchiveHeader header_;
    CommitInfo commit_;
    bool encryptionEnabled_{};
    bool allowUnverifiedIndexReads_{};
    std::optional<SecretKey> dataKey_;
    std::optional<EncryptionEnvelope> encryptionEnvelope_;
    std::shared_ptr<std::recursive_mutex> mutex_{std::make_shared<std::recursive_mutex>()};
};

core::Result<ArchiveInfo> inspectArchive(const std::filesystem::path& path, std::string_view passphrase = {});

} // namespace tutorux::archive

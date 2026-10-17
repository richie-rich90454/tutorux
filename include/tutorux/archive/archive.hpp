#pragma once

#include "tutorux/archive/crypto.hpp"
#include "tutorux/archive/file.hpp"
#include "tutorux/archive/format.hpp"

#include <functional>
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
        bool writable{};
        std::string healthStatus{"healthy"};
    };

    struct VerificationReport final {
        bool valid{};
        std::uint64_t generation{};
        std::uint64_t recordsChecked{};
        std::uint64_t indexPagesChecked{};
        std::vector<std::string> issues;
    };

    class Archive final {
      public:
        Archive(const Archive&) = delete;
        Archive& operator=(const Archive&) = delete;
        Archive(Archive&&) noexcept = default;
        Archive& operator=(Archive&&) noexcept = default;

        static core::Result<Archive> create(const std::filesystem::path& path,
                                            std::string_view displayName,
                                            std::string_view description = {});
        static core::Result<Archive> open(const std::filesystem::path& path, bool writable = false,
                                          std::string_view passphrase = {},
                                          bool allowLocked = false);
        static core::Result<std::vector<ArchiveInfo>>
        discover(const std::filesystem::path& directory);

        const ArchiveHeader& header() const {
            return header_;
        }
        const CommitInfo& commitInfo() const {
            return commit_;
        }
        const std::filesystem::path& path() const {
            return file_.path();
        }
        bool writable() const {
            return file_.writable();
        }
        bool encrypted() const {
            return encryptionEnabled_;
        }
        bool locked() const {
            return encryptionEnabled_ && !dataKey_;
        }

        core::Result<std::optional<Record>> get(RecordType type, const Uuid& id) const;
        core::Result<std::optional<Record>> getRevision(RecordType type, const Uuid& id,
                                                        std::size_t revisionIndex) const;
        core::Result<std::optional<Record>> getByIndexKey(std::string_view key) const;
        core::Status forEachIndexPrefix(std::string_view indexPrefix,
                                        const std::function<bool(Record&&)>& visitor,
                                        bool includeDeleted = false) const;
        core::Status forEach(RecordType type, const std::function<bool(Record&&)>& visitor,
                             bool includeDeleted = false) const;
        core::Status forEachAudioChunk(const Uuid& sessionId, const std::optional<Uuid>& trackId,
                                       const std::function<bool(Record&&)>& visitor,
                                       bool includeDeleted = false) const;
        core::Result<std::vector<Record>> list(RecordType type, bool includeDeleted = false) const;
        core::Status put(Record record);
        core::Status putMany(std::vector<Record> records);
        core::Result<VerificationReport> verify(bool full) const;
        core::Status backup(const std::filesystem::path& destination) const;
        core::Status compact();
        core::Status enableEncryption(std::string_view passphrase);
        core::Status changePassphrase(std::string_view passphrase);

      private:
        struct IndexPage;
        Archive(ArchiveFile file, ArchiveHeader header, CommitInfo commit)
            : file_(std::move(file)), header_(header), commit_(commit) {}

        core::Result<std::optional<std::uint64_t>> findOffset(std::string_view key) const;
        core::Result<RecordLocation> appendRecord(const Record& record);
        core::Result<Record> readRecordAt(std::uint64_t offset) const;
        core::Result<Bytes> readRecordPayloadAt(std::uint64_t offset,
                                                std::optional<RecordType> expected = {}) const;
        core::Result<std::uint64_t> writeIndexPage(const IndexPage& page);
        core::Result<IndexPage> readIndexPage(std::uint64_t offset) const;
        struct InsertResult final {
            std::uint64_t leftOffset{};
            std::optional<std::pair<std::string, std::uint64_t>> split;
        };
        core::Result<InsertResult> insertIndex(std::uint64_t pageOffset, std::string_view key,
                                               std::uint64_t valueOffset);
        core::Result<std::uint64_t> indexRecord(std::string_view key, std::uint64_t valueOffset);
        core::Status publishCommit(std::uint64_t rootOffset, const Uuid& transactionId,
                                   std::uint64_t recordCount);
        core::Result<std::vector<std::pair<std::string, std::uint64_t>>> allIndexEntries() const;
        core::Status verifyIndexAuthentication() const;
        core::Status verifyCommitAuthentication() const;
        core::Status rewrite(bool encrypted, std::optional<EncryptionEnvelope> envelope,
                             const SecretKey* key);
        core::Result<Record> encryptionMetadata() const;
        core::Status writeEncryptionMetadata(const EncryptionEnvelope& envelope);

        ArchiveFile file_;
        ArchiveHeader header_;
        CommitInfo commit_;
        bool encryptionEnabled_{};
        bool allowUnverifiedIndexReads_{};
        std::optional<SecretKey> dataKey_;
        std::optional<EncryptionEnvelope> encryptionEnvelope_;
    };

    core::Result<ArchiveInfo> inspectArchive(const std::filesystem::path& path,
                                             std::string_view passphrase = {});

} // namespace tutorux::archive

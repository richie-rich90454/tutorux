#pragma once

#include "tutorux/archive/format.hpp"

#include <array>
#include <cstddef>
#include <cstdint>
#include <span>
#include <string>
#include <string_view>

namespace tutorux::archive {

inline constexpr std::size_t kEncryptionSaltSize = 16;
inline constexpr std::size_t kEncryptionNonceSize = 24;
inline constexpr std::size_t kEncryptionKeySize = 32;
inline constexpr std::size_t kEncryptionTagSize = 16;
inline constexpr std::size_t kEncryptionWrappedKeySize = kEncryptionKeySize + kEncryptionTagSize;

struct EncryptionEnvelope final {
    std::array<std::byte, kEncryptionSaltSize> salt{};
    std::array<std::byte, kEncryptionNonceSize> nonce{};
    std::array<std::byte, kEncryptionWrappedKeySize> wrappedKey{};
    std::uint64_t opsLimit{};
    std::uint64_t memoryLimit{};
};

class SecretKey final {
  public:
    SecretKey() = default;
    SecretKey(const SecretKey&) = delete;
    SecretKey& operator=(const SecretKey&) = delete;
    SecretKey(SecretKey&& other) noexcept;
    SecretKey& operator=(SecretKey&& other) noexcept;
    ~SecretKey();

    static core::Result<SecretKey> createRandom();
    static core::Result<SecretKey> copyOf(std::span<const std::byte> value);

    std::span<const std::byte> bytes() const;
    std::span<std::byte> mutableBytes();
    explicit operator bool() const {
        return value_ != nullptr;
    }

  private:
    explicit SecretKey(std::byte* value)
        : value_(value) {}
    void clear() noexcept;

    std::byte* value_{};
};

core::Result<EncryptionEnvelope>
wrapArchiveKey(std::string_view passphrase, const SecretKey& archiveKey, const Uuid& archiveId);
core::Result<SecretKey> unwrapArchiveKey(std::string_view passphrase,
                                         const EncryptionEnvelope& envelope,
                                         const Uuid& archiveId);
core::Result<Bytes> encryptRecordPayload(std::span<const std::byte> plaintext,
                                         const SecretKey& archiveKey,
                                         const Uuid& archiveId,
                                         RecordType type,
                                         const Uuid& recordId,
                                         std::uint64_t revision,
                                         std::uint64_t previousOffset);
core::Result<Bytes> decryptRecordPayload(std::span<const std::byte> ciphertext,
                                         const SecretKey& archiveKey,
                                         const Uuid& archiveId,
                                         RecordType type,
                                         const Uuid& recordId,
                                         std::uint64_t revision,
                                         std::uint64_t previousOffset);
std::array<std::byte, 32> authenticateBytes(std::span<const std::byte> bytes, const SecretKey& key);
bool authenticationMatches(std::span<const std::byte> bytes,
                           std::span<const std::byte> authentication,
                           const SecretKey& key);
std::string encodeHex(std::span<const std::byte> bytes);
core::Result<Bytes> decodeHex(std::string_view value);

} // namespace tutorux::archive

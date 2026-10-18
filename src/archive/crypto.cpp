#include "tutorux/archive/crypto.hpp"

#include <sodium.h>

#include <algorithm>
#include <array>
#include <cstring>
#include <limits>
#include <string_view>

namespace tutorux::archive {
namespace {

    constexpr std::uint64_t kMinimumOpsLimit = crypto_pwhash_OPSLIMIT_INTERACTIVE;
    constexpr std::uint64_t kMaximumOpsLimit = crypto_pwhash_OPSLIMIT_MODERATE;
    constexpr std::uint64_t kMinimumMemoryLimit = crypto_pwhash_MEMLIMIT_INTERACTIVE;
    constexpr std::uint64_t kMaximumMemoryLimit = crypto_pwhash_MEMLIMIT_MODERATE;

    void appendLittle(Bytes& output, std::uint64_t value, std::size_t length) {
        for (std::size_t index = 0; index < length; ++index) {
            output.push_back(static_cast<std::byte>((value >> (index * 8U)) & 0xffU));
        }
    }

    Bytes wrapAssociatedData(const Uuid& archiveId) {
        constexpr std::string_view label = "TUTORUX-ARCHIVE-KEY-V1";
        Bytes result;
        result.reserve(label.size() + archiveId.size());
        for (const char character : label)
            result.push_back(static_cast<std::byte>(character));
        result.insert(result.end(), archiveId.begin(), archiveId.end());
        return result;
    }

    Bytes recordAssociatedData(const Uuid& archiveId,
                               RecordType type,
                               const Uuid& recordId,
                               std::uint64_t revision,
                               std::uint64_t previousOffset,
                               std::uint8_t codec) {
        constexpr std::string_view label = "TUTORUX-RECORD-V1";
        Bytes result;
        result.reserve(label.size() + archiveId.size() + 2 + recordId.size() + 16);
        for (const char character : label)
            result.push_back(static_cast<std::byte>(character));
        result.insert(result.end(), archiveId.begin(), archiveId.end());
        appendLittle(result, static_cast<std::uint16_t>(type), 2);
        result.insert(result.end(), recordId.begin(), recordId.end());
        appendLittle(result, revision, 8);
        appendLittle(result, previousOffset, 8);
        if (codec != 0)
            result.push_back(static_cast<std::byte>(codec));
        return result;
    }

    core::Status initializeSodium() {
        if (sodium_init() < 0) {
            return std::unexpected(
                core::error("crypto_initialization_failed", "libsodium initialization failed."));
        }
        return {};
    }

} // namespace

SecretKey::SecretKey(SecretKey&& other) noexcept
    : value_(std::exchange(other.value_, nullptr)) {}

SecretKey& SecretKey::operator=(SecretKey&& other) noexcept {
    if (this != &other) {
        clear();
        value_ = std::exchange(other.value_, nullptr);
    }
    return *this;
}

SecretKey::~SecretKey() {
    clear();
}

void SecretKey::clear() noexcept {
    if (value_) {
        sodium_free(value_);
        value_ = nullptr;
    }
}

core::Result<SecretKey> SecretKey::createRandom() {
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());
    auto* value = static_cast<std::byte*>(sodium_malloc(kEncryptionKeySize));
    if (!value) {
        return std::unexpected(
            core::error("crypto_memory_unavailable", "Unable to allocate protected key memory."));
    }
    randombytes_buf(value, kEncryptionKeySize);
    return SecretKey(value);
}

core::Result<SecretKey> SecretKey::copyOf(std::span<const std::byte> value) {
    if (value.size() != kEncryptionKeySize) {
        return std::unexpected(
            core::error("crypto_key_invalid", "Archive data keys must contain 32 bytes."));
    }
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());
    auto* copied = static_cast<std::byte*>(sodium_malloc(kEncryptionKeySize));
    if (!copied) {
        return std::unexpected(
            core::error("crypto_memory_unavailable", "Unable to allocate protected key memory."));
    }
    std::memcpy(copied, value.data(), value.size());
    return SecretKey(copied);
}

std::span<const std::byte> SecretKey::bytes() const {
    return value_ ? std::span<const std::byte>(value_, kEncryptionKeySize)
                  : std::span<const std::byte>{};
}

std::span<std::byte> SecretKey::mutableBytes() {
    return value_ ? std::span<std::byte>(value_, kEncryptionKeySize) : std::span<std::byte>{};
}

core::Result<EncryptionEnvelope>
wrapArchiveKey(std::string_view passphrase, const SecretKey& archiveKey, const Uuid& archiveId) {
    if (passphrase.empty() || passphrase.size() > 4096 || !archiveKey) {
        return std::unexpected(
            core::error("crypto_input_invalid",
                        "Passphrase or archive key is empty or exceeds its limit."));
    }
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());

    EncryptionEnvelope envelope;
    envelope.opsLimit = kMinimumOpsLimit;
    envelope.memoryLimit = kMinimumMemoryLimit;
    randombytes_buf(envelope.salt.data(), envelope.salt.size());
    randombytes_buf(envelope.nonce.data(), envelope.nonce.size());

    std::array<std::byte, kEncryptionKeySize> wrappingKey{};
    if (crypto_pwhash(reinterpret_cast<unsigned char*>(wrappingKey.data()),
                      wrappingKey.size(),
                      passphrase.data(),
                      passphrase.size(),
                      reinterpret_cast<const unsigned char*>(envelope.salt.data()),
                      envelope.opsLimit,
                      envelope.memoryLimit,
                      crypto_pwhash_ALG_ARGON2ID13) != 0) {
        sodium_memzero(wrappingKey.data(), wrappingKey.size());
        return std::unexpected(core::error("crypto_memory_unavailable",
                                           "Unable to derive the archive key in memory."));
    }

    const Bytes associatedData = wrapAssociatedData(archiveId);
    unsigned long long ciphertextLength = 0;
    const int encrypted = crypto_aead_xchacha20poly1305_ietf_encrypt(
        reinterpret_cast<unsigned char*>(envelope.wrappedKey.data()),
        &ciphertextLength,
        reinterpret_cast<const unsigned char*>(archiveKey.bytes().data()),
        archiveKey.bytes().size(),
        reinterpret_cast<const unsigned char*>(associatedData.data()),
        associatedData.size(),
        nullptr,
        reinterpret_cast<const unsigned char*>(envelope.nonce.data()),
        reinterpret_cast<const unsigned char*>(wrappingKey.data()));
    sodium_memzero(wrappingKey.data(), wrappingKey.size());
    if (encrypted != 0 || ciphertextLength != envelope.wrappedKey.size()) {
        return std::unexpected(
            core::error("crypto_key_wrap_failed", "Unable to wrap the archive data key."));
    }
    return envelope;
}

core::Result<SecretKey> unwrapArchiveKey(std::string_view passphrase,
                                         const EncryptionEnvelope& envelope,
                                         const Uuid& archiveId) {
    if (passphrase.empty() || passphrase.size() > 4096 || envelope.opsLimit < kMinimumOpsLimit ||
        envelope.opsLimit > kMaximumOpsLimit || envelope.memoryLimit < kMinimumMemoryLimit ||
        envelope.memoryLimit > kMaximumMemoryLimit) {
        return std::unexpected(
            core::error("archive_encryption_parameters_invalid",
                        "Archive encryption parameters are outside the supported safe range."));
    }
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());

    std::array<std::byte, kEncryptionKeySize> wrappingKey{};
    if (crypto_pwhash(reinterpret_cast<unsigned char*>(wrappingKey.data()),
                      wrappingKey.size(),
                      passphrase.data(),
                      passphrase.size(),
                      reinterpret_cast<const unsigned char*>(envelope.salt.data()),
                      envelope.opsLimit,
                      envelope.memoryLimit,
                      crypto_pwhash_ALG_ARGON2ID13) != 0) {
        sodium_memzero(wrappingKey.data(), wrappingKey.size());
        return std::unexpected(core::error("crypto_memory_unavailable",
                                           "Unable to derive the archive key in memory."));
    }

    auto archiveKey = SecretKey::createRandom();
    if (!archiveKey) {
        sodium_memzero(wrappingKey.data(), wrappingKey.size());
        return std::unexpected(archiveKey.error());
    }
    const Bytes associatedData = wrapAssociatedData(archiveId);
    unsigned long long plaintextLength = 0;
    const int decrypted = crypto_aead_xchacha20poly1305_ietf_decrypt(
        reinterpret_cast<unsigned char*>(archiveKey->mutableBytes().data()),
        &plaintextLength,
        nullptr,
        reinterpret_cast<const unsigned char*>(envelope.wrappedKey.data()),
        envelope.wrappedKey.size(),
        reinterpret_cast<const unsigned char*>(associatedData.data()),
        associatedData.size(),
        reinterpret_cast<const unsigned char*>(envelope.nonce.data()),
        reinterpret_cast<const unsigned char*>(wrappingKey.data()));
    sodium_memzero(wrappingKey.data(), wrappingKey.size());
    if (decrypted != 0 || plaintextLength != kEncryptionKeySize) {
        return std::unexpected(
            core::error("archive_passphrase_invalid",
                        "Passphrase is incorrect or the key envelope is damaged."));
    }
    return std::move(*archiveKey);
}

core::Result<Bytes> encryptRecordPayload(std::span<const std::byte> plaintext,
                                         const SecretKey& archiveKey,
                                         const Uuid& archiveId,
                                         RecordType type,
                                         const Uuid& recordId,
                                         std::uint64_t revision,
                                         std::uint64_t previousOffset,
                                         std::uint8_t codec) {
    if (!archiveKey ||
        plaintext.size() > kMaximumRecordPayload - kEncryptionNonceSize - kEncryptionTagSize) {
        return std::unexpected(
            core::error("record_payload_limit", "Encrypted record exceeds the v1 payload limit."));
    }
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());

    std::array<std::byte, kEncryptionNonceSize> nonce{};
    randombytes_buf(nonce.data(), nonce.size());
    const Bytes associatedData =
        recordAssociatedData(archiveId, type, recordId, revision, previousOffset, codec);
    Bytes output(nonce.size() + plaintext.size() + kEncryptionTagSize);
    std::copy(nonce.begin(), nonce.end(), output.begin());
    unsigned long long ciphertextLength = 0;
    const int encrypted = crypto_aead_xchacha20poly1305_ietf_encrypt(
        reinterpret_cast<unsigned char*>(output.data() + nonce.size()),
        &ciphertextLength,
        reinterpret_cast<const unsigned char*>(plaintext.data()),
        plaintext.size(),
        reinterpret_cast<const unsigned char*>(associatedData.data()),
        associatedData.size(),
        nullptr,
        reinterpret_cast<const unsigned char*>(nonce.data()),
        reinterpret_cast<const unsigned char*>(archiveKey.bytes().data()));
    if (encrypted != 0 || ciphertextLength != plaintext.size() + kEncryptionTagSize) {
        return std::unexpected(
            core::error("crypto_record_encrypt_failed", "Unable to encrypt the archive record."));
    }
    return output;
}

core::Result<Bytes> decryptRecordPayload(std::span<const std::byte> ciphertext,
                                         const SecretKey& archiveKey,
                                         const Uuid& archiveId,
                                         RecordType type,
                                         const Uuid& recordId,
                                         std::uint64_t revision,
                                         std::uint64_t previousOffset,
                                         std::uint8_t codec) {
    if (!archiveKey || ciphertext.size() < kEncryptionNonceSize + kEncryptionTagSize) {
        return std::unexpected(
            core::error("archive_record_encrypted",
                        "Encrypted record is truncated or the archive is locked."));
    }
    if (auto status = initializeSodium(); !status)
        return std::unexpected(status.error());

    const auto nonce = ciphertext.first(kEncryptionNonceSize);
    const auto body = ciphertext.subspan(kEncryptionNonceSize);
    const Bytes associatedData =
        recordAssociatedData(archiveId, type, recordId, revision, previousOffset, codec);
    Bytes plaintext(body.size() - kEncryptionTagSize);
    unsigned long long plaintextLength = 0;
    const int decrypted = crypto_aead_xchacha20poly1305_ietf_decrypt(
        reinterpret_cast<unsigned char*>(plaintext.data()),
        &plaintextLength,
        nullptr,
        reinterpret_cast<const unsigned char*>(body.data()),
        body.size(),
        reinterpret_cast<const unsigned char*>(associatedData.data()),
        associatedData.size(),
        reinterpret_cast<const unsigned char*>(nonce.data()),
        reinterpret_cast<const unsigned char*>(archiveKey.bytes().data()));
    if (decrypted != 0 || plaintextLength != plaintext.size()) {
        return std::unexpected(core::error(
            "archive_record_authentication_failed",
            "Encrypted record authentication failed; archive metadata may be damaged."));
    }
    return plaintext;
}

std::array<std::byte, 32> authenticateBytes(std::span<const std::byte> bytes,
                                            const SecretKey& key) {
    std::array<std::byte, 32> authentication{};
    crypto_auth_hmacsha256(reinterpret_cast<unsigned char*>(authentication.data()),
                           reinterpret_cast<const unsigned char*>(bytes.data()),
                           bytes.size(),
                           reinterpret_cast<const unsigned char*>(key.bytes().data()));
    return authentication;
}

bool authenticationMatches(std::span<const std::byte> bytes,
                           std::span<const std::byte> authentication,
                           const SecretKey& key) {
    if (authentication.size() != 32 || !key)
        return false;
    const auto expected = authenticateBytes(bytes, key);
    return sodium_memcmp(expected.data(), authentication.data(), expected.size()) == 0;
}

std::string encodeHex(std::span<const std::byte> bytes) {
    static constexpr char alphabet[] = "0123456789abcdef";
    std::string output(bytes.size() * 2, '\0');
    for (std::size_t index = 0; index < bytes.size(); ++index) {
        const auto value = std::to_integer<unsigned int>(bytes[index]);
        output[index * 2] = alphabet[value >> 4U];
        output[index * 2 + 1] = alphabet[value & 0x0fU];
    }
    return output;
}

core::Result<Bytes> decodeHex(std::string_view value) {
    if (value.size() % 2 != 0) {
        return std::unexpected(
            core::error("archive_encryption_metadata_invalid", "Hexadecimal field is malformed."));
    }
    const auto digit = [](char character) -> int {
        if (character >= '0' && character <= '9')
            return character - '0';
        if (character >= 'a' && character <= 'f')
            return character - 'a' + 10;
        if (character >= 'A' && character <= 'F')
            return character - 'A' + 10;
        return -1;
    };
    Bytes output(value.size() / 2);
    for (std::size_t index = 0; index < output.size(); ++index) {
        const int high = digit(value[index * 2]);
        const int low = digit(value[index * 2 + 1]);
        if (high < 0 || low < 0) {
            return std::unexpected(core::error("archive_encryption_metadata_invalid",
                                               "Hexadecimal field is malformed."));
        }
        output[index] = static_cast<std::byte>((high << 4) | low);
    }
    return output;
}

} // namespace tutorux::archive

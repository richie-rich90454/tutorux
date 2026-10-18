#include "tutorux/archive/compression.hpp"

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <utility>
#include <vector>

namespace tutorux::archive {
namespace {

    constexpr std::size_t kHashTableSize = 1U << 16U;
    constexpr std::size_t kMinimumCompressionInput = 256U;
    constexpr std::size_t kMinimumCompressionSavings = 16U;
    constexpr std::size_t kUncompressedLengthSize = sizeof(std::uint64_t);
    constexpr std::uint32_t kHashMultiplier = 2'654'435'761U;

    std::uint32_t readLittle32(std::span<const std::byte> input, std::size_t offset) {
        return std::to_integer<std::uint32_t>(input[offset]) |
               (std::to_integer<std::uint32_t>(input[offset + 1U]) << 8U) |
               (std::to_integer<std::uint32_t>(input[offset + 2U]) << 16U) |
               (std::to_integer<std::uint32_t>(input[offset + 3U]) << 24U);
    }

    void appendLittle64(Bytes& output, std::uint64_t value) {
        for (std::size_t index = 0; index < sizeof(value); ++index)
            output.push_back(static_cast<std::byte>((value >> (index * 8U)) & 0xffU));
    }

    core::Result<std::uint64_t> readLittle64(std::span<const std::byte> input) {
        if (input.size() < kUncompressedLengthSize) {
            return std::unexpected(
                core::error("record_compression_invalid",
                            "Compressed record is missing its original length."));
        }
        std::uint64_t value = 0;
        for (std::size_t index = 0; index < kUncompressedLengthSize; ++index) {
            value |= std::to_integer<std::uint64_t>(input[index]) << (index * 8U);
        }
        return value;
    }

    std::size_t hashSequence(std::span<const std::byte> input, std::size_t offset) {
        const std::uint32_t sequence = readLittle32(input, offset);
        return static_cast<std::size_t>((sequence * kHashMultiplier) >> 16U);
    }

    void appendLength(Bytes& output, std::size_t length) {
        while (length >= 255U) {
            output.push_back(std::byte{255});
            length -= 255U;
        }
        output.push_back(static_cast<std::byte>(length));
    }

    Bytes compressLz4Block(std::span<const std::byte> input) {
        std::vector<std::int32_t> table(kHashTableSize, -1);
        Bytes output;
        output.reserve(input.size());
        std::size_t anchor = 0;
        std::size_t cursor = 0;

        while (cursor + 12U <= input.size()) {
            const std::size_t hash = hashSequence(input, cursor);
            const std::int32_t previous = table[hash];
            table[hash] = static_cast<std::int32_t>(cursor);
            if (previous < 0 || cursor - static_cast<std::size_t>(previous) > 65'535U ||
                readLittle32(input, static_cast<std::size_t>(previous)) !=
                    readLittle32(input, cursor)) {
                ++cursor;
                continue;
            }

            const std::size_t matchOffset = static_cast<std::size_t>(previous);
            std::size_t matchLength = 4U;
            while (cursor + matchLength < input.size() - 5U &&
                   input[matchOffset + matchLength] == input[cursor + matchLength]) {
                ++matchLength;
            }

            const std::size_t literalLength = cursor - anchor;
            const std::size_t matchCode = matchLength - 4U;
            const std::size_t tokenOffset = output.size();
            output.push_back(std::byte{});
            const unsigned int literalNibble =
                static_cast<unsigned int>(std::min<std::size_t>(literalLength, 15U));
            const unsigned int matchNibble =
                static_cast<unsigned int>(std::min<std::size_t>(matchCode, 15U));
            output[tokenOffset] = static_cast<std::byte>((literalNibble << 4U) | matchNibble);

            if (literalLength >= 15U)
                appendLength(output, literalLength - 15U);
            output.insert(output.end(),
                          input.begin() + static_cast<std::ptrdiff_t>(anchor),
                          input.begin() + static_cast<std::ptrdiff_t>(cursor));
            const std::uint16_t distance = static_cast<std::uint16_t>(cursor - matchOffset);
            output.push_back(static_cast<std::byte>(distance & 0xffU));
            output.push_back(static_cast<std::byte>((distance >> 8U) & 0xffU));
            if (matchCode >= 15U)
                appendLength(output, matchCode - 15U);

            cursor += matchLength;
            anchor = cursor;
            const std::size_t updateStart = cursor > 3U ? cursor - 3U : 0U;
            for (std::size_t position = updateStart;
                 position < cursor && position + 4U <= input.size();
                 ++position) {
                table[hashSequence(input, position)] = static_cast<std::int32_t>(position);
            }
        }

        const std::size_t literalLength = input.size() - anchor;
        output.push_back(static_cast<std::byte>(
            static_cast<unsigned int>(std::min<std::size_t>(literalLength, 15U)) << 4U));
        if (literalLength >= 15U)
            appendLength(output, literalLength - 15U);
        output.insert(output.end(),
                      input.begin() + static_cast<std::ptrdiff_t>(anchor),
                      input.end());
        return output;
    }

    core::Result<std::size_t> readExtendedLength(std::span<const std::byte> input,
                                                 std::size_t& cursor,
                                                 std::size_t initialLength) {
        std::size_t length = initialLength;
        if (initialLength != 15U)
            return length;
        while (true) {
            if (cursor >= input.size()) {
                return std::unexpected(core::error("record_compression_invalid",
                                                   "Compressed record length is truncated."));
            }
            const std::size_t extension = std::to_integer<std::size_t>(input[cursor++]);
            if (extension > std::numeric_limits<std::size_t>::max() - length) {
                return std::unexpected(core::error("record_compression_invalid",
                                                   "Compressed record length overflows."));
            }
            length += extension;
            if (extension != 255U)
                return length;
        }
    }

} // namespace

core::Result<EncodedPayload> compressRecordPayload(Bytes payload) {
    if (payload.size() > kMaximumRecordPayload) {
        return std::unexpected(core::error("record_payload_limit",
                                           "Record exceeds the v1 uncompressed payload limit."));
    }
    EncodedPayload result;
    if (payload.size() < kMinimumCompressionInput) {
        result.bytes = std::move(payload);
        return result;
    }

    Bytes compressed = compressLz4Block(payload);
    constexpr std::size_t maximumSavingsCheck = std::numeric_limits<std::size_t>::max() -
                                                kUncompressedLengthSize -
                                                kMinimumCompressionSavings;
    if (compressed.size() > maximumSavingsCheck ||
        compressed.size() + kUncompressedLengthSize + kMinimumCompressionSavings > payload.size()) {
        result.bytes = std::move(payload);
        return result;
    }
    result.codec = RecordCodec::lz4Block;
    result.bytes.reserve(kUncompressedLengthSize + compressed.size());
    appendLittle64(result.bytes, static_cast<std::uint64_t>(payload.size()));
    result.bytes.insert(result.bytes.end(), compressed.begin(), compressed.end());
    return result;
}

core::Result<Bytes> decompressRecordPayload(RecordCodec codec, std::span<const std::byte> payload) {
    if (codec == RecordCodec::uncompressed)
        return Bytes(payload.begin(), payload.end());
    if (codec != RecordCodec::lz4Block) {
        return std::unexpected(core::error("record_codec_unsupported",
                                           "Record uses an unsupported compression codec."));
    }

    auto decodedLength = readLittle64(payload);
    if (!decodedLength || *decodedLength > kMaximumRecordPayload ||
        *decodedLength > std::numeric_limits<std::size_t>::max()) {
        return std::unexpected(core::error("record_compression_invalid",
                                           "Compressed record expands beyond the v1 size limit."));
    }
    const std::size_t expectedSize = static_cast<std::size_t>(*decodedLength);
    std::span<const std::byte> block = payload.subspan(kUncompressedLengthSize);
    Bytes output;
    output.reserve(expectedSize);
    std::size_t cursor = 0;

    while (cursor < block.size()) {
        const unsigned int token = std::to_integer<unsigned int>(block[cursor++]);
        auto literalLength = readExtendedLength(block, cursor, token >> 4U);
        if (!literalLength)
            return std::unexpected(literalLength.error());
        if (*literalLength > block.size() - cursor ||
            *literalLength > expectedSize - output.size()) {
            return std::unexpected(core::error("record_compression_invalid",
                                               "Compressed record literal range is invalid."));
        }
        output.insert(output.end(),
                      block.begin() + static_cast<std::ptrdiff_t>(cursor),
                      block.begin() + static_cast<std::ptrdiff_t>(cursor + *literalLength));
        cursor += *literalLength;
        if (cursor == block.size())
            break;
        if (block.size() - cursor < 2U) {
            return std::unexpected(
                core::error("record_compression_invalid", "Compressed record match is truncated."));
        }
        const std::size_t distance = std::to_integer<std::size_t>(block[cursor]) |
                                     (std::to_integer<std::size_t>(block[cursor + 1U]) << 8U);
        cursor += 2U;
        if (distance == 0 || distance > output.size()) {
            return std::unexpected(core::error("record_compression_invalid",
                                               "Compressed record match distance is invalid."));
        }
        auto matchCode = readExtendedLength(block, cursor, token & 0x0fU);
        if (!matchCode)
            return std::unexpected(matchCode.error());
        if (*matchCode > std::numeric_limits<std::size_t>::max() - 4U) {
            return std::unexpected(core::error("record_compression_invalid",
                                               "Compressed record match length overflows."));
        }
        const std::size_t matchLength = *matchCode + 4U;
        if (matchLength > expectedSize - output.size()) {
            return std::unexpected(core::error("record_compression_invalid",
                                               "Compressed record match exceeds its output size."));
        }
        for (std::size_t index = 0; index < matchLength; ++index)
            output.push_back(output[output.size() - distance]);
    }

    if (output.size() != expectedSize) {
        return std::unexpected(
            core::error("record_compression_invalid",
                        "Compressed record did not expand to its declared size."));
    }
    return output;
}

} // namespace tutorux::archive

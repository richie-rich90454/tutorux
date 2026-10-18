#pragma once

#include "tutorux/archive/format.hpp"

namespace tutorux::archive {

enum class RecordCodec : std::uint8_t {
    uncompressed = 0,
    lz4Block = 1
};

struct EncodedPayload final {
    RecordCodec codec{RecordCodec::uncompressed};
    Bytes bytes;
};

core::Result<EncodedPayload> compressRecordPayload(Bytes payload);
core::Result<Bytes> decompressRecordPayload(RecordCodec codec, std::span<const std::byte> payload);

} // namespace tutorux::archive

#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/wav_import.hpp"
#include "tutorux/command/session_package.hpp"
#include "tutorux/domain/entities.hpp"

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#include <string_view>
#include <type_traits>
#include <vector>

namespace {

struct TemporaryFiles final {
    std::vector<std::filesystem::path> paths;

    ~TemporaryFiles() {
        for (const auto& path : paths) {
            std::error_code ignored;
            std::filesystem::remove(path, ignored);
        }
    }
};

void appendAscii(std::vector<std::byte>& bytes, std::string_view value) {
    for (const char character : value)
        bytes.push_back(static_cast<std::byte>(static_cast<unsigned char>(character)));
}

template <typename Integer> void appendLittle(std::vector<std::byte>& bytes, Integer value) {
    using Unsigned = std::make_unsigned_t<Integer>;
    const auto bits = static_cast<Unsigned>(value);
    for (std::size_t index = 0; index < sizeof(Integer); ++index) {
        bytes.push_back(static_cast<std::byte>((bits >> (index * 8U)) & 0xffU));
    }
}

bool writeWave(const std::filesystem::path& path) {
    constexpr std::uint32_t sampleRate = 8'000;
    constexpr std::uint32_t sampleCount = 256;
    constexpr std::uint32_t dataSize = sampleCount * 2;

    std::vector<std::byte> bytes;
    bytes.reserve(44 + dataSize);
    appendAscii(bytes, "RIFF");
    appendLittle(bytes, std::uint32_t{36} + dataSize);
    appendAscii(bytes, "WAVEfmt ");
    appendLittle(bytes, std::uint32_t{16});
    appendLittle(bytes, std::uint16_t{1});
    appendLittle(bytes, std::uint16_t{1});
    appendLittle(bytes, sampleRate);
    appendLittle(bytes, sampleRate * 2);
    appendLittle(bytes, std::uint16_t{2});
    appendLittle(bytes, std::uint16_t{16});
    appendAscii(bytes, "data");
    appendLittle(bytes, dataSize);
    bytes.resize(44 + dataSize, std::byte{});

    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output)
        return false;
    for (const std::byte byte : bytes)
        output.put(static_cast<char>(std::to_integer<unsigned char>(byte)));
    return output.good();
}

int fail(std::string_view message) {
    std::cerr << message << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    const auto basePath = std::filesystem::current_path() /
                          ("tutorux-session-transfer-" + std::to_string(uniqueSuffix));
    TemporaryFiles temporary{
        {basePath.string() + "-source.tux",
         basePath.string() + "-audio.wav",
         basePath.string() + "-package.tux",
         basePath.string() + "-destination.tux"}
    };

    if (!writeWave(temporary.paths[1]))
        return fail("Unable to write the test WAV fixture.");

    const archive::Uuid originalSessionId = archive::randomUuid();
    auto createdSource = archive::Archive::create(temporary.paths[0], "Source");
    if (!createdSource)
        return fail(createdSource.error().message);
    domain::Session session;
    session.id = originalSessionId;
    session.studentId = "anonymous";
    session.subject = "Test";
    session.title = "Transfer regression";
    if (auto status = createdSource->put(domain::toRecord(session)); !status)
        return fail(status.error().message);
    archive::Archive source = std::move(*createdSource);

    auto importedAudio = audio::importWave(source, originalSessionId, temporary.paths[1]);
    if (!importedAudio || !importedAudio->completed || importedAudio->sampleCount != 256 ||
        importedAudio->chunkCount == 0) {
        return fail(importedAudio ? "WAV import did not commit the complete sample stream."
                                  : importedAudio.error().message);
    }
    auto recoveredAudio = audio::recoverWaveImport(source, originalSessionId);
    if (!recoveredAudio || !recoveredAudio->completed ||
        recoveredAudio->sampleCount != importedAudio->sampleCount ||
        recoveredAudio->chunkCount != importedAudio->chunkCount) {
        return fail(recoveredAudio ? "Audio recovery changed the committed WAV stream."
                                   : recoveredAudio.error().message);
    }

    if (auto status =
            command::exportSessionPackage(source, originalSessionId, temporary.paths[2], false);
        !status)
        return fail(status.error().message);

    archive::Uuid importedSessionId{};
    {
        auto destination = archive::Archive::create(temporary.paths[3], "Destination");
        if (!destination)
            return fail(destination.error().message);
        auto importedSession = command::importSessionPackage(*destination, temporary.paths[2]);
        if (!importedSession)
            return fail(importedSession.error().message);
        importedSessionId = *importedSession;
    }

    auto reopenedDestination = archive::Archive::open(temporary.paths[3]);
    if (!reopenedDestination)
        return fail(reopenedDestination.error().message);
    auto importedRecord = reopenedDestination->get(archive::RecordType::Session, importedSessionId);
    if (!importedRecord || !*importedRecord ||
        domain::getField(**importedRecord, "title") != "Transfer regression") {
        return fail("Transferred session is missing or has an unexpected title.");
    }
    auto verification = reopenedDestination->verify(true);
    if (!verification || !verification->valid)
        return fail("Transferred archive did not pass full verification.");

    auto audioChunks = reopenedDestination->list(archive::RecordType::AudioChunk);
    if (!audioChunks || audioChunks->empty())
        return fail("Transferred session package lost its imported audio chunks.");

    return 0;
}

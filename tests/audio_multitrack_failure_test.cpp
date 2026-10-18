#include "tutorux/archive/archive.hpp"
#include "tutorux/audio/capture.hpp"
#include "tutorux/domain/entities.hpp"

#include <charconv>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

int fail(std::string_view message) {
    std::cerr << message << '\n';
    return 1;
}

std::optional<std::uint64_t> parseUnsignedInteger(std::string_view value) {
    if (value.empty())
        return std::nullopt;
    std::uint64_t parsed{};
    const auto [end, errorCode] = std::from_chars(value.data(), value.data() + value.size(), parsed);
    if (errorCode != std::errc{} || end != value.data() + value.size())
        return std::nullopt;
    return parsed;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() / ("tutorux-audio-track-failure-" + std::to_string(uniqueSuffix))};
    std::error_code filesystemError;
    std::filesystem::create_directories(temporary.path, filesystemError);
    if (filesystemError)
        return fail("Unable to create the multi-track failure test directory.");

    auto archive = archive::Archive::create(temporary.path / "failure.tux", "Multi-track failure regression");
    if (!archive)
        return fail(archive.error().message);

    domain::Session session;
    session.id = archive::randomUuid();
    session.studentId = "anonymous";
    session.subject = "Audio";
    session.title = "Failed source interval";
    if (auto status = archive->put(domain::toRecord(session)); !status)
        return fail(status.error().message);

    audio::CaptureOptions microphone;
    microphone.source = audio::DeviceKind::microphone;
    microphone.deviceId = "tutorux-test-missing-microphone";
    microphone.consentConfirmedBy = "multi-track failure regression test";
    audio::CaptureOptions systemAudio;
    systemAudio.source = audio::DeviceKind::playback;
    systemAudio.deviceId = "tutorux-test-missing-system-audio";
    systemAudio.consentConfirmedBy = "multi-track failure regression test";

    auto capture = audio::captureNativeTracks(*archive, session.id, std::move(microphone), std::move(systemAudio));
    if (!capture)
        return fail(capture.error().message);

    auto records = archive->list(archive::RecordType::AssetMetadata);
    if (!records)
        return fail(records.error().message);
    std::vector<archive::Record> trackRecords;
    for (const auto& record : *records) {
        if (domain::getField(record, "record_role") == "audio-track" &&
            domain::getField(record, "session_id") == archive::uuidToString(session.id)) {
            trackRecords.push_back(record);
        }
    }
    if (trackRecords.size() != 2)
        return fail("A failed synchronized capture did not retain both track records.");

    for (const auto& track : trackRecords) {
        const std::string source = domain::getField(track, "source");
        if ((source != "microphone" && source != "system-audio") || domain::getField(track, "failure_source") != source) {
            return fail("A failed track record lost its source identity.");
        }
        if (!parseUnsignedInteger(domain::getField(track, "failure_at_unix_us")))
            return fail("A failed track record has no valid failure timestamp.");
        if (domain::getField(track, "failure_device_id") != domain::getField(track, "device_id"))
            return fail("A failed track record lost the failed device identifier.");
        if (domain::getField(track, "failure_interval_state") != "closed")
            return fail("A completed recording did not close the failed source interval.");

        const std::string start = domain::getField(track, "failure_interval_start_session_us");
        const std::string end = domain::getField(track, "failure_interval_end_session_us");
        const auto startUs = parseUnsignedInteger(start);
        const auto endUs = parseUnsignedInteger(end);
        if (!startUs || !endUs || *endUs < *startUs)
            return fail("A failed track record has incomplete session-relative interval bounds.");
    }

    return 0;
}

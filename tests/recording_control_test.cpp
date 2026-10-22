// Recording control IPC lifecycle coverage without capturing a physical device.
#include "tutorux/audio/recording_control.hpp"

#include <atomic>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "recording control: " << label << '\n';
    return false;
}

std::string endpointFor(const std::filesystem::path& archive, std::string_view session) {
    auto endpoint = tutorux::audio::recordingControlEndpoint(archive, session);
    return endpoint ? *endpoint : std::string{};
}

} // namespace

int main() {
    using namespace tutorux;
    bool okay = true;

    const auto archive = std::filesystem::temp_directory_path() / "tutorux-ipc-test.tux";
    const std::string first = endpointFor(archive, "session-a");
    const std::string second = endpointFor(archive, "session-b");
    okay &= expect(!first.empty() && !second.empty() && first != second,
                   "recording endpoints are not session-specific");
    auto invalidCommand = audio::sendRecordingControl(first, "invalid");
    okay &= expect(!invalidCommand, "invalid recording command was accepted");
    auto emptyEndpoint = audio::sendRecordingControl("", "status");
    okay &= expect(!emptyEndpoint, "empty recording endpoint was accepted");

    std::atomic_bool workerStarted{};
    std::atomic_bool workerFinished{};
    std::thread worker([&] {
        const int status = audio::runRecordingWorker(
            first, [&](const audio::RecordingControlCallbacks& callbacks) -> core::Status {
                workerStarted.store(true, std::memory_order_release);
                bool paused = false;
                callbacks.stateChanged("recording", "Recording is active.");
                while (!callbacks.stopRequested()) {
                    const bool pauseRequested = callbacks.pauseRequested();
                    if (pauseRequested != paused) {
                        paused = pauseRequested;
                        callbacks.stateChanged(paused ? "paused" : "recording",
                                               paused ? "Recording is paused."
                                                      : "Recording resumed.");
                    }
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                }
                callbacks.stateChanged("completed", "Recording finished.");
                return core::Status{};
            });
        workerFinished.store(status == 0, std::memory_order_release);
    });

    std::optional<audio::RecordingControlResponse> status;
    for (int attempt = 0; attempt < 100 && !status; ++attempt) {
        auto result = audio::sendRecordingControl(first, "status");
        if (result)
            status = std::move(*result);
        else
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    okay &= expect(workerStarted.load() && status.has_value(),
                   "recording worker did not start its IPC server");
    okay &= expect(status && (status->state == "recording" || status->state == "starting"),
                   "initial recording status is wrong");

    auto pause = audio::sendRecordingControl(first, "pause");
    okay &= expect(pause && pause->state == "pause-requested",
                   "pause request was not acknowledged");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    auto paused = audio::sendRecordingControl(first, "status");
    okay &= expect(paused && paused->state == "paused", "worker did not enter paused state");
    auto resume = audio::sendRecordingControl(first, "resume");
    okay &= expect(resume && resume->state == "resume-requested",
                   "resume request was not acknowledged");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    auto resumed = audio::sendRecordingControl(first, "status");
    okay &= expect(resumed && resumed->state == "recording",
                   "worker did not resume recording");
    auto stop = audio::sendRecordingControl(first, "stop");
    okay &= expect(stop && stop->state == "stop-requested",
                   "stop request was not acknowledged");
    worker.join();
    okay &= expect(workerFinished.load(), "recording worker exited with a failure");
    auto afterStop = audio::sendRecordingControl(first, "status");
    okay &= expect(!afterStop, "recording worker still accepted commands after exit");

    return okay ? 0 : 1;
}

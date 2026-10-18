#include "tutorux/archive/archive.hpp"

#include <chrono>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>

#ifdef _WIN32
#include <Windows.h>
#elif !defined(__EMSCRIPTEN__)
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

int probeWriter(const std::filesystem::path& archivePath, bool expectLocked) {
    auto writer = tutorux::archive::Archive::open(archivePath, true);
    if (expectLocked)
        return !writer && writer.error().code == "archive_locked" ? 0 : 1;
    return writer ? 0 : 1;
}

bool runChildProbe(const std::filesystem::path& executablePath, const std::filesystem::path& archivePath, bool expectLocked) {
#ifdef _WIN32
    const auto executable = std::filesystem::absolute(executablePath).wstring();
    const auto archive = archivePath.wstring();
    std::wstring commandLine = L"\"" + executable + L"\" --probe-writer \"" + archive + L"\" " + (expectLocked ? L"locked" : L"free");
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(executable.c_str(), commandLine.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, nullptr, &startup,
                        &process))
        return false;
    const DWORD waitResult = WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = 1;
    const bool readExitCode = waitResult == WAIT_OBJECT_0 && GetExitCodeProcess(process.hProcess, &exitCode) != 0;
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return readExitCode && exitCode == 0;
#elif defined(__EMSCRIPTEN__)
    static_cast<void>(executablePath);
    static_cast<void>(archivePath);
    static_cast<void>(expectLocked);
    return true;
#else
    const auto executable = std::filesystem::absolute(executablePath);
    const pid_t child = ::fork();
    if (child < 0)
        return false;
    if (child == 0) {
        const char* expected = expectLocked ? "locked" : "free";
        ::execl(executable.c_str(), executable.c_str(), "--probe-writer", archivePath.c_str(), expected, static_cast<char*>(nullptr));
        ::_exit(127);
    }
    int status = 0;
    if (::waitpid(child, &status, 0) != child)
        return false;
    return WIFEXITED(status) && WEXITSTATUS(status) == 0;
#endif
}

} // namespace

int main(int argc, char** argv) {
    using namespace tutorux;

    if (argc == 4 && std::string_view(argv[1]) == "--probe-writer") {
        return probeWriter(argv[2], std::string_view(argv[3]) == "locked");
    }

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() / ("tutorux-archive-locking-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode) {
        std::cerr << "Unable to create the archive locking test directory: " << errorCode.message() << '\n';
        return 1;
    }
    const auto archivePath = temporary.path / "locked.tux";
    const auto sidecarPath = archivePath.parent_path() / ("." + archivePath.filename().string() + ".lock");

    {
        auto created = archive::Archive::create(archivePath, "Transient lock regression");
        if (!created) {
            std::cerr << "Archive creation failed: " << created.error().message << '\n';
            return 1;
        }
    }
    if (std::filesystem::exists(sidecarPath)) {
        std::cerr << "Archive creation left a permanent lock sidecar.\n";
        return 1;
    }

    {
        auto writer = archive::Archive::open(archivePath, true);
        if (!writer) {
            std::cerr << "Writer open failed: " << writer.error().message << '\n';
            return 1;
        }
#ifndef __EMSCRIPTEN__
        auto secondWriter = archive::Archive::open(archivePath, true);
        if (secondWriter || secondWriter.error().code != "archive_locked") {
            std::cerr << "A second in-process writer was not rejected.\n";
            return 1;
        }
#endif
        const auto sizeBeforeDiscovery = std::filesystem::file_size(archivePath, errorCode);
        if (errorCode) {
            std::cerr << "Unable to inspect archive size before discovery.\n";
            return 1;
        }
        auto discovered = archive::Archive::discover(temporary.path);
        if (!discovered || discovered->size() != 1 || !discovered->front().writable) {
            std::cerr << "Discovery did not report write access while a writer was active.\n";
            return 1;
        }
        const auto sizeAfterDiscovery = std::filesystem::file_size(archivePath, errorCode);
        if (errorCode || sizeAfterDiscovery != sizeBeforeDiscovery) {
            std::cerr << "Discovery changed archive bytes while probing write access.\n";
            return 1;
        }
#ifndef __EMSCRIPTEN__
        if (!runChildProbe(argv[0], archivePath, true)) {
            std::cerr << "A second-process writer was not rejected.\n";
            return 1;
        }
#endif
        if (auto status = writer->compact(); !status) {
            std::cerr << "Compaction failed: " << status.error().message << '\n';
            return 1;
        }
        if (std::filesystem::exists(sidecarPath)) {
            std::cerr << "Compaction created a permanent lock sidecar.\n";
            return 1;
        }
#ifndef __EMSCRIPTEN__
        if (!runChildProbe(argv[0], archivePath, true)) {
            std::cerr << "The replacement archive was not locked after compaction.\n";
            return 1;
        }
#endif
    }

#ifndef __EMSCRIPTEN__
    if (!runChildProbe(argv[0], archivePath, false)) {
        std::cerr << "The archive remained locked after the writer closed.\n";
        return 1;
    }
#endif
    if (std::filesystem::exists(sidecarPath)) {
        std::cerr << "Archive close left a permanent lock sidecar.\n";
        return 1;
    }
    return 0;
}

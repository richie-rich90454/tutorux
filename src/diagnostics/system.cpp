#include "tutorux/diagnostics/system.hpp"

#include <algorithm>
#include <chrono>
#include <limits>
#include <thread>

#ifdef _WIN32
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <Windows.h>
#include <Psapi.h>
#elif defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_host.h>
#include <mach/vm_statistics.h>
#include <sys/resource.h>
#include <sys/sysctl.h>
#include <sys/time.h>
#elif defined(__linux__)
#include <fstream>
#include <sys/resource.h>
#include <sys/sysinfo.h>
#include <sys/time.h>
#include <unistd.h>
#endif

namespace tutorux::diagnostics {
namespace {

    using Clock = std::chrono::steady_clock;
    const Clock::time_point processStartTime = Clock::now();

#if defined(__APPLE__) || defined(__linux__)
    std::uint64_t timevalMicroseconds(const timeval& value) {
        if (value.tv_sec < 0 || value.tv_usec < 0)
            return 0;
        constexpr std::uint64_t microsecondsPerSecond = 1'000'000;
        const auto seconds = static_cast<std::uint64_t>(value.tv_sec);
        const auto microseconds = static_cast<std::uint64_t>(value.tv_usec);
        if (seconds >
            (std::numeric_limits<std::uint64_t>::max() - microseconds) / microsecondsPerSecond) {
            return std::numeric_limits<std::uint64_t>::max();
        }
        return seconds * microsecondsPerSecond + microseconds;
    }
#endif

    std::string operatingSystemName() {
#ifdef _WIN32
        return "Windows";
#elif defined(__APPLE__)
        return "macOS";
#elif defined(__linux__)
        return "Linux";
#elif defined(__EMSCRIPTEN__)
        return "WebAssembly";
#elif defined(__FreeBSD__)
        return "FreeBSD";
#else
        return "Unknown";
#endif
    }

    std::string architectureName() {
#if defined(_M_X64) || defined(__x86_64__)
        return "x86_64";
#elif defined(_M_ARM64) || defined(__aarch64__)
        return "arm64";
#elif defined(_M_IX86) || defined(__i386__)
        return "x86";
#elif defined(__arm__) || defined(_M_ARM)
        return "arm";
#elif defined(__EMSCRIPTEN__)
        return "wasm32";
#else
        return "unknown";
#endif
    }

#ifdef _WIN32
    std::uint64_t fileTimeMicroseconds(const FILETIME& time) {
        ULARGE_INTEGER ticks{};
        ticks.LowPart = time.dwLowDateTime;
        ticks.HighPart = time.dwHighDateTime;
        return ticks.QuadPart / 10U;
    }
#endif

} // namespace

core::Result<SystemSnapshot> readSystemSnapshot() {
    SystemSnapshot snapshot;
    snapshot.operatingSystem = operatingSystemName();
    snapshot.architecture = architectureName();
    snapshot.hardwareThreads = std::max(1U, std::thread::hardware_concurrency());
    const auto elapsed =
        std::chrono::duration_cast<std::chrono::microseconds>(Clock::now() - processStartTime)
            .count();
    snapshot.processUptimeUs = elapsed > 0 ? static_cast<std::uint64_t>(elapsed) : 0;

#ifdef _WIN32
    MEMORYSTATUSEX memoryStatus{};
    memoryStatus.dwLength = sizeof(memoryStatus);
    if (GlobalMemoryStatusEx(&memoryStatus)) {
        snapshot.availableMemoryBytes = memoryStatus.ullAvailPhys;
        snapshot.availableMemoryAvailable = true;
    }
    FILETIME creationTime{};
    FILETIME exitTime{};
    FILETIME kernelTime{};
    FILETIME userTime{};
    if (GetProcessTimes(GetCurrentProcess(), &creationTime, &exitTime, &kernelTime, &userTime)) {
        const std::uint64_t kernel = fileTimeMicroseconds(kernelTime);
        const std::uint64_t user = fileTimeMicroseconds(userTime);
        snapshot.processCpuTimeUs = kernel > std::numeric_limits<std::uint64_t>::max() - user
                                        ? std::numeric_limits<std::uint64_t>::max()
                                        : kernel + user;
        snapshot.processCpuAvailable = true;
    }
    PROCESS_MEMORY_COUNTERS_EX memory{};
    memory.cb = sizeof(memory);
    if (GetProcessMemoryInfo(GetCurrentProcess(),
                             reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&memory),
                             sizeof(memory))) {
        snapshot.residentMemoryBytes = memory.WorkingSetSize;
        snapshot.peakResidentMemoryBytes = memory.PeakWorkingSetSize;
        snapshot.residentMemoryAvailable = true;
    }
#elif defined(__APPLE__) || defined(__linux__)
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) == 0) {
        const std::uint64_t user = timevalMicroseconds(usage.ru_utime);
        const std::uint64_t system = timevalMicroseconds(usage.ru_stime);
        snapshot.processCpuTimeUs = system > std::numeric_limits<std::uint64_t>::max() - user
                                        ? std::numeric_limits<std::uint64_t>::max()
                                        : user + system;
        snapshot.processCpuAvailable = true;
        if (usage.ru_maxrss > 0) {
            const auto maximum = static_cast<std::uint64_t>(usage.ru_maxrss);
#ifdef __APPLE__
            snapshot.peakResidentMemoryBytes = maximum;
#else
            snapshot.peakResidentMemoryBytes = maximum * 1024U;
#endif
        }
    }
#ifdef __APPLE__
    vm_statistics64_data_t vmStatistics{};
    mach_msg_type_number_t vmCount = HOST_VM_INFO64_COUNT;
    vm_size_t pageSize = 0;
    if (host_page_size(mach_host_self(), &pageSize) == KERN_SUCCESS && pageSize > 0 &&
        host_statistics64(mach_host_self(),
                          HOST_VM_INFO64,
                          reinterpret_cast<host_info64_t>(&vmStatistics),
                          &vmCount) == KERN_SUCCESS) {
        const std::uint64_t availablePages =
            static_cast<std::uint64_t>(vmStatistics.free_count) +
            static_cast<std::uint64_t>(vmStatistics.inactive_count) +
            static_cast<std::uint64_t>(vmStatistics.speculative_count);
        if (availablePages <= std::numeric_limits<std::uint64_t>::max() / pageSize) {
            snapshot.availableMemoryBytes = availablePages * pageSize;
            snapshot.availableMemoryAvailable = true;
        }
    }
    mach_task_basic_info_data_t taskInfo{};
    mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
    if (task_info(mach_task_self(),
                  MACH_TASK_BASIC_INFO,
                  reinterpret_cast<task_info_t>(&taskInfo),
                  &count) == KERN_SUCCESS) {
        snapshot.residentMemoryBytes = taskInfo.resident_size;
        snapshot.residentMemoryAvailable = true;
    }
#elif defined(__linux__)
    struct sysinfo memoryInfo{};
    if (sysinfo(&memoryInfo) == 0) {
        const std::uint64_t freePages = static_cast<std::uint64_t>(memoryInfo.freeram) +
                                        static_cast<std::uint64_t>(memoryInfo.bufferram);
        const std::uint64_t unit = memoryInfo.mem_unit;
        if (unit == 0U || freePages <= std::numeric_limits<std::uint64_t>::max() / unit) {
            snapshot.availableMemoryBytes = freePages * unit;
            snapshot.availableMemoryAvailable = true;
        }
    }
    std::ifstream statusFile("/proc/self/statm");
    [[maybe_unused]] std::uint64_t totalPages = 0;
    std::uint64_t residentPages = 0;
    if (statusFile >> totalPages >> residentPages) {
        const long pageSize = sysconf(_SC_PAGESIZE);
        if (pageSize > 0 && residentPages <= std::numeric_limits<std::uint64_t>::max() /
                                                 static_cast<std::uint64_t>(pageSize)) {
            snapshot.residentMemoryBytes = residentPages * static_cast<std::uint64_t>(pageSize);
            snapshot.residentMemoryAvailable = true;
        }
    }
#endif
#endif
    if (snapshot.residentMemoryAvailable && snapshot.peakResidentMemoryBytes == 0)
        snapshot.peakResidentMemoryBytes = snapshot.residentMemoryBytes;
    return snapshot;
}

} // namespace tutorux::diagnostics

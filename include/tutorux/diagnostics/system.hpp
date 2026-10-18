#pragma once

#include "tutorux/core/result.hpp"

#include <cstdint>
#include <string>

namespace tutorux::diagnostics {

struct SystemSnapshot final {
    std::string operatingSystem;
    std::string architecture;
    std::uint64_t processUptimeUs{};
    std::uint64_t processCpuTimeUs{};
    std::uint64_t residentMemoryBytes{};
    std::uint64_t peakResidentMemoryBytes{};
    std::uint64_t availableMemoryBytes{};
    std::uint32_t hardwareThreads{};
    bool processCpuAvailable{};
    bool residentMemoryAvailable{};
    bool availableMemoryAvailable{};
};

core::Result<SystemSnapshot> readSystemSnapshot();

} // namespace tutorux::diagnostics

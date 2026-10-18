#include "tutorux/command/zip.hpp"

#include "tutorux/archive/format.hpp"

#include <algorithm>
#include <cstdint>
#include <limits>
#include <set>

namespace tutorux::command {
namespace {

    template <typename Integer> void appendLittle(std::vector<std::byte>& output, Integer value) {
        using Unsigned = std::make_unsigned_t<Integer>;
        const auto bits = static_cast<Unsigned>(value);
        for (std::size_t index = 0; index < sizeof(Integer); ++index) {
            output.push_back(static_cast<std::byte>((bits >> (index * 8U)) & 0xffU));
        }
    }

    void appendBytes(std::vector<std::byte>& output, std::string_view value) {
        for (const char rawCharacter : value) {
            output.push_back(static_cast<std::byte>(static_cast<unsigned char>(rawCharacter)));
        }
    }

    struct CentralDirectoryEntry final {
        std::string_view path;
        std::uint32_t checksum{};
        std::uint32_t size{};
        std::uint32_t localOffset{};
    };

    bool validZipPath(std::string_view path) {
        if (path.empty() || path.size() > std::numeric_limits<std::uint16_t>::max() ||
            path.front() == '/' || path.front() == '\\' ||
            path.find('\\') != std::string_view::npos ||
            path.find('\0') != std::string_view::npos || path.find(':') != std::string_view::npos) {
            return false;
        }
        std::size_t segmentStart = 0;
        while (segmentStart <= path.size()) {
            const std::size_t separator = path.find('/', segmentStart);
            const std::size_t segmentEnd =
                separator == std::string_view::npos ? path.size() : separator;
            const auto segment = path.substr(segmentStart, segmentEnd - segmentStart);
            if (segment.empty() || segment == "." || segment == "..")
                return false;
            if (separator == std::string_view::npos)
                break;
            segmentStart = separator + 1;
        }
        return true;
    }

} // namespace

core::Result<std::vector<std::byte>> encodeStoredZip(std::span<const ZipEntry> entries) {
    constexpr std::uint64_t maximumClassicZipValue = std::numeric_limits<std::uint32_t>::max();
    if (entries.empty() || entries.size() > std::numeric_limits<std::uint16_t>::max()) {
        return std::unexpected(core::error("zip_entry_count_invalid",
                                           "A ZIP package must contain 1 to 65,535 entries."));
    }

    std::set<std::string_view, std::less<>> uniquePaths;
    std::uint64_t estimatedSize = 22;
    for (const ZipEntry& entry : entries) {
        if (!validZipPath(entry.path) || !uniquePaths.insert(entry.path).second) {
            return std::unexpected(
                core::error("zip_entry_path_invalid",
                            "ZIP entry paths must be unique safe relative paths."));
        }
        if (entry.contents.size() > maximumClassicZipValue) {
            return std::unexpected(
                core::error("zip_entry_too_large",
                            "A ZIP entry exceeds the supported 4 GiB size limit."));
        }
        estimatedSize += 30U + entry.path.size() + entry.contents.size();
        estimatedSize += 46U + entry.path.size();
        if (estimatedSize > maximumClassicZipValue) {
            return std::unexpected(
                core::error("zip_package_too_large",
                            "The ZIP package exceeds the supported 4 GiB limit."));
        }
    }

    std::vector<std::byte> output;
    output.reserve(static_cast<std::size_t>(estimatedSize));
    std::vector<CentralDirectoryEntry> directory;
    directory.reserve(entries.size());
    for (const ZipEntry& entry : entries) {
        const auto localOffset = output.size();
        const auto size = static_cast<std::uint32_t>(entry.contents.size());
        const std::uint32_t checksum = archive::crc32(entry.contents);
        appendLittle<std::uint32_t>(output, 0x04034b50U);
        appendLittle<std::uint16_t>(output, 20);
        appendLittle<std::uint16_t>(output, 1U << 11U);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0x0021U);
        appendLittle(output, checksum);
        appendLittle(output, size);
        appendLittle(output, size);
        appendLittle<std::uint16_t>(output, static_cast<std::uint16_t>(entry.path.size()));
        appendLittle<std::uint16_t>(output, 0);
        appendBytes(output, entry.path);
        output.insert(output.end(), entry.contents.begin(), entry.contents.end());
        directory.push_back({entry.path, checksum, size, static_cast<std::uint32_t>(localOffset)});
    }

    const auto directoryOffset = output.size();
    for (const CentralDirectoryEntry& entry : directory) {
        appendLittle<std::uint32_t>(output, 0x02014b50U);
        appendLittle<std::uint16_t>(output, 20);
        appendLittle<std::uint16_t>(output, 20);
        appendLittle<std::uint16_t>(output, 1U << 11U);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0x0021U);
        appendLittle(output, entry.checksum);
        appendLittle(output, entry.size);
        appendLittle(output, entry.size);
        appendLittle<std::uint16_t>(output, static_cast<std::uint16_t>(entry.path.size()));
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint16_t>(output, 0);
        appendLittle<std::uint32_t>(output, 0);
        appendLittle(output, entry.localOffset);
        appendBytes(output, entry.path);
    }

    const auto directorySize = output.size() - directoryOffset;
    if (directoryOffset > maximumClassicZipValue || directorySize > maximumClassicZipValue) {
        return std::unexpected(
            core::error("zip_package_too_large",
                        "The ZIP directory exceeds the classic ZIP size limit."));
    }
    appendLittle<std::uint32_t>(output, 0x06054b50U);
    appendLittle<std::uint16_t>(output, 0);
    appendLittle<std::uint16_t>(output, 0);
    appendLittle<std::uint16_t>(output, static_cast<std::uint16_t>(directory.size()));
    appendLittle<std::uint16_t>(output, static_cast<std::uint16_t>(directory.size()));
    appendLittle<std::uint32_t>(output, static_cast<std::uint32_t>(directorySize));
    appendLittle<std::uint32_t>(output, static_cast<std::uint32_t>(directoryOffset));
    appendLittle<std::uint16_t>(output, 0);
    return output;
}

} // namespace tutorux::command

#pragma once

#include "tutorux/archive/format.hpp"
#include "tutorux/core/result.hpp"

#include <filesystem>
#include <memory>
#include <span>

namespace tutorux::archive {

    class ArchiveFile final {
      public:
        ArchiveFile() = default;
        ArchiveFile(const ArchiveFile&) = delete;
        ArchiveFile& operator=(const ArchiveFile&) = delete;
        ArchiveFile(ArchiveFile&& other) noexcept;
        ArchiveFile& operator=(ArchiveFile&& other) noexcept;
        ~ArchiveFile();

        static core::Result<ArchiveFile> open(const std::filesystem::path& path, bool writable,
                                              bool createNew = false);

        core::Result<Bytes> read(std::uint64_t offset, std::size_t length) const;
        core::Status readInto(std::uint64_t offset, std::span<std::byte> output) const;
        core::Status write(std::uint64_t offset, std::span<const std::byte> bytes);
        core::Status append(std::span<const std::byte> bytes, std::uint64_t& offset);
        core::Status flush();
        core::Result<std::uint64_t> size() const;
        const std::filesystem::path& path() const {
            return path_;
        }
        bool writable() const {
            return writable_;
        }

      private:
        void close() noexcept;
        std::filesystem::path path_;
        bool writable_{};
        void* nativeHandle_{};
    };

} // namespace tutorux::archive

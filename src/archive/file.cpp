#include "tutorux/archive/file.hpp"

#include <algorithm>
#include <cerrno>
#include <limits>
#include <system_error>

#ifdef _WIN32
#include <Windows.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace tutorux::archive {
    namespace {

        core::Error fileError(std::string code, const std::filesystem::path& path,
                              std::string_view operation) {
#ifdef _WIN32
            const auto nativeError = static_cast<unsigned long>(GetLastError());
            return core::error(std::move(code), std::string(operation) + " '" + path.string() +
                                                    "' failed (Windows error " +
                                                    std::to_string(nativeError) + ").");
#else
            return core::error(std::move(code), std::string(operation) + " '" + path.string() +
                                                    "': " + std::generic_category().message(errno));
#endif
        }

    } // namespace

    ArchiveFile::ArchiveFile(ArchiveFile&& other) noexcept
        : path_(std::move(other.path_)), writable_(other.writable_),
          nativeHandle_(std::exchange(other.nativeHandle_, nullptr)) {}

    ArchiveFile& ArchiveFile::operator=(ArchiveFile&& other) noexcept {
        if (this != &other) {
            close();
            path_ = std::move(other.path_);
            writable_ = other.writable_;
            nativeHandle_ = std::exchange(other.nativeHandle_, nullptr);
        }
        return *this;
    }

    ArchiveFile::~ArchiveFile() {
        close();
    }

    core::Result<ArchiveFile> ArchiveFile::open(const std::filesystem::path& path, bool writable,
                                                bool createNew) {
        ArchiveFile file;
        file.path_ = path;
        file.writable_ = writable;
#ifdef _WIN32
        const DWORD access = writable ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ;
        const DWORD disposition = createNew ? CREATE_NEW : OPEN_EXISTING;
        HANDLE handle =
            CreateFileW(path.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
                        disposition, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, nullptr);
        if (handle == INVALID_HANDLE_VALUE) {
            return std::unexpected(fileError(createNew ? "archive_exists" : "archive_open_failed",
                                             path, "Opening archive"));
        }
        OVERLAPPED range{};
        const DWORD lockFlags =
            LOCKFILE_FAIL_IMMEDIATELY | (writable ? LOCKFILE_EXCLUSIVE_LOCK : 0U);
        if (!LockFileEx(handle, lockFlags, 0, MAXDWORD, MAXDWORD, &range)) {
            const auto error = fileError("archive_locked", path, "Locking archive");
            CloseHandle(handle);
            return std::unexpected(error);
        }
        file.nativeHandle_ = handle;
#else
        int flags = writable ? O_RDWR : O_RDONLY;
        if (createNew)
            flags |= O_CREAT | O_EXCL;
        const int descriptor = ::open(path.c_str(), flags, 0600);
        if (descriptor < 0) {
            return std::unexpected(
                fileError(createNew && errno == EEXIST ? "archive_exists" : "archive_open_failed",
                          path, "Opening archive"));
        }
        const int lockType = writable ? LOCK_EX : LOCK_SH;
        if (::flock(descriptor, lockType | LOCK_NB) != 0) {
            const auto error = fileError("archive_locked", path, "Locking archive");
            ::close(descriptor);
            return std::unexpected(error);
        }
        file.nativeHandle_ = reinterpret_cast<void*>(static_cast<std::intptr_t>(descriptor));
#endif
        return file;
    }

    core::Result<Bytes> ArchiveFile::read(std::uint64_t offset, std::size_t length) const {
        Bytes bytes(length);
        if (auto status = readInto(offset, bytes); !status)
            return std::unexpected(status.error());
        return bytes;
    }

    core::Status ArchiveFile::readInto(std::uint64_t offset, std::span<std::byte> output) const {
        if (!nativeHandle_)
            return std::unexpected(core::error("archive_closed", "Archive is closed."));
        if (offset > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max()) ||
            output.size() > static_cast<std::size_t>(std::numeric_limits<std::int64_t>::max()) ||
            offset + output.size() >
                static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
            return std::unexpected(core::error("archive_offset_invalid",
                                               "Archive read at offset " + std::to_string(offset) +
                                                   " with length " + std::to_string(output.size()) +
                                                   " exceeds the supported file range."));
        }
        std::size_t total = 0;
        while (total < output.size()) {
#ifdef _WIN32
            OVERLAPPED position{};
            const std::uint64_t absoluteOffset = offset + total;
            position.Offset = static_cast<DWORD>(absoluteOffset & 0xffffffffULL);
            position.OffsetHigh = static_cast<DWORD>(absoluteOffset >> 32U);
            position.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (!position.hEvent) {
                return std::unexpected(
                    fileError("archive_read_failed", path_, "Creating read event"));
            }
            DWORD transferred = 0;
            const DWORD requested = static_cast<DWORD>(
                std::min<std::size_t>(output.size() - total, static_cast<std::size_t>(MAXDWORD)));
            BOOL succeeded = ReadFile(static_cast<HANDLE>(nativeHandle_), output.data() + total,
                                      requested, &transferred, &position);
            if (!succeeded && GetLastError() == ERROR_IO_PENDING) {
                succeeded = GetOverlappedResult(static_cast<HANDLE>(nativeHandle_), &position,
                                                &transferred, TRUE);
            }
            const DWORD ioError = succeeded ? ERROR_SUCCESS : GetLastError();
            CloseHandle(position.hEvent);
            if (!succeeded)
                return std::unexpected(
                    core::error("archive_read_failed", "Reading archive '" + path_.string() +
                                                           "' failed (Windows error " +
                                                           std::to_string(ioError) + ")."));
            if (transferred == 0) {
                return std::unexpected(
                    core::error("archive_truncated", "Unexpected end of archive."));
            }
#else
            const auto descriptor =
                static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
            const ssize_t transferred =
                ::pread(descriptor, output.data() + total, output.size() - total,
                        static_cast<off_t>(offset + total));
            if (transferred < 0) {
                if (errno == EINTR)
                    continue;
                return std::unexpected(fileError("archive_read_failed", path_, "Reading archive"));
            }
            if (transferred == 0) {
                return std::unexpected(
                    core::error("archive_truncated", "Unexpected end of archive."));
            }
#endif
            total += static_cast<std::size_t>(transferred);
        }
        return {};
    }

    core::Status ArchiveFile::write(std::uint64_t offset, std::span<const std::byte> bytes) {
        if (!writable_ || !nativeHandle_) {
            return std::unexpected(
                core::error("archive_read_only", "Archive was opened read-only."));
        }
        std::size_t total = 0;
        while (total < bytes.size()) {
#ifdef _WIN32
            OVERLAPPED position{};
            const std::uint64_t absoluteOffset = offset + total;
            position.Offset = static_cast<DWORD>(absoluteOffset & 0xffffffffULL);
            position.OffsetHigh = static_cast<DWORD>(absoluteOffset >> 32U);
            position.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (!position.hEvent) {
                return std::unexpected(
                    fileError("archive_write_failed", path_, "Creating write event"));
            }
            DWORD transferred = 0;
            const DWORD requested = static_cast<DWORD>(
                std::min<std::size_t>(bytes.size() - total, static_cast<std::size_t>(MAXDWORD)));
            BOOL succeeded = WriteFile(static_cast<HANDLE>(nativeHandle_), bytes.data() + total,
                                       requested, &transferred, &position);
            if (!succeeded && GetLastError() == ERROR_IO_PENDING) {
                succeeded = GetOverlappedResult(static_cast<HANDLE>(nativeHandle_), &position,
                                                &transferred, TRUE);
            }
            const DWORD ioError = succeeded ? ERROR_SUCCESS : GetLastError();
            CloseHandle(position.hEvent);
            if (!succeeded)
                return std::unexpected(
                    core::error("archive_write_failed", "Writing archive '" + path_.string() +
                                                            "' failed (Windows error " +
                                                            std::to_string(ioError) + ")."));
            if (transferred == 0) {
                return std::unexpected(
                    core::error("archive_write_failed", "Archive write made no progress."));
            }
#else
            const auto descriptor =
                static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
            const ssize_t transferred =
                ::pwrite(descriptor, bytes.data() + total, bytes.size() - total,
                         static_cast<off_t>(offset + total));
            if (transferred < 0) {
                if (errno == EINTR)
                    continue;
                return std::unexpected(fileError("archive_write_failed", path_, "Writing archive"));
            }
            if (transferred == 0) {
                return std::unexpected(
                    core::error("archive_write_failed", "Archive write made no progress."));
            }
#endif
            total += static_cast<std::size_t>(transferred);
        }
        return {};
    }

    core::Status ArchiveFile::append(std::span<const std::byte> bytes, std::uint64_t& offset) {
        auto currentSize = size();
        if (!currentSize)
            return std::unexpected(currentSize.error());
        offset = *currentSize;
        return write(offset, bytes);
    }

    core::Status ArchiveFile::flush() {
        if (!writable_ || !nativeHandle_) {
            return std::unexpected(
                core::error("archive_read_only", "Archive was opened read-only."));
        }
#ifdef _WIN32
        if (!FlushFileBuffers(static_cast<HANDLE>(nativeHandle_))) {
#else
        const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
        if (::fsync(descriptor) != 0) {
#endif
            return std::unexpected(fileError("archive_flush_failed", path_, "Flushing archive"));
        }
        return {};
    }

    core::Result<std::uint64_t> ArchiveFile::size() const {
        if (!nativeHandle_)
            return std::unexpected(core::error("archive_closed", "Archive is closed."));
#ifdef _WIN32
        LARGE_INTEGER result{};
        if (!GetFileSizeEx(static_cast<HANDLE>(nativeHandle_), &result) || result.QuadPart < 0) {
#else
        struct stat status{};
        const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
        if (::fstat(descriptor, &status) != 0 || status.st_size < 0) {
#endif
            return std::unexpected(fileError("archive_stat_failed", path_, "Reading archive size"));
        }
#ifdef _WIN32
        return static_cast<std::uint64_t>(result.QuadPart);
#else
        return static_cast<std::uint64_t>(status.st_size);
#endif
    }

    void ArchiveFile::close() noexcept {
        if (!nativeHandle_)
            return;
#ifdef _WIN32
        OVERLAPPED range{};
        UnlockFileEx(static_cast<HANDLE>(nativeHandle_), 0, MAXDWORD, MAXDWORD, &range);
        CloseHandle(static_cast<HANDLE>(nativeHandle_));
#else
        const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
        ::flock(descriptor, LOCK_UN);
        ::close(descriptor);
#endif
        nativeHandle_ = nullptr;
    }

} // namespace tutorux::archive

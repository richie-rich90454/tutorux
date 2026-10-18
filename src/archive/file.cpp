#include "tutorux/archive/file.hpp"

#include <algorithm>
#include <cerrno>
#include <limits>
#include <system_error>

#ifdef _WIN32
#include <Windows.h>
#else
#include <fcntl.h>
#ifndef __EMSCRIPTEN__
#include <sys/file.h>
#endif
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

    bool needsStablePathLock(const std::filesystem::path& path) {
#ifdef __EMSCRIPTEN__
        static_cast<void>(path);
        return false;
#else
        return path.extension() != ".partial";
#endif
    }

    std::filesystem::path stableLockPath(const std::filesystem::path& path) {
        std::error_code errorCode;
        auto lockBase = std::filesystem::weakly_canonical(path, errorCode);
        if (errorCode) {
            errorCode.clear();
            lockBase = std::filesystem::absolute(path, errorCode);
        }
        if (errorCode)
            lockBase = path.lexically_normal();

        auto filename = lockBase.filename().native();
        filename.insert(filename.begin(), static_cast<std::filesystem::path::value_type>('.'));
        filename += std::filesystem::path(".lock").native();
        return lockBase.parent_path() / std::filesystem::path(filename);
    }

    core::Result<void*> openAndLockPath(const std::filesystem::path& archivePath, bool writable) {
#ifdef __EMSCRIPTEN__
        static_cast<void>(writable);
#endif
        const auto lockPath = stableLockPath(archivePath);
#ifdef _WIN32
        HANDLE handle = CreateFileW(
            lockPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr,
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_HIDDEN | FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
        if (handle == INVALID_HANDLE_VALUE) {
            const DWORD error = GetLastError();
            if (!writable && (error == ERROR_ACCESS_DENIED || error == ERROR_WRITE_PROTECT)) {
                return std::unexpected(core::error(
                    "archive_path_lock_unavailable",
                    "The archive directory does not permit creating its coordination lock."));
            }
            return std::unexpected(
                fileError("archive_path_lock_open_failed", lockPath, "Opening archive lock"));
        }
        BY_HANDLE_FILE_INFORMATION information{};
        if (!GetFileInformationByHandle(handle, &information) ||
            (information.dwFileAttributes &
             (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
            CloseHandle(handle);
            return std::unexpected(core::error("archive_path_lock_invalid",
                                               "Archive lock path is not a regular file."));
        }
        OVERLAPPED range{};
        const DWORD lockFlags =
            LOCKFILE_FAIL_IMMEDIATELY | (writable ? LOCKFILE_EXCLUSIVE_LOCK : 0U);
        if (!LockFileEx(handle, lockFlags, 0, MAXDWORD, MAXDWORD, &range)) {
            const auto error = fileError("archive_locked", archivePath, "Locking archive path");
            CloseHandle(handle);
            return std::unexpected(error);
        }
        return static_cast<void*>(handle);
#else
        int flags = O_RDONLY | O_CREAT;
#ifdef O_CLOEXEC
        flags |= O_CLOEXEC;
#endif
#ifdef O_NOFOLLOW
        flags |= O_NOFOLLOW;
#endif
        const int descriptor = ::open(lockPath.c_str(), flags, 0666);
        if (descriptor < 0) {
            if (!writable && (errno == EACCES || errno == EROFS)) {
                return std::unexpected(core::error(
                    "archive_path_lock_unavailable",
                    "The archive directory does not permit creating its coordination lock."));
            }
            return std::unexpected(
                fileError("archive_path_lock_open_failed", lockPath, "Opening archive lock"));
        }
        struct stat information{};
        if (::fstat(descriptor, &information) != 0 || !S_ISREG(information.st_mode)) {
            const auto error =
                fileError("archive_path_lock_invalid", lockPath, "Inspecting archive lock");
            ::close(descriptor);
            return std::unexpected(error);
        }
#ifndef __EMSCRIPTEN__
        const int lockType = writable ? LOCK_EX : LOCK_SH;
        if (::flock(descriptor, lockType | LOCK_NB) != 0) {
            const auto error = fileError("archive_locked", archivePath, "Locking archive path");
            ::close(descriptor);
            return std::unexpected(error);
        }
#endif
        return reinterpret_cast<void*>(static_cast<std::intptr_t>(descriptor));
#endif
    }

} // namespace

ArchiveFile::ArchiveFile(ArchiveFile&& other) noexcept
    : path_(std::move(other.path_))
    , writable_(other.writable_)
    , nativeHandle_(std::exchange(other.nativeHandle_, nullptr))
    , pathLockHandle_(std::exchange(other.pathLockHandle_, nullptr)) {}

ArchiveFile& ArchiveFile::operator=(ArchiveFile&& other) noexcept {
    if (this != &other) {
        close();
        path_ = std::move(other.path_);
        writable_ = other.writable_;
        nativeHandle_ = std::exchange(other.nativeHandle_, nullptr);
        pathLockHandle_ = std::exchange(other.pathLockHandle_, nullptr);
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
    if (needsStablePathLock(path)) {
        auto pathLock = openAndLockPath(path, writable);
        if (!pathLock && (writable || pathLock.error().code != "archive_path_lock_unavailable")) {
            return std::unexpected(pathLock.error());
        }
        if (pathLock)
            file.pathLockHandle_ = *pathLock;
    }
    if (auto status = file.openDataHandle(createNew); !status)
        return std::unexpected(status.error());
    return file;
}

core::Status ArchiveFile::openDataHandle(bool createNew) {
#ifdef _WIN32
    const DWORD access = writable_ ? (GENERIC_READ | GENERIC_WRITE) : GENERIC_READ;
    const DWORD disposition = createNew ? CREATE_NEW : OPEN_EXISTING;
    const DWORD shareMode = FILE_SHARE_READ | FILE_SHARE_WRITE |
                            (path_.extension() == ".partial" ? FILE_SHARE_DELETE : 0U);
    HANDLE handle = CreateFileW(path_.c_str(), access, shareMode, nullptr, disposition,
                                FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OVERLAPPED, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        return std::unexpected(fileError(createNew ? "archive_exists" : "archive_open_failed",
                                         path_, "Opening archive"));
    }
    OVERLAPPED range{};
    const DWORD lockFlags = LOCKFILE_FAIL_IMMEDIATELY | (writable_ ? LOCKFILE_EXCLUSIVE_LOCK : 0U);
    if (!LockFileEx(handle, lockFlags, 0, MAXDWORD, MAXDWORD, &range)) {
        const auto error = fileError("archive_locked", path_, "Locking archive");
        CloseHandle(handle);
        return std::unexpected(error);
    }
    nativeHandle_ = handle;
#else
    int flags = writable_ ? O_RDWR : O_RDONLY;
    if (createNew)
        flags |= O_CREAT | O_EXCL;
    const int descriptor = ::open(path_.c_str(), flags, 0600);
    if (descriptor < 0) {
        return std::unexpected(
            fileError(createNew && errno == EEXIST ? "archive_exists" : "archive_open_failed",
                      path_, "Opening archive"));
    }
#ifndef __EMSCRIPTEN__
    const int lockType = writable_ ? LOCK_EX : LOCK_SH;
    if (::flock(descriptor, lockType | LOCK_NB) != 0) {
        const auto error = fileError("archive_locked", path_, "Locking archive");
        ::close(descriptor);
        return std::unexpected(error);
    }
#endif
    nativeHandle_ = reinterpret_cast<void*>(static_cast<std::intptr_t>(descriptor));
#endif
    return {};
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
            return std::unexpected(fileError("archive_read_failed", path_, "Creating read event"));
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
            return std::unexpected(core::error("archive_truncated", "Unexpected end of archive."));
        }
#else
        const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
        const ssize_t transferred =
            ::pread(descriptor, output.data() + total, output.size() - total,
                    static_cast<off_t>(offset + total));
        if (transferred < 0) {
            if (errno == EINTR)
                continue;
            return std::unexpected(fileError("archive_read_failed", path_, "Reading archive"));
        }
        if (transferred == 0) {
            return std::unexpected(core::error("archive_truncated", "Unexpected end of archive."));
        }
#endif
        total += static_cast<std::size_t>(transferred);
    }
    return {};
}

core::Status ArchiveFile::write(std::uint64_t offset, std::span<const std::byte> bytes) {
    if (!writable_ || !nativeHandle_) {
        return std::unexpected(core::error("archive_read_only", "Archive was opened read-only."));
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
        const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
        const ssize_t transferred = ::pwrite(descriptor, bytes.data() + total, bytes.size() - total,
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
        return std::unexpected(core::error("archive_read_only", "Archive was opened read-only."));
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

core::Status ArchiveFile::truncate(std::uint64_t length) {
    if (!writable_ || !nativeHandle_) {
        return std::unexpected(core::error("archive_read_only", "Archive was opened read-only."));
    }
    if (length > static_cast<std::uint64_t>(std::numeric_limits<std::int64_t>::max())) {
        return std::unexpected(core::error("archive_offset_invalid",
                                           "Archive truncation exceeds the supported file range."));
    }
#ifdef _WIN32
    FILE_END_OF_FILE_INFO end{};
    end.EndOfFile.QuadPart = static_cast<LONGLONG>(length);
    if (!SetFileInformationByHandle(static_cast<HANDLE>(nativeHandle_), FileEndOfFileInfo, &end,
                                    sizeof(end))) {
#else
    const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
    if (::ftruncate(descriptor, static_cast<off_t>(length)) != 0) {
#endif
        return std::unexpected(fileError("archive_truncate_failed", path_, "Truncating archive"));
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

void ArchiveFile::closeDataForAtomicReplace() noexcept {
    closeDataHandle();
}

core::Status ArchiveFile::reopenDataAfterAtomicReplace() {
    if (nativeHandle_) {
        return std::unexpected(
            core::error("archive_handle_state_invalid", "Archive data handle is already open."));
    }
    return openDataHandle(false);
}

void ArchiveFile::closeDataHandle() noexcept {
    if (!nativeHandle_)
        return;
#ifdef _WIN32
    OVERLAPPED range{};
    UnlockFileEx(static_cast<HANDLE>(nativeHandle_), 0, MAXDWORD, MAXDWORD, &range);
    CloseHandle(static_cast<HANDLE>(nativeHandle_));
#else
    const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(nativeHandle_));
#ifndef __EMSCRIPTEN__
    ::flock(descriptor, LOCK_UN);
#endif
    ::close(descriptor);
#endif
    nativeHandle_ = nullptr;
}

void ArchiveFile::closePathLock() noexcept {
    if (!pathLockHandle_)
        return;
#ifdef _WIN32
    OVERLAPPED range{};
    UnlockFileEx(static_cast<HANDLE>(pathLockHandle_), 0, MAXDWORD, MAXDWORD, &range);
    CloseHandle(static_cast<HANDLE>(pathLockHandle_));
#else
    const auto descriptor = static_cast<int>(reinterpret_cast<std::intptr_t>(pathLockHandle_));
#ifndef __EMSCRIPTEN__
    ::flock(descriptor, LOCK_UN);
#endif
    ::close(descriptor);
#endif
    pathLockHandle_ = nullptr;
}

void ArchiveFile::close() noexcept {
    closeDataHandle();
    closePathLock();
}

} // namespace tutorux::archive

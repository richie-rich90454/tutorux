#include "tutorux/audio/recording_control.hpp"

#include "tutorux/domain/hash.hpp"

#include <algorithm>
#include <array>
#include <chrono>
#include <csignal>
#include <exception>
#include <memory>
#include <mutex>
#include <span>
#include <system_error>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#include <sddl.h>
#else
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#ifdef __APPLE__
#include <mach-o/dyld.h>
#endif
#endif

namespace tutorux::audio {
namespace {

    struct WorkerState final {
        std::atomic_bool stop{};
        std::atomic_bool pause{};
        std::atomic_bool finished{};
        std::atomic_bool serverReady{};
        std::mutex mutex;
        std::string state{"starting"};
        std::string message{"Recording worker is starting."};

        RecordingControlResponse snapshot() {
            std::lock_guard lock(mutex);
            return {state, message};
        }

        void set(std::string nextState, std::string nextMessage) {
            std::lock_guard lock(mutex);
            state = std::move(nextState);
            message = std::move(nextMessage);
        }
    };

    std::string encodeHex(std::string_view value) {
        constexpr char digits[] = "0123456789abcdef";
        std::string encoded;
        encoded.reserve(value.size() * 2);
        for (const char character : value) {
            const auto byte = static_cast<unsigned char>(character);
            encoded.push_back(digits[byte >> 4U]);
            encoded.push_back(digits[byte & 0x0fU]);
        }
        return encoded;
    }

    core::Result<std::string> decodeHex(std::string_view value) {
        if (value.size() % 2 != 0) {
            return std::unexpected(
                core::error("recording_ipc_protocol_invalid", "Malformed IPC response."));
        }
        const auto digit = [](char value) -> int {
            if (value >= '0' && value <= '9')
                return value - '0';
            if (value >= 'a' && value <= 'f')
                return value - 'a' + 10;
            if (value >= 'A' && value <= 'F')
                return value - 'A' + 10;
            return -1;
        };
        std::string decoded;
        decoded.reserve(value.size() / 2);
        for (std::size_t index = 0; index < value.size(); index += 2) {
            const int high = digit(value[index]);
            const int low = digit(value[index + 1]);
            if (high < 0 || low < 0) {
                return std::unexpected(
                    core::error("recording_ipc_protocol_invalid", "Malformed IPC response."));
            }
            decoded.push_back(static_cast<char>((high << 4) | low));
        }
        return decoded;
    }

    std::string
    encodeResponse(std::string_view kind, std::string_view state, std::string_view message) {
        return std::string(kind) + "\t" + std::string(state) + "\t" + encodeHex(message) + "\n";
    }

    core::Result<RecordingControlResponse> parseResponse(std::string_view response) {
        if (!response.empty() && response.back() == '\n')
            response.remove_suffix(1);
        const std::size_t firstTab = response.find('\t');
        const std::size_t secondTab =
            firstTab == std::string_view::npos ? firstTab : response.find('\t', firstTab + 1);
        if (firstTab == std::string_view::npos || secondTab == std::string_view::npos) {
            return std::unexpected(
                core::error("recording_ipc_protocol_invalid", "Malformed IPC response."));
        }
        if (response.substr(0, firstTab) != "OK") {
            auto message = decodeHex(response.substr(secondTab + 1));
            if (!message)
                return std::unexpected(message.error());
            return std::unexpected(
                core::error(std::string(response.substr(firstTab + 1, secondTab - firstTab - 1)),
                            std::move(*message)));
        }
        auto message = decodeHex(response.substr(secondTab + 1));
        if (!message)
            return std::unexpected(message.error());
        return RecordingControlResponse{
            std::string(response.substr(firstTab + 1, secondTab - firstTab - 1)),
            std::move(*message)};
    }

    std::string makeResponse(const std::shared_ptr<WorkerState>& state, std::string_view command) {
        if (command == "status") {
            const auto current = state->snapshot();
            return encodeResponse("OK", current.state, current.message);
        }
        if (command == "stop") {
            const auto current = state->snapshot();
            if (current.state == "completed" || current.state == "failed" ||
                current.state == "interrupted") {
                return encodeResponse("OK", current.state, current.message);
            }
            state->stop.store(true, std::memory_order_release);
            return encodeResponse("OK", "stop-requested", "Recording stop was requested.");
        }
        if (command == "pause") {
            const auto current = state->snapshot();
            if (current.state != "recording") {
                return encodeResponse("ERR",
                                      "recording_not_active",
                                      "Recording is not in the active state.");
            }
            state->pause.store(true, std::memory_order_release);
            return encodeResponse("OK", "pause-requested", "Recording pause was requested.");
        }
        if (command == "resume") {
            const auto current = state->snapshot();
            if (current.state != "paused") {
                return encodeResponse("ERR", "recording_not_paused", "Recording is not paused.");
            }
            state->pause.store(false, std::memory_order_release);
            return encodeResponse("OK", "resume-requested", "Recording resume was requested.");
        }
        return encodeResponse("ERR",
                              "recording_ipc_command_invalid",
                              "Unsupported recording control command.");
    }

#ifdef _WIN32
    core::Result<std::wstring> toWide(std::string_view text) {
        if (text.empty())
            return std::wstring{};
        const int required = MultiByteToWideChar(CP_UTF8,
                                                 MB_ERR_INVALID_CHARS,
                                                 text.data(),
                                                 static_cast<int>(text.size()),
                                                 nullptr,
                                                 0);
        if (required <= 0) {
            return std::unexpected(core::error("recording_ipc_encoding_failed",
                                               "Unable to encode the local IPC name."));
        }
        std::wstring converted(static_cast<std::size_t>(required), L'\0');
        if (MultiByteToWideChar(CP_UTF8,
                                MB_ERR_INVALID_CHARS,
                                text.data(),
                                static_cast<int>(text.size()),
                                converted.data(),
                                required) != required) {
            return std::unexpected(core::error("recording_ipc_encoding_failed",
                                               "Unable to encode the local IPC name."));
        }
        return converted;
    }

    std::wstring quoteWindowsArgument(std::wstring_view argument) {
        if (argument.find_first_of(L" \t\n\v\"") == std::wstring_view::npos)
            return std::wstring(argument);
        std::wstring quoted(1, L'"');
        std::size_t backslashes = 0;
        for (const wchar_t character : argument) {
            if (character == L'\\') {
                ++backslashes;
            } else if (character == L'"') {
                quoted.append(backslashes * 2 + 1, L'\\');
                quoted.push_back(L'"');
                backslashes = 0;
            } else {
                quoted.append(backslashes, L'\\');
                quoted.push_back(character);
                backslashes = 0;
            }
        }
        quoted.append(backslashes * 2, L'\\');
        quoted.push_back(L'"');
        return quoted;
    }

    std::filesystem::path currentExecutablePath() {
        std::vector<wchar_t> buffer(32'768);
        const DWORD length =
            GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (length == 0 || length >= buffer.size())
            return {};
        return std::filesystem::path(std::wstring(buffer.data(), length));
    }

    void serveWorker(const std::wstring& endpoint,
                     const std::shared_ptr<WorkerState>& state,
                     std::stop_token stopToken) {
        PSECURITY_DESCRIPTOR descriptor = nullptr;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(L"D:P(A;;GA;;;SY)(A;;GA;;;OW)",
                                                                  SDDL_REVISION_1,
                                                                  &descriptor,
                                                                  nullptr)) {
            state->set("failed", "Unable to secure the Windows recording control pipe.");
            state->serverReady.store(true, std::memory_order_release);
            return;
        }
        SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), descriptor, FALSE};
        while (!stopToken.stop_requested() && !state->finished.load(std::memory_order_acquire)) {
            HANDLE pipe = CreateNamedPipeW(endpoint.c_str(),
                                           PIPE_ACCESS_DUPLEX,
                                           PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT,
                                           1,
                                           4096,
                                           4096,
                                           100,
                                           &security);
            if (pipe == INVALID_HANDLE_VALUE) {
                state->set("failed", "Unable to create the Windows recording control pipe.");
                state->serverReady.store(true, std::memory_order_release);
                break;
            }
            state->serverReady.store(true, std::memory_order_release);
            BOOL connected = ConnectNamedPipe(pipe, nullptr);
            if (!connected && GetLastError() == ERROR_PIPE_CONNECTED)
                connected = TRUE;
            while (!connected && !stopToken.stop_requested() &&
                   !state->finished.load(std::memory_order_acquire)) {
                if (GetLastError() != ERROR_PIPE_LISTENING)
                    break;
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                connected = ConnectNamedPipe(pipe, nullptr);
                if (!connected && GetLastError() == ERROR_PIPE_CONNECTED)
                    connected = TRUE;
            }
            if (connected) {
                std::array<char, 128> request{};
                std::size_t requestSize = 0;
                bool requestReady = false;
                const auto requestDeadline =
                    std::chrono::steady_clock::now() + std::chrono::seconds(2);
                while (!requestReady && requestSize < request.size() - 1 &&
                       !stopToken.stop_requested() &&
                       std::chrono::steady_clock::now() < requestDeadline &&
                       !state->finished.load(std::memory_order_acquire)) {
                    DWORD bytesRead = 0;
                    const BOOL read = ReadFile(pipe,
                                               request.data() + requestSize,
                                               static_cast<DWORD>(request.size() - requestSize - 1),
                                               &bytesRead,
                                               nullptr);
                    if (read && bytesRead > 0) {
                        requestSize += bytesRead;
                        request[requestSize] = '\0';
                        requestReady =
                            std::find(request.begin(), request.begin() + requestSize, '\n') !=
                            request.begin() + requestSize;
                    } else if (!read && GetLastError() != ERROR_NO_DATA) {
                        break;
                    } else {
                        std::this_thread::sleep_for(std::chrono::milliseconds(20));
                    }
                }
                if (requestReady) {
                    const std::string_view line(request.data(), requestSize);
                    const auto newline = line.find('\n');
                    const std::string response = makeResponse(state, line.substr(0, newline));
                    DWORD bytesWritten = 0;
                    WriteFile(pipe,
                              response.data(),
                              static_cast<DWORD>(response.size()),
                              &bytesWritten,
                              nullptr);
                }
                FlushFileBuffers(pipe);
                DisconnectNamedPipe(pipe);
            }
            CloseHandle(pipe);
        }
        LocalFree(descriptor);
    }

    core::Result<std::string> transact(const std::wstring& endpoint, std::string_view command) {
        const std::string request = std::string(command) + "\n";
        for (int attempt = 0; attempt < 10; ++attempt) {
            if (!WaitNamedPipeW(endpoint.c_str(), 500)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
            HANDLE pipe = CreateFileW(endpoint.c_str(),
                                      GENERIC_READ | GENERIC_WRITE,
                                      0,
                                      nullptr,
                                      OPEN_EXISTING,
                                      0,
                                      nullptr);
            if (pipe == INVALID_HANDLE_VALUE) {
                std::this_thread::sleep_for(std::chrono::milliseconds(20));
                continue;
            }
            DWORD bytesWritten = 0;
            const BOOL writeSucceeded = WriteFile(pipe,
                                                  request.data(),
                                                  static_cast<DWORD>(request.size()),
                                                  &bytesWritten,
                                                  nullptr);
            std::array<char, 4096> response{};
            DWORD bytesRead = 0;
            const BOOL readSucceeded =
                writeSucceeded && ReadFile(pipe,
                                           response.data(),
                                           static_cast<DWORD>(response.size() - 1),
                                           &bytesRead,
                                           nullptr);
            CloseHandle(pipe);
            if (readSucceeded && bytesRead != 0)
                return std::string(response.data(), bytesRead);
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        return std::unexpected(core::error("recording_ipc_connection_failed",
                                           "The recording worker closed its pipe."));
    }
#else
    std::filesystem::path currentExecutablePath() {
#ifdef __APPLE__
        std::uint32_t required = 0;
        static_cast<void>(_NSGetExecutablePath(nullptr, &required));
        std::vector<char> buffer(required + 1);
        if (required > 0 && _NSGetExecutablePath(buffer.data(), &required) == 0)
            return std::filesystem::absolute(buffer.data());
#else
        std::error_code errorCode;
        auto executable = std::filesystem::read_symlink("/proc/self/exe", errorCode);
        if (!errorCode)
            return executable;
#endif
        return {};
    }

    core::Result<sockaddr_un> unixAddress(std::string_view endpoint) {
        sockaddr_un address{};
        address.sun_family = AF_UNIX;
        if (endpoint.size() >= sizeof(address.sun_path)) {
            return std::unexpected(core::error("recording_ipc_path_invalid",
                                               "The local IPC socket path is too long."));
        }
        std::memcpy(address.sun_path, endpoint.data(), endpoint.size());
        address.sun_path[endpoint.size()] = '\0';
        return address;
    }

    core::Result<int> makeSocket(std::string_view endpoint) {
        const int descriptor = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (descriptor < 0)
            return std::unexpected(core::error("recording_ipc_socket_failed", strerror(errno)));
        auto address = unixAddress(endpoint);
        if (!address) {
            ::close(descriptor);
            return std::unexpected(address.error());
        }
        if (::connect(descriptor,
                      reinterpret_cast<const sockaddr*>(&*address),
                      sizeof(sockaddr_un)) != 0) {
            const int errorCode = errno;
            ::close(descriptor);
            return std::unexpected(core::error("recording_worker_not_found",
                                               "No recording worker is listening (" +
                                                   std::string(strerror(errorCode)) + ")."));
        }
        return descriptor;
    }

    void serveWorker(std::string_view endpoint,
                     const std::shared_ptr<WorkerState>& state,
                     std::stop_token stopToken) {
        auto address = unixAddress(endpoint);
        if (!address) {
            state->set("failed", address.error().message);
            state->serverReady.store(true, std::memory_order_release);
            return;
        }
        const int listener = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (listener < 0) {
            state->set("failed", "Unable to create the local recording socket.");
            state->serverReady.store(true, std::memory_order_release);
            return;
        }
        struct stat existing{};
        if (::lstat(std::string(endpoint).c_str(), &existing) == 0) {
            if (!S_ISSOCK(existing.st_mode) || existing.st_uid != ::getuid()) {
                state->set("failed", "The local recording socket path is occupied.");
                state->serverReady.store(true, std::memory_order_release);
                ::close(listener);
                return;
            }
            const int probe = ::socket(AF_UNIX, SOCK_STREAM, 0);
            if (probe < 0) {
                state->set("failed", "Unable to check the existing local recording socket.");
                state->serverReady.store(true, std::memory_order_release);
                ::close(listener);
                return;
            }
            const int connectResult =
                ::connect(probe, reinterpret_cast<const sockaddr*>(&*address), sizeof(sockaddr_un));
            const int connectError = errno;
            ::close(probe);
            if (connectResult == 0 || connectError != ECONNREFUSED) {
                state->set("failed", "A recording worker already owns this session socket.");
                state->serverReady.store(true, std::memory_order_release);
                ::close(listener);
                return;
            }
            ::unlink(std::string(endpoint).c_str());
        }
        if (::bind(listener, reinterpret_cast<const sockaddr*>(&*address), sizeof(sockaddr_un)) !=
            0) {
            state->set("failed", "Unable to bind the local recording socket.");
            state->serverReady.store(true, std::memory_order_release);
            ::close(listener);
            return;
        }
        if (::chmod(std::string(endpoint).c_str(), S_IRUSR | S_IWUSR) != 0 ||
            ::listen(listener, 8) != 0) {
            state->set("failed", "Unable to secure the local recording socket.");
            state->serverReady.store(true, std::memory_order_release);
            ::close(listener);
            ::unlink(std::string(endpoint).c_str());
            return;
        }
        state->serverReady.store(true, std::memory_order_release);
        pollfd waitForClient{listener, POLLIN, 0};
        while (!stopToken.stop_requested() && !state->finished.load(std::memory_order_acquire)) {
            const int ready = ::poll(&waitForClient, 1, 100);
            if (ready <= 0)
                continue;
            const int connection = ::accept(listener, nullptr, nullptr);
            if (connection < 0)
                continue;
            std::array<char, 128> request{};
            std::size_t requestSize = 0;
            bool requestReady = false;
            const auto requestDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
            while (!requestReady && requestSize < request.size() - 1 &&
                   std::chrono::steady_clock::now() < requestDeadline) {
                const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
                    requestDeadline - std::chrono::steady_clock::now());
                pollfd waitForRequest{connection, POLLIN, 0};
                const int ready = ::poll(&waitForRequest, 1, static_cast<int>(remaining.count()));
                if (ready <= 0)
                    break;
                const ssize_t count = ::read(connection,
                                             request.data() + requestSize,
                                             request.size() - requestSize - 1);
                if (count <= 0)
                    break;
                requestSize += static_cast<std::size_t>(count);
                request[requestSize] = '\0';
                requestReady = std::find(request.begin(), request.begin() + requestSize, '\n') !=
                               request.begin() + requestSize;
            }
            if (requestReady) {
                const std::string_view line(request.data(), requestSize);
                const auto newline = line.find('\n');
                const std::string response = makeResponse(state, line.substr(0, newline));
#ifdef __APPLE__
                const int noSignal = 1;
                setsockopt(connection, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, sizeof(noSignal));
#endif
                std::size_t written = 0;
                while (written < response.size()) {
                    const ssize_t count =
                        ::write(connection, response.data() + written, response.size() - written);
                    if (count < 0 && errno == EINTR)
                        continue;
                    if (count <= 0)
                        break;
                    written += static_cast<std::size_t>(count);
                }
            }
            ::close(connection);
        }
        ::close(listener);
        ::unlink(std::string(endpoint).c_str());
    }

    core::Result<std::string> transact(std::string_view endpoint, std::string_view command) {
        auto connection = makeSocket(endpoint);
        if (!connection)
            return std::unexpected(connection.error());
        const std::string request = std::string(command) + "\n";
        const ssize_t bytesWritten = ::write(*connection, request.data(), request.size());
        std::array<char, 4096> response{};
        const ssize_t bytesRead =
            bytesWritten < 0 ? -1 : ::read(*connection, response.data(), response.size() - 1);
        ::close(*connection);
        if (bytesRead <= 0) {
            return std::unexpected(core::error("recording_ipc_connection_failed",
                                               "The recording worker closed its socket."));
        }
        return std::string(response.data(), static_cast<std::size_t>(bytesRead));
    }
#endif

    core::Result<RecordingControlResponse> request(std::string_view endpoint,
                                                   std::string_view command) {
#ifdef _WIN32
        auto wideEndpoint = toWide(endpoint);
        if (!wideEndpoint)
            return std::unexpected(wideEndpoint.error());
        auto response = transact(*wideEndpoint, command);
#else
        auto response = transact(endpoint, command);
#endif
        if (!response)
            return std::unexpected(response.error());
        return parseResponse(*response);
    }

} // namespace

core::Result<std::string> recordingControlEndpoint(const std::filesystem::path& archivePath,
                                                   std::string_view sessionId) {
    std::error_code errorCode;
    auto canonicalPath = std::filesystem::weakly_canonical(archivePath, errorCode);
    if (errorCode)
        canonicalPath = std::filesystem::absolute(archivePath, errorCode);
    if (errorCode) {
        return std::unexpected(core::error("recording_ipc_path_invalid", errorCode.message()));
    }
    const std::string key = canonicalPath.generic_string() + "\n" + std::string(sessionId);
    const auto bytes = std::as_bytes(std::span(key.data(), key.size()));
    const std::string identifier = domain::hexHash(domain::sha256(bytes)).substr(0, 32);
#ifdef _WIN32
    return "\\\\.\\pipe\\Tutorux-" + identifier;
#else
    std::error_code tempError;
    const auto tempDirectory = std::filesystem::temp_directory_path(tempError);
    if (tempError)
        return std::unexpected(core::error("recording_ipc_path_invalid", tempError.message()));
    return (tempDirectory / ("tutorux-" + identifier + ".sock")).string();
#endif
}

core::Result<RecordingControlResponse> sendRecordingControl(std::string_view endpoint,
                                                            std::string_view command) {
    if (command != "status" && command != "pause" && command != "resume" && command != "stop") {
        return std::unexpected(
            core::error("recording_ipc_command_invalid", "Unsupported recording control command."));
    }
    return request(endpoint, command);
}

core::Status launchRecordingWorker(std::string_view endpoint,
                                   const std::vector<std::string>& arguments) {
    const std::filesystem::path executable = currentExecutablePath();
    if (executable.empty()) {
        return std::unexpected(core::error("recording_worker_launch_failed",
                                           "Unable to locate the Tutorux executable."));
    }
#ifdef _WIN32
    auto wideExecutable = executable.native();
    auto wideEndpoint = toWide(endpoint);
    if (!wideEndpoint)
        return std::unexpected(wideEndpoint.error());
    std::wstring commandLine = quoteWindowsArgument(wideExecutable) + L" --record-worker " +
                               quoteWindowsArgument(*wideEndpoint);
    for (const std::string& argument : arguments) {
        auto wideArgument = toWide(argument);
        if (!wideArgument)
            return std::unexpected(wideArgument.error());
        commandLine += L" " + quoteWindowsArgument(*wideArgument);
    }
    STARTUPINFOW startup{};
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(wideExecutable.c_str(),
                        commandLine.data(),
                        nullptr,
                        nullptr,
                        FALSE,
                        CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
                        nullptr,
                        nullptr,
                        &startup,
                        &process)) {
        return std::unexpected(
            core::error("recording_worker_launch_failed",
                        "Unable to start the detached recording worker (Windows error " +
                            std::to_string(GetLastError()) + ")."));
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
#else
    std::vector<std::string> storage;
    storage.reserve(arguments.size() + 3);
    storage.push_back(executable.string());
    storage.emplace_back("--record-worker");
    storage.emplace_back(endpoint);
    storage.insert(storage.end(), arguments.begin(), arguments.end());
    std::vector<char*> values;
    values.reserve(storage.size() + 1);
    for (auto& value : storage)
        values.push_back(value.data());
    values.push_back(nullptr);

    const pid_t process = ::fork();
    if (process < 0)
        return std::unexpected(core::error("recording_worker_launch_failed", strerror(errno)));
    if (process == 0) {
        const pid_t detachedProcess = ::fork();
        if (detachedProcess < 0)
            ::_exit(127);
        if (detachedProcess > 0)
            ::_exit(0);
        if (::setsid() < 0)
            ::_exit(127);
        const int nullDescriptor = ::open("/dev/null", O_RDWR);
        if (nullDescriptor >= 0) {
            if (::dup2(nullDescriptor, STDIN_FILENO) < 0 ||
                ::dup2(nullDescriptor, STDOUT_FILENO) < 0 ||
                ::dup2(nullDescriptor, STDERR_FILENO) < 0)
                ::_exit(127);
            if (nullDescriptor > STDERR_FILENO)
                ::close(nullDescriptor);
        }
        ::execv(values[0], values.data());
        ::_exit(127);
    }
    int childStatus = 0;
    while (::waitpid(process, &childStatus, 0) < 0) {
        if (errno != EINTR) {
            return std::unexpected(core::error("recording_worker_launch_failed",
                                               "Unable to detach the recording worker."));
        }
    }
    if (!WIFEXITED(childStatus) || WEXITSTATUS(childStatus) != 0) {
        return std::unexpected(core::error("recording_worker_launch_failed",
                                           "Unable to detach the recording worker."));
    }
#endif
    return {};
}

int runRecordingWorker(std::string endpoint, RecordingWorker worker) {
    auto state = std::make_shared<WorkerState>();
#ifdef _WIN32
    auto wideEndpoint = toWide(endpoint);
    if (!wideEndpoint) {
        state->set("failed", wideEndpoint.error().message);
        return 2;
    }
    std::jthread server([state, endpoint = std::move(*wideEndpoint)](std::stop_token token) {
        serveWorker(endpoint, state, token);
    });
#else
    std::jthread server([state, endpoint](std::stop_token token) {
        serveWorker(endpoint, state, token);
    });
#endif
#ifndef _WIN32
    std::signal(SIGPIPE, SIG_IGN);
#endif
    const auto serverDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (!state->serverReady.load(std::memory_order_acquire) &&
           std::chrono::steady_clock::now() < serverDeadline) {
        if (state->snapshot().state == "failed") {
            server.request_stop();
            return 2;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(20));
    }
    if (!state->serverReady.load(std::memory_order_acquire)) {
        state->set("failed", "Recording control IPC did not become ready.");
        server.request_stop();
        return 2;
    }
    if (state->snapshot().state == "failed") {
        state->finished.store(true, std::memory_order_release);
        server.request_stop();
        return 2;
    }
    RecordingControlCallbacks callbacks{[state] {
                                            return state->stop.load(std::memory_order_acquire);
                                        },
                                        [state] {
                                            return state->pause.load(std::memory_order_acquire);
                                        },
                                        [state](std::string nextState, std::string message) {
                                            state->set(std::move(nextState), std::move(message));
                                        }};
    core::Status workerStatus;
    try {
        workerStatus = worker(callbacks);
    } catch (const std::exception& exception) {
        workerStatus = std::unexpected(core::error("recording_worker_failed", exception.what()));
    } catch (...) {
        workerStatus = std::unexpected(
            core::error("recording_worker_failed", "Recording worker failed unexpectedly."));
    }
    if (!workerStatus) {
        const auto current = state->snapshot();
        if (current.state != "interrupted" && current.state != "failed")
            state->set("failed", workerStatus.error().message);
        for (int attempt = 0; attempt < 50; ++attempt)
            std::this_thread::sleep_for(std::chrono::milliseconds(100));
        state->finished.store(true, std::memory_order_release);
        server.request_stop();
        return 2;
    }
    const auto current = state->snapshot();
    if (current.state != "completed")
        state->set("completed", "Recording worker finished.");
    for (int attempt = 0; attempt < 20; ++attempt)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    state->finished.store(true, std::memory_order_release);
    server.request_stop();
    return 0;
}

} // namespace tutorux::audio

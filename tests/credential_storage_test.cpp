#include "tutorux/archive/archive.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <optional>
#include <string>
#include <vector>

namespace {

    struct TemporaryDirectory final {
        std::filesystem::path path;

        ~TemporaryDirectory() {
            std::error_code ignored;
            std::filesystem::remove_all(path, ignored);
        }
    };

    bool setEnvironment(std::string_view name, std::string_view value) {
#ifdef _WIN32
        return _putenv_s(std::string(name).c_str(), std::string(value).c_str()) == 0;
#else
        return setenv(std::string(name).c_str(), std::string(value).c_str(), 1) == 0;
#endif
    }

    int reportFailure(std::string_view step, std::string_view detail) {
        std::cerr << step << ": " << detail << '\n';
        return 1;
    }

    tutorux::core::Result<tutorux::command::CommandResult>
    dispatchSettings(const std::filesystem::path& archivePath,
                     const std::vector<std::string>& command) {
        std::vector<std::string> arguments{"--archive", archivePath.string(), "--passphrase-env",
                                           "TUTORUX_TEST_PASSPHRASE"};
        arguments.insert(arguments.end(), command.begin(), command.end());
        return tutorux::command::dispatch(arguments);
    }

} // namespace

int main() {
    using namespace tutorux;

    constexpr std::string_view passphrase = "test credential archive passphrase";
    constexpr std::string_view replacementPassphrase = "new command line passphrase";
    constexpr std::string_view credentialMarker = "credential plaintext marker 9341";
    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-credential-storage-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return reportFailure("temporary directory", errorCode.message());
    if (!setEnvironment("TUTORUX_TEST_PASSPHRASE", passphrase) ||
        !setEnvironment("TUTORUX_TEST_NEW_PASSPHRASE", replacementPassphrase) ||
        !setEnvironment("TUTORUX_TEST_API_KEY", credentialMarker)) {
        return reportFailure("environment setup", "Could not set test environment variables.");
    }

    const auto encryptedPath = temporary.path / "encrypted.tux";
    {
        auto created = archive::Archive::create(encryptedPath, "Credential test");
        if (!created)
            return reportFailure("create encrypted archive", created.error().message);
        if (auto status = created->enableEncryption(passphrase); !status)
            return reportFailure("encrypt archive", status.error().message);
    }

    auto noOptIn = dispatchSettings(encryptedPath, {"settings", "set", "--key", "provider-api-key",
                                                    "--value-env", "TUTORUX_TEST_API_KEY"});
    if (noOptIn || noOptIn.error().code != "credential_storage_requires_opt_in")
        return reportFailure("credential opt-in",
                             "Sensitive setting was accepted without explicit opt-in.");

    auto rawValue =
        dispatchSettings(encryptedPath, {"settings", "set", "--key", "provider-api-key", "--value",
                                         std::string(credentialMarker), "--store-credential"});
    if (rawValue || rawValue.error().code != "credential_environment_required")
        return reportFailure("raw credential rejection",
                             "Raw command-line credential value was accepted.");

    auto stored = dispatchSettings(encryptedPath,
                                   {"settings", "set", "--key", "provider-api-key", "--value-env",
                                    "TUTORUX_TEST_API_KEY", "--store-credential"});
    if (!stored || stored->exitCode != 0 ||
        stored->output.find(credentialMarker) != std::string::npos)
        return reportFailure("encrypted credential write",
                             stored ? "Credential output leaked its value"
                                    : stored.error().message);

    {
        auto opened = archive::Archive::open(encryptedPath, false, passphrase);
        if (!opened)
            return reportFailure("open encrypted archive", opened.error().message);
        auto settings = opened->list(archive::RecordType::Settings);
        if (!settings)
            return reportFailure("list credential records", settings.error().message);
        bool foundCredential = false;
        for (const auto& setting : *settings) {
            if (domain::getField(setting, "record_role") == "credential" &&
                domain::getField(setting, "key") == "provider-api-key" &&
                domain::getField(setting, "value") == credentialMarker) {
                foundCredential = true;
            }
        }
        if (!foundCredential)
            return reportFailure("credential roundtrip", "Credential did not round-trip.");
    }

    auto listed = dispatchSettings(encryptedPath, {"settings", "list"});
    if (!listed || listed->output.find(credentialMarker) != std::string::npos)
        return reportFailure("settings list redaction", "Settings list exposed a credential.");

    auto credentialList = dispatchSettings(encryptedPath, {"settings", "credential-list"});
    if (!credentialList || credentialList->output.find("provider-api-key") == std::string::npos ||
        credentialList->output.find(credentialMarker) != std::string::npos) {
        return reportFailure("credential listing",
                             "Credential listing exposed a value or hid its key.");
    }

    auto removed = dispatchSettings(encryptedPath,
                                    {"settings", "credential-remove", "--key", "provider-api-key"});
    if (!removed || removed->output.find(credentialMarker) != std::string::npos)
        return reportFailure("credential removal", "Could not remove the saved credential.");
    credentialList = dispatchSettings(encryptedPath, {"settings", "credential-list"});
    if (!credentialList || credentialList->output.find("provider-api-key") != std::string::npos)
        return reportFailure("credential removal verification", "Credential remains listed.");

    const auto plaintextPath = temporary.path / "plaintext.tux";
    {
        auto created = archive::Archive::create(plaintextPath, "Plaintext test");
        if (!created)
            return reportFailure("create plaintext archive", created.error().message);
    }
    auto plaintextStore = dispatchSettings(
        plaintextPath, {"settings", "set", "--key", "provider-api-key", "--value-env",
                        "TUTORUX_TEST_API_KEY", "--store-credential"});
    if (plaintextStore || plaintextStore.error().code != "credential_archive_not_encrypted") {
        return reportFailure("plaintext credential rejection",
                             "Credential was accepted by a plaintext archive.");
    }
    std::ifstream archiveBytes(plaintextPath, std::ios::binary);
    const std::string bytes((std::istreambuf_iterator<char>(archiveBytes)),
                            std::istreambuf_iterator<char>());
    if (bytes.find(credentialMarker) != std::string::npos)
        return reportFailure("plaintext scan", "Credential bytes reached a plaintext archive.");

    const auto cliEncryptionPath = temporary.path / "cli-encryption.tux";
    {
        auto created = archive::Archive::create(cliEncryptionPath, "CLI encryption test");
        if (!created)
            return reportFailure("create CLI encryption archive", created.error().message);
    }
    auto encrypted = dispatchSettings(cliEncryptionPath, {"archive", "encrypt"});
    if (!encrypted || encrypted->exitCode != 0)
        return reportFailure("CLI archive encryption",
                             encrypted ? encrypted->output : encrypted.error().message);
    auto rotated =
        dispatchSettings(cliEncryptionPath, {"archive", "change-passphrase", "--new-passphrase-env",
                                             "TUTORUX_TEST_NEW_PASSPHRASE"});
    if (!rotated || rotated->exitCode != 0)
        return reportFailure("CLI passphrase rotation",
                             rotated ? rotated->output : rotated.error().message);
    auto oldPassphraseOpen = archive::Archive::open(cliEncryptionPath, false, passphrase);
    if (oldPassphraseOpen)
        return reportFailure("CLI passphrase rotation", "Old passphrase still opens the archive.");
    auto newPassphraseOpen =
        archive::Archive::open(cliEncryptionPath, false, replacementPassphrase);
    if (!newPassphraseOpen)
        return reportFailure("CLI passphrase rotation", newPassphraseOpen.error().message);

    return 0;
}

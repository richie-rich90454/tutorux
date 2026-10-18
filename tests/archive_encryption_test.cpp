#include "tutorux/archive/archive.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>

namespace {

struct TemporaryDirectory final {
    std::filesystem::path path;

    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

int reportFailure(std::string_view step, std::string_view detail) {
    std::cerr << step << ": " << detail << '\n';
    return 1;
}

std::string verificationIssues(const tutorux::archive::VerificationReport& report) {
    std::string issues;
    for (const std::string& issue : report.issues) {
        if (!issues.empty())
            issues += "; ";
        issues += issue;
    }
    return issues;
}

} // namespace

int main() {
    using namespace tutorux;

    const auto uniqueSuffix = std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{std::filesystem::current_path() /
                                 ("tutorux-archive-encryption-" + std::to_string(uniqueSuffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode)
        return reportFailure("temporary directory", errorCode.message());

    const auto archivePath = temporary.path / "encrypted.tux";
    const std::string originalPassphrase = "correct horse battery staple";
    const std::string replacementPassphrase = "another private phrase 2026";
    const std::string privateMarker = "Tutorux private encryption marker 6b97d0";
    const archive::Uuid studentId = archive::randomUuid();

    {
        auto created = archive::Archive::create(archivePath, "Encryption test");
        if (!created)
            return reportFailure("create", created.error().message);

        archive::Record student;
        student.type = archive::RecordType::Student;
        student.id = studentId;
        student.fields = {
            {"display_name", "Encryption test student"},
            {"tutor_notes",  privateMarker            }
        };
        if (auto status = created->put(std::move(student)); !status)
            return reportFailure("write plaintext record", status.error().message);

        if (auto status = created->enableEncryption(originalPassphrase); !status)
            return reportFailure("enable encryption", status.error().message);
    }

    {
        auto inspected = archive::inspectArchive(archivePath);
        if (!inspected || inspected->healthStatus != "locked") {
            return reportFailure("locked discovery",
                                 inspected ? "archive did not report a locked status"
                                           : inspected.error().message);
        }
        auto locked = archive::Archive::open(archivePath, false, {}, true);
        if (!locked || !locked->locked())
            return reportFailure("locked open",
                                 locked ? "archive was unexpectedly open" : locked.error().message);
        auto missingPassphrase = archive::Archive::open(archivePath);
        if (missingPassphrase || missingPassphrase.error().code != "archive_locked")
            return reportFailure("missing passphrase",
                                 "locked archive did not reject implicit open");
        auto wrongPassphrase = archive::Archive::open(archivePath, false, "incorrect phrase");
        if (wrongPassphrase || wrongPassphrase.error().code != "archive_passphrase_invalid")
            return reportFailure("wrong passphrase", "archive did not reject the incorrect phrase");
    }

    {
        auto unlocked = archive::Archive::open(archivePath, true, originalPassphrase);
        if (!unlocked)
            return reportFailure("unlock", unlocked.error().message);
        auto student = unlocked->get(archive::RecordType::Student, studentId);
        if (!student || !*student || domain::getField(**student, "tutor_notes") != privateMarker) {
            return reportFailure("read encrypted record",
                                 student ? "encrypted content did not round-trip"
                                         : student.error().message);
        }
        auto verification = unlocked->verify(true);
        if (!verification || !verification->valid) {
            return reportFailure("full verification",
                                 verification ? verificationIssues(*verification)
                                              : verification.error().message);
        }
        if (auto status = unlocked->compact(); !status)
            return reportFailure("encrypted compaction", status.error().message);
        auto compactedVerification = unlocked->verify(true);
        if (!compactedVerification || !compactedVerification->valid) {
            return reportFailure("verify compacted writer",
                                 compactedVerification ? verificationIssues(*compactedVerification)
                                                       : compactedVerification.error().message);
        }
    }

    {
        auto afterCompaction = archive::Archive::open(archivePath, false, originalPassphrase);
        if (!afterCompaction)
            return reportFailure("reopen after compaction", afterCompaction.error().message);
        auto verification = afterCompaction->verify(true);
        if (!verification || !verification->valid) {
            return reportFailure("verify after compaction",
                                 verification ? verificationIssues(*verification)
                                              : verification.error().message);
        }
    }

    {
        auto unlocked = archive::Archive::open(archivePath, true, originalPassphrase);
        if (!unlocked)
            return reportFailure("reopen for rotation", unlocked.error().message);
        if (auto status = unlocked->changePassphrase(replacementPassphrase); !status)
            return reportFailure("passphrase rotation", status.error().message);
    }

    {
        std::ifstream input(archivePath, std::ios::binary);
        const std::string archiveBytes((std::istreambuf_iterator<char>(input)),
                                       std::istreambuf_iterator<char>());
        if (!input || archiveBytes.find(privateMarker) != std::string::npos)
            return reportFailure("plaintext scan", "sensitive record bytes remain in the archive");
    }

    auto oldPassphrase = archive::Archive::open(archivePath, false, originalPassphrase);
    if (oldPassphrase)
        return reportFailure("old passphrase", "old passphrase still unlocks after rotation");
    auto newPassphrase = archive::Archive::open(archivePath, false, replacementPassphrase);
    if (!newPassphrase)
        return reportFailure("new passphrase", newPassphrase.error().message);
    auto verification = newPassphrase->verify(true);
    if (!verification || !verification->valid)
        return reportFailure("post-rotation verification",
                             verification ? verificationIssues(*verification)
                                          : verification.error().message);
    return 0;
}

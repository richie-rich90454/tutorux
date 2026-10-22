// Sanitized-copy selection and isolation coverage.
#include "tutorux/archive/archive.hpp"
#include "tutorux/archive/sanitized_copy.hpp"
#include "tutorux/domain/entities.hpp"

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <string>
#include <string_view>
#include <system_error>

namespace {

bool expect(bool condition, std::string_view label) {
    if (condition)
        return true;
    std::cerr << "sanitized copy: " << label << '\n';
    return false;
}

template <typename T>
bool expectError(const tutorux::core::Result<T>& result, std::string_view label) {
    if (result)
        return expect(false, label);
    return true;
}

struct TemporaryDirectory final {
    std::filesystem::path path;
    ~TemporaryDirectory() {
        std::error_code ignored;
        std::filesystem::remove_all(path, ignored);
    }
};

} // namespace

int main() {
    using namespace tutorux;
    const auto suffix =
        std::chrono::steady_clock::now().time_since_epoch().count();
    TemporaryDirectory temporary{
        std::filesystem::temp_directory_path() /
        ("tutorux-sanitize-" + std::to_string(suffix))};
    std::error_code errorCode;
    std::filesystem::create_directories(temporary.path, errorCode);
    if (errorCode) {
        std::cerr << "sanitized copy: temporary directory failed\n";
        return 1;
    }
    bool okay = true;

    const auto sourcePath = temporary.path / "source.tux";
    auto created = archive::Archive::create(sourcePath, "Sanitize source");
    if (!created) {
        std::cerr << "sanitized copy: source archive failed: " << created.error().message
                  << '\n';
        return 1;
    }
    archive::Archive source = std::move(*created);

    domain::Student firstStudent;
    firstStudent.id = archive::randomUuid();
    firstStudent.name = "First Student";
    firstStudent.grade = "9";
    static_cast<void>(source.put(domain::toRecord(firstStudent)));
    domain::Student secondStudent;
    secondStudent.id = archive::randomUuid();
    secondStudent.name = "Second Student";
    secondStudent.grade = "10";
    static_cast<void>(source.put(domain::toRecord(secondStudent)));

    domain::Session firstSession;
    firstSession.id = archive::randomUuid();
    firstSession.studentId = archive::uuidToString(firstStudent.id);
    firstSession.title = "First session";
    firstSession.subject = "Algebra";
    static_cast<void>(source.put(domain::toRecord(firstSession)));
    domain::Session secondSession;
    secondSession.id = archive::randomUuid();
    secondSession.studentId = archive::uuidToString(secondStudent.id);
    secondSession.title = "Second session";
    secondSession.subject = "Writing";
    static_cast<void>(source.put(domain::toRecord(secondSession)));

    domain::Annotation publicAnnotation;
    publicAnnotation.id = archive::randomUuid();
    publicAnnotation.sessionId = archive::uuidToString(firstSession.id);
    publicAnnotation.type = "general-note";
    publicAnnotation.content = "Public note";
    static_cast<void>(source.put(domain::toRecord(publicAnnotation)));
    domain::Annotation privateAnnotation = publicAnnotation;
    privateAnnotation.id = archive::randomUuid();
    privateAnnotation.content = "Private note";
    auto privateRecord = domain::toRecord(privateAnnotation);
    privateRecord.fields["private"] = "true";
    static_cast<void>(source.put(privateRecord));

    archive::SanitizedCopyOptions options;
    auto preview = archive::previewSanitizedCopy(source, options);
    okay &= expect(preview && preview->students == 2 && preview->sessions == 2,
                   "default preview lost students or sessions");
    okay &= expect(preview && preview->annotations == 1,
                   "private annotation was not excluded from the default preview");

    options.includePrivateAnnotations = true;
    auto privatePreview = archive::previewSanitizedCopy(source, options);
    okay &= expect(privatePreview && privatePreview->annotations == 2,
                   "private annotation was not included when requested");
    options.includePrivateAnnotations = false;

    options.excludeStudents.insert(firstStudent.id);
    auto excludedStudent = archive::previewSanitizedCopy(source, options);
    okay &= expect(excludedStudent && excludedStudent->students == 1 &&
                       excludedStudent->sessions == 1,
                   "student exclusion did not narrow the copy");
    options.excludeStudents.clear();

    options.includeStudents.insert(firstStudent.id);
    auto includedStudent = archive::previewSanitizedCopy(source, options);
    okay &= expect(includedStudent && includedStudent->students == 1 &&
                       includedStudent->sessions == 1,
                   "student inclusion did not narrow the copy");
    options.includeStudents.clear();

    options.includeSessions.insert(secondSession.id);
    auto includedSession = archive::previewSanitizedCopy(source, options);
    okay &= expect(includedSession && includedSession->sessions == 1 &&
                       includedSession->annotations == 0,
                   "session inclusion retained unrelated annotations");
    options.includeSessions.clear();

    const auto copyPath = temporary.path / "copy.tux";
    auto defaultCopy = archive::previewSanitizedCopy(source, options);
    if (!defaultCopy) {
        std::cerr << "sanitized copy: preview failed\n";
        return 1;
    }
    auto copyStatus = archive::createSanitizedCopy(source, options, *defaultCopy, copyPath);
    okay &= expect(static_cast<bool>(copyStatus), "default sanitized copy failed");
    {
        auto copied = archive::Archive::open(copyPath);
        okay &= expect(copied.has_value(), "default copy could not be opened");
        if (copied) {
            auto verification = copied->verify(true);
            okay &= expect(verification && verification->valid,
                           "default copy failed full verification");
            auto annotations = copied->list(archive::RecordType::Annotation);
            okay &= expect(annotations && annotations->size() == 1,
                           "default copy retained a private annotation");
        }
    }

    options.includePrivateAnnotations = true;
    auto privateCopyPreview = archive::previewSanitizedCopy(source, options);
    const auto privateCopyPath = temporary.path / "private-copy.tux";
    if (privateCopyPreview) {
        auto privateCopy = archive::createSanitizedCopy(
            source, options, *privateCopyPreview, privateCopyPath);
        okay &= expect(static_cast<bool>(privateCopy),
                       "private-inclusive sanitized copy failed");
        auto copied = archive::Archive::open(privateCopyPath);
        if (copied) {
            auto annotations = copied->list(archive::RecordType::Annotation);
            okay &= expect(annotations && annotations->size() == 2,
                           "private-inclusive copy omitted the private annotation");
        }
    } else {
        okay &= expect(false, "private-inclusive preview failed");
    }
    options.includePrivateAnnotations = false;

    auto wrongExpected = *defaultCopy;
    wrongExpected.selectionFingerprint = "not-the-selection";
    okay &= expectError(archive::createSanitizedCopy(
                            source, options, wrongExpected,
                            temporary.path / "wrong.tux"),
                        "mismatched selection fingerprint was accepted");

    const auto encryptedCopyPath = temporary.path / "encrypted-copy.tux";
    options.includePrivateAnnotations = true;
    auto encryptedPreview = archive::previewSanitizedCopy(source, options);
    if (encryptedPreview) {
        auto encryptedCopy = archive::createSanitizedCopy(
            source, options, *encryptedPreview, encryptedCopyPath, "copy-passphrase");
        okay &= expect(static_cast<bool>(encryptedCopy), "encrypted copy failed");
        auto locked = archive::Archive::open(encryptedCopyPath, false, "wrong-passphrase");
        okay &= expect(!locked, "encrypted copy opened with a wrong passphrase");
        auto opened = archive::Archive::open(encryptedCopyPath, false, "copy-passphrase");
        okay &= expect(opened.has_value(), "encrypted copy could not be opened");
        if (opened) {
            auto verification = opened->verify(true);
            okay &= expect(verification && verification->valid,
                           "encrypted copy failed verification");
        }
    } else {
        okay &= expect(false, "encrypted preview failed");
    }

    return okay ? 0 : 1;
}

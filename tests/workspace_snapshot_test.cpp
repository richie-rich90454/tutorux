#include "tutorux/application/workspace-service.hpp"
#include "tutorux/command/dispatcher.hpp"
#include "tutorux/domain/entities.hpp"
#include "tutorux/domain/journal.hpp"

#include <cstdlib>
#include <filesystem>
#include <iostream>
#include <string>

namespace {

int fail(std::string_view message) {
    std::cerr << "workspace service: " << message << '\n';
    return 1;
}

} // namespace

int main() {
    using namespace tutorux;
    if (const char* probe = std::getenv("TUTORUX_PROBE_ARCHIVE"); probe && *probe) {
        application::OverviewRequest request;
        request.path = probe;
        const auto overview = application::WorkspaceService{}.snapshotOverview(request);
        std::cout << "error=" << overview.errorMessage << " students=" << overview.students.size()
                  << " sessions=" << overview.sessions.size() << " entries=" << overview.entries.size()
                  << " selected=" << overview.selectedSession.title
                  << " notes=" << overview.selectedSession.notes.blocks.size() << '\n';
        return overview.errorMessage.empty() ? 0 : 2;
    }
    const auto directory = std::filesystem::temp_directory_path() / "tutorux-workspace-service";
    std::error_code error;
    std::filesystem::remove_all(directory, error);
    std::filesystem::create_directories(directory);
    const auto archivePath = directory / "Workspace.tux";

    auto created = command::dispatch({"archive", "init", archivePath.string(), "--name",
                                      "Workspace"});
    if (!created || created->exitCode != 0)
        return fail("could not create archive");

    auto student = command::dispatch(
        {"--archive", archivePath.string(), "--json", "student", "create", "--name", "Ada"});
    if (!student || student->exitCode != 0)
        return fail("could not create student");
    archive::Uuid seededSessionId{};
    {
        auto studentRecord = archive::Archive::open(archivePath, true);
        if (!studentRecord)
            return fail("could not open archive for seeding");
        domain::Session session;
        session.id = archive::randomUuid();
        seededSessionId = session.id;
        session.title = "Fractions review";
        session.subject = "Mathematics";
        session.studentId = "anonymous";
        session.sessionState = "active";
        session.startedAtUs = 1'700'000'000'000'000;
        if (auto status = studentRecord->put(domain::toRecord(session)); !status)
            return fail("could not seed session");
    }

    auto journalEntry = command::dispatch({"--archive", archivePath.string(), "--json", "journal",
                                           "entry", "create", "--title", "Week one"});
    if (!journalEntry || journalEntry->exitCode != 0)
        return fail("could not create journal entry");

    application::OverviewRequest request;
    request.path = archivePath;
    const auto overview = application::WorkspaceService{}.snapshotOverview(request);
    if (!overview.errorMessage.empty())
        return fail(overview.errorMessage);
    if (overview.students.size() != 1)
        return fail("student overview count mismatch");
    if (overview.sessions.size() != 1)
        return fail("session overview count mismatch");
    if (overview.entries.size() != 1)
        return fail("journal overview count mismatch");
    if (overview.selectedSessionId != archive::uuidToString(seededSessionId))
        return fail("selected session was not resolved");
    if (overview.selectedSession.title != "Fractions review")
        return fail("selected session inspector was not populated");
    if (overview.generation == 0)
        return fail("overview did not report the archive generation");

    std::filesystem::remove_all(directory, error);
    return 0;
}

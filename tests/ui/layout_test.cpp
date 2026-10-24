// Headless layout gate: renders the real MainWindow with the Slint testing
// backend at every supported window size and both themes.
#include "app-window.h"

#include <slint-testing.h>

#include <array>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <vector>

namespace {

using slint::testing::ElementHandle;

bool check(bool condition, std::string_view message) {
    if (!condition)
        std::cerr << "layout check failed: " << message << '\n';
    return condition;
}

void settle(slint::ComponentHandle<MainWindow> window) {
    window->show();
    static_cast<void>(slint::invoke_from_event_loop([] { slint::quit_event_loop(); }));
    slint::run_event_loop();
}

std::optional<ElementHandle> element(slint::ComponentHandle<MainWindow> window, std::string_view id) {
    auto found = ElementHandle::find_by_element_id(window, id);
    if (found.empty())
        return std::nullopt;
    return found[0];
}

} // namespace

int main() {
    slint::testing::init();
    auto window = MainWindow::create();

    window->set_archive_path("C:/tutorux-layout-test/Test.tux");
    window->set_selected_archive("Test.tux");
    window->set_selected_session("Algebra · Fractions review");
    window->set_selected_session_title("Fractions review");
    window->set_selected_session_student("Ada");
    window->set_selected_session_subject("Mathematics");
    window->set_selected_session_started("2026-10-23 10:00");
    window->set_selected_session_state("In progress");
    window->set_status_message("Layout gate is running.");
    window->set_note_save_state("saved");

    std::vector<SessionRow> sessions;
    sessions.push_back(SessionRow{slint::SharedString("session-1"),
                                  slint::SharedString("Algebra · Fractions review"),
                                  slint::SharedString("Fractions review"),
                                  slint::SharedString("Ada · 42 min"),
                                  slint::SharedString("Today"),
                                  true,
                                  slint::SharedString("not-started")});
    window->set_session_rows(
        std::make_shared<slint::VectorModel<SessionRow>>(sessions));
    std::vector<NoteRow> notes;
    notes.push_back(NoteRow{slint::SharedString("block-1"), slint::SharedString("Paragraph · Block 1"),
                            slint::SharedString("Paragraph"),
                            slint::SharedString("A readable notebook measure keeps long text inside the pane.")});
    window->set_note_rows(std::make_shared<slint::VectorModel<NoteRow>>(notes));
    window->set_selected_journal_note_block(slint::SharedString("Paragraph · Block 1"));
    window->set_journal_document_block_text(
        slint::SharedString("A readable notebook measure keeps long text inside the pane."));

    struct Size final {
        int width;
        int height;
        bool inspector;
    };
    constexpr std::array sizes{Size{900, 560, false}, Size{1024, 768, false},
                               Size{1280, 800, true}, Size{1440, 900, true},
                               Size{1600, 1000, true}, Size{1920, 1200, true}};
    constexpr std::array themes{"light", "dark"};

    bool ok = true;
    for (const auto& size : sizes) {
        for (const char* theme : themes) {
            window->set_theme_mode(slint::SharedString(theme));
            window->set_effective_inspector_open(size.inspector);
            slint::LogicalSize windowSize;
            windowSize.width = static_cast<float>(size.width);
            windowSize.height = static_cast<float>(size.height);
            window->window().set_size(windowSize);
            settle(window);

            const auto navigator = element(window, "MainWindow::main-navigator");
            const auto content = element(window, "MainWindow::content-pane");
            const auto transport = element(window, "MainWindow::recording-transport");
            const auto status = element(window, "MainWindow::status-line");
            const auto inspector = element(window, "MainWindow::session-inspector");

            ok = check(navigator.has_value(), "navigator exists") && ok;
            ok = check(content.has_value(), "content pane exists") && ok;
            ok = check(transport.has_value(), "transport exists") && ok;
            ok = check(status.has_value(), "status line exists") && ok;

            const auto contentSize = content->size();
            const auto contentPosition = content->absolute_position();
            const auto transportSize = transport->size();
            const auto transportPosition = transport->absolute_position();
            ok = check(contentSize.width > 320, "content pane keeps a usable width") && ok;
            ok = check(contentPosition.x + contentSize.width <= size.width + 1,
                       "content pane stays inside the window") && ok;
            ok = check(transportPosition.y + transportSize.height <= size.height + 1,
                       "transport stays above the bottom edge") && ok;

            if (size.inspector) {
                ok = check(inspector.has_value(), "inspector exists for a selected session") && ok;
                if (inspector.has_value()) {
                    const auto inspectorPosition = inspector->absolute_position();
                    const auto inspectorSize = inspector->size();
                    ok = check(inspectorSize.width >= 260,
                               "inspector keeps its readable width") && ok;
                    ok = check(contentPosition.x + contentSize.width <= inspectorPosition.x + 1,
                               "notebook never renders under the inspector") && ok;
                    ok = check(inspectorPosition.x + inspectorSize.width <= size.width + 1,
                               "inspector stays inside the window") && ok;
                    ok = check(inspectorPosition.y + inspectorSize.height <=
                                   transportPosition.y + 1,
                               "inspector stays above the transport") && ok;
                }
            } else {
                ok = check(!inspector.has_value(), "inspector collapses on narrow windows") && ok;
            }

            if (status.has_value()) {
                const auto statusPosition = status->absolute_position();
                const auto statusSize = status->size();
                ok = check(statusPosition.y + statusSize.height <= size.height + 1,
                           "status line stays reachable") && ok;
            }
        }
    }

    // First-class pages must render inside the content pane, not as modal sheets.
    window->set_theme_mode(slint::SharedString("light"));
    window->set_effective_inspector_open(true);
    slint::LogicalSize pageSize;
    pageSize.width = 1280.F;
    pageSize.height = 800.F;
    window->window().set_size(pageSize);
    for (const std::string scope : {"journal", "guides", "settings"}) {
        window->set_navigator_scope(slint::SharedString(scope));
        settle(window);
        const auto page = element(window, scope == "journal"   ? "MainWindow::journal-page-root"
                                           : scope == "guides" ? "MainWindow::guides-page-root"
                                                               : "MainWindow::settings-page-root");
        ok = check(page.has_value(), scope + " page exists") && ok;
        if (page.has_value()) {
            const auto position = page->absolute_position();
            const auto size = page->size();
            ok = check(size.width > 320, scope + " page keeps a usable width") && ok;
            ok = check(position.x + size.width <= pageSize.width + 1,
                       scope + " page stays inside the window") && ok;
        }
    }

    window->hide();
    return ok ? 0 : 1;
}

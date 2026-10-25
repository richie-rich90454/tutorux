// Headless layout gate: renders the real MainWindow with the Slint testing
// backend at every supported window size and both themes.
#include "app-window.h"

#include <private/slint_tests_helpers.h>

#include <algorithm>
#include <array>
#include <cstdlib>
#include <iostream>
#include <optional>
#include <string>
#include <string_view>
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

bool inside(const ElementHandle& parent, const ElementHandle& child) {
    const auto parentPosition = parent.absolute_position();
    const auto parentSize = parent.size();
    const auto childPosition = child.absolute_position();
    const auto childSize = child.size();
    return childSize.width > 0 && childSize.height > 0 &&
           childPosition.x >= parentPosition.x - 1 &&
           childPosition.y >= parentPosition.y - 1 &&
           childPosition.x + childSize.width <= parentPosition.x + parentSize.width + 1 &&
           childPosition.y + childSize.height <= parentPosition.y + parentSize.height + 1;
}

std::string bounds(const ElementHandle& element) {
    const auto position = element.absolute_position();
    const auto size = element.size();
    return "x=" + std::to_string(position.x) + ",y=" + std::to_string(position.y) +
           ",w=" + std::to_string(size.width) + ",h=" + std::to_string(size.height);
}

bool horizontallyInside(const ElementHandle& parent, const ElementHandle& child) {
    const auto parentPosition = parent.absolute_position();
    const auto parentSize = parent.size();
    const auto childPosition = child.absolute_position();
    const auto childSize = child.size();
    return childSize.width > 0 && childPosition.x >= parentPosition.x - 1 &&
           childPosition.x + childSize.width <= parentPosition.x + parentSize.width + 1;
}

bool overlaps(const ElementHandle& first, const ElementHandle& second) {
    const auto firstPosition = first.absolute_position();
    const auto firstSize = first.size();
    const auto secondPosition = second.absolute_position();
    const auto secondSize = second.size();
    const float intersectionWidth = std::min(firstPosition.x + firstSize.width,
                                             secondPosition.x + secondSize.width) -
                                   std::max(firstPosition.x, secondPosition.x);
    const float intersectionHeight = std::min(firstPosition.y + firstSize.height,
                                              secondPosition.y + secondSize.height) -
                                    std::max(firstPosition.y, secondPosition.y);
    return intersectionWidth > 1 && intersectionHeight > 1;
}

bool isInteractive(const ElementHandle& element) {
    const auto role = element.accessible_role();
    if (!role)
        return false;
    using slint::language::AccessibleRole;
    switch (*role) {
    case AccessibleRole::Button:
    case AccessibleRole::Checkbox:
    case AccessibleRole::Combobox:
    case AccessibleRole::RadioButton:
    case AccessibleRole::Slider:
    case AccessibleRole::Spinbox:
    case AccessibleRole::Switch:
    case AccessibleRole::Tab:
    case AccessibleRole::TextInput:
        return true;
    default:
        return false;
    }
}

std::vector<ElementHandle> visibleControls(slint::ComponentHandle<MainWindow> window) {
    std::vector<ElementHandle> controls;
    ElementHandle::visit_elements(window, [&](ElementHandle element) {
        if (isInteractive(element))
            controls.push_back(std::move(element));
    });
    return controls;
}

std::string controlName(const ElementHandle& control) {
    if (const auto label = control.accessible_label())
        return std::string(label->data(), label->size());
    if (const auto id = control.id())
        return std::string(id->data(), id->size());
    if (const auto type = control.type_name())
        return std::string(type->data(), type->size());
    return "unnamed control";
}

bool controlsDoNotOverlap(slint::ComponentHandle<MainWindow> window,
                          std::string_view scope, int width, int height) {
    const auto controls = visibleControls(window);
    bool ok = true;
    for (std::size_t first = 0; first < controls.size(); ++first) {
        for (std::size_t second = first + 1; second < controls.size(); ++second) {
            if (!overlaps(controls[first], controls[second]))
                continue;
            const auto message = std::string(scope) + " interactive controls overlap at " +
                                 std::to_string(width) + "x" + std::to_string(height) + ": " +
                                 controlName(controls[first]) + " / " +
                                 controlName(controls[second]);
            ok = check(false, message) && ok;
        }
    }
    return ok;
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
    window->set_marker_rows(std::make_shared<slint::VectorModel<MarkerRow>>(
        std::vector<MarkerRow>{
            MarkerRow{slint::SharedString("marker-one"), slint::SharedString("00:12:30"),
                      slint::SharedString("Student explains a multi-step solution clearly."), 750},
            MarkerRow{slint::SharedString("marker-two"), slint::SharedString("00:20:00"),
                      slint::SharedString("Return to the diagram and check the scale."), 1200},
        }));
    window->set_status_message("Layout gate is running.");
    window->set_note_save_state("saved");
    // Exercise the expanded transport layout throughout the responsive matrix.
    window->set_recording_state("recording");
    window->set_recording_elapsed_seconds(760);
    window->set_recording_duration_seconds(760);
    window->set_recording_duration_us("760000000");
    window->set_recording_input_level(43);
    window->set_recording_take_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_recording_track_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>());

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
    notes.push_back(NoteRow{slint::SharedString("block-2"), slint::SharedString("Heading · Block 2"),
                            slint::SharedString("Heading"),
                            slint::SharedString("A second note block remains selectable.")});
    window->set_note_rows(std::make_shared<slint::VectorModel<NoteRow>>(notes));
    window->set_selected_journal_note_block(slint::SharedString("Paragraph · Block 1"));
    window->set_journal_document_block_text(
        slint::SharedString("A readable notebook measure keeps long text inside the pane."));
    settle(window);
    bool ok = true;
    const auto secondNote = ElementHandle::find_by_accessible_label(
        window, "Select note block: Heading · Block 2");
    ok = check(!secondNote.empty(), "unselected notebook blocks are accessible controls") && ok;
    if (!secondNote.empty()) {
        secondNote[0].invoke_accessible_default_action();
        settle(window);
        ok = check(window->get_selected_journal_note_block() ==
                       slint::SharedString("Heading · Block 2"),
                   "the accessible note action selects its block") && ok;
        ok = check(window->get_journal_document_block_text() ==
                       slint::SharedString("A second note block remains selectable."),
                   "selecting a note loads that block's text") && ok;
        ok = check(window->get_journal_document_block_kind() ==
                       slint::SharedString("Heading"),
                   "selecting a note restores that block's type") && ok;
        window->set_selected_journal_note_block(slint::SharedString("Paragraph · Block 1"));
        window->set_journal_document_block_text(
            slint::SharedString("A readable notebook measure keeps long text inside the pane."));
        window->set_journal_document_block_kind(slint::SharedString("Paragraph"));
        settle(window);
    }
    const auto editTitle =
        ElementHandle::find_by_accessible_label(window, "Edit session title");
    ok = check(!editTitle.empty(), "session title exposes an accessible edit action") && ok;
    if (!editTitle.empty()) {
        editTitle[0].invoke_accessible_default_action();
        settle(window);
        ok = check(!ElementHandle::find_by_accessible_label(window, "Session title").empty(),
                   "the accessible session-title action opens its editor") && ok;
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), false);
        settle(window);
    }
    const auto editDetails =
        ElementHandle::find_by_accessible_label(window, "Edit session details");
    ok = check(!editDetails.empty(), "session details expose an edit action") && ok;
    if (!editDetails.empty()) {
        const auto addMarker = ElementHandle::find_by_accessible_label(window, "Add session marker");
        window->set_archive_writable(false);
        settle(window);
        ok = check(editDetails[0].accessible_enabled() == std::optional<bool>(false),
                   "read-only archives disable session detail editing") && ok;
        if (!addMarker.empty()) {
            ok = check(addMarker[0].accessible_enabled() == std::optional<bool>(false),
                       "read-only archives disable marker creation") && ok;
        }
        window->set_archive_writable(true);
        settle(window);
        editDetails[0].invoke_accessible_default_action();
        settle(window);
        ok = check(!ElementHandle::find_by_accessible_label(window, "Session subject").empty(),
                   "session detail editing exposes a labelled subject field") && ok;
        window->set_session_details_save_state(slint::SharedString("failed"));
        settle(window);
        ok = check(!ElementHandle::find_by_accessible_label(window, "Save session details").empty(),
                   "a failed detail save keeps a retry action available") && ok;
        ok = check(!ElementHandle::find_by_accessible_label(window, "Cancel session edit").empty(),
                   "a failed detail save preserves the active edit form") && ok;
        window->set_session_details_save_state(slint::SharedString("saved"));
        settle(window);
        ok = check(!ElementHandle::find_by_accessible_label(window, "Edit session details").empty(),
                   "a successful detail save closes the edit form") && ok;
        window->set_session_details_save_state(slint::SharedString("idle"));
        settle(window);
    }
    const auto firstMarker = ElementHandle::find_by_accessible_label(
        window, "Play marker at 00:12:30: Student explains a multi-step solution clearly.");
    ok = check(!firstMarker.empty(), "session markers expose accessible play controls") && ok;
    if (!firstMarker.empty()) {
        firstMarker[0].invoke_accessible_default_action();
        settle(window);
        ok = check(window->get_selected_marker() == slint::SharedString("marker-one"),
                   "the accessible marker action selects its marker") && ok;
        const auto saveMarker = ElementHandle::find_by_accessible_label(window, "Save marker");
        if (!saveMarker.empty()) {
            saveMarker[0].invoke_accessible_default_action();
            settle(window);
            ok = check(window->get_selected_marker() == slint::SharedString("marker-one"),
                       "attempting to save a marker keeps it selected for retry") && ok;
        }
        window->set_selected_session(slint::SharedString("session-2"));
        settle(window);
        ok = check(window->get_selected_marker().empty(),
                   "changing sessions clears the prior session's marker selection") && ok;
        window->set_selected_session(slint::SharedString("Algebra · Fractions review"));
        settle(window);
    }
    const auto markerButton = ElementHandle::find_by_accessible_label(
        window, "Add a marker at the current recording time");
    const auto pauseButton = ElementHandle::find_by_accessible_label(window, "Pause");
    const auto stopButton = ElementHandle::find_by_accessible_label(window, "Stop");
    ok = check(!markerButton.empty(), "active recording marker action is accessible") && ok;
    ok = check(!pauseButton.empty(), "active recording pause action is accessible") && ok;
    ok = check(!stopButton.empty(), "active recording stop action is accessible") && ok;

    struct Size final {
        int width;
        int height;
        bool inspector;
    };
    constexpr std::array sizes{Size{900, 560, false}, Size{1024, 768, false},
                               Size{1280, 800, true}, Size{1440, 900, true},
                               Size{1600, 1000, true}, Size{1920, 1200, true}};
    constexpr std::array themes{"light", "dark"};

    for (const auto& size : sizes) {
        for (const char* theme : themes) {
            window->set_theme_mode(slint::SharedString(theme));
            window->set_compact_navigator(size.width < 1100);
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
            const auto navigatorPosition = navigator->absolute_position();
            const auto navigatorSize = navigator->size();
            if (size.width < 1100) {
                ok = check(navigatorSize.width <= 209,
                           "compact navigator respects its fixed width") && ok;
            }
            ok = check(contentSize.width > 320, "content pane keeps a usable width") && ok;
            ok = check(contentPosition.x + contentSize.width <= size.width + 1,
                       "content pane stays inside the window") && ok;
            ok = check(navigatorPosition.x + navigatorSize.width <= contentPosition.x + 1,
                       "navigator does not intrude into the content pane") && ok;
            ok = check(!overlaps(*navigator, *content),
                       "navigator and content pane do not overlap") && ok;
            std::vector<ElementHandle> notebookActions;
            for (const std::string_view label : {
                     "Add or close notebook composer", "Open journal tools",
                     "Toggle notebook formatting", "Notebook block type",
                     "Remove notebook block"}) {
                const auto matches = ElementHandle::find_by_accessible_label(window, label);
                if (matches.empty())
                    continue;
                notebookActions.push_back(matches[0]);
                ok = check(horizontallyInside(*content, matches[0]),
                           std::string(label) + " stays horizontally inside the notebook content pane (pane " +
                               bounds(*content) + "; control " + bounds(matches[0]) + ")") && ok;
            }
            for (std::size_t first = 0; first < notebookActions.size(); ++first) {
                for (std::size_t second = first + 1; second < notebookActions.size(); ++second) {
                    ok = check(!overlaps(notebookActions[first], notebookActions[second]),
                               "notebook action controls do not overlap") && ok;
                }
            }
            if (transport.has_value()) {
                const auto transportSize = transport->size();
                const auto transportPosition = transport->absolute_position();
                ok = check(transportSize.height > 0, "transport has a visible height") && ok;
                ok = check(transportPosition.y + transportSize.height <= size.height + 1,
                           "transport stays above the bottom edge") && ok;
                ok = check(contentPosition.y + contentSize.height <= transportPosition.y + 1,
                           "content pane stays above the recording dock") && ok;
                if (status.has_value()) {
                    ok = check(!overlaps(*transport, *status),
                               "recording dock and status line do not overlap") && ok;
                }
            }

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
                    std::vector<ElementHandle> inspectorHeaderControls;
                    for (const std::string_view label : {
                             "Session inspector heading", "Edit session details",
                             "Manage session recordings"}) {
                        const auto matches = ElementHandle::find_by_accessible_label(window, label);
                        ok = check(!matches.empty(),
                                   std::string("inspector exposes ") + std::string(label)) && ok;
                        if (!matches.empty()) {
                            inspectorHeaderControls.push_back(matches[0]);
                            ok = check(inside(*inspector, matches[0]),
                                       std::string(label) + " stays inside inspector") && ok;
                        }
                    }
                    for (std::size_t first = 0; first < inspectorHeaderControls.size(); ++first) {
                        for (std::size_t second = first + 1;
                             second < inspectorHeaderControls.size(); ++second) {
                            ok = check(!overlaps(inspectorHeaderControls[first],
                                                 inspectorHeaderControls[second]),
                                       "inspector heading and actions do not overlap") && ok;
                        }
                    }
                    std::vector<ElementHandle> markerControls;
                    for (const std::string_view label : {
                             "Session marker time", "Use current recording time",
                             "Session marker note", "Session marker type",
                             "Add session marker"}) {
                        const auto matches = ElementHandle::find_by_accessible_label(window, label);
                        const bool mayRequireInspectorScroll =
                            (label == "Add session marker" || label == "Session marker note" ||
                             label == "Session marker type") && size.height < 1000;
                        ok = check(!matches.empty() || mayRequireInspectorScroll,
                                   std::string("inspector exposes ") + std::string(label)) && ok;
                        if (!matches.empty()) {
                            markerControls.push_back(matches[0]);
                            ok = check(horizontallyInside(*inspector, matches[0]),
                                       std::string(label) + " stays horizontally inside the scrollable inspector (pane " +
                                           bounds(*inspector) + "; control " + bounds(matches[0]) + ")") && ok;
                        }
                    }
                    for (std::size_t first = 0; first < markerControls.size(); ++first) {
                        for (std::size_t second = first + 1; second < markerControls.size(); ++second) {
                            ok = check(!overlaps(markerControls[first], markerControls[second]),
                                       "marker form controls do not overlap") && ok;
                        }
                    }
                    if (transport.has_value()) {
                        const auto transportPosition = transport->absolute_position();
                        ok = check(inspectorPosition.y + inspectorSize.height <=
                                       transportPosition.y + 1,
                                   "inspector stays above the transport") && ok;
                    }
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
            ok = controlsDoNotOverlap(window, "session", size.width, size.height) && ok;
        }
    }

    // Every primary page must remain inside the content pane in empty and
    // populated states, across narrow/large windows and both palettes.
    constexpr std::array pageScopes{"students", "materials", "trash", "journal", "guides",
                                    "settings"};
    for (const auto& size : sizes) {
        for (const char* theme : themes) {
            window->set_theme_mode(slint::SharedString(theme));
            window->set_compact_navigator(size.width < 1100);
            window->set_effective_inspector_open(false);
            slint::LogicalSize pageSize;
            pageSize.width = static_cast<float>(size.width);
            pageSize.height = static_cast<float>(size.height);
            window->window().set_size(pageSize);
            for (const std::string_view scope : pageScopes) {
                window->set_navigator_scope(slint::SharedString(scope));
                settle(window);
                const std::string_view pageName =
                    scope == "journal"   ? "MainWindow::journal-page-root"
                    : scope == "guides"  ? "MainWindow::guides-page-root"
                    : scope == "settings" ? "MainWindow::settings-page-root"
                    : scope == "students" ? "MainWindow::students-page-root"
                    : scope == "materials" ? "MainWindow::materials-page-root"
                                             : "MainWindow::trash-page-root";
                const auto page = element(window, pageName);
                const auto pageContent = element(window, "MainWindow::content-pane");
                ok = check(page.has_value(), std::string(scope) + " page exists") && ok;
                if (page.has_value() && pageContent.has_value()) {
                    const auto pageSizeActual = page->size();
                    ok = check(pageSizeActual.width > 320,
                               std::string(scope) + " page keeps a usable width") && ok;
                    ok = check(inside(*pageContent, *page),
                               std::string(scope) + " page stays inside the content pane") && ok;
                }
                ok = controlsDoNotOverlap(window, scope, size.width, size.height) && ok;
            }
        }
    }

    // Shared selectors must open through mouse, keyboard, and accessibility,
    // then close cleanly without leaving an orphan popup behind.
    window->set_theme_mode(slint::SharedString("light"));
    window->set_navigator_scope(slint::SharedString("session"));
    window->set_compact_navigator(false);
    window->set_effective_inspector_open(true);
    slint::LogicalSize popupTestSize;
    popupTestSize.width = 1600;
    popupTestSize.height = 1000;
    window->window().set_size(popupTestSize);
    settle(window);

    window->set_recording_take_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>(
            std::vector<slint::SharedString>{"First", "Second", "Third"}));
    window->set_selected_recording_take_label("Third");
    settle(window);
    const auto takeSelector = ElementHandle::find_by_accessible_label(window, "Recording take");
    ok = check(!takeSelector.empty(), "recording take selector has an accessible name") && ok;
    if (!takeSelector.empty()) {
        const auto selector = takeSelector[0];
        const auto position = selector.absolute_position();
        const auto size = selector.size();
        slint::private_api::testing::send_mouse_click(
            &*window, position.x + size.width / 2, position.y + size.height / 2);
        settle(window);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x81"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x81"), false);
        settle(window);
        ok = check(selector.accessible_value() ==
                       std::optional<slint::SharedString>(slint::SharedString("Third")),
                   "keyboard navigation starts from the externally selected take") && ok;
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), false);
        settle(window);
    }

    window->set_recording_take_options(
        std::make_shared<slint::VectorModel<slint::SharedString>>());
    window->set_selected_recording_take_label("");
    settle(window);

    bool foundEmptySelector = false;
    std::vector<ElementHandle> emptySelectors;
    ElementHandle::visit_elements(window, [&](ElementHandle candidate) {
        const auto role = candidate.accessible_role();
        const auto value = candidate.accessible_value();
        if (!role || *role != slint::language::AccessibleRole::Combobox || !value ||
            !value->empty()) {
            return;
        }
        foundEmptySelector = true;
        emptySelectors.push_back(std::move(candidate));
    });
    for (const auto& selector : emptySelectors) {
        ok = check(selector.accessible_expandable() == std::optional<bool>(false),
                   "empty recording selectors do not advertise a popup") && ok;
        const auto position = selector.absolute_position();
        const auto size = selector.size();
        slint::private_api::testing::send_mouse_click(
            &*window, position.x + size.width / 2, position.y + size.height / 2);
        settle(window);
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 0,
                   "empty recording selectors do not open a blank popup") && ok;
    }
    ok = check(foundEmptySelector,
               "empty recording selector is present for the empty-state test") && ok;

    const auto markerType = ElementHandle::find_by_accessible_label(window, "Session marker type");
    ok = check(!markerType.empty(), "marker type selector is available for popup interaction") && ok;
    if (!markerType.empty()) {
        const auto selector = markerType[0];
        const auto selectorPosition = selector.absolute_position();
        const auto selectorSize = selector.size();

        slint::private_api::testing::send_mouse_click(
            &*window, selectorPosition.x + selectorSize.width / 2,
            selectorPosition.y + selectorSize.height / 2);
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(true),
                   "mouse click opens the shared selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 1,
                   "mouse click creates one selector popup") && ok;

        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), false);
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(false),
                   "Escape closes the shared selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 0,
                   "Escape removes the selector popup") && ok;

        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\n"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\n"), false);
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(true),
                   "Return opens the shared selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 1,
                   "Return creates one selector popup") && ok;

        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x81"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x81"), false);
        settle(window);
        ok = check(selector.accessible_value() ==
                       std::optional<slint::SharedString>(slint::SharedString("Mistake")),
                   "Down Arrow changes the selector value") && ok;

        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\n"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\n"), false);
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(false),
                   "Return confirms and closes the shared selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 0,
                   "Return removes the selector popup") && ok;

        selector.invoke_accessible_expand_action();
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(true),
                   "accessibility expand opens the shared selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 1,
                   "accessibility expand creates one selector popup") && ok;

        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), false);
        settle(window);
        ok = check(selector.accessible_expanded() == std::optional<bool>(false),
                   "Escape closes an accessibility-opened selector popup") && ok;
        ok = check(slint::private_api::testing::active_popup_count(&*window) == 0,
                   "selector popup count returns to zero") && ok;
    }

    slint::LogicalSize compactPaletteSize;
    compactPaletteSize.width = 900;
    compactPaletteSize.height = 560;
    window->window().set_size(compactPaletteSize);
    window->set_command_palette_query("");
    window->set_command_palette_open(true);
    settle(window);
    const auto paletteJournal =
        ElementHandle::find_by_accessible_label(window, "Open journal");
    const auto paletteConsole =
        ElementHandle::find_by_accessible_label(window, "Command console");
    ok = check(!paletteJournal.empty(), "command palette actions are accessible buttons") && ok;
    ok = check(!paletteConsole.empty(), "command palette actions stay available at minimum height") && ok;
    if (!paletteConsole.empty()) {
        const auto position = paletteConsole[0].absolute_position();
        const auto size = paletteConsole[0].size();
        ok = check(position.y + size.height <= compactPaletteSize.height,
                   "last command palette action stays inside the minimum-height window") && ok;
    }
    window->set_command_palette_query("no-such-action");
    settle(window);
    const auto noResults =
        ElementHandle::find_by_accessible_label(window, "No matching actions");
    ok = check(!noResults.empty(), "command palette explains an empty search") && ok;
    window->set_command_palette_open(false);

    const auto moreActions = ElementHandle::find_by_accessible_label(window, "More actions");
    ok = check(!moreActions.empty(), "overflow menu trigger is keyboard-accessible") && ok;
    if (!moreActions.empty()) {
        const auto position = moreActions[0].absolute_position();
        const auto size = moreActions[0].size();
        slint::private_api::testing::send_mouse_click(
            &*window, position.x + size.width / 2, position.y + size.height / 2);
        settle(window);
        const auto journalMenuAction =
            ElementHandle::find_by_accessible_label(window, "Journal…");
        ok = check(!journalMenuAction.empty(), "overflow actions are accessible buttons") && ok;
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\x1b"), false);
        settle(window);
        ok = check(!window->get_workspace_menu_open(),
                   "Escape closes the keyboard-accessible overflow menu") && ok;
    }
    window->set_archive_menu_open(true);
    settle(window);
    const auto archiveMenuAction =
        ElementHandle::find_by_accessible_label(window, "Open or create archive…");
    ok = check(!archiveMenuAction.empty(), "archive menu actions are accessible buttons") && ok;
    slint::private_api::testing::send_keyboard_key_text(
        &*window, slint::SharedString("\x1b"), true);
    slint::private_api::testing::send_keyboard_key_text(
        &*window, slint::SharedString("\x1b"), false);
    settle(window);
    ok = check(!window->get_archive_menu_open(), "Escape closes the archive menu") && ok;

    window->set_recording_state("completed");
    window->set_recording_waveform_state("ready");
    window->set_recording_duration_seconds(120);
    window->set_recording_duration_us("120000000");
    window->set_recording_playback_position_seconds(60);
    WaveformBucketRow seekBucket;
    seekBucket.position = 0;
    seekBucket.width = 1;
    seekBucket.start_seconds = 0;
    seekBucket.end_seconds = 120;
    seekBucket.minimum = -0.5F;
    seekBucket.maximum = 0.5F;
    window->set_recording_waveform_buckets(
        std::make_shared<slint::VectorModel<WaveformBucketRow>>(
            std::vector<WaveformBucketRow>{seekBucket}));
    window->on_seek_recording([&](slint::SharedString, float position) {
        window->set_recording_playback_position_seconds(
            static_cast<int>(position * 120 + 0.5F));
    });
    settle(window);
    const auto audioSlider = ElementHandle::find_by_accessible_label(
        window, "Audio position 00:01:00 of 00:02:00");
    ok = check(!audioSlider.empty(), "recording waveform exposes the current time as a slider") && ok;
    if (!audioSlider.empty()) {
        auto slider = audioSlider[0];
        ok = check(slider.accessible_role() ==
                       std::optional<slint::language::AccessibleRole>(
                           slint::language::AccessibleRole::Slider),
                   "recording waveform has the slider accessibility role") && ok;
        ok = check(slider.accessible_enabled() == std::optional<bool>(true),
                   "completed recording timeline is seekable") && ok;
        ok = check(slider.accessible_value_minimum() == std::optional<float>(0) &&
                       slider.accessible_value_maximum() == std::optional<float>(1),
                   "recording timeline exposes a normalized seek range") && ok;
        slider.invoke_accessible_increment_action();
        settle(window);
        ok = check(window->get_recording_playback_position_seconds() == 61,
                   "accessible increment seeks one second forward") && ok;
        slider.set_accessible_value("0.75");
        settle(window);
        ok = check(window->get_recording_playback_position_seconds() == 90,
                   "assistive technology can set the timeline position") && ok;
        const auto position = slider.absolute_position();
        const auto size = slider.size();
        slint::private_api::testing::send_mouse_click(
            &*window, position.x + size.width / 2, position.y + size.height / 2);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x82"), true);
        slint::private_api::testing::send_keyboard_key_text(
            &*window, slint::SharedString("\xef\x9c\x82"), false);
        settle(window);
        ok = check(window->get_recording_playback_position_seconds() == 59,
                   "left-arrow seeks the focused waveform by one second") && ok;
    }

    window->hide();
    return ok ? 0 : 1;
}

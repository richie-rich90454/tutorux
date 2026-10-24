// Deterministic screenshot tool: renders the real MainWindow through the
// Slint testing backend at an exact logical size and writes a BMP snapshot.
#include "app-window.h"


#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {

void writeBmp(const std::string& path, const slint::SharedPixelBuffer<slint::Rgba8Pixel>& buffer) {
    const std::uint32_t width = buffer.width();
    const std::uint32_t height = buffer.height();
    const std::uint32_t rowBytes = width * 4U;
    const std::uint32_t imageBytes = rowBytes * height;
    const std::uint32_t fileBytes = 54U + imageBytes;

    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    const auto u16 = [&](std::uint16_t value) {
        output.put(static_cast<char>(value & 0xffU));
        output.put(static_cast<char>((value >> 8U) & 0xffU));
    };
    const auto u32 = [&](std::uint32_t value) {
        output.put(static_cast<char>(value & 0xffU));
        output.put(static_cast<char>((value >> 8U) & 0xffU));
        output.put(static_cast<char>((value >> 16U) & 0xffU));
        output.put(static_cast<char>((value >> 24U) & 0xffU));
    };

    output.put('B');
    output.put('M');
    u32(fileBytes);
    u16(0);
    u16(0);
    u32(54);
    u32(40);
    u32(width);
    u32(height);
    u16(1);
    u16(32);
    u32(0);
    u32(imageBytes);
    u32(2835);
    u32(2835);
    u32(0);
    u32(0);

    for (std::uint32_t row = height; row > 0; --row) {
        const auto* pixels = buffer.begin() + static_cast<std::ptrdiff_t>((row - 1U) * width);
        for (std::uint32_t column = 0; column < width; ++column) {
            const auto& pixel = pixels[column];
            output.put(static_cast<char>(pixel.b));
            output.put(static_cast<char>(pixel.g));
            output.put(static_cast<char>(pixel.r));
            output.put(static_cast<char>(pixel.a));
        }
    }
}

void settle(slint::ComponentHandle<MainWindow> window) {
    window->show();
    slint::Timer::single_shot(std::chrono::milliseconds(250), [] { slint::quit_event_loop(); });
    slint::run_event_loop();
}

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: tutorux_ui_screenshot OUTPUT.bmp [mode] [scale]\n";
        return 2;
    }

    const std::string mode = argc > 2 ? argv[2] : "session";
    const std::string scale = argc > 3 ? argv[3] : "";
    if (!scale.empty()) {
#ifdef _WIN32
        _putenv_s("SLINT_SCALE_FACTOR", scale.c_str());
#else
        setenv("SLINT_SCALE_FACTOR", scale.c_str(), 1);
#endif
    }

    auto window = MainWindow::create();
    const bool paletteMode = mode == "palette";
    const bool darkMode = mode == "dark";
    const bool journalMode = mode == "journal";
    const bool guidesMode = mode == "guides";
    const bool settingsMode = mode == "settings";
    const bool compactMode = mode == "compact";
    const bool minMode = mode == "min" || mode == "minimum";
    if (mode == "empty") {
        window->set_theme_mode(slint::SharedString("light"));
        window->set_effective_inspector_open(false);
        slint::LogicalSize emptySize;
        emptySize.width = 1280.F;
        emptySize.height = 800.F;
        window->window().set_size(emptySize);
        settle(window);
        const auto emptySnapshot = window->window().take_snapshot();
        if (!emptySnapshot) return 1;
        writeBmp(argv[1], *emptySnapshot);
        window->hide();
        return 0;
    }
    window->set_archive_path(slint::SharedString("C:/tutorux-demo/Demo.tux"));
    window->set_selected_archive(slint::SharedString("Demo.tux"));
    window->set_archive_status(slint::SharedString("Read/Write · Unencrypted"));
    window->set_theme_mode(slint::SharedString(darkMode ? "dark" : "light"));
    window->set_effective_inspector_open(false);
    if (journalMode || guidesMode || settingsMode || compactMode || minMode) {
        if (compactMode || minMode)
            window->set_navigator_scope(slint::SharedString("sessions"));
        else if (journalMode)
            window->set_navigator_scope(slint::SharedString("journal"));
        else if (guidesMode)
            window->set_navigator_scope(slint::SharedString("guides"));
        else
            window->set_navigator_scope(slint::SharedString("settings"));

        if (journalMode) {
            std::vector<slint::SharedString> entries{
                slint::SharedString("2026-10-21 · Fractions and equivalence · 1 session"),
                slint::SharedString("2026-10-18 · Rhetorical analysis · 2 sessions"),
                slint::SharedString("2026-10-12 · Independent reading")};
            window->set_journal_entry_options(
                std::make_shared<slint::VectorModel<slint::SharedString>>(entries));
            window->set_selected_journal_entry(entries.front());
            window->set_journal_entry_id(
                slint::SharedString("11111111-1111-4111-8111-111111111111"));
            window->set_journal_entry_title(slint::SharedString("Fractions and equivalence"));
            window->set_journal_entry_date(slint::SharedString("2026-10-21"));
            window->set_journal_document_id(
                slint::SharedString("22222222-2222-4222-8222-222222222222"));
            window->set_journal_document_blocks_json(slint::SharedString(
                R"([{"id":"33333333-3333-4333-8333-333333333333","kind":"paragraph","text":"Ada compared 3/4 and 5/8 on a number line."}])"));
            window->set_journal_document_block_count(1);
            window->set_journal_note_block_options(
                std::make_shared<slint::VectorModel<slint::SharedString>>(
                    std::vector<slint::SharedString>{
                        slint::SharedString("Paragraph · Block 1")}));
            window->set_selected_journal_note_block(
                slint::SharedString("Paragraph · Block 1"));
            window->set_journal_document_block_text(slint::SharedString(
                "Ada compared 3/4 and 5/8 on a number line before choosing a common denominator."));
            window->set_journal_document_new_block_text(
                slint::SharedString("Add the next observation here."));
            window->set_journal_session_options(
                std::make_shared<slint::VectorModel<slint::SharedString>>(
                    std::vector<slint::SharedString>{
                        slint::SharedString("Mathematics · Fractions and equivalence")}));
            window->set_selected_journal_session(
                slint::SharedString("Mathematics · Fractions and equivalence"));
            window->set_status_message(slint::SharedString("Journal entry loaded."));
        } else if (guidesMode) {
            std::vector<slint::SharedString> guides{
                slint::SharedString("Fractions and equivalence"),
                slint::SharedString("Rhetorical analysis")};
            window->set_guide_options(
                std::make_shared<slint::VectorModel<slint::SharedString>>(guides));
            window->set_selected_guide(guides.front());
            std::vector<slint::SharedString> blocks{
                slint::SharedString("Learning objective · Paragraph"),
                slint::SharedString("Worked example · Paragraph"),
                slint::SharedString("Practice · Bulleted list")};
            window->set_guide_block_options(
                std::make_shared<slint::VectorModel<slint::SharedString>>(blocks));
            window->set_selected_guide_block(blocks.front());
            window->set_guide_edit_text(slint::SharedString(
                "Compare fractions by building equivalent fractions with a common denominator."));
            window->set_guide_output(slint::SharedString(
                "3 blocks · validated 2026-10-21 · 1 stale source"));
        }

        slint::LogicalSize pageSize;
        pageSize.width = minMode ? 900.F : compactMode ? 1024.F : 1280.F;
        pageSize.height = minMode ? 560.F : compactMode ? 768.F : 800.F;
        window->window().set_size(pageSize);
        settle(window);
        const auto pageSnapshot = window->window().take_snapshot();
        if (!pageSnapshot)
            return 1;
        writeBmp(argv[1], *pageSnapshot);
        window->hide();
        return 0;
    }
    if (mode == "no-session") {
        window->set_archive_status(slint::SharedString("Read/Write · Unencrypted"));
        window->set_theme_mode(slint::SharedString("light"));
        window->set_effective_inspector_open(false);
        slint::LogicalSize emptySessionSize;
        emptySessionSize.width = 1280.F;
        emptySessionSize.height = 800.F;
        window->window().set_size(emptySessionSize);
        settle(window);
        const auto emptySessionSnapshot = window->window().take_snapshot();
        if (!emptySessionSnapshot) return 1;
        writeBmp(argv[1], *emptySessionSnapshot);
        window->hide();
        return 0;
    }
    window->set_selected_session(slint::SharedString("Mathematics · Fractions review"));
    window->set_selected_session_title(slint::SharedString("Fractions and equivalence"));
    window->set_selected_session_student(slint::SharedString("Ada Lovelace"));
    window->set_selected_session_subject(slint::SharedString("Mathematics"));
    window->set_selected_session_started(slint::SharedString("2026-10-23 10:00"));
    window->set_selected_session_state(slint::SharedString("In progress"));
    window->set_status_message(slint::SharedString("All changes saved to this archive."));
    window->set_note_save_state(slint::SharedString("saved"));
    window->set_selected_journal_note_block(slint::SharedString("Paragraph · Block 1"));
    window->set_journal_document_block_count(3);
    window->set_journal_document_block_text(
        slint::SharedString("Ada compared 3/4 and 5/8 on a number line before choosing a "
                            "common denominator."));

    std::vector<SessionRow> sessions;
    sessions.push_back(SessionRow{slint::SharedString("session-1"),
                                  slint::SharedString("Mathematics · Fractions and equivalence"),
                                  slint::SharedString("Fractions and equivalence"),
                                  slint::SharedString("Ada Lovelace · 42 min"),
                                  slint::SharedString("Today"), true,
                                  slint::SharedString("not-started")});
    window->set_session_rows(std::make_shared<slint::VectorModel<SessionRow>>(sessions));

    std::vector<NoteRow> notes;
    notes.push_back(NoteRow{
        slint::SharedString("block-1"), slint::SharedString("Paragraph · Block 1"),
        slint::SharedString("Paragraph"),
        slint::SharedString("Ada compared 3/4 and 5/8 on a number line before choosing a common "
                            "denominator.")});
    notes.push_back(NoteRow{slint::SharedString("block-2"), slint::SharedString("Heading · Block 2"),
                            slint::SharedString("Heading"), slint::SharedString("Next steps")});
    notes.push_back(NoteRow{
        slint::SharedString("block-3"), slint::SharedString("Bulleted list · Block 3"),
        slint::SharedString("Bulleted list"),
        slint::SharedString("Practise two equivalence chains without prompts.")});
    window->set_note_rows(std::make_shared<slint::VectorModel<NoteRow>>(notes));

    std::vector<MarkerRow> markers;
    markers.push_back(MarkerRow{slint::SharedString("marker-1"), slint::SharedString("00:12:40"),
                                slint::SharedString("Number line comparison"), 760});
    window->set_marker_rows(std::make_shared<slint::VectorModel<MarkerRow>>(markers));

    window->set_theme_mode(slint::SharedString(darkMode ? "dark" : "light"));
    window->set_effective_inspector_open(true);
    if (paletteMode)
        window->set_command_palette_open(true);
    slint::LogicalSize size;
    size.width = 1280.F;
    size.height = 800.F;
    window->window().set_size(size);
    settle(window);

    const auto snapshot = window->window().take_snapshot();
    if (!snapshot) {
        std::cerr << "take_snapshot returned no pixels\n";
        return 1;
    }
    writeBmp(argv[1], *snapshot);
    window->hide();
    return 0;
}

// Deterministic screenshot tool: renders the real MainWindow through the
// Slint testing backend at an exact logical size and writes a BMP snapshot.
#include "app-window.h"


#include <cstdint>
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

} // namespace

int main(int argc, char** argv) {
    if (argc < 2) {
        std::cerr << "usage: tutorux_ui_screenshot OUTPUT.bmp\n";
        return 2;
    }

    auto window = MainWindow::create();
    const std::string mode = argc > 2 ? argv[2] : "session";
    const bool paletteMode = mode == "palette";
    const bool darkMode = mode == "dark";
    if (mode == "empty") {
        window->set_theme_mode(slint::SharedString("light"));
        window->set_effective_inspector_open(false);
        slint::LogicalSize emptySize;
        emptySize.width = 1280.F;
        emptySize.height = 800.F;
        window->window().set_size(emptySize);
        window->show();
        static_cast<void>(slint::invoke_from_event_loop([] { slint::quit_event_loop(); }));
        slint::run_event_loop();
        const auto emptySnapshot = window->window().take_snapshot();
        if (!emptySnapshot) return 1;
        writeBmp(argv[1], *emptySnapshot);
        window->hide();
        return 0;
    }
    window->set_archive_path(slint::SharedString("C:/tutorux-demo/Demo.tux"));
    window->set_selected_archive(slint::SharedString("Demo.tux"));
    window->set_archive_status(slint::SharedString("Read/Write · Unencrypted"));
    if (mode == "no-session") {
        window->set_archive_status(slint::SharedString("Read/Write · Unencrypted"));
        window->set_theme_mode(slint::SharedString("light"));
        window->set_effective_inspector_open(false);
        slint::LogicalSize emptySessionSize;
        emptySessionSize.width = 1280.F;
        emptySessionSize.height = 800.F;
        window->window().set_size(emptySessionSize);
        window->show();
        static_cast<void>(slint::invoke_from_event_loop([] { slint::quit_event_loop(); }));
        slint::run_event_loop();
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
    window->show();
    static_cast<void>(slint::invoke_from_event_loop([] { slint::quit_event_loop(); }));
    slint::run_event_loop();

    const auto snapshot = window->window().take_snapshot();
    if (!snapshot) {
        std::cerr << "take_snapshot returned no pixels\n";
        return 1;
    }
    writeBmp(argv[1], *snapshot);
    window->hide();
    return 0;
}

// Deterministic screenshot tool: renders the real MainWindow through the
// Slint testing backend at an exact logical size and writes a BMP snapshot.
#include "app-window.h"


#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <string>
#include <utility>
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
    const bool darkMode = mode == "dark" || mode == "recording-dark" ||
                          mode == "waveform-dark";
    const bool journalMode = mode == "journal" || mode == "journal-tall";
    const bool journalTall = mode == "journal-tall";
    const bool guidesMode = mode == "guides";
    const bool materialsMode = mode == "materials";
    const bool settingsMode = mode == "settings";
    const bool compactMode = mode == "compact";
    const bool minMode = mode == "min" || mode == "minimum";
    const bool aiMode = mode == "ai";
    const bool waveformMode = mode == "waveform" || mode == "waveform-dark";
    const bool recordingMode = mode == "recording" || mode == "recording-dark" ||
                               mode == "recording-silent" || mode == "recording-error";
    const bool consentMode = mode == "consent";
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
    if (journalMode || guidesMode || materialsMode || settingsMode || compactMode || minMode) {
        if (compactMode || minMode)
            window->set_navigator_scope(slint::SharedString("sessions"));
        else if (journalMode)
            window->set_navigator_scope(slint::SharedString("journal"));
        else if (guidesMode)
            window->set_navigator_scope(slint::SharedString("guides"));
        else if (materialsMode)
            window->set_navigator_scope(slint::SharedString("materials"));
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
        } else if (materialsMode) {
            window->set_selected_session_title(
                slint::SharedString("Fractions and equivalence"));
            std::vector<MaterialRow> materials{
                MaterialRow{slint::SharedString("material-1"),
                            slint::SharedString("Number line worksheet.pdf"),
                            slint::SharedString("Number line worksheet.pdf"),
                            slint::SharedString("PDF · 248 KB · imported with this lesson")},
                MaterialRow{slint::SharedString("material-2"),
                            slint::SharedString("Worked examples.wav"),
                            slint::SharedString("Worked examples.wav"),
                            slint::SharedString("Audio · 1.2 MB · imported with this lesson")},
            };
            window->set_material_rows(
                std::make_shared<slint::VectorModel<MaterialRow>>(std::move(materials)));
            window->set_selected_asset(slint::SharedString("material-2"));
            window->set_asset_preview_kind(slint::SharedString("audio"));
            window->set_asset_preview_description(slint::SharedString(
                "Worked examples.wav · 8 kHz · 00:42 · linked to Fractions and equivalence"));
            window->set_asset_preview_waveform_state(slint::SharedString("ready"));
            window->set_asset_preview_waveform_duration_seconds(42);
            std::vector<WaveformBucketRow> materialWaveform;
            materialWaveform.reserve(56);
            for (int index = 0; index < 56; ++index) {
                const float phase = static_cast<float>(index % 13) / 13.0F;
                const float envelope = 0.12F + 0.62F *
                    (1.0F - std::abs(phase - 0.5F) * 1.5F);
                WaveformBucketRow bucket;
                bucket.position = static_cast<float>(index) / 56.0F;
                bucket.width = 1.0F / 56.0F;
                bucket.start_seconds = static_cast<float>(index) * 0.75F;
                bucket.end_seconds = static_cast<float>(index + 1) * 0.75F;
                bucket.minimum = -envelope * 0.68F;
                bucket.maximum = envelope;
                bucket.contains_gap = index == 29;
                materialWaveform.push_back(bucket);
            }
            window->set_asset_preview_waveform_buckets(
                std::make_shared<slint::VectorModel<WaveformBucketRow>>(
                    std::move(materialWaveform)));
            window->set_command_output(slint::SharedString("Audio preview ready."));
        }

        slint::LogicalSize pageSize;
        pageSize.width = minMode ? 900.F : compactMode ? 1024.F : 1280.F;
        pageSize.height = minMode ? 560.F : compactMode ? 768.F : journalTall ? 2400.F : 800.F;
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

    if (recordingMode || waveformMode) {
        std::vector<slint::SharedString> takes{
            slint::SharedString("Take 1 · Imported audio · 00:04:20"),
            slint::SharedString("Take 2 · Microphone + system audio · 00:12:40")};
        std::vector<slint::SharedString> tracks{
            slint::SharedString("Microphone 1"), slint::SharedString("System audio 2")};
        window->set_recording_take_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(takes));
        window->set_selected_recording_take_label(takes.back());
        window->set_recording_take_mutable(true);
        window->set_recording_track_options(
            std::make_shared<slint::VectorModel<slint::SharedString>>(tracks));
        window->set_selected_recording_track_label(tracks.front());
        window->set_recording_state(slint::SharedString("recording"));
        window->set_recording_elapsed_seconds(760);
        window->set_recording_duration_seconds(760);
        window->set_recording_duration_us(slint::SharedString("760000000"));
        window->set_recording_input_level(43);
        std::vector<WaveformBucketRow> waveform;
        waveform.reserve(96);
        for (int index = 0; index < 96; ++index) {
            const float phase = static_cast<float>(index % 19) / 19.0F;
            const float envelope = 0.16F + 0.56F * (1.0F - std::abs(phase - 0.5F) * 1.55F);
            WaveformBucketRow bucket;
            bucket.position = static_cast<float>(index) / 96.0F;
            bucket.width = 1.0F / 96.0F;
            bucket.start_seconds = static_cast<float>(index) * 8.0F;
            bucket.end_seconds = static_cast<float>(index + 1) * 8.0F;
            bucket.minimum = -envelope * 0.72F;
            bucket.maximum = envelope;
            bucket.contains_gap = index == 39 || index == 40;
            waveform.push_back(bucket);
        }
        window->set_recording_waveform_buckets(
            std::make_shared<slint::VectorModel<WaveformBucketRow>>(std::move(waveform)));
        window->set_recording_waveform_state(
            slint::SharedString(mode == "recording-silent" ? "silent" :
                                mode == "recording-error" ? "error" : "ready"));
        if (mode == "recording-silent" || mode == "recording-error")
            window->set_recording_state(slint::SharedString("completed"));
        if (mode == "recording-error")
            window->set_recording_waveform_message(
                slint::SharedString("The waveform index could not be loaded."));
        window->set_recording_playback_position_seconds(432);
    }

    window->set_theme_mode(slint::SharedString(darkMode ? "dark" : "light"));
    window->set_effective_inspector_open(
        !(aiMode || recordingMode || waveformMode || consentMode));
    if (paletteMode)
        window->set_command_palette_open(true);
    if (aiMode)
        window->set_overlay_panel(slint::SharedString("ai"));
    if (recordingMode)
        window->set_overlay_panel(slint::SharedString("recording"));
    if (consentMode)
        window->set_overlay_panel(slint::SharedString("recording-consent"));
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

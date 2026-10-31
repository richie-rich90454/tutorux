#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai_transport;
mod archive_lock;
mod archive_lock_support;
mod audio_import;
mod console;
mod credentials;
mod desktop;
mod diagnostics;
mod embedded_ai;
mod live_transcription;
mod platform;
mod transcription;

use desktop::{archive_launch_path, install_native_menu, DesktopState};
use std::path::{Path, PathBuf};
use tauri::{Emitter, Manager};

fn main() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .manage(console::ConsoleState::default())
        .manage(embedded_ai::EmbeddedAiState::default())
        .manage(platform::audio_capture::AudioCaptureState::default())
        .manage(platform::synchronized_audio::SynchronizedAudioCaptureState::default())
        .plugin(tauri_plugin_single_instance::init(
            |app, arguments, current_directory| {
                if let Some(path) = archive_launch_path(
                    arguments.into_iter().skip(1).map(PathBuf::from),
                    Path::new(&current_directory),
                ) {
                    if let Ok(mut pending) = app.state::<DesktopState>().pending_open.lock() {
                        pending.push_back(path);
                        let _ = app.emit("tutorux:native-command", "open-launch-archive");
                    }
                }
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            },
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let current_directory = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            if let Some(path) = archive_launch_path(
                std::env::args_os().skip(1).map(PathBuf::from),
                &current_directory,
            ) {
                app.state::<DesktopState>()
                    .pending_open
                    .lock()
                    .map_err(|_| std::io::Error::other("Launch archive state is unavailable."))?
                    .push_back(path);
            }
            install_native_menu(app)
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "archive.open" => {
                let _ = app.emit("tutorux:native-command", "open");
            }
            "archive.save" => {
                let _ = app.emit("tutorux:native-command", "save");
            }
            "app.quick-actions" => {
                let _ = app.emit("tutorux:native-command", "quick-actions");
            }
            "app.preferences" => {
                let _ = app.emit("tutorux:native-command", "preferences");
            }
            "app.toggle-appearance" => {
                let _ = app.emit("tutorux:native-command", "toggle-appearance");
            }
            "app.quit" => app.exit(0),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            diagnostics::get_desktop_diagnostics,
            audio_import::import_compressed_audio,
            console::command_console_availability,
            console::run_command_console,
            console::cancel_command_console,
            credentials::ai_credential_store_available,
            credentials::has_ai_credential,
            credentials::save_ai_credential,
            credentials::remove_ai_credential,
            embedded_ai::authorize_embedded_model,
            embedded_ai::load_embedded_model,
            embedded_ai::unload_embedded_model,
            embedded_ai::embedded_model_status,
            embedded_ai::generate_embedded_text,
            embedded_ai::cancel_embedded_generation,
            desktop::archive::authorize_archive_path,
            desktop::archive::close_archive,
            desktop::archive::read_archive_range,
            desktop::save::prepare_archive_save,
            desktop::save::publish_archive_save,
            desktop::save::cancel_archive_save,
            desktop::launch::take_pending_open_archive,
            desktop::export::write_export_file,
            ai_transport::send_ai_request,
            transcription::begin_whisper_run,
            transcription::cancel_whisper_run,
            transcription::end_whisper_run,
            transcription::transcribe_whisper,
            live_transcription::begin_live_whisper,
            live_transcription::enqueue_live_whisper_audio,
            live_transcription::poll_live_whisper,
            live_transcription::acknowledge_live_whisper_cues,
            live_transcription::cancel_live_whisper,
            live_transcription::finish_live_whisper,
            live_transcription::end_live_whisper,
            desktop::append::append_audio_archive_generation,
            platform::audio_capture::begin_audio_capture,
            platform::audio_capture::append_audio_capture_chunk,
            platform::audio_capture::pause_audio_capture,
            platform::audio_capture::resume_audio_capture,
            platform::audio_capture::finish_audio_capture,
            platform::audio_capture::discard_audio_capture,
            platform::synchronized_audio::list_synchronized_audio_devices,
            platform::microphone_preflight::preflight_microphone,
            platform::synchronized_audio::begin_synchronized_audio_capture,
            platform::synchronized_audio::activate_synchronized_audio_capture,
            platform::synchronized_audio::pause_synchronized_audio_capture,
            platform::synchronized_audio::resume_synchronized_audio_capture,
            platform::synchronized_audio::stop_synchronized_audio_source,
            platform::synchronized_audio::finish_synchronized_audio_capture,
            platform::synchronized_audio::discard_synchronized_audio_capture
        ])
        .run(tauri::generate_context!())
        .expect("Tutorux desktop host failed to start");
}

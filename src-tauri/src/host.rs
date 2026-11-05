use std::path::{Path, PathBuf};

use tauri::{Emitter, Manager};

use crate::desktop::{archive_launch_path, install_native_menu, DesktopState};
use crate::store::WorkspaceState;
use crate::{
    ai_transport, credentials, diagnostics, embedded_ai, live_transcription, platform, store,
    transcription,
};

pub fn run() {
    tauri::Builder::default()
        .manage(DesktopState::default())
        .manage(WorkspaceState::default())
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
                        if pending.len() < 8 {
                            pending.push_back(path);
                        }
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
        .plugin(tauri_plugin_notification::init())
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
            store::workspace_create,
            store::workspace_open,
            store::workspace_close,
            store::workspace_summary,
            store::workspace_rename,
            store::workspace_rekey,
            store::today_data,
            store::students_list,
            store::student_get,
            store::student_create,
            store::student_update,
            store::student_delete,
            store::student_detail,
            store::sessions_list,
            store::session_get,
            store::session_create,
            store::session_update,
            store::session_delete,
            store::session_start,
            store::session_detail,
            store::schedule_list,
            store::schedule_create,
            store::schedule_update,
            store::schedule_delete,
            store::journal_list,
            store::journal_create,
            store::journal_update,
            store::journal_delete,
            store::observations_list,
            store::observation_create,
            store::observation_update,
            store::observation_delete,
            store::cues_list,
            store::cue_create,
            store::cue_update,
            store::cue_delete,
            store::materials_list,
            store::material_import,
            store::material_link,
            store::material_update,
            store::material_delete,
            store::material_read,
            store::material_ocr,
            store::recordings_list,
            store::recording_import,
            store::recording_import_tracks,
            store::recording_read,
            store::recording_read_track,
            store::recording_delete,
            store::guides_list,
            store::guide_get,
            store::guide_create,
            store::guide_update,
            store::guide_delete,
            store::evidence_list,
            store::evidence_create,
            store::evidence_update,
            store::evidence_delete,
            store::evidence_graph,
            store::evidence_link_create,
            store::evidence_link_delete,
            store::goals_list,
            store::goal_upsert,
            store::goal_delete,
            store::skills_list,
            store::skill_upsert,
            store::skill_delete,
            store::search_global,
            store::trash_list,
            store::trash_restore,
            store::trash_delete,
            store::trash_empty,
            store::trash_purge_expired,
            store::settings_all,
            store::setting_set,
            store::backup_create,
            store::workspace_check,
            store::workspace_compact,
            store::workspace_reindex,
            store::workspace_recovery_copy,
            store::workspace_sanitized_copy,
            store::session_package_export,
            store::session_package_import,
            store::reminders_due,
            store::calendar_client_status,
            store::calendar_save_client,
            store::calendar_accounts,
            store::calendar_connect,
            store::calendar_connect_caldav,
            store::calendar_sync,
            store::calendar_disconnect,
            diagnostics::get_desktop_diagnostics,
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
            crate::desktop::launch::take_pending_open_archive,
            crate::desktop::export::write_export_file,
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

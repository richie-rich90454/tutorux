use tauri::WebviewWindow;

/// Application commands are only exposed to the single Tutorux window.
pub(crate) fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("This action is only available from the main Tutorux window.".to_owned());
    }
    Ok(())
}

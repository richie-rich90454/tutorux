use tauri::WebviewWindow;

fn is_main_window_label(label: &str) -> bool {
    label == "main"
}

/// Application commands are only exposed to the single Tutorux window.
pub(crate) fn ensure_main_window(window: &WebviewWindow) -> Result<(), String> {
    if !is_main_window_label(window.label()) {
        return Err("This action is only available from the main Tutorux window.".to_owned());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_main_label_is_accepted() {
        assert!(super::is_main_window_label("main"));
        assert!(!super::is_main_window_label("settings"));
        assert!(!super::is_main_window_label(""));
    }
}

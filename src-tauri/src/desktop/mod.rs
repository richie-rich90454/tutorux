pub(crate) mod export;
pub(crate) mod identity;
pub(crate) mod launch;
pub(crate) mod menu;
pub(crate) mod state;
pub(crate) mod window;

pub(crate) use launch::archive_launch_path;
pub(crate) use menu::install_native_menu;
pub(crate) use state::DesktopState;

#[tauri::command]
pub(crate) fn system_temp_directory() -> String {
    std::env::temp_dir().to_string_lossy().into_owned()
}

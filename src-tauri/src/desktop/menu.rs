use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

pub(crate) fn install_native_menu(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let open_archive = MenuItem::with_id(
        handle,
        "archive.open",
        "Open Archive…",
        true,
        Some("CmdOrCtrl+O"),
    )?;
    let save_archive = MenuItem::with_id(
        handle,
        "archive.save",
        "Save Archive",
        true,
        Some("CmdOrCtrl+S"),
    )?;
    let quick_actions = MenuItem::with_id(
        handle,
        "app.quick-actions",
        "Quick Actions…",
        true,
        None::<&str>,
    )?;
    let preferences = MenuItem::with_id(
        handle,
        "app.preferences",
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let toggle_appearance = MenuItem::with_id(
        handle,
        "app.toggle-appearance",
        "Toggle Appearance",
        true,
        Some("CmdOrCtrl+Shift+L"),
    )?;
    let quit = MenuItem::with_id(
        handle,
        "app.quit",
        "Quit Tutorux",
        true,
        Some("CmdOrCtrl+Q"),
    )?;
    let separator = PredefinedMenuItem::separator(handle)?;
    let file_menu = Submenu::with_items(
        handle,
        "File",
        true,
        &[&open_archive, &save_archive, &separator, &quit],
    )?;
    let edit_menu = Submenu::with_items(
        handle,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(handle, None)?,
            &PredefinedMenuItem::redo(handle, None)?,
            &PredefinedMenuItem::separator(handle)?,
            &PredefinedMenuItem::cut(handle, None)?,
            &PredefinedMenuItem::copy(handle, None)?,
            &PredefinedMenuItem::paste(handle, None)?,
            &PredefinedMenuItem::select_all(handle, None)?,
        ],
    )?;
    let view_menu = Submenu::with_items(
        handle,
        "View",
        true,
        &[&quick_actions, &toggle_appearance, &preferences],
    )?;

    #[cfg(target_os = "macos")]
    let app_menu = Submenu::with_items(
        handle,
        "Tutorux",
        true,
        &[
            &PredefinedMenuItem::about(handle, Some("About Tutorux"), None)?,
            &PredefinedMenuItem::separator(handle)?,
            &quit,
        ],
    )?;
    #[cfg(target_os = "macos")]
    let menu = Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &view_menu])?;
    #[cfg(not(target_os = "macos"))]
    let menu = Menu::with_items(app, &[&file_menu, &edit_menu, &view_menu])?;
    app.set_menu(menu)?;
    Ok(())
}

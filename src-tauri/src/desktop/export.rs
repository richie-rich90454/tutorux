use super::identity::move_file_without_replacing;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_EXPORT_BYTES: usize = 256 * 1024 * 1024;

#[tauri::command]
pub(crate) fn write_export_file(
    window: tauri::WebviewWindow,
    path: String,
    contents: String,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Exports are only available from the main window.".to_owned());
    }
    write_export_contents(path, contents)
}

fn write_export_contents(path: String, contents: String) -> Result<(), String> {
    if contents.len() > MAX_EXPORT_BYTES {
        return Err("Transcript export exceeds the 256 MiB safety limit.".to_owned());
    }
    let requested = PathBuf::from(path);
    if !requested.is_absolute() {
        return Err("Export destinations must be absolute paths.".to_owned());
    }
    let extension = requested
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    const ALLOWED_EXPORT_EXTENSIONS: &[&str] = &[
        "txt", "md", "markdown", "srt", "vtt", "json", "jsonl", "html", "htm", "docx", "pdf",
        "wav", "csv", "xml",
    ];
    if !ALLOWED_EXPORT_EXTENSIONS.contains(&extension.as_str()) {
        return Err(
            "Exports are limited to document, transcript, data, and audio file types.".to_owned(),
        );
    }
    let normalized = requested.to_string_lossy().to_lowercase();
    const BLOCKED_EXPORT_PATHS: &[&str] = &[
        "\\start menu\\",
        "/start menu/",
        "\\.config\\autostart\\",
        "/.config/autostart/",
        "\\startup\\",
        "/startup/",
        "\\windows\\system32\\",
        "/etc/",
        "/usr/",
        "/bin/",
        "/sbin/",
        "/lib/",
    ];
    if BLOCKED_EXPORT_PATHS
        .iter()
        .any(|blocked| normalized.contains(blocked))
    {
        return Err("Exports cannot be written to a system or startup directory.".to_owned());
    }
    let parent = requested
        .parent()
        .filter(|folder| !folder.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Could not create the export folder {}: {error}",
            parent.display()
        )
    })?;
    let parent = fs::canonicalize(parent)
        .map_err(|error| format!("Could not access export folder: {error}"))?;
    let filename = requested
        .file_name()
        .ok_or_else(|| "Export destination needs a file name.".to_owned())?;
    let target = parent.join(filename);
    if target.is_dir() {
        return Err("The export destination is a folder.".to_owned());
    }

    let token = Uuid::new_v4().to_string();
    let temporary = parent.join(format!(".tutorux-export-{token}.partial"));
    let backup = parent.join(format!(".tutorux-export-{token}.backup"));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Could not create transcript export: {error}"))?;
    if let Err(error) = file
        .write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not write transcript export: {error}"));
    }
    drop(file);

    let had_target = target.exists();
    if had_target {
        if let Err(error) = fs::rename(&target, &backup) {
            let _ = fs::remove_file(&temporary);
            return Err(format!("Could not preserve the existing export: {error}"));
        }
    }
    if let Err(error) = move_file_without_replacing(&temporary, &target) {
        if had_target {
            if let Err(restore_error) = move_file_without_replacing(&backup, &target) {
                let _ = fs::remove_file(&temporary);
                return Err(format!(
                    "Could not publish transcript export: {error}. The previous export remains at {} because it could not be safely restored: {restore_error}",
                    backup.display()
                ));
            }
            let _ = fs::remove_file(&backup);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("Could not publish transcript export: {error}"));
    }
    if had_target {
        let _ = fs::remove_file(backup);
    }
    let _ = fs::remove_file(&temporary);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::write_export_contents;

    #[test]
    fn export_creates_missing_folders() {
        let root = tempfile::tempdir().expect("temp dir");
        let target = root.path().join("reports").join("guide.html");
        write_export_contents(
            target.to_string_lossy().into_owned(),
            "<p>guide</p>".to_owned(),
        )
        .expect("write export");
        assert_eq!(
            std::fs::read_to_string(&target).expect("read export"),
            "<p>guide</p>"
        );
    }

    #[test]
    fn export_replaces_an_existing_file_through_a_staged_copy() {
        let root = tempfile::tempdir().expect("temp dir");
        let target = root.path().join("guide.html");
        std::fs::write(&target, "old export").expect("write existing export");

        write_export_contents(
            target.to_string_lossy().into_owned(),
            "<p>updated guide</p>".to_owned(),
        )
        .expect("replace export");

        assert_eq!(
            std::fs::read_to_string(&target).expect("read updated export"),
            "<p>updated guide</p>"
        );
    }
}

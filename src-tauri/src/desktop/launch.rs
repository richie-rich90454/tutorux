use super::state::DesktopState;
use std::path::{Path, PathBuf};
use tauri::State;

#[tauri::command]
pub(crate) fn take_pending_open_archive(
    state: State<'_, DesktopState>,
) -> Result<Option<String>, String> {
    let path = state
        .pending_open
        .lock()
        .map_err(|_| "Launch file state is unavailable.".to_owned())?
        .pop_front();
    Ok(path.map(|path| path.to_string_lossy().into_owned()))
}

pub(crate) fn archive_launch_path(
    arguments: impl IntoIterator<Item = PathBuf>,
    current_directory: &Path,
) -> Option<PathBuf> {
    arguments
        .into_iter()
        .find(|path| {
            path.extension()
                .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("tux"))
        })
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                current_directory.join(path)
            }
        })
}

#[cfg(test)]
mod tests {
    use super::archive_launch_path;
    use std::path::{Path, PathBuf};

    #[test]
    fn archive_launch_path_ignores_non_archives_and_resolves_relative_paths() {
        let cwd = Path::new("launch-directory");
        let path = archive_launch_path(
            [
                PathBuf::from("Tutorux.exe"),
                PathBuf::from("lessons/Math.TUX"),
                PathBuf::from("ignored.tux"),
            ],
            cwd,
        );

        assert_eq!(path, Some(cwd.join("lessons/Math.TUX")));
    }

    #[test]
    fn archive_launch_path_preserves_absolute_paths() {
        let absolute_path = std::env::current_dir()
            .expect("test working directory should be available")
            .join("lesson.tux");
        let path = archive_launch_path([absolute_path.clone()], Path::new("other-directory"));

        assert_eq!(path, Some(absolute_path));
    }
}

use std::{
    fs::{self, File},
    io::{self, Cursor},
    path::{Component, Path, PathBuf},
    sync::OnceLock,
    time::SystemTime,
};
use tauri::{AppHandle, Manager};

const EMBEDDED_RUNTIME: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/tutorux-runtime.zip"));
const RUNTIME_ID: &str = env!("TUTORUX_RUNTIME_ID");
const MAX_RUNTIME_BYTES: u64 = 4 * 1024 * 1024 * 1024;

static RUNTIME_PATHS: OnceLock<Result<RuntimePaths, String>> = OnceLock::new();

#[derive(Clone)]
pub(crate) struct RuntimePaths {
    pub(crate) node: PathBuf,
    pub(crate) cli_entry: PathBuf,
    pub(crate) audio_helper: PathBuf,
    pub(crate) embedded_ai: PathBuf,
}

pub(crate) fn paths(app: &AppHandle) -> Result<RuntimePaths, String> {
    RUNTIME_PATHS.get_or_init(|| prepare(app)).clone()
}

fn prepare(app: &AppHandle) -> Result<RuntimePaths, String> {
    if EMBEDDED_RUNTIME.is_empty() {
        return development_paths();
    }
    let runtime_directory = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Tutorux could not locate its application data directory.".to_owned())?
        .join("runtime");
    let root = runtime_directory.join(RUNTIME_ID);
    if !runtime_is_ready(&root) {
        extract_runtime(&runtime_directory, &root)?;
    }
    Ok(paths_in(root))
}

fn runtime_is_ready(root: &Path) -> bool {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    root.join(".ready").is_file()
        && root
            .join("console-runtime")
            .join(format!("node{extension}"))
            .is_file()
        && root
            .join("console-runtime")
            .join("tutorux-cli.mjs")
            .is_file()
        && root
            .join(format!("tutorux-audio-helper{extension}"))
            .is_file()
        && root
            .join(format!("tutorux-embedded-ai{extension}"))
            .is_file()
}

fn extract_runtime(parent: &Path, root: &Path) -> Result<(), String> {
    fs::create_dir_all(parent)
        .map_err(|error| format!("Tutorux could not create its runtime directory: {error}"))?;
    if root.exists() && !runtime_is_ready(root) {
        fs::remove_dir_all(root)
            .map_err(|error| format!("Tutorux could not repair its runtime directory: {error}"))?;
    }
    let staging = parent.join(format!(".staging-{}", uuid::Uuid::new_v4()));
    let result = extract_archive(EMBEDDED_RUNTIME, &staging)
        .and_then(|()| {
            fs::write(staging.join(".ready"), RUNTIME_ID)
                .map_err(|error| format!("Tutorux could not finish its runtime: {error}"))
        })
        .and_then(|()| match fs::rename(&staging, root) {
            Ok(()) => Ok(()),
            Err(_) if runtime_is_ready(root) => {
                let _ = fs::remove_dir_all(&staging);
                Ok(())
            }
            Err(error) => Err(format!(
                "Tutorux could not install its embedded runtime: {error}"
            )),
        });
    if result.is_err() {
        let _ = fs::remove_dir_all(&staging);
        return result;
    }
    Ok(())
}

fn extract_archive(bytes: &[u8], destination: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
        .map_err(|_| "The embedded Tutorux runtime archive is invalid.".to_owned())?;
    fs::create_dir_all(destination)
        .map_err(|error| format!("Tutorux could not create its runtime directory: {error}"))?;
    let mut total_bytes = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| "The embedded Tutorux runtime archive is damaged.".to_owned())?;
        if entry.name().contains('\\') {
            return Err("The embedded Tutorux runtime archive contains an invalid path.".into());
        }
        let Some(relative) = entry.enclosed_name() else {
            return Err("The embedded Tutorux runtime archive contains an unsafe path.".into());
        };
        if relative.as_os_str().is_empty()
            || relative.components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err("The embedded Tutorux runtime archive contains an unsafe path.".into());
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("The embedded Tutorux runtime archive contains a link.".into());
        }
        total_bytes = total_bytes.saturating_add(entry.size());
        if total_bytes > MAX_RUNTIME_BYTES {
            return Err("The embedded Tutorux runtime exceeds its supported size.".into());
        }

        let target = destination.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| {
                format!("Tutorux could not create its runtime directory: {error}")
            })?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Tutorux could not create its runtime directory: {error}")
            })?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("Tutorux could not write its runtime: {error}"))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("Tutorux could not unpack its runtime: {error}"))?;
        make_executable(&target, &relative);
    }
    Ok(())
}

fn make_executable(path: &Path, relative: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let executable = relative
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                matches!(
                    name,
                    "node" | "tutorux-audio-helper" | "tutorux-embedded-ai"
                )
            });
        if executable {
            let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o755));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, relative);
    }
}

fn paths_in(root: PathBuf) -> RuntimePaths {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let console_directory = root.join("console-runtime");
    RuntimePaths {
        node: console_directory.join(format!("node{extension}")),
        cli_entry: console_directory.join("tutorux-cli.mjs"),
        audio_helper: root.join(format!("tutorux-audio-helper{extension}")),
        embedded_ai: root.join(format!("tutorux-embedded-ai{extension}")),
    }
}

fn development_paths() -> Result<RuntimePaths, String> {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let console_directory = manifest.join("binaries").join("console-runtime");
    Ok(RuntimePaths {
        node: console_directory.join(format!("node{extension}")),
        cli_entry: console_directory.join("tutorux-cli.mjs"),
        audio_helper: development_sidecar(manifest, "tutorux-audio-helper")?,
        embedded_ai: development_sidecar(manifest, "tutorux-embedded-ai")?,
    })
}

fn development_sidecar(manifest: &Path, name: &str) -> Result<PathBuf, String> {
    let extension = if cfg!(windows) { ".exe" } else { "" };
    let directory = manifest.join("binaries");
    let prefix = format!("{name}-");
    let mut candidates = Vec::new();
    if let Ok(entries) = fs::read_dir(&directory) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if path.is_file()
                && file_name.ends_with(extension)
                && (file_name == format!("{name}{extension}") || file_name.starts_with(&prefix))
            {
                let modified = fs::metadata(&path)
                    .and_then(|metadata| metadata.modified())
                    .unwrap_or(SystemTime::UNIX_EPOCH);
                candidates.push((modified, path));
            }
        }
    }
    candidates.sort_by(|left, right| right.0.cmp(&left.0));
    if let Some((_, path)) = candidates.into_iter().next() {
        return Ok(path);
    }
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    let built = manifest
        .join("target")
        .join(profile)
        .join(format!("{name}{extension}"));
    if built.is_file() {
        return Ok(built);
    }
    Err(format!(
        "The bundled {name} helper is missing. Run pnpm run build:audio-helper and pnpm run build:embedded-ai."
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn archive(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
        for (name, contents) in entries {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .expect("start a zip entry");
            writer.write_all(contents).expect("write a zip entry");
        }
        writer
            .finish()
            .expect("finish the zip archive")
            .into_inner()
    }

    fn temporary_directory() -> PathBuf {
        std::env::temp_dir().join(format!("tutorux-runtime-test-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn extracts_nested_runtime_files() {
        let destination = temporary_directory();
        let bytes = archive(&[
            ("console-runtime/tutorux-cli.mjs", b"console.log('ok');"),
            ("tutorux-audio-helper.exe", b"helper"),
        ]);
        extract_archive(&bytes, &destination).expect("extract the runtime");
        assert_eq!(
            fs::read(destination.join("console-runtime/tutorux-cli.mjs")).expect("read the CLI"),
            b"console.log('ok');"
        );
        assert_eq!(
            fs::read(destination.join("tutorux-audio-helper.exe")).expect("read the helper"),
            b"helper"
        );
        let _ = fs::remove_dir_all(destination);
    }

    #[test]
    fn rejects_parent_paths() {
        let destination = temporary_directory();
        let bytes = archive(&[("../escape.txt", b"escape")]);
        assert!(extract_archive(&bytes, &destination).is_err());
        assert!(!destination
            .parent()
            .expect("parent")
            .join("escape.txt")
            .exists());
        let _ = fs::remove_dir_all(destination);
    }

    #[test]
    fn readiness_requires_the_node_runtime_and_both_helpers() {
        let destination = temporary_directory();
        let extension = if cfg!(windows) { ".exe" } else { "" };
        let node = format!("console-runtime/node{extension}");
        let audio_helper = format!("tutorux-audio-helper{extension}");
        let embedded_ai = format!("tutorux-embedded-ai{extension}");
        let bytes = archive(&[
            (node.as_str(), b"node" as &[u8]),
            ("console-runtime/tutorux-cli.mjs", b"cli"),
            (audio_helper.as_str(), b"audio"),
            (embedded_ai.as_str(), b"ai"),
        ]);
        extract_archive(&bytes, &destination).expect("extract the runtime");
        fs::write(destination.join(".ready"), "test").expect("write the marker");
        assert!(runtime_is_ready(&destination));
        fs::remove_file(destination.join(&node)).expect("remove the node runtime");
        assert!(!runtime_is_ready(&destination));
        let _ = fs::remove_dir_all(destination);
    }
}

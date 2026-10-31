fn main() {
    // Tauri checks configured resources while compiling. The console runtime is
    // generated before packaging, but a plain `cargo check` needs the directory.
    let _ = std::fs::create_dir_all("../dist/console-runtime");
    prepare_embedded_ai_sidecar();
    tauri_build::build();
}

// Tauri validates configured external binaries during every package build,
// including the sidecar's own build. Reuse a previously compiled helper when
// one exists; otherwise leave an empty placeholder that packaging replaces.
fn prepare_embedded_ai_sidecar() {
    let Ok(target) = std::env::var("TARGET") else {
        return;
    };
    if target.is_empty() {
        return;
    }
    let extension = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let helper_name = format!("tutorux-embedded-ai{extension}");
    let output =
        std::path::Path::new("binaries").join(format!("tutorux-embedded-ai-{target}{extension}"));
    if output.exists() {
        return;
    }
    let profile = std::env::var("PROFILE").unwrap_or_else(|_| "debug".to_owned());
    let candidates = [
        std::path::Path::new("target")
            .join(&target)
            .join(&profile)
            .join(&helper_name),
        std::path::Path::new("target")
            .join(&profile)
            .join(&helper_name),
    ];
    let _ = std::fs::create_dir_all("binaries");
    for candidate in candidates {
        if candidate.is_file() && std::fs::copy(&candidate, &output).is_ok() {
            make_executable(&output);
            return;
        }
    }
    let _ = std::fs::File::create(&output);
}

fn make_executable(path: &std::path::Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755));
    }
    #[cfg(not(unix))]
    {
        let _ = path;
    }
}

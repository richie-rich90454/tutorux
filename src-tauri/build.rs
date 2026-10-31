use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

fn main() {
    prepare_runtime_archive();
    tauri_build::build();
}

// The portable runtime is a single ZIP embedded into the desktop binary. The
// packaging scripts create it before Cargo runs; plain cargo commands use an
// empty placeholder and fall back to the development file layout.
fn prepare_runtime_archive() {
    let output = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR is set by Cargo"))
        .join("tutorux-runtime.zip");
    let target = env::var("TARGET").expect("TARGET is set by Cargo");
    let source = Path::new("binaries").join(format!("tutorux-runtime-{target}.zip"));
    println!("cargo:rerun-if-changed=binaries");
    println!("cargo:rerun-if-changed={}", source.display());

    let bytes = match fs::read(&source) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => panic!("Could not read {}: {error}", source.display()),
    };
    fs::write(&output, &bytes).expect("Could not stage the embedded Tutorux runtime");

    let id = if bytes.is_empty() {
        "development".to_owned()
    } else {
        Sha256::digest(&bytes)
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect()
    };
    println!("cargo:rustc-env=TUTORUX_RUNTIME_ID={id}");
}

fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
        if let Ok(output) = std::process::Command::new("xcode-select").arg("-p").output() {
            if output.status.success() {
                let xcode = String::from_utf8_lossy(&output.stdout).trim().to_string();
                let swift_lib_path = format!(
                    "{xcode}/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx"
                );
                println!("cargo:rustc-link-arg=-Wl,-rpath,{swift_lib_path}");
            }
        }
    }
    tauri_build::build();
}

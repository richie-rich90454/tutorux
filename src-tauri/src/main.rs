#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![cfg_attr(windows, allow(linker_messages))]

fn main() {
    tutorux_desktop::host::run();
}

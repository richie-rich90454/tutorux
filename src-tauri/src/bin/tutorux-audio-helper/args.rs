use std::env;
use std::io::{self, Write};

use crate::application::{application_devices, application_probe_unavailable_reason};
use crate::application_capture::capture_application_audio;
use crate::application_probe::probe_application_audio;
use crate::archive_lock::archive_lock;
use crate::native_input;

pub(crate) fn run() -> Result<(), String> {
    let mut arguments = env::args().skip(1);
    match arguments.next().as_deref() {
        Some("devices") => {
            if arguments.next().is_some() {
                return Err("devices does not accept arguments".to_owned());
            }
            let devices = application_devices()?;
            serde_json::to_writer(io::stdout().lock(), &devices)
                .map_err(|error| format!("could not write the application list: {error}"))?;
            io::stdout()
                .lock()
                .write_all(b"\n")
                .map_err(|error| format!("could not finish the application list: {error}"))?;
            Ok(())
        }
        Some("inputs") => {
            if arguments.next().is_some() {
                return Err("inputs does not accept arguments".to_owned());
            }
            let devices = native_input::enumerate()?;
            serde_json::to_writer(io::stdout().lock(), &devices)
                .map_err(|error| format!("could not write the native audio input list: {error}"))?;
            io::stdout()
                .lock()
                .write_all(b"\n")
                .map_err(|error| format!("could not finish the native audio input list: {error}"))?;
            Ok(())
        }
        Some("probe") => {
            let first_option = arguments.next();
            if first_option.as_deref() == Some("--application") {
                let id = arguments
                    .next()
                    .ok_or_else(|| "an application device ID is required".to_owned())?;
                if arguments.next().is_some() {
                    return Err("use probe --application <device-id>".to_owned());
                }
                let device = application_devices()?
                    .into_iter()
                    .find(|device| device.id == id)
                    .ok_or_else(|| application_probe_unavailable_reason())?;
                return probe_application_audio(&device);
            }
            let source = arguments.next();
            let device_option = arguments.next();
            let device_id = arguments.next();
            if first_option.as_deref() != Some("--source")
                || device_option.as_deref() != Some("--device")
                || arguments.next().is_some()
            {
                return Err("use probe --source microphone|system-audio --device <device-id> or probe --application <device-id>".to_owned());
            }
            let source = capture_source(source.as_deref(), "probe")?;
            let device_id = device_id.ok_or_else(|| "a device ID is required".to_owned())?;
            native_input::probe(source, &device_id)
        }
        Some("capture") => {
            let option = arguments.next();
            let id = arguments.next();
            if option.as_deref() == Some("--application") {
                if arguments.next().is_some() {
                    return Err("use capture --application <device-id>".to_owned());
                }
                let id = id.ok_or_else(|| "an application device ID is required".to_owned())?;
                let device = application_devices()?
                    .into_iter()
                    .find(|device| device.id == id)
                    .ok_or_else(|| "the selected application is no longer available".to_owned())?;
                return capture_application_audio(&device);
            }
            if option.as_deref() != Some("--source") {
                return Err("use capture --source microphone|system-audio --device <device-id>".to_owned());
            }
            let source = capture_source(id.as_deref(), "capture")?;
            let device_option = arguments.next();
            let device_id = arguments.next();
            if device_option.as_deref() != Some("--device") || arguments.next().is_some() {
                return Err("use capture --source microphone|system-audio --device <device-id>".to_owned());
            }
            let device_id = device_id.ok_or_else(|| "a device ID is required".to_owned())?;
            native_input::capture(source, &device_id)
        }
        Some("archive-lock") => archive_lock(arguments),
        Some("--version") => {
            if arguments.next().is_some() {
                return Err("--version does not accept arguments".to_owned());
            }
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        _ => Err("use devices, inputs, probe --source microphone|system-audio --device <device-id>, probe --application <device-id>, capture --application <device-id>, capture --source microphone|system-audio --device <device-id>, archive-lock --shared|--exclusive <archive-path>, or --version".to_owned()),
    }
}

pub(crate) fn capture_source<'a>(source: Option<&'a str>, command: &str) -> Result<&'a str, String> {
    match source {
        Some(value @ ("microphone" | "system-audio")) => Ok(value),
        _ => Err(format!(
            "{command} source must be microphone or system-audio"
        )),
    }
}

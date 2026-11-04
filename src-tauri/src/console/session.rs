use super::{
    output::ConsoleOutputSink,
    parser::{
        has_passphrase_env_option, is_archive_discovery, replace_passphrase_env_option,
        supports_new_passphrase,
    },
    ConsoleRunResult,
};
use crate::archive_lock_support::{register_ambient_archive_lock, SharedArchiveLock};
use crate::core::cli::{execute_cli_with_secrets, Cancellation};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::AppHandle;
use zeroize::Zeroizing;

struct RunCancellation<'a> {
    cancelled: &'a AtomicBool,
    observed: &'a AtomicBool,
}

impl Cancellation for RunCancellation<'_> {
    fn is_cancelled(&self) -> bool {
        self.observed.store(true, Ordering::Release);
        self.cancelled.load(Ordering::Acquire)
    }
}

#[allow(clippy::too_many_arguments)]
pub(super) fn execute_console_command(
    app: &AppHandle,
    run_id: &str,
    archive_path: &Path,
    mut arguments: Vec<String>,
    passphrase: &Zeroizing<String>,
    new_passphrase: &Zeroizing<String>,
    cancellation: &AtomicBool,
    archive_lock: SharedArchiveLock,
) -> Result<ConsoleRunResult, String> {
    if cancellation.load(Ordering::Acquire) {
        return Ok(ConsoleRunResult {
            exit_code: 130,
            cancelled: true,
            archive_changed: false,
        });
    }

    let suffix = run_id.replace('-', "");
    let mut secrets: Vec<(String, Zeroizing<String>)> = Vec::new();
    if !passphrase.is_empty() {
        if has_passphrase_env_option(&arguments, "--passphrase-env") {
            return Err("Enter the current passphrase in the console field or use --passphrase-env from your environment, not both.".to_owned());
        }
        let name = format!("TUTORUX_CONSOLE_CURRENT_{suffix}");
        secrets.push((name.clone(), Zeroizing::new(passphrase.to_string())));
        arguments.push("--passphrase-env".to_owned());
        arguments.push(name);
    }
    if !new_passphrase.is_empty() {
        if !supports_new_passphrase(&arguments)
            && !has_passphrase_env_option(&arguments, "--new-passphrase-env")
        {
            return Err("A new passphrase is only used by archive init, encrypt, change-passphrase, or sanitize commands.".to_owned());
        }
        let name = format!("TUTORUX_CONSOLE_NEW_{suffix}");
        secrets.push((name.clone(), Zeroizing::new(new_passphrase.to_string())));
        if !replace_passphrase_env_option(&mut arguments, "--new-passphrase-env", &name) {
            arguments.push("--new-passphrase-env".to_owned());
            arguments.push(name);
        }
    }

    let mut cli_arguments = vec![
        "--archive".to_owned(),
        archive_path.to_string_lossy().into_owned(),
    ];
    if is_archive_discovery(&arguments) {
        if let Some(directory) = archive_path
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
        {
            cli_arguments.push("--directory".to_owned());
            cli_arguments.push(directory.to_string_lossy().into_owned());
        }
    }
    cli_arguments.extend(arguments);

    let observed = AtomicBool::new(false);
    let mut output = ConsoleOutputSink::new(app.clone(), run_id);
    let _ambient_lock = register_ambient_archive_lock(archive_path, archive_lock)?;
    let exit_code = execute_cli_with_secrets(
        &cli_arguments,
        &mut output,
        &RunCancellation {
            cancelled: cancellation,
            observed: &observed,
        },
        &secrets,
    );

    Ok(ConsoleRunResult {
        exit_code,
        cancelled: cancellation.load(Ordering::Acquire) && observed.load(Ordering::Acquire),
        archive_changed: false,
    })
}

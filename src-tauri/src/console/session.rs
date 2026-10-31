use super::{
    output::ConsoleOutputSink,
    parser::{
        has_passphrase_env_option, is_archive_discovery, replace_passphrase_env_option,
        supports_new_passphrase,
    },
    ConsoleRunResult,
};
use std::{
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::AppHandle;
use crate::core::cli::{execute_cli, Cancellation};
use zeroize::Zeroizing;

/// Removes the short-lived passphrase variables even if the command unwinds.
struct SecretEnvironment {
    names: Vec<String>,
}

impl SecretEnvironment {
    fn set(name: String, value: &str) -> Result<Self, String> {
        if value.contains('\0') {
            return Err("A passphrase cannot contain a null character.".to_owned());
        }
        // shortcut: execute_cli only accepts passphrases through --passphrase-env, so an
        // in-process run must use the process environment. Replace this when the core exposes a
        // direct secret parameter.
        std::env::set_var(&name, value);
        Ok(Self { names: vec![name] })
    }

    fn extend(&mut self, mut other: SecretEnvironment) {
        self.names.append(&mut other.names);
    }
}

impl Drop for SecretEnvironment {
    fn drop(&mut self) {
        for name in &self.names {
            std::env::remove_var(name);
        }
    }
}

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
) -> Result<ConsoleRunResult, String> {
    if cancellation.load(Ordering::Acquire) {
        return Ok(ConsoleRunResult {
            exit_code: 130,
            cancelled: true,
            archive_changed: false,
        });
    }

    let suffix = run_id.replace('-', "");
    let mut secrets = SecretEnvironment { names: Vec::new() };
    if !passphrase.is_empty() {
        if has_passphrase_env_option(&arguments, "--passphrase-env") {
            return Err("Enter the current passphrase in the console field or use --passphrase-env from your environment, not both.".to_owned());
        }
        let name = format!("TUTORUX_CONSOLE_CURRENT_{suffix}");
        secrets.extend(SecretEnvironment::set(name.clone(), passphrase.as_str())?);
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
        secrets.extend(SecretEnvironment::set(
            name.clone(),
            new_passphrase.as_str(),
        )?);
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
    let exit_code = execute_cli(
        &cli_arguments,
        &mut output,
        &RunCancellation {
            cancelled: cancellation,
            observed: &observed,
        },
    );
    drop(secrets);

    Ok(ConsoleRunResult {
        exit_code,
        cancelled: cancellation.load(Ordering::Acquire) && observed.load(Ordering::Acquire),
        archive_changed: false,
    })
}

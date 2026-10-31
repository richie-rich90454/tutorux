use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::core::error::{CoreError, Result as CoreResult};

pub mod archive;
pub mod misc;
pub mod recordings;
pub mod records;

pub trait CliOutput {
    fn stdout(&mut self, message: &str);
    fn stderr(&mut self, message: &str);
}

pub trait Cancellation {
    fn is_cancelled(&self) -> bool;
}

pub struct NoCancellation;

impl Cancellation for NoCancellation {
    fn is_cancelled(&self) -> bool {
        false
    }
}

#[derive(Debug, Clone)]
pub struct CliError(pub String);

impl std::fmt::Display for CliError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for CliError {}

pub enum Failure {
    Usage(String),
    Core(CoreError),
}

impl From<CoreError> for Failure {
    fn from(error: CoreError) -> Self {
        Failure::Core(error)
    }
}

impl From<CliError> for Failure {
    fn from(error: CliError) -> Self {
        Failure::Usage(error.0)
    }
}

pub type CliResult<T = ()> = std::result::Result<T, Failure>;

#[derive(Debug, Clone, Default)]
pub struct ParsedArguments {
    pub positionals: Vec<String>,
    pub options: BTreeMap<String, String>,
    pub flags: BTreeSet<String>,
}

impl ParsedArguments {
    pub fn flag(&self, name: &str) -> bool {
        self.flags.contains(name)
    }

    pub fn option(&self, name: &str) -> Option<&str> {
        self.options.get(name).map(String::as_str)
    }

    pub fn required_option(&self, name: &str) -> CliResult<&str> {
        match self.option(name).map(str::trim) {
            Some(value) if !value.is_empty() => Ok(value),
            _ => Err(CliError(format!("--{name} is required.")).into()),
        }
    }

    pub fn required_position(&self, index: usize, label: &str) -> CliResult<&str> {
        match self.positionals.get(index).map(String::as_str).map(str::trim) {
            Some(value) if !value.is_empty() => Ok(value),
            _ => Err(CliError(format!("{label} is required.")).into()),
        }
    }

    pub fn json(&self) -> bool {
        self.flag("json")
    }
}

pub fn parse_arguments(args: &[String]) -> CliResult<ParsedArguments> {
    let mut parsed = ParsedArguments::default();
    let mut index = 0usize;
    while index < args.len() {
        let value = &args[index];
        if !value.starts_with("--") {
            parsed.positionals.push(value.clone());
            index += 1;
            continue;
        }
        let body = &value[2..];
        let (name, inline) = match body.split_once('=') {
            Some((name, value)) => (name, Some(value.to_owned())),
            None => (body, None),
        };
        if name.is_empty() {
            return Err(CliError("Option names cannot be empty.".to_owned()).into());
        }
        let next = inline.clone().or_else(|| args.get(index + 1).cloned());
        if let Some(next) = next {
            if !next.starts_with("--") {
                parsed.options.insert(name.to_owned(), next);
                if inline.is_none() {
                    index += 1;
                }
            } else {
                parsed.flags.insert(name.to_owned());
            }
        } else {
            parsed.flags.insert(name.to_owned());
        }
        index += 1;
    }
    Ok(parsed)
}

pub fn take_global_option(args: &mut Vec<String>, name: &str) -> CliResult<Option<String>> {
    let option = format!("--{name}");
    let indexes: Vec<usize> = args
        .iter()
        .enumerate()
        .filter(|(_, value)| *value == &option || value.starts_with(&format!("{option}=")))
        .map(|(index, _)| index)
        .collect();
    if indexes.len() > 1 {
        return Err(CliError(format!("Choose only one {option} value.")).into());
    }
    let Some(index) = indexes.first().copied() else {
        return Ok(None);
    };
    let argument = &args[index];
    let inline = argument
        .split_once('=')
        .map(|(_, value)| value.to_owned());
    let value = inline.or_else(|| args.get(index + 1).cloned());
    let Some(value) = value else {
        return Err(CliError(format!("{option} requires a value.")).into());
    };
    if value.starts_with("--") {
        return Err(CliError(format!("{option} requires a value.")).into());
    }
    args.drain(index..index + if argument.contains('=') { 1 } else { 2 });
    Ok(Some(value))
}

pub fn emit(
    output: &mut dyn CliOutput,
    value: serde_json::Value,
    summary: &str,
    json: bool,
) {
    if json {
        output.stdout(&serde_json::to_string_pretty(&value).unwrap_or_else(|_| "null".to_owned()));
    } else {
        output.stdout(summary);
    }
}

pub fn timestamp_now() -> String {
    crate::core::archive::now_us().to_string()
}

pub fn resolve_path(path: &str) -> PathBuf {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(candidate)
    }
}

pub fn validate_uuid(value: &str, label: &str) -> CliResult<String> {
    if !crate::core::format::valid_uuid(value) {
        return Err(CliError(format!("{label} must be a valid UUID.")).into());
    }
    Ok(value.to_lowercase())
}

pub fn option_id_list(args: &ParsedArguments, name: &str) -> CliResult<Option<Vec<String>>> {
    let Some(value) = args.option(name) else {
        return Ok(None);
    };
    if value.trim().is_empty() {
        return Ok(Some(Vec::new()));
    }
    let mut ids = BTreeSet::new();
    for id in value.split(',').map(str::trim) {
        if !crate::core::format::valid_uuid(id) {
            return Err(CliError(format!(
                "--{name} must contain comma-separated archive IDs."
            ))
            .into());
        }
        ids.insert(id.to_lowercase());
    }
    Ok(Some(ids.into_iter().collect()))
}

pub fn parse_integer(raw: Option<&str>, name: &str, fallback: u64, min: u64, max: u64) -> CliResult<u64> {
    let Some(raw) = raw else {
        return Ok(fallback);
    };
    if raw.is_empty() || !raw.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(CliError(format!(
            "--{name} must be an integer from {min} through {max}."
        ))
        .into());
    }
    let value: u64 = raw
        .parse()
        .map_err(|_| CliError(format!("--{name} must be an integer from {min} through {max}.")))?;
    if !(min..=max).contains(&value) {
        return Err(CliError(format!(
            "--{name} must be an integer from {min} through {max}."
        ))
        .into());
    }
    Ok(value)
}

pub const VERSION: &str = "Tutorux 1.0.0 (Rust)";

const HELP: &str = r#"Tutorux — local-first tutoring archive tools

Usage:
  tutorux archive init <file.tux> --name <name> [--description <text>] [--new-passphrase-env <name>]
  tutorux archive discover|list [--directory <directory>] [--json]
  tutorux archive rename <file.tux> --name <name> [--passphrase-env <name>]
  tutorux archive encrypt <file.tux> --new-passphrase-env <name>
  tutorux archive unlock <file.tux> [--passphrase-env <name>] [--json]
  tutorux archive change-passphrase <file.tux> --new-passphrase-env <name>
  tutorux archive info|verify <file.tux> [--full] [--history] [--passphrase-env <name>] [--json]
  tutorux archive backup|copy <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux archive recover <file.tux> [--apply] [--discard-tail] [--json]
  tutorux archive compact <file.tux> [--apply] [--json]
  tutorux archive backfill-indexes <file.tux> [--apply] [--json]
  tutorux archive repair <file.tux> --output <copy.tux> --confirm-sensitive [--json]
  tutorux archive rebuild-index <file.tux> --output <new-copy.tux> --confirm-sensitive [--json]
  tutorux archive sanitize <file.tux> --output <copy.tux> [selection options]
  tutorux --archive <file.tux> student|session|journal|annotation|asset|evidence|guide|template|settings|transcript|record|ai|model ... [--json]
  tutorux diagnostics run|archive|report|providers|graphics|audio|network
  tutorux benchmark startup|memory|cpu|indexing|rendering|export|audio|full

Global options:
  --archive <path>  Select the archive for record commands
  --directory <path>  Select the directory for archive discovery
  --passphrase-env <name>  Read an encrypted archive passphrase from an environment variable
  --json            Print machine-readable JSON
  --help            Show this help
  --version         Show the application version"#;

pub fn execute_cli(arguments: &[String], output: &mut dyn CliOutput, cancellation: &dyn Cancellation) -> i32 {
    match execute_inner(arguments, output, cancellation) {
        Ok(code) => code,
        Err(Failure::Usage(message)) => {
            output.stderr(&format!("tutorux: {message}"));
            2
        }
        Err(Failure::Core(error)) => {
            output.stderr(&format!("tutorux: {}", error.message));
            1
        }
    }
}

fn execute_inner(
    arguments: &[String],
    output: &mut dyn CliOutput,
    cancellation: &dyn Cancellation,
) -> CliResult<i32> {
    let mut argv: Vec<String> = arguments.to_vec();
    if argv.iter().any(|value| value == "--help" || value == "-h")
        || argv.first().map(String::as_str) == Some("help")
    {
        output.stdout(HELP);
        return Ok(0);
    }
    if argv.iter().any(|value| value == "--version" || value == "-v")
        || argv.first().map(String::as_str) == Some("version")
    {
        output.stdout(VERSION);
        return Ok(0);
    }

    let passphrase_environment = take_global_option(&mut argv, "passphrase-env")?;
    let directory = take_global_option(&mut argv, "directory")?;
    let passphrase = match passphrase_environment {
        Some(name) => {
            if !valid_environment_name(&name) {
                return Err(CliError(
                    "--passphrase-env requires a valid environment variable name.".to_owned(),
                )
                .into());
            }
            match std::env::var(&name) {
                Ok(value) => Some(value),
                Err(_) => {
                    return Err(CliError(
                        "The archive passphrase environment variable is not set.".to_owned(),
                    )
                    .into())
                }
            }
        }
        None => None,
    };

    let mut json = false;
    argv.retain(|value| {
        if value == "--json" {
            json = true;
            false
        } else {
            true
        }
    });
    let archive_path = take_global_option(&mut argv, "archive")?;
    if argv.is_empty() {
        return Err(CliError(
            "Choose a command group and action. Run `tutorux --help` for help.".to_owned(),
        )
        .into());
    }
    let group = argv.remove(0);
    if argv.is_empty() {
        return Err(CliError(
            "Choose a command group and action. Run `tutorux --help` for help.".to_owned(),
        )
        .into());
    }
    let action = argv.remove(0);
    let mut parsed = parse_arguments(&argv)?;
    if json {
        parsed.flags.insert("json".to_owned());
    }
    if let Some(directory) = directory {
        if group != "archive" || (action != "discover" && action != "list") {
            return Err(CliError(
                "--directory is only available for archive discovery.".to_owned(),
            )
            .into());
        }
        parsed
            .options
            .insert("directory".to_owned(), directory);
    }

    let context = CliContext {
        passphrase,
        archive_path: archive_path.map(|value| resolve_path(&value)),
    };
    if group == "archive" {
        return archive::run_archive_command(&action, parsed, output, &context);
    }
    if group == "diagnostics" {
        return misc::run_diagnostics_command(&action, parsed, output, &context, cancellation);
    }
    if group == "benchmark" {
        return misc::run_benchmark_command(&action, parsed, output, &context, cancellation);
    }
    if group == "ai" && action == "providers" {
        return misc::run_ai_providers(parsed, output);
    }
    if group == "template" && action == "list" && context.archive_path.is_none() {
        return records::run_builtin_templates(parsed, output);
    }
    if group == "record" && action == "devices" {
        return recordings::run_recording_devices(parsed, output);
    }
    if group == "record" && action == "test" {
        return recordings::run_recording_test(parsed, output);
    }
    let Some(archive_path) = context.archive_path.clone() else {
        return Err(CliError("Record commands require --archive <path>.".to_owned()).into());
    };
    if group == "record" {
        return recordings::run_record_command(&action, parsed, output, &archive_path, &context);
    }
    records::run_record_command(&group, &action, parsed, output, &archive_path, &context)
}

fn valid_environment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    match bytes.next() {
        Some(first) if first.is_ascii_alphabetic() || first == b'_' => {}
        _ => return false,
    }
    bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

#[derive(Debug, Clone)]
pub struct CliContext {
    pub passphrase: Option<String>,
    pub archive_path: Option<PathBuf>,
}

impl CliContext {
    pub fn passphrase(&self) -> Option<&str> {
        self.passphrase.as_deref()
    }
}

pub fn open_archive(path: &Path, passphrase: Option<&str>) -> CoreResult<crate::core::archive::ArchiveSnapshot> {
    let source = std::sync::Arc::new(crate::core::source::FileSource::open(path)?);
    crate::core::archive::ArchiveSnapshot::open(source)
        .and_then(|snapshot| {
            if snapshot.locked() {
                if let Some(passphrase) = passphrase {
                    snapshot.unlock(passphrase)
                } else {
                    Ok(snapshot)
                }
            } else {
                Ok(snapshot)
            }
        })
}

pub fn require_unlocked(
    snapshot: &crate::core::archive::ArchiveSnapshot,
) -> CliResult<crate::core::archive::ArchiveSnapshot> {
    if snapshot.locked() {
        return Err(CliError(
            "This archive is encrypted. Provide --passphrase-env to unlock it.".to_owned(),
        )
        .into());
    }
    Ok(snapshot.clone())
}

pub fn save_archive(
    path: &Path,
    snapshot: &crate::core::archive::ArchiveSnapshot,
) -> CoreResult<()> {
    let bytes = snapshot.source.read(0, snapshot.source.size() as usize)?;
    write_file_atomically(path, &bytes)
}

pub fn write_file_atomically(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not create the archive directory: {error}"),
        )
    })?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not create a temporary file: {error}"),
        )
    })?;
    use std::io::Write;
    temporary.write_all(bytes).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not write the archive: {error}"),
        )
    })?;
    temporary.as_file().sync_all().map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not flush the archive: {error}"),
        )
    })?;
    temporary.persist(path).map_err(|error| {
        CoreError::new(
            "archive_write_failed",
            format!("Could not publish the archive: {error}"),
        )
    })?;
    Ok(())
}

pub fn write_new_file(path: &Path, bytes: &[u8]) -> CoreResult<()> {
    if path.exists() {
        return Err(CoreError::new(
            "archive_output_exists",
            format!("Output already exists: {}", path.display()),
        ));
    }
    write_file_atomically(path, bytes)
}

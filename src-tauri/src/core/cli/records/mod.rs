pub(crate) use std::collections::{BTreeMap, BTreeSet};

pub(crate) use serde_json::{json, Map, Value};

pub(crate) use crate::core::archive::{create_archive_bytes, now_us, ArchiveSnapshot};
pub(crate) use crate::core::cli::{
    emit, open_archive, option_id_list, parse_integer, resolve_path, timestamp_now,
    write_file_atomically, write_new_file, CliContext, CliError, CliOutput, CliResult,
    ParsedArguments,
};
pub(crate) use crate::core::error::{CoreError, Result};
pub(crate) use crate::core::format::{record_type_name, ArchiveRecord, RecordType};

mod annotations;
mod assets;
mod evidence;
mod evidence_sources;
mod guide_model;
mod guides;
mod helpers;
mod journal;
mod journal_document;
mod journal_list;
mod journal_organizer;
mod packages;
mod progress;
mod session_clone;
mod session_dates;
mod session_list;
mod session_support;
mod session_trash;
mod sessions;
mod settings;
mod students;
mod template_custom;
mod templates;
mod transcript_edit;
mod transcript_model;
mod transcripts;

pub(crate) use annotations::*;
pub(crate) use assets::*;
pub(crate) use evidence::*;
pub(crate) use evidence_sources::*;
pub(crate) use guide_model::*;
pub(crate) use guides::*;
pub(crate) use helpers::*;
pub(crate) use journal::*;
pub(crate) use journal_document::*;
pub(crate) use journal_list::*;
pub(crate) use journal_organizer::*;
pub(crate) use packages::*;
pub(crate) use progress::*;
pub(crate) use session_clone::*;
pub(crate) use session_dates::*;
pub(crate) use session_list::*;
pub(crate) use session_support::*;
pub(crate) use session_trash::*;
pub(crate) use sessions::*;
pub(crate) use settings::*;
pub(crate) use students::*;
pub(crate) use template_custom::*;
pub(crate) use templates::*;
pub(crate) use transcript_edit::*;
pub(crate) use transcript_model::*;
pub(crate) use transcripts::*;
pub use templates::run_builtin_templates;

pub fn run_record_command(
    group: &str,
    action: &str,
    args: ParsedArguments,
    output: &mut dyn CliOutput,
    path: &std::path::Path,
    context: &CliContext,
) -> CliResult<i32> {
    match group {
        "student" => run_student(action, args, output, path, context),
        "session" => run_session(action, args, output, path, context),
        "journal" => run_journal(action, args, output, path, context),
        "annotation" => run_annotation(action, args, output, path, context),
        "template" => run_template(action, args, output, path, context),
        "settings" => run_settings(action, args, output, path, context),
        "asset" => run_asset(action, args, output, path, context),
        "evidence" => run_evidence(action, args, output, path, context),
        "guide" => run_guide(action, args, output, path, context),
        "transcript" => run_transcript(action, args, output, path, context),
        "ai" | "model" => super::misc::run_record_ai_command(group, action, args, output, path, context),
        _ => Err(CliError(format!("{group} {action} is not implemented in the Rust CLI yet.")).into()),
    }
}
